// ─── Channels v2 Step 3a: the wake worker ──────────────────────────────────
//
// The push half of the durable inbox. Delivery correctness lives in the
// PULL path (cursor + unread — a message is never lost by a missed nudge);
// this worker only shortens the time until an agent LOOKS. It injects a
// one-line hint into an idle member pane's PTY:
//
//   [wmux] #general: 2 unread (1 mention you) — run: wmux channel read ch-… --since 5
//
// Wake strategy stack (design doc):
//   - ATTACHED Claude panes are SKIPPED here — the renderer's Stop-hook
//     mention path owns them (surfaceAgent busy check, proven in
//     production). A DETACHED Claude pane has no renderer and therefore no
//     Stop-hook path — headless (the reboot-recovery window) it is a valid
//     injection target like any other agent (Codex round-3: a Claude-only
//     workspace used to stay silent forever in headless, never even
//     reaching the exhaustion handoff because no nudge was ever spent).
//   - Generic panes (Codex/OpenCode/…) get the PTY injection below.
//   - Agents that poll (`wmux channel unread` in AGENTS.md) need no nudge
//     at all — the worker is an accelerator, never a dependency.
//
// Safety rules (all live-dogfood findings, 2026-07-02):
//   F2  — text and Enter are written SEPARATELY (a single "text\r" write
//         trips TUI bracketed-paste heuristics and strands the nudge in the
//         composer, uncommitted).
//   Quiet gate — inject only after QUIET_MS of output silence (a busy agent
//         mid-stream must never get bytes spliced into its input; input
//         activity echoes as output for both shells and TUIs, so output
//         quiet is the conservative proxy for both).
//   Target discipline — inject only when the pane is unambiguous: a live
//         non-claude session whose detected agent slug equals the member id,
//         else the ONLY live non-claude session in the workspace. Ambiguity
//         = no injection (polling fallback), never a guess.
//   Re-nudge policy — mention-unread re-nudges with backoff up to a hard
//         cap, then STOPS and emits `channel.nudgeExhausted` (loop-storm
//         guard: two agents must not ping-pong each other's token budgets
//         forever). Plain unread nudges ONCE per head advance. Ack resets
//         everything (cursor catches up → unread 0 → tracker cleared).
//
// State is deliberately IN-MEMORY (nudge attempts are retry bookkeeping,
// not truth — the deliveryStatus dead-code audit finding is not coming
// back as a schema field).

export interface WakeUnreadEntry {
  channelId: string;
  name: string;
  memberId: string;
  lastReadSeq: number;
  headSeq: number;
  unread: number;
  mentionUnread: number;
  trimmedBeforeCursor: number;
}

export interface WakeSessionView {
  id: string;
  /** Canonical agent slug last detected in this pane ('claude', 'codex', …). */
  lastDetectedAgent?: string;
  /** Epoch ms of the last PTY output activity. */
  lastActivityMs: number;
  /** Owning workspace ('' when the session has no binding). */
  workspaceId: string;
  /**
   * True for a RECOVERED session still in deferred-output mode (waiting for
   * its first renderer resize to activate). Live dogfood 2026-07-02: after a
   * daemon SIGKILL+respawn, such a pane is bookkept 'attached' but nothing
   * renders and the pre-crash agent process is gone — the worker burned 2 of
   * its 3 mention nudges into that void. A deferred pane has no agent to
   * wake, so it is never an injection target.
   */
  deferred?: boolean;
  /**
   * True when a renderer is attached to this session (GUI alive). Claude
   * panes are excluded ONLY while attached — the renderer's Stop-hook
   * mention path owns them there. Detached = headless: no renderer path
   * exists, so the worker must nudge Claude panes itself (Codex round-3).
   */
  attached?: boolean;
}

export interface ChannelWakeWorkerDeps {
  memberWorkspaces(): string[];
  unreadFor(workspaceId: string): WakeUnreadEntry[];
  /** Live sessions only (attached/detached — a usable PTY child exists). */
  listLiveSessions(): WakeSessionView[];
  /** Write raw bytes into a session's PTY stdin. */
  write(sessionId: string, data: string): void;
  /** Broadcast a daemon event (nudge exhaustion → human attention). */
  broadcast(event: Record<string, unknown>): void;
  log(level: 'debug' | 'info' | 'warn', message: string): void;
  now(): number;
  /** Test seam: ms between the text write and the Enter write. */
  enterDelayMs?: number;
}

// Conservative defaults (Step 3b tunes with field data).
export const WAKE_TICK_MS = 15_000;
export const WAKE_QUIET_MS = 10_000;
/** Backoff BETWEEN mention re-nudges: immediate, then 1m, then 5m. */
export const MENTION_NUDGE_BACKOFF_MS = [0, 60_000, 300_000] as const;
/** Hard cap of mention nudges per (channel, member) episode. */
export const MENTION_NUDGE_CAP = MENTION_NUDGE_BACKOFF_MS.length;
/**
 * Re-announce interval for an exhausted episode. The broadcast reaches only
 * CURRENTLY connected clients — in the headless window there is nobody, and
 * a once-ever announcement would be lost forever while the worker has
 * already stopped nudging (Codex round-4). Re-announcing on a slow cadence
 * makes the human handoff eventually-delivered (a GUI that reconnects gets
 * it within one interval) and doubles as bounded escalation while a mention
 * rots unanswered. Ack resets the episode and stops it.
 */
export const EXHAUSTED_REANNOUNCE_MS = 30 * 60_000;
const ENTER_DELAY_MS = 150;
const NUDGE_MAX_LEN = 220;

interface NudgeTrackerEntry {
  /** Mention nudges sent in the current unread episode. */
  mentionNudges: number;
  lastMentionNudgeAt: number;
  /** Head seq at the time of the last PLAIN nudge (one per head advance). */
  plainNudgedAtSeq: number;
  /** Epoch ms of the last exhaustion announcement (0 = never). */
  lastExhaustedAnnounceAt: number;
}

const keyOf = (ws: string, e: { channelId: string; memberId: string }): string =>
  `${e.channelId}|${ws}|${e.memberId}`;

const sanitizeLine = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, NUDGE_MAX_LEN);

export class ChannelWakeWorker {
  private readonly deps: ChannelWakeWorkerDeps;
  private readonly tracker = new Map<string, NudgeTrackerEntry>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingEnter = new Set<ReturnType<typeof setTimeout>>();

  constructor(deps: ChannelWakeWorkerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.safeTick(), WAKE_TICK_MS);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.kickTimer) {
      clearTimeout(this.kickTimer);
      this.kickTimer = null;
    }
    for (const t of this.pendingEnter) clearTimeout(t);
    this.pendingEnter.clear();
  }

  /**
   * Fast path: a channel event just fired (post) — check soon instead of
   * waiting for the next 15 s tick. Debounced so a burst of posts costs one
   * sweep. The 1 s delay also lets the post's own output echo settle before
   * the quiet gate looks at the pane.
   */
  notifyChannelActivity(): void {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.safeTick();
    }, 1_000);
    this.kickTimer.unref?.();
  }

  /**
   * Every scheduled entry point goes through here: a sweep runs on a bare
   * timer, so ANY dep throw (a PTY write racing session death, corrupted
   * channel state) would otherwise become an uncaught exception and take
   * the whole daemon down. The worker is an accelerator — it is never
   * allowed to be the thing that kills the process (CodeRabbit review).
   */
  private safeTick(): void {
    try {
      this.tickOnce();
    } catch (err) {
      this.deps.log('warn', `[wake] sweep failed (skipping this tick): ${String(err)}`);
    }
  }

  /** One sweep over every member workspace. Public for tests + the kick path. */
  tickOnce(): void {
    let sessions: WakeSessionView[] | null = null; // lazy — most ticks have zero unread
    for (const ws of this.deps.memberWorkspaces()) {
      for (const entry of this.deps.unreadFor(ws)) {
        const key = keyOf(ws, entry);
        if (entry.unread === 0) {
          // Ack caught the cursor up — the episode is over; a future unread
          // starts a fresh nudge budget.
          this.tracker.delete(key);
          continue;
        }
        const state = this.tracker.get(key) ?? {
          mentionNudges: 0,
          lastMentionNudgeAt: 0,
          plainNudgedAtSeq: -1,
          lastExhaustedAnnounceAt: 0,
        };

        const wantMention = entry.mentionUnread > 0;
        if (wantMention) {
          if (state.mentionNudges >= MENTION_NUDGE_CAP) {
            const never = state.lastExhaustedAnnounceAt === 0;
            if (never || this.deps.now() - state.lastExhaustedAnnounceAt >= EXHAUSTED_REANNOUNCE_MS) {
              state.lastExhaustedAnnounceAt = this.deps.now();
              this.tracker.set(key, state);
              this.deps.log(
                'warn',
                `[wake] nudge budget exhausted for ${key} (${MENTION_NUDGE_CAP} mention nudges, still ${entry.unread} unread) — handing off to humans`,
              );
              this.deps.broadcast({
                type: 'channel.nudgeExhausted',
                channelId: entry.channelId,
                channelName: entry.name,
                workspaceId: ws,
                memberId: entry.memberId,
                unread: entry.unread,
                mentionUnread: entry.mentionUnread,
              });
            }
            continue;
          }
          const backoff = MENTION_NUDGE_BACKOFF_MS[state.mentionNudges] ?? 0;
          if (this.deps.now() - state.lastMentionNudgeAt < backoff) continue;
        } else {
          // Plain unread: one nudge per head advance.
          if (state.plainNudgedAtSeq >= entry.headSeq) continue;
        }

        sessions ??= this.deps.listLiveSessions();
        const target = pickTarget(sessions, ws, entry.memberId);
        if (!target) continue; // ambiguity / no live pane / claude-only → polling fallback
        if (this.deps.now() - target.lastActivityMs < WAKE_QUIET_MS) continue; // busy — retry next tick

        // A failed write must not burn the nudge budget (G5 spirit: never
        // spend nudges into a void) — retry on a later tick instead.
        if (!this.inject(target.id, entry)) continue;

        if (wantMention) {
          state.mentionNudges += 1;
          state.lastMentionNudgeAt = this.deps.now();
        } else {
          state.plainNudgedAtSeq = entry.headSeq;
        }
        this.tracker.set(key, state);
      }
    }
  }

  /**
   * F2: text first, Enter as a SEPARATE write after a short delay.
   * Returns false when the text write throws (the session died between
   * target selection and the write — a PTY write to a destroyed stream
   * throws synchronously); the caller then keeps the nudge budget intact.
   */
  private inject(sessionId: string, entry: WakeUnreadEntry): boolean {
    const mention = entry.mentionUnread > 0 ? ` (${entry.mentionUnread} mention you)` : '';
    const line = sanitizeLine(
      `[wmux] #${entry.name}: ${entry.unread} unread${mention} — run: wmux channel read ${entry.channelId} --since ${entry.lastReadSeq + 1}`,
    );
    this.deps.log('info', `[wake] nudging ${sessionId} for ${entry.channelId}#${entry.memberId} (${entry.unread} unread)`);
    try {
      this.deps.write(sessionId, line);
    } catch (err) {
      this.deps.log('warn', `[wake] nudge write to ${sessionId} failed (session died mid-race?): ${String(err)}`);
      return false;
    }
    const t = setTimeout(() => {
      this.pendingEnter.delete(t);
      try {
        this.deps.write(sessionId, '\r');
      } catch {
        // session died between the two writes — the pull path still owns
        // correctness; drop silently.
      }
    }, this.deps.enterDelayMs ?? ENTER_DELAY_MS);
    t.unref?.();
    this.pendingEnter.add(t);
    return true;
  }
}

/**
 * Injection target discipline: never guess.
 *  0. deferred (recovered-not-yet-activated) sessions are excluded outright —
 *     no agent lives there and nothing renders (dogfood G5 finding);
 *  1. ATTACHED claude panes are excluded — the renderer's Stop-hook mention
 *     path owns them while a GUI is alive; a DETACHED claude pane is
 *     eligible like any agent (headless has no other delivery path —
 *     Codex round-3);
 *  2. eligible session whose detected agent slug === memberId;
 *  3. else the ONLY eligible session in the workspace;
 *  4. else null (multi-pane ambiguity falls back to polling).
 */
export function pickTarget(
  sessions: WakeSessionView[],
  workspaceId: string,
  memberId: string,
): WakeSessionView | null {
  const inWs = sessions.filter((s) => s.workspaceId === workspaceId && s.deferred !== true);
  const eligible = inWs.filter((s) => s.lastDetectedAgent !== 'claude' || s.attached !== true);
  const slugMatch = eligible.filter((s) => s.lastDetectedAgent === memberId);
  if (slugMatch.length === 1) return slugMatch[0];
  if (slugMatch.length > 1) return null;
  // The member's OWN pane exists but is an ATTACHED claude pane: the
  // renderer Stop-hook path owns that delivery — do NOT reroute the nudge
  // to an unrelated single pane, which would double-deliver AND burn the
  // budget in the wrong place (Codex round-4). A DEFERRED slug-match, by
  // contrast, still falls through: nobody lives there and the one live
  // pane may be the member's actual home (dogfood G5).
  const ownedByRenderer = inWs.some(
    (s) => s.lastDetectedAgent === memberId && s.lastDetectedAgent === 'claude' && s.attached === true,
  );
  if (ownedByRenderer) return null;
  if (eligible.length === 1) return eligible[0];
  return null;
}

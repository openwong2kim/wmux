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
//   Target discipline — a stable principal coordinate must resolve to that
//         exact live agent pane or no injection occurs. Legacy rows without a
//         usable principal lookup use the slug/only-live-agent heuristic.
//         Ambiguity or an invalid exact target = polling fallback, never a
//         guess.
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
  /** R2 — the member row's principal stable coordinate. When present, ptyId is
   *  looked up directly from the registry to target the exact session without
   *  the slug heuristic. */
  principalId?: string;
  lastReadSeq: number;
  headSeq: number;
  unread: number;
  mentionUnread: number;
  trimmedBeforeCursor: number;
  /**
   * The OLDEST owed message's body, supplied by ChannelService. The nudge
   * carries its first line so the woken agent knows WHAT it is being woken
   * for — a bare "2 unread, run wmux channel read …" makes every nudge look
   * identical, and an agent mid-task cannot tell an urgent mention from
   * routine chatter without spending a turn on the read. Optional: an older
   * producer that does not supply it still gets the hint-only nudge.
   */
  oldestUnreadBody?: string;
}

/** Outcome of one nudge attempt, reported back to the producer so a message's
 *  delivery bookkeeping reflects what actually happened at the PTY. */
export interface WakeNudgeOutcome {
  workspaceId: string;
  channelId: string;
  memberId: string;
  sessionId: string;
  /**
   * The seq range this nudge was announcing: the member's cursor at nudge time
   * (exclusive) through the channel head (inclusive). Bookkeeping must not
   * spill outside it — a nudge says nothing about messages the member had
   * already read, or about ones posted after it went out.
   */
  fromSeqExclusive: number;
  toSeqInclusive: number;
  /** False when the write threw — the pane died between target selection and
   *  the write, so nothing was delivered. */
  ok: boolean;
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
  /** R2 — principal registry lookup: returns the last registered ptyId
   *  coordinate without interpreting registry liveness. This worker proves
   *  liveness against listLiveSessions(), whose attached/detached snapshot is
   *  daemon-owned and survives a restart. Optional (test / legacy compatible). */
  principalPtyIdOf?(principalId: string): string | undefined;
  /** Write raw bytes into a session's PTY stdin. */
  write(sessionId: string, data: string): void;
  /** Broadcast a daemon event (nudge exhaustion → human attention). */
  broadcast(event: Record<string, unknown>): void;
  log(level: 'debug' | 'info' | 'warn', message: string): void;
  /**
   * Report what happened at the PTY for one nudge. The push half used to be
   * write-only: a nudge into a pane that died mid-race was logged and dropped,
   * and the message it was announcing stayed `pending` forever — a receipt for
   * a delivery nobody made. Wired to ChannelService, a failure marks that
   * recipient `target_gone` instead. Optional (test / legacy compatible).
   */
  onNudgeOutcome?(outcome: WakeNudgeOutcome): void;
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
  /** Last time we LOGGED that no eligible agent pane exists for this key —
   *  the null-target hold would otherwise be fully silent (no nudge, no
   *  budget spend, no exhaustion handoff), which is exactly the invisible
   *  infinite-hold class the delivery audit flagged. Log-only, slow cadence. */
  lastNoTargetAnnounceAt: number;
}

const keyOf = (ws: string, e: { channelId: string; memberId: string }): string =>
  `${e.channelId}|${ws}|${e.memberId}`;

/** Single initializer for tracker entries — recordExternalNudge and tickOnce
 *  must stay in lockstep when the ledger state grows a field (ship review). */
const freshTrackerState = (): NudgeTrackerEntry => ({
  mentionNudges: 0,
  lastMentionNudgeAt: 0,
  plainNudgedAtSeq: -1,
  lastExhaustedAnnounceAt: 0,
  lastNoTargetAnnounceAt: 0,
});

const sanitizeLine = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, NUDGE_MAX_LEN);

/** Longest body excerpt carried in a nudge. */
export const BODY_PREVIEW_MAX_LEN = 200;

/**
 * The first line of a message body, safe to TYPE INTO A LIVE PANE and commit
 * with an Enter.
 *
 * That last clause is the whole problem. This text is written by another
 * workspace, and it is submitted, not merely displayed. Two escapes matter:
 * `lastDetectedAgent` can be stale, so the pane may really be a shell, where
 * `$(…)` and backticks EXECUTE; and a quote can close the agent's own framing.
 * So the preview keeps letters and punctuation and drops the characters that
 * change how the line is interpreted — control characters (the newlines that
 * would submit early included), `$`, backtick, backslash, and both quote
 * marks. Blank in, blank out, so the caller can drop the segment entirely
 * instead of appending a dangling separator.
 */
export function bodyPreview(body: string | undefined): string {
  if (!body) return '';
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const clean = firstLine
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    // Shell/agent metacharacters. Dropped rather than escaped: an escape is
    // only correct for the interpreter you assumed, and the point here is that
    // we do not reliably know which one is on the other end.
    .replace(/[$`\\"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= BODY_PREVIEW_MAX_LEN) return clean;
  return `${clean.slice(0, BODY_PREVIEW_MAX_LEN - 1)}…`;
}

/**
 * Agents whose pane is a TUI chat box, where a pasted line lands in a composer
 * rather than a command interpreter. The body preview rides only into these:
 * an unknown or absent agent means the pane may be a bare shell, and a bare
 * shell would RUN the other workspace's text.
 */
const BODY_PREVIEW_AGENTS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'gemini',
  'aider',
  'opencode',
  'copilot',
]);

/** Whether a nudge into this pane may carry the message body at all. */
export function mayCarryBody(detectedAgent: string | undefined): boolean {
  return !!detectedAgent && BODY_PREVIEW_AGENTS.has(detectedAgent);
}

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
   * Shared nudge ledger (remediation 2a-2): the RENDERER just pasted a channel
   * mention into this member's pane (its Stop-hook delivery path). Count it
   * against the same per-(channel, member) budget this worker's own injections
   * use, so the worker's next action lands on the NEXT backoff slot instead of
   * an immediate duplicate paste — while an unacked mention still escalates to
   * exhaustion (the human handoff is a feature, not a bug). The tracker entry
   * is cleared by the normal ack path (unread hits 0 on a later tick).
   *
   * Returns false without recording when the (channel, member) tuple is not a
   * REAL membership row of that workspace (3-specialist ship-review consensus:
   * unvalidated keys are never enumerated by the unread sweep, so they would
   * live for the daemon's lifetime — an unbounded-growth vector for any caller
   * that can reach the RPC).
   */
  recordExternalNudge(channelId: string, workspaceId: string, memberId: string): boolean {
    const known = this.deps
      .unreadFor(workspaceId)
      .some((e) => e.channelId === channelId && e.memberId === memberId);
    if (!known) return false;
    const key = keyOf(workspaceId, { channelId, memberId });
    const state = this.tracker.get(key) ?? freshTrackerState();
    state.mentionNudges += 1;
    state.lastMentionNudgeAt = this.deps.now();
    this.tracker.set(key, state);
    return true;
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
        const state = this.tracker.get(key) ?? freshTrackerState();

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
        const target = pickTargetWithPrincipal(
          sessions,
          ws,
          entry.memberId,
          entry.principalId,
          this.deps.principalPtyIdOf?.bind(this.deps),
        );
        if (!target) {
          // Ambiguity / no live pane / claude-only / agent-less shells →
          // polling fallback. Surface the silent hold on a slow cadence so a
          // member that can never be targeted (e.g. its agent exited and only
          // bare shells remain) is visible in the log instead of stalling
          // invisibly with zero budget spend (Codex micro-pass, 2026-07-05).
          const never = state.lastNoTargetAnnounceAt === 0;
          if (never || this.deps.now() - state.lastNoTargetAnnounceAt >= EXHAUSTED_REANNOUNCE_MS) {
            state.lastNoTargetAnnounceAt = this.deps.now();
            this.tracker.set(key, state);
            this.deps.log(
              'info',
              `[wake] no eligible agent pane for ${key} (${entry.unread} unread) — holding for detection/poll`,
            );
          }
          continue;
        }
        if (this.deps.now() - target.lastActivityMs < WAKE_QUIET_MS) continue; // busy — retry next tick

        // A failed write must not burn the nudge budget (G5 spirit: never
        // spend nudges into a void) — retry on a later tick instead.
        if (!this.inject(target.id, ws, entry, target)) continue;

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
  private inject(sessionId: string, workspaceId: string, entry: WakeUnreadEntry, target: WakeSessionView): boolean {
    const mention = entry.mentionUnread > 0 ? ` (${entry.mentionUnread} mention you)` : '';
    const hint = `[wmux] #${entry.name}: ${entry.unread} unread${mention} — run: wmux channel read ${entry.channelId} --since ${entry.lastReadSeq + 1}`;
    // The body's first line rides AFTER the hint. Every nudge used to read the
    // same, so an agent mid-task had to spend a turn on the read just to learn
    // whether it mattered.
    //
    // But ONLY into a pane we can name as an agent TUI. `lastDetectedAgent` can
    // be stale — the agent exits and the shell stays — and this text comes from
    // another workspace and is committed with an Enter, so a bare shell would
    // run it. The hint is ours and always safe; the body is not.
    const preview = mayCarryBody(target.lastDetectedAgent) ? bodyPreview(entry.oldestUnreadBody) : '';
    // sanitize + cap the FINAL line, not its pieces: the cap has to bound what
    // actually reaches the PTY, and concatenation is exactly where a bounded
    // hint and a bounded preview stop being bounded.
    const line = sanitizeLine(preview ? `${hint} — ${preview}` : hint);
    const report = (ok: boolean): void => {
      this.deps.onNudgeOutcome?.({
        workspaceId,
        channelId: entry.channelId,
        memberId: entry.memberId,
        sessionId,
        fromSeqExclusive: entry.lastReadSeq,
        toSeqInclusive: entry.headSeq,
        ok,
      });
    };
    this.deps.log('info', `[wake] nudging ${sessionId} for ${entry.channelId}#${entry.memberId} (${entry.unread} unread)`);
    try {
      this.deps.write(sessionId, line);
    } catch (err) {
      this.deps.log('warn', `[wake] nudge write to ${sessionId} failed (session died mid-race?): ${String(err)}`);
      report(false);
      return false;
    }
    const t = setTimeout(() => {
      this.pendingEnter.delete(t);
      try {
        this.deps.write(sessionId, '\r');
      } catch {
        // The session died between the two writes: the hint is stranded
        // uncommitted in a pane nobody is reading. The pull path still owns
        // correctness, but the attempt must not be recorded as a delivery.
        report(false);
        return;
      }
      // Committed. This is the only point at which the nudge actually reached
      // the agent, so it is the only point that may report success.
      report(true);
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
 *  3. else the ONLY eligible session in the workspace — but ONLY when it
 *     actually hosts a detected agent; a bare shell is never nudged
 *     (2026-07-05 dogfood, see the guard below);
 *  4. else null (multi-pane ambiguity / agent-less shell falls back to polling).
 */
/**
 * R2 — direct principal targeting. When the member row has a principalId and
 * the registry knows a ptyId that is present in the daemon's LIVE session
 * snapshot, aim straight at that session (an auto-name
 * memberId never matches the slug heuristic, so without the principal path an
 * R2 pane member would never get nudged). Keeps the same discipline as the
 * existing pickTarget:
 *   - exclude deferred sessions (G5);
 *   - an ATTACHED claude pane → null — the renderer Stop-hook owns it. Do not
 *     fall back to the heuristic (re-routing to the wrong single pane = double
 *     delivery + wasted budget);
 *   - if the exact coordinate is missing, dead, in another workspace, or no
 *     longer hosts an agent, fail closed. A stable principal must never be
 *     re-routed to a sibling by the heuristic;
 *   - use the heuristic only for legacy rows without a principal id or lookup.
 */
export function pickTargetWithPrincipal(
  sessions: WakeSessionView[],
  workspaceId: string,
  memberId: string,
  principalId: string | undefined,
  principalPtyIdOf: ((principalId: string) => string | undefined) | undefined,
): WakeSessionView | null {
  if (!principalId || !principalPtyIdOf) return pickTarget(sessions, workspaceId, memberId);

  const ptyId = principalPtyIdOf(principalId);
  if (!ptyId) return null;

  const session = sessions.find((candidate) => candidate.id === ptyId && candidate.deferred !== true);
  if (!session || session.workspaceId !== workspaceId) return null;
  if (session.lastDetectedAgent === 'claude' && session.attached === true) return null;

  // A registry coordinate can outlive the agent: the agent exits while the
  // pane keeps its shell. Never auto-submit there, and never redirect a nudge
  // addressed to this stable principal into a sibling pane.
  return session.lastDetectedAgent ? session : null;
}

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
  // Single-pane fallback — but ONLY if that pane actually hosts an agent to
  // receive the nudge. A bare shell with no detected agent (lastDetectedAgent
  // undefined/empty) is NOT a wake target: live -dev dogfood 2026-07-05 caught
  // the worker auto-submitting `wmux channel read ch-… --since N` into an
  // agent-less zsh — the member's real Claude pane was ATTACHED, so it deferred
  // to the renderer Stop-hook path and left the shell as the lone "eligible"
  // pane; the pasted hint (text + Enter) then ran as a shell command. If the
  // only eligible pane is such a shell, hand off to polling (null) — the same
  // philosophy as the budget-exhausted human handoff, never a guess.
  if (eligible.length === 1 && Boolean(eligible[0].lastDetectedAgent)) return eligible[0];
  return null;
}

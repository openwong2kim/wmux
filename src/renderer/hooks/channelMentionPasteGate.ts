// ─── Channel-mention paste gate — unknown-status grace window ────────────────
//
// RCA 2026-07-05 (idle-since-attach delivery block): the mention flush skips a
// pane whose agent is BUSY. Busy is read from `surfaceAgent[ptyId].status`,
// which AgentDetector only sets when a status PATTERN flows through the pty
// output (e.g. Claude's "bypass permissions on" idle-prompt fragment → 'waiting').
//
// An agent that has been idle since its pty attached never re-emits that pattern
// — it just sits emitting cursor-position queries — so its status stays
// `undefined`. The old gate treated `undefined` as busy FOREVER (fail-closed),
// relying on the agent's next Stop to flush the queued mention. But a
// continuously-idle agent never Stops, so the mention was stuck until an
// unrelated repaint (observed: splitting the pane) forced Claude to redraw the
// idle prompt, which finally emitted 'waiting'. Cross-workspace mentions to a
// background pane are exactly this case: the pane never gets focus, never
// repaints, never delivers.
//
// The fail-closed WAS load-bearing for one real window: right after attach a
// genuinely-running agent's first 'running' broadcast may not have landed yet,
// and pasting into a running agent corrupts its turn. That window is transient
// (a running agent produces output → ActivityMonitor 'active' → 'running' within
// ~1 output burst). So we keep fail-closed for a short GRACE period after the
// first unknown observation, then treat persistent-unknown as idle and deliver.
// A status that stays `undefined` past the grace means the agent produced no
// activity = quiet/idle, which is paste-safe.
//
// RCA 2026-07-05 (mid-turn paste race, Codex+Claude CRITICAL): grace ALONE is a
// leaky gate. A background agent that is genuinely thinking / emitting tokens
// SLOWLY can sit at status `undefined` past the grace — its output bursts stay
// under ActivityMonitor's 2000-byte/3s threshold, so no 'running' broadcast ever
// lands — and the grace-only gate then pastes MID-TURN and corrupts the turn.
// The naive fix ("any raw pty output = busy") reintroduces the c8b3bf9 bug: an
// idle agent still emits sparse output (cursor-position queries), so raw-output
// gating would hold an idle mention forever. So we require BOTH gates to clear:
//   - GRACE (4s) since first-unknown, AND
//   - OUTPUT-QUIET (2s) since the pty's last observed output.
// A thinking agent repaints its status line on a ~1s timer, so it never crosses
// the 2s quiet bar → held. A truly idle agent emits only rare queries, clears
// the quiet bar → delivered. The last-output timestamps are fed by a global
// pty-data listener (see useChannelsEventSubscription) and pruned per-pty via
// prunePasteGateState so the maps can't leak dead ptys.
//
// Known statuses: 'running'/'awaiting_input' busy, everything else (including
// 'waiting'/'complete'/'idle') paste-safe immediately — with two more 2026-07-05
// hardening passes layered on top:
//   - STALE-RUNNING: a 'running' agent that hangs mid-turn keeps status 'running'
//     forever while emitting nothing, so the gate would hold the mention forever
//     (silent never-deliver). We anchor the observation start on the first
//     'running' sight and, once the pty has been output-quiet for RUNNING_STALE_MS
//     (3 min), treat 'running' as stale and deliver (one console.debug for
//     visibility). A genuinely-thinking agent repaints its ~1s status line, which
//     refreshes the anchor via notePtyOutput, so it never trips the bar.
//   - FLAP GUARD: a known-status tick used to clear firstUnknownAt immediately, so
//     a 1-tick blip (a lone 'running'/'waiting' sample) mid-hold re-armed the
//     unknown clock and pushed the MAX_UNKNOWN_HOLD ceiling far into the future.
//     We now only clear firstUnknownAt once the known status has held for
//     KNOWN_STABLE_MS (stableKnownSince tracks the streak start); an unknown tick
//     drops that streak. A real resolution clears within 10s; a blip never does.
//   - CPR NOISE: an idle TUI still answers DSR/CPR cursor queries. notePtyOutput
//     takes the raw chunk and ignores DSR/CPR-only chunks so cursor chatter
//     neither refreshes the stale anchor nor pins the quiet gate.

/** Paste is unsafe while the agent is actively producing ('running') or blocked
 *  on a confirmation prompt ('awaiting_input') — those defer to the agent's
 *  Stop. 'waiting' (turn ended, ready for input), 'complete', 'idle' are all
 *  paste-safe (deliver immediately). */
export const PASTE_UNSAFE_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'awaiting_input',
]);

/**
 * Agent slugs whose TUI queues mid-turn input safely (message-latency epic,
 * 2026-07-10). Current Claude Code buffers text typed while a turn is running
 * and consumes it at the next tool-call boundary WITHOUT corrupting the turn —
 * proven end-to-end (scripts/midturn-inject-probe.mjs, both raw and
 * bracketed-paste production paths). For these agents a channel mention is
 * delivered IMMEDIATELY instead of waiting out the whole turn, which was the
 * dominant "messages arrive late" latency (a long turn = minutes of hold).
 *
 * Conservative by construction: only 'running' becomes safe, and ONLY for
 * listed agents. 'awaiting_input' stays a hard hold for everyone (pasting would
 * answer a live confirmation prompt / menu), and unlisted agents (codex,
 * opencode, unknown) keep the classic Stop-wait until their mid-turn behavior
 * is separately proven.
 */
export const MIDTURN_QUEUE_AGENT_SLUGS: ReadonlySet<string> = new Set(['claude']);

/** Default grace window before a persistently-unknown status is treated as idle.
 *  Comfortably longer than the ~1-2s post-attach window in which a running
 *  agent's first 'running' broadcast lands, short enough that a real idle-pane
 *  mention delivers within a few poll ticks instead of never. */
export const UNKNOWN_STATUS_GRACE_MS = 4000;

/** Second gate for a persistently-unknown pty: how long the pty must have been
 *  QUIET (no observed output) before an unknown-status mention delivers. A
 *  thinking agent repaints its status line on a ~1s cadence and never crosses
 *  this bar; a truly idle agent emits only sparse cursor queries and does.
 *  Conservative default — dogfood-tuning target (RCA 2026-07-05, Codex+Claude
 *  mid-turn-paste race). */
export const OUTPUT_QUIET_MS = 2000;

/** Hard ceiling on holding a persistently-unknown mention. After this long at
 *  unknown status the mention delivers even if output is still recent — bounds
 *  the output-quiet gate so a perpetual-unknown, never-quiet pane (an idle
 *  prompt with a live clock/ticker, or a TUI AgentDetector can't classify)
 *  can't pin a mention forever. Generous so a normal thinking agent (which
 *  resolves to a known status or goes quiet first) never hits it; past it the
 *  failure mode is "delivered late", not "silently never delivered" (RCA
 *  2026-07-05, 2-model never-deliver consensus: Codex CRITICAL + Claude). */
export const MAX_UNKNOWN_HOLD_MS = 45000;

/** How long a 'running' pty may stay OUTPUT-QUIET before the status is treated as
 *  stale (the agent hung mid-turn) and the mention delivered anyway. Anchored on
 *  the first 'running' observation (no output recorded yet) and refreshed by every
 *  non-CPR pty chunk via `notePtyOutput`. A genuinely-thinking agent repaints its
 *  ~1s status line so its anchor never ages past this bar; only a truly hung agent
 *  (no real output for 3 min) crosses it. Past it the failure mode is "delivered
 *  late", not "silently never delivered" (RCA 2026-07-05 stale-running). */
export const RUNNING_STALE_MS = 180_000;

/** How long a KNOWN status must persist before it clears the unknown-hold clock
 *  (`firstUnknownAt`). A 1-tick status blip (e.g. a lone 'running' sample midway
 *  through a long unknown hold) must NOT reset the MAX_UNKNOWN_HOLD ceiling, or a
 *  flapping detector could pin a mention far past the ceiling. Only once a known
 *  status has held this long do we treat it as a real resolution and reset (RCA
 *  2026-07-05 flap fix). */
export const KNOWN_STABLE_MS = 10_000;

/** Per-pty grace/quiet/flap trackers. Effect-scoped, mutated in place so the
 *  clocks survive across poll ticks.
 *   - firstUnknownAt: first-unknown-observation timestamp (grace clock),
 *     mutated by `isMentionPasteBusy`.
 *   - lastOutputAt: last observed pty output timestamp (quiet clock + running
 *     staleness anchor), stamped by `notePtyOutput` from a global pty-data
 *     listener and seeded once by `isMentionPasteBusy` on the first 'running'
 *     sight.
 *   - stableKnownSince: start of the current uninterrupted known-status streak
 *     (flap guard). A known tick only clears firstUnknownAt once this streak has
 *     lasted >= KNOWN_STABLE_MS; an unknown tick drops it.
 *  All three are pruned by `prunePasteGateState` so dead ptys can't leak. */
export interface PasteGateState {
  firstUnknownAt: Map<string, number>;
  lastOutputAt: Map<string, number>;
  stableKnownSince: Map<string, number>;
}

export function createPasteGateState(): PasteGateState {
  return {
    firstUnknownAt: new Map(),
    lastOutputAt: new Map(),
    stableKnownSince: new Map(),
  };
}

/** DSR/CPR cursor-query and answer sequences, e.g. ESC[6n (device-status query)
 *  or ESC[24;80R (cursor-position report). An idle TUI answers these on a timer
 *  without doing any real work, so a chunk that reduces to ONLY these must not
 *  count as activity. */
// eslint-disable-next-line no-control-regex -- ESC (0x1b) is required to match DSR/CPR sequences
const CPR_SEQ_RE = /\x1b\[[0-9;?]*[Rn]/g;

/** Record that `ptyId` just produced output at `now`. Fed by the renderer's
 *  global pty-data listener; a no-op for an empty id (app-level frames).
 *
 *  @param data optional raw chunk. When provided, DSR/CPR cursor sequences are
 *  STRIPPED and the stamp is skipped when nothing remains — an idle TUI
 *  answering cursor queries is not genuine activity and must neither refresh a
 *  running agent's stale anchor nor pin the unknown-status quiet gate. Judging
 *  the remainder (not a whole-chunk match) keeps CPR echo mixed with stray
 *  bytes from counting, and treats an EMPTY chunk as no activity (adversarial
 *  review F11b). Omitting `data` preserves the original always-stamp behavior. */
export function notePtyOutput(state: PasteGateState, ptyId: string, now: number, data?: string): void {
  if (!ptyId) return;
  if (data != null) {
    const rest = data.replace(CPR_SEQ_RE, '');
    if (rest.length === 0) return;
  }
  state.lastOutputAt.set(ptyId, now);
}

/** Drop grace/quiet/flap entries for ptys no longer in `livePtyIds` (leaf-pane
 *  sweep). Bounds all three maps to live panes — without this a churned pty's
 *  timestamps live forever (3-model consensus map-leak fix). */
export function prunePasteGateState(state: PasteGateState, livePtyIds: Set<string>): void {
  for (const id of state.firstUnknownAt.keys()) {
    if (!livePtyIds.has(id)) state.firstUnknownAt.delete(id);
  }
  for (const id of state.lastOutputAt.keys()) {
    if (!livePtyIds.has(id)) state.lastOutputAt.delete(id);
  }
  for (const id of state.stableKnownSince.keys()) {
    if (!livePtyIds.has(id)) state.stableKnownSince.delete(id);
  }
}

/**
 * Should a queued mention be HELD (agent busy) rather than pasted into `ptyId`?
 *
 * @param status        live `surfaceAgent[ptyId]?.status` (undefined = unknown)
 * @param ptyId         target pty
 * @param now           current epoch ms (Date.now())
 * @param state         mutable grace/quiet/flap tracker (see PasteGateState)
 * @param graceMs       grace window for unknown status
 * @param quietMs       output-quiet window an unknown pty must clear to deliver
 * @param maxHoldMs     hard ceiling on holding a persistently-unknown mention
 * @param staleMs       output-quiet span after which a 'running' pty is treated
 *                      as stale/hung and delivered (RUNNING_STALE_MS)
 * @param knownStableMs how long a known status must hold before it clears the
 *                      unknown clock (flap guard, KNOWN_STABLE_MS)
 *
 * Side effects on `state`: records/clears the pty's first-unknown timestamp;
 * tracks the known-status streak (`stableKnownSince`); and seeds `lastOutputAt`
 * once to anchor the running-staleness clock on the first 'running' sight (that
 * clock is otherwise owned by `notePtyOutput` / `prunePasteGateState`).
 */
export function isMentionPasteBusy(
  status: string | undefined,
  ptyId: string,
  now: number,
  state: PasteGateState,
  graceMs: number = UNKNOWN_STATUS_GRACE_MS,
  quietMs: number = OUTPUT_QUIET_MS,
  maxHoldMs: number = MAX_UNKNOWN_HOLD_MS,
  staleMs: number = RUNNING_STALE_MS,
  knownStableMs: number = KNOWN_STABLE_MS,
  /** Agent slug in this pane. When it queues mid-turn input safely
   *  (MIDTURN_QUEUE_AGENT_SLUGS), a 'running' status is NOT busy — the mention
   *  is pasted immediately and the TUI queues it to the next tool boundary.
   *  Only 'running' is affected; 'awaiting_input' still holds for everyone. */
  agentSlug: string | undefined = undefined,
): boolean {
  if (status != null) {
    // A known-status tick. Flap guard: do NOT clear the unknown clock on a
    // transient blip — a lone known sample mid-hold would otherwise re-arm the
    // unknown window and push the MAX_UNKNOWN_HOLD ceiling far out. Track the
    // start of the uninterrupted known streak and only clear firstUnknownAt once
    // the status has held for `knownStableMs`.
    let stableSince = state.stableKnownSince.get(ptyId);
    if (stableSince == null) {
      stableSince = now;
      state.stableKnownSince.set(ptyId, now);
    }
    if (now - stableSince >= knownStableMs) {
      state.firstUnknownAt.delete(ptyId);
    }

    if (!PASTE_UNSAFE_STATUSES.has(status)) return false;

    // Known UNSAFE. 'awaiting_input' is a genuine block on a human confirmation
    // prompt (may legitimately sit quiet, and pasting would answer the prompt) —
    // always hold. For 'running', guard against a hung agent stuck at 'running'
    // while emitting nothing (silent never-deliver): anchor the observation start
    // on first sight (no output recorded yet), then deliver once the pty has been
    // output-quiet for `staleMs`. A real thinking agent repaints its ~1s status
    // line, so notePtyOutput keeps the anchor fresh and it never crosses the bar.
    if (status === 'running') {
      // Mid-turn-safe agents (Claude): a running turn is NOT a hold — paste now,
      // the TUI queues it to the next tool boundary (proven, message-latency
      // epic). This removes the turn-length delay that dominated "late mentions".
      if (agentSlug != null && MIDTURN_QUEUE_AGENT_SLUGS.has(agentSlug)) return false;
      const lastOut = state.lastOutputAt.get(ptyId);
      if (lastOut == null) {
        state.lastOutputAt.set(ptyId, now);
      } else if (now - lastOut >= staleMs) {
        console.debug(
          `[paste-gate] pty ${ptyId} 'running' output-quiet ${now - lastOut}ms ` +
            `(>= ${staleMs}ms) — treating as stale/hung, delivering mention`,
        );
        return false;
      }
    }
    return true;
  }
  // Unknown tick: the known streak (if any) is broken — drop it so a later known
  // tick re-measures stability from scratch. Then hold during the grace window.
  state.stableKnownSince.delete(ptyId);
  const first = state.firstUnknownAt.get(ptyId);
  if (first == null) {
    state.firstUnknownAt.set(ptyId, now);
    return true;
  }
  if (now - first < graceMs) return true;
  // Hard ceiling: never hold an unknown-status mention forever. A pane stuck at
  // unknown that keeps emitting sub-quiet output (idle prompt with a live
  // clock/ticker) would otherwise pin the output-quiet gate below busy every
  // tick — a silent never-deliver. Past the ceiling we deliver regardless; the
  // failure mode flips from "mention lost, no signal" to "mention delivered
  // late" (3-model review 2026-07-05: Codex CRITICAL + Claude fallback).
  if (now - first >= maxHoldMs) return false;
  // Grace elapsed, under the ceiling. Second gate: a slow/thinking agent whose
  // bursts stay under ActivityMonitor's threshold sits at unknown past the grace
  // but keeps emitting — hold it while its last output is still recent (mid-turn
  // race). A truly idle pty's last output is old (only rare cursor queries its
  // live CPR responder answers), so it clears the quiet bar and delivers.
  const lastOut = state.lastOutputAt.get(ptyId);
  if (lastOut != null && now - lastOut < quietMs) return true;
  return false;
}

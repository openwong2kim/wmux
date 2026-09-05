// CompletionAlarm — the verdict machine that decides when a pane's lead turn
// has ACTUALLY ended, gating the "work finished" alarm.
//
// Problem it fixes: raw stop-shaped signals (the vendor Stop hook, the
// detector's `waiting` heuristic, SubagentStop) fire while background
// shells/builds are still running or while the turn is merely repainting.
// Treating them as "done" tells the user work is finished when it isn't.
//
// Pipeline every cue passes through:
//
//   hook / detector signal
//     → normalize (working | attention | stop | session | answered)
//     → turn gate (did the agent work this turn? already announced?)
//     → provisional window (~1.5s, discarded when a rebuttal cue arrives)
//     → confirmed alarm | status only
//
// Rebuttal cues for a pending completion window: `working` (any tool
// activity, byte activity, prompt arrival) and `attention`. `answered`
// cancels a pending ATTENTION window. The HookSignalRouter dedup ledger is
// INDEPENDENT of this machine: with the wiring from the eng review, ledger
// writes for gated cue classes happen at CONFIRMATION, never at arrival, so
// a held-then-rebutted candidate leaves no ghost 'emit' behind and a
// confirmed broadcast can never carry a stale 'dedup'.
//
// State dots / fleet badges stay loose on purpose — only the alarm is
// strict. Callers keep their metadata broadcasts outside this gate.

import type { AgentSignal } from './signal-types';

/** Default provisional window. Long enough for a follow-up tool call or a
 *  detector repaint to arrive and rebut the candidate; short enough that the
 *  completion alarm still feels immediate. */
export const DEFAULT_ALARM_WINDOW_MS = 1_500;

// Shared resume default — an expression body, because a block body `() => {}`
// trips @typescript-eslint/no-empty-function on the observe() signature.
const noop = (): void => undefined;

/**
 * A normalized cue. Everything the alarm needs to make a verdict, with all
 * vendor/detector specifics already stripped by the normalize functions.
 *
 * - `working`    — evidence the turn is alive (tool activity, byte activity,
 *                  prompt arrival). Rebuts any pending window.
 * - `attention`  — the agent is blocked waiting for a human (approval
 *                  prompt, question). Gets its own symmetric hold.
 * - `stop`       — a turn-end candidate. `child` marks subagent stops (never
 *                  a lead-turn end). `leftoverWork` is the count of
 *                  background tasks still running at stop time, mined from
 *                  the transcript tail by the bridge (>0 → the turn has NOT
 *                  actually ended; treat as working).
 * - `session`    — session boundary. Resets the turn gate.
 * - `answered`   — a pending question/approval was resolved. Cancels a
 *                  pending attention window.
 */
export type AlarmCue =
  | { class: 'working' }
  | { class: 'attention' }
  | { class: 'stop'; child: boolean; leftoverWork: number }
  | { class: 'session' }
  | { class: 'answered' };

/** Verdict for the observed cue. `hold` = a provisional window is open; the
 *  caller must withhold its broadcast until `onConfirmed` fires (the resume
 *  closure carries it). `drop` = no alarm; the caller proceeds with its
 *  status-only handling. */
export type AlarmOutcome = 'hold' | 'drop';

/** Which window class opened. `done` is the completion alarm, `attention`
 *  the needs-a-human alarm. */
export type AlarmClass = 'done' | 'attention';

interface PaneState {
  /** Working evidence seen since the last confirmed completion / session
   *  start. The first gate a stop candidate must pass. */
  seenWorking: boolean;
  /** A completion/attention was already announced for this turn. Blocks
   *  re-announcing detector repaints until the next working cue clears it. */
  announced: boolean;
  /** The open provisional window, if any. */
  pending: PendingWindow | null;
}

interface PendingWindow {
  cls: AlarmClass;
  /** Cancels the scheduled confirmation timer. */
  cancel: () => void;
  /** Caller-supplied deferred side effects, handed back at confirmation. */
  resume: () => void;
}

/**
 * One instance per process (daemon: HookIngest ctor; local fallback:
 * main/index.ts). No singleton — the wiring layer holds the reference.
 *
 * Time and scheduling are injected: `now` for deterministic tests, `schedule`
 * so the daemon can hand out unref'd timers (an open window must never keep
 * the process alive).
 */
export class CompletionAlarm {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly onConfirmed: (pane: string, slug: string, cls: AlarmClass, resume: () => void) => void;
  private readonly log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
  private readonly states = new Map<string, PaneState>();

  constructor(deps: {
    windowMs?: number;
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => () => void;
    onConfirmed: (pane: string, slug: string, cls: AlarmClass, resume: () => void) => void;
    log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
  }) {
    this.windowMs = deps.windowMs ?? DEFAULT_ALARM_WINDOW_MS;
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
    this.onConfirmed = deps.onConfirmed;
    this.log = deps.log;
  }

  /**
   * Feed one normalized cue for a (slug, pane) pair. Returns the verdict;
   * `resume` is only read when the verdict is `hold`.
   *
   * Truth table (pending = the currently open window, if any):
   *
   *   cue              | pending        | result
   *   -----------------+----------------+-------------------------------
   *   working          | any            | cancel (rebut), announced=false,
   *   working          |                | seenWorking=true → drop
   *   answered         | attention      | cancel → drop
   *   answered         | other/none     | no-op → drop
   *   attention        | done/attention | cancel, open attention window → hold
   *   stop.child       | any            | NO-OP, never a toast → drop
   *   stop.leftover>0  | any            | cancel, treated as working → drop
   *   stop clean       | attention      | cancel, then evaluate the gate
   *   stop clean       | done           | cancel, replace with new window (R2)
   *   stop clean       | —              | gate: !seenWorking || announced →
   *   stop clean       |                | drop; else open window → hold
   *   session          | any            | cancel, reset flags → drop
   *
   * Window expiry (no rebuttal) fires `onConfirmed` with the stashed resume
   * closure, sets announced=true and seenWorking=false.
   */
  observe(pane: string, slug: string, cue: AlarmCue, resume: () => void = noop): AlarmOutcome {
    const key = `${slug}:${pane}`;
    const state = this.stateFor(key);

    switch (cue.class) {
      case 'working':
        this.cancelPending(state, key, 'rebutted by working');
        state.announced = false;
        state.seenWorking = true;
        return 'drop';

      case 'answered':
        if (state.pending?.cls === 'attention') {
          this.cancelPending(state, key, 'answered');
        }
        return 'drop';

      case 'attention':
        this.cancelPending(state, key, 'superseded by attention');
        return this.openWindow(state, key, pane, slug, 'attention', resume);

      case 'stop': {
        if (cue.child) {
          // A subagent finishing is never a lead-turn end — and it is not
          // evidence ABOUT the lead turn either, so it must leave a window the
          // lead turn's own stop opened completely alone. Status only, no
          // state touched.
          //
          // This used to cancel first and ask afterwards, which lost real
          // alarms: the cancel dropped the completion outright — nothing
          // re-fires, while `seenWorking`/`announced` still say one is owed.
          //
          // The rule that settles it is the asymmetry, NOT an ordering
          // guarantee. Do not restore the cancel on the argument that a child
          // stop inside the window proves the turn resumed: a backgrounded
          // Task dispatch lets the lead turn end while a subagent is still
          // running, so a genuinely-later child stop is possible, and hooks
          // are separate processes that can deliver out of order anyway. In
          // BOTH readings the cost is bounded — at worst one early toast, and
          // a resumed turn announces itself again through its own working
          // cues — whereas cancelling costs the alarm entirely, with nothing
          // left to fire. Missed beats early is the trade this module refuses
          // to make.
          return 'drop';
        }
        this.cancelPending(state, key, 'superseded by stop');
        if (cue.leftoverWork > 0) {
          // The turn has not actually ended: background work is running.
          // Treat as working evidence so the eventual real stop (after the
          // task completes and the agent resumes) passes the gate.
          state.seenWorking = true;
          return 'drop';
        }
        if (!state.seenWorking || state.announced) {
          // Never saw the agent work (idle chrome repaint, tracking enabled
          // on an idle screen) or this turn was already announced.
          return 'drop';
        }
        return this.openWindow(state, key, pane, slug, 'done', resume);
      }

      case 'session':
        this.cancelPending(state, key, 'session boundary');
        state.seenWorking = false;
        state.announced = false;
        return 'drop';
    }
  }

  /** Drop all state for a disposed pane. Wired to the same cleanup paths as
   *  HookSignalRouter.dropPty so a reused id starts from a clean gate. */
  dropPty(pane: string): void {
    if (!pane) return;
    for (const key of [...this.states.keys()]) {
      if (!key.endsWith(`:${pane}`)) continue;
      const state = this.states.get(key);
      state?.pending?.cancel();
      this.states.delete(key);
    }
  }

  /** Cancel every window. Called on process shutdown paths. */
  dispose(): void {
    for (const state of this.states.values()) {
      state.pending?.cancel();
    }
    this.states.clear();
  }

  private openWindow(
    state: PaneState,
    key: string,
    pane: string,
    slug: string,
    cls: AlarmClass,
    resume: () => void,
  ): AlarmOutcome {
    const t0 = this.now();
    const cancel = this.schedule(() => {
      const current = this.states.get(key);
      // Only confirm if THIS window is still the open one — a replaced or
      // cancelled window's timer must be inert even if the cancel raced.
      if (current !== state || current.pending === null) return;
      current.pending = null;
      current.announced = true;
      current.seenWorking = false;
      this.log?.('debug', `[alarm] ${cls} confirmed for ${key} after ${this.now() - t0}ms`);
      // Guarded because this runs from a TIMER, not from the caller's stack.
      // The resume closures fan out through eventBus.emit (synchronous
      // listeners), metadata broadcasts and toast delivery; a throw from any
      // of them here is an uncaughtException, which takes the whole process
      // with it rather than failing one notification. The daemon path wraps
      // its own broadcast, the local fallback does not — guarding at the one
      // call site covers both. State is already committed above, so a
      // throwing consumer cannot leave the gate mid-transition either.
      try {
        this.onConfirmed(pane, slug, cls, resume);
      } catch (err) {
        // console.warn is the FALLBACK, not a nicety: neither wiring site
        // passes `log` today, so `this.log?.()` alone would swallow the throw
        // whole — and by here `announced` is already committed, so nothing
        // re-fires. That trades a loud crash for a silent lost alarm, which is
        // the worse half of this module's own rule. The stack, not just the
        // message: the daemon's resume runs ordered side effects (ledger
        // write, then phone-card expiry, then broadcast), so WHERE it threw
        // decides which of them landed.
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        const line = `[alarm] ${cls} confirmation for ${key} threw: ${detail}`;
        if (this.log) this.log('warn', line);
        else console.warn(line);
      }
    }, this.windowMs);
    state.pending = { cls, cancel, resume };
    return 'hold';
  }

  private cancelPending(state: PaneState, key: string, reason: string): void {
    if (!state.pending) return;
    this.log?.('debug', `[alarm] pending window for ${key} cancelled (${reason})`);
    state.pending.cancel();
    state.pending = null;
  }

  private stateFor(key: string): PaneState {
    let state = this.states.get(key);
    if (!state) {
      // Empty start = seenWorking:false, so an idle screen the tracker
      // happens to enable on can never announce a completion.
      state = { seenWorking: false, announced: false, pending: null };
      this.states.set(key, state);
    }
    return state;
  }
}

/**
 * Normalize a hook-bridge signal into a cue. Total: every AgentSignalKind
 * maps to something. `agent.user_prompt_submit` is WORKING evidence — the turn
 * has just begun — and now that both install paths register UserPromptSubmit
 * it is the earliest and most precise such cue a governed pane produces. Byte
 * activity (session:active / PTY writes) remains the backstop for panes with
 * no bridge.
 */
export function normalizeHookCue(signal: AgentSignal): AlarmCue {
  switch (signal.kind) {
    case 'agent.activity':
    case 'agent.tool_started':
    case 'agent.awaiting_permission':
    case 'agent.user_prompt_submit':
      return { class: 'working' };
    case 'agent.awaiting_input':
      return { class: 'attention' };
    case 'agent.input_answered':
    case 'agent.permission_answered':
      return { class: 'answered' };
    case 'agent.session_start':
      return { class: 'session' };
    case 'agent.subagent_stop':
      return { class: 'stop', child: true, leftoverWork: 0 };
    case 'agent.stop': {
      const raw = signal.payload?.['wmux_leftover_work'];
      const leftoverWork = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.floor(raw)
        : 0;
      return { class: 'stop', child: false, leftoverWork };
    }
  }
}

/**
 * Normalize a raw AgentDetector status string into a cue. Consumes the RAW
 * status — NOT agentStatusToSignalKind, whose waiting→agent.stop collapse is
 * load-bearing for the dedup ledger and stays untouched. Returns null for
 * statuses that carry no alarm semantics (idle chrome, unknown).
 */
export function normalizeDetectorCue(status: string): AlarmCue | null {
  switch (status) {
    case 'running':
      return { class: 'working' };
    case 'waiting':
    case 'complete':
      return { class: 'stop', child: false, leftoverWork: 0 };
    case 'awaiting_input':
      return { class: 'attention' };
    default:
      return null;
  }
}

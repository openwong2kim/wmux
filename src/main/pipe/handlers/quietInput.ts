// The Git page's hand-off delivery, main side: wait for the person to stop
// typing in the target pane, and keep checking that the agent the person
// chose is still the one there. A pane whose state cannot be read at all (a
// local pty, no daemon) is not handed to here: the caller refuses it, because
// its agent cannot be verified.

export const QUIET_INPUT_MS = 10_000;
const POLL_MS = 500;
/** The longest wait for quiet: the quiet window plus room for someone still
 *  typing when the hand-off starts to finish (about 10 s of it). */
export const QUIET_INPUT_WAIT_MS = 20_000;
/**
 * What the rest of a new-task delivery may take after the wait: the pane
 * lock, the task-store read, the gates, a fresh-context step and the paste
 * (about 21 s worst case, see NEW_TASK_SEND_MAIN_TIMEOUT_MS). The wait gets
 * what is left of the deadline after this.
 */
export const DELIVERY_RESERVE_MS = 21_000;

export interface PaneInputState {
  hasDraft?: boolean;
  keyInputIdleMs?: number;
  keyInputQuiet?: boolean;
  /** The daemon's key-input counter: one per write that can act on the screen. */
  keyInputRevision?: number;
}

/** The daemon's view of a pane's agent, as getAgentState reports it. */
export interface PaneAgentState extends PaneInputState {
  agentName: string | null;
  agentStatus: string;
  agentVerified?: boolean;
  incarnationId: string;
}

/** The agent a hand-off was aimed at, as first seen in the pane. */
export interface AgentBaseline {
  agentName: string;
  incarnationId: string;
  agentVerified: boolean;
}

/** Quiet now: no draft, and keys idle for the window (an older daemon without
 *  the idle time answers with its short quiet flag). Pure. */
export function isPaneQuiet(s: PaneInputState, quietMs = QUIET_INPUT_MS): boolean {
  if (s.hasDraft === true) return false;
  if (typeof s.keyInputIdleMs === 'number') return s.keyInputIdleMs >= quietMs;
  return s.keyInputQuiet !== false;
}

/** The same agent is still in the pane: same name and session incarnation,
 *  not back at a shell, and not a process-backed agent whose process went
 *  away. Pure. */
export function agentIdentityHolds(base: AgentBaseline, s: PaneAgentState): boolean {
  if (s.agentName !== base.agentName) return false;
  if (s.incarnationId !== base.incarnationId) return false;
  if (s.agentStatus === 'idle') return false;
  return !(base.agentVerified && s.agentVerified !== true);
}

/** Someone pressed a key besides our own writes: the daemon's key counter
 *  moved past `expected`, the count our writes account for. Our paste is one
 *  write, so it moves the counter by one however soon a key follows it; a time
 *  window cannot tell the two apart within the agent's Enter delay. A counter
 *  still below `expected` is our write not yet counted (it rides the data
 *  pipe, the read the control pipe). Unknown counts count as typed. Pure. */
export function typedPastOwnInput(s: PaneInputState, expected: number | undefined): boolean {
  if (typeof s.keyInputRevision !== 'number' || expected === undefined) return true;
  return s.keyInputRevision > expected;
}

/** How long the quiet wait may take before `deadlineAt`, leaving the rest of
 *  the delivery its reserve; never more than QUIET_INPUT_WAIT_MS. Pure. */
export function quietWaitBudget(deadlineAt: number, now: number): number {
  return Math.max(0, Math.min(QUIET_INPUT_WAIT_MS, deadlineAt - now - DELIVERY_RESERVE_MS));
}

export type QuietAgentResult =
  | { ok: true; baseline: AgentBaseline; /** The key count at the quiet read. */ keyInputRevision?: number }
  | { ok: false; reason: 'user_typing' | 'agent_changed'; detail: string };

/**
 * Wait until the pane is quiet with the expected agent in it. A read that
 * fails or times out is not quiet: it is retried until the wait runs out,
 * then refused as `user_typing`. A different agent, or none, is refused at
 * once as `agent_changed`.
 */
export async function waitForQuietAgent(
  read: () => Promise<PaneAgentState | null>,
  opts: {
    expectAgent?: string;
    quietMs?: number;
    waitMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<QuietAgentResult> {
  const quietMs = opts.quietMs ?? QUIET_INPUT_MS;
  const waitMs = opts.waitMs ?? QUIET_INPUT_WAIT_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  let baseline: AgentBaseline | null = null;
  for (;;) {
    const s = await read().catch(() => null);
    if (s) {
      if (!s.agentName || s.agentStatus === 'idle' || (opts.expectAgent && s.agentName !== opts.expectAgent)) {
        return { ok: false, reason: 'agent_changed', detail: 'delivery: the agent the hand-off was aimed at is no longer in the pane' };
      }
      baseline ??= { agentName: s.agentName, incarnationId: s.incarnationId, agentVerified: s.agentVerified === true };
      if (!agentIdentityHolds(baseline, s)) {
        return { ok: false, reason: 'agent_changed', detail: 'delivery: the agent in the pane changed while waiting' };
      }
      if (isPaneQuiet(s, quietMs)) {
        return { ok: true, baseline, ...(typeof s.keyInputRevision === 'number' ? { keyInputRevision: s.keyInputRevision } : {}) };
      }
    }
    if (now() + pollMs > deadline) {
      return { ok: false, reason: 'user_typing', detail: 'delivery: someone is typing in the target pane (or its state could not be read)' };
    }
    await sleep(pollMs);
  }
}

// Waiting for a person to stop typing in a pane before a delivery pastes into
// it (the Git page's hand-off): no draft in the composer and no key input for
// a quiet window, within a bounded wait. A pane whose state cannot be read
// (no daemon, a local pty) is not held here; the approval gate still runs.

export const QUIET_INPUT_MS = 10_000;
/** Bounded so the whole delivery stays inside a new task send's main timeout. */
export const QUIET_INPUT_WAIT_MS = 14_000;
const POLL_MS = 500;

export interface PaneInputState {
  hasDraft?: boolean;
  keyInputIdleMs?: number;
  keyInputQuiet?: boolean;
}

/** Quiet now: no draft, and keys idle for the window (an older daemon without
 *  the idle time answers with its short quiet flag). Pure. */
export function isPaneQuiet(s: PaneInputState, quietMs = QUIET_INPUT_MS): boolean {
  if (s.hasDraft === true) return false;
  if (typeof s.keyInputIdleMs === 'number') return s.keyInputIdleMs >= quietMs;
  return s.keyInputQuiet !== false;
}

/** True once the pane is quiet (or its state is unreadable); false when the
 *  person was still typing, or left a draft, when the wait ran out. */
export async function waitForQuietInput(
  read: () => Promise<PaneInputState | null>,
  opts: { quietMs?: number; waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const quietMs = opts.quietMs ?? QUIET_INPUT_MS;
  const waitMs = opts.waitMs ?? QUIET_INPUT_WAIT_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  for (;;) {
    const s = await read().catch(() => null);
    if (!s) return true;
    if (isPaneQuiet(s, quietMs)) return true;
    if (now() + pollMs > deadline) return false;
    await sleep(pollMs);
  }
}

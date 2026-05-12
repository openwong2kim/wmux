/**
 * Per-PTY suppression for the ActivityMonitor "Task may have finished"
 * fallback notification.
 *
 * The fallback fires when output has been quiet for IDLE_DELAY_MS (5s) after
 * a sustained burst. That heuristic produces false positives in two
 * everyday cases:
 *
 *   1. PTY resize: switching to a workspace fits xterm, sends pty:resize,
 *      and TUI agents (Claude, Codex) respond with a full-screen redraw.
 *      The redraw is several KB → ActivityMonitor enters 'active'. If the
 *      user leaves the workspace within 5s, the idle timer fires later and
 *      a notification appears for a workspace the user just visited
 *      without typing anything.
 *
 *   2. User typing: keystrokes echo back through the PTY (the shell or TUI
 *      writes the typed character to the screen). Long input, paste, or
 *      sustained typing crosses the active threshold; pausing to think
 *      then fires the idle notification while the user is still composing.
 *
 * Both PTYBridge (local mode) and DaemonNotificationRouter (daemon mode)
 * consult `recentlySuppressed(ptyId)` before emitting the activity
 * fallback, and skip when a recent resize / user write happened.
 *
 * AgentDetector emissions are NOT gated by this — they are precise signals
 * tied to specific prompt patterns, not throughput heuristics.
 */

// Window length: bigger than ActivityMonitor's IDLE_DELAY_MS (5s) so any
// idle timer that started during the suppression window still observes the
// suppression when it fires. 30s gives ample headroom for slow typists
// and large redraws without masking genuine long-running agent output.
const SUPPRESSION_WINDOW_MS = 30_000;

const lastResizeAt = new Map<string, number>();
const lastUserWriteAt = new Map<string, number>();

export function markResize(ptyId: string): void {
  lastResizeAt.set(ptyId, Date.now());
}

export function markUserWrite(ptyId: string): void {
  lastUserWriteAt.set(ptyId, Date.now());
}

export function recentlySuppressed(ptyId: string, now: number = Date.now()): boolean {
  const r = lastResizeAt.get(ptyId) ?? 0;
  const w = lastUserWriteAt.get(ptyId) ?? 0;
  return (now - r < SUPPRESSION_WINDOW_MS) || (now - w < SUPPRESSION_WINDOW_MS);
}

export function clearPty(ptyId: string): void {
  lastResizeAt.delete(ptyId);
  lastUserWriteAt.delete(ptyId);
}

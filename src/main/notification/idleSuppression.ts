/**
 * Per-PTY resize bookkeeping for the AgentDetector emission-reset guard.
 *
 * This module used to carry a second, much wider guard: a 30s window that
 * suppressed the ActivityMonitor "Task may have finished" fallback
 * NOTIFICATION after a resize redraw or a burst of typing. That toast was
 * removed (see PTYBridge.onActiveToIdle / DaemonNotificationRouter.onIdle —
 * the byte-silence heuristic cannot tell a finished turn from a mid-turn tool
 * call, so it raised false "Task may have finished" toasts on plain shells).
 *
 * The window outlived the toast and kept gating the handler's only remaining
 * job: clearing a stale `running` back to `idle`. That was strictly wrong.
 * `onActive` was never gated, so a resize redraw — several KB of repaint —
 * raised a false `running` and then the window blocked the very clear that
 * would have corrected it. Worse, ActivityMonitor consumes its state
 * transition BEFORE invoking callbacks, so a swallowed idle never retried:
 * a quiet pane stayed `running` forever, and for a plain shell (no
 * AgentDetector match, so no `session:agent` ever arrives) `session:idle` is
 * the only path that can clear the status at all. See issue #733.
 *
 * What remains is the narrow, still-justified guard: a resize is followed
 * within a couple of seconds by the TUI's full-screen redraw, and resetting
 * AgentDetector's emission dedup on that burst would let an UNCHANGED idle
 * footer re-match and re-fire a stale "Ready for input".
 */

const lastResizeAt = new Map<string, number>();

export function markResize(ptyId: string): void {
  lastResizeAt.set(ptyId, Date.now());
}

/**
 * Resize-recency check with a caller-chosen window. Used by the AgentDetector
 * emission-reset guard in PTYBridge, which delays a dedup RESET (bookkeeping),
 * never a user-visible status update — a genuinely new agent turn re-arms on
 * its next non-resize burst. The daemon process keeps its own timestamp
 * (DaemonPTYBridge.noteResize); this Map is main-process state only.
 */
export const RESIZE_REDRAW_GUARD_MS = 3_000;

export function recentlyResized(
  ptyId: string,
  windowMs: number = RESIZE_REDRAW_GUARD_MS,
  now: number = Date.now(),
): boolean {
  return now - (lastResizeAt.get(ptyId) ?? 0) < windowMs;
}

/**
 * Per-PTY settle bookkeeping — the same timestamp-window mechanism as the
 * resize guard above, for the same shape of problem.
 *
 * A settle is immediately followed by a redraw: Claude Code answers an
 * interrupt by printing "Interrupted · What should Claude do instead?" and
 * repainting its prompt, an exited agent's shell repaints its own. That burst
 * reaches ActivityMonitor.onActive, which broadcasts byte-'running' and undoes
 * the settle the user just earned. The window only gates that broadcast: the
 * alarm's working cue and the detector's dedup reset are untouched, and a
 * genuinely new turn lights the pane through its own turn-start hook, which
 * never passes through here.
 */
const lastSettleAt = new Map<string, number>();

export const SETTLE_REDRAW_GUARD_MS = 3_000;

export function markSettled(ptyId: string, now: number = Date.now()): void {
  if (!ptyId) return;
  lastSettleAt.set(ptyId, now);
}

export function recentlySettled(
  ptyId: string,
  windowMs: number = SETTLE_REDRAW_GUARD_MS,
  now: number = Date.now(),
): boolean {
  return now - (lastSettleAt.get(ptyId) ?? 0) < windowMs;
}

export function clearPty(ptyId: string): void {
  lastResizeAt.delete(ptyId);
  lastSettleAt.delete(ptyId);
}

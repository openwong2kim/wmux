/**
 * Terminal geometry floors shared by both sides of the pipe (#1255).
 *
 * The daemon floors every resize it accepts (the zle.so SIGBUS guard — see
 * DaemonSessionManager), but the floor matters on the renderer side too, and
 * for a different reason: fitting an xterm instance to a transient
 * small-but-nonzero container (mid-split, session restore before
 * react-resizable-panels settles) APPLIES those columns to the buffer, and
 * the reflow re-wraps the entire scrollback at that width. That damage is
 * not undone by a later correct fit — which is how a pane could render
 * ~1 column wide forever. Both sides importing one constant keeps the
 * contract single-sourced: the renderer never proposes what the daemon
 * would have to clamp.
 */
export const MIN_SAFE_COLS = 10;
export const MIN_SAFE_ROWS = 2;

/**
 * Whether a proposed fit is safe to APPLY to an xterm buffer (and to send).
 * A `undefined` dimension (container not measurable yet) is not safe — the
 * caller skips and lets the next resize tick try again after layout settles.
 */
export function isSafeGeometry(cols: number | undefined, rows: number | undefined): boolean {
  return cols !== undefined && rows !== undefined && cols >= MIN_SAFE_COLS && rows >= MIN_SAFE_ROWS;
}

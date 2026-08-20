// Seam between restored terminal content and a freshly spawned process (#952).
//
// IMPORTANT: browser-safe, pure — imported by both the daemon
// (DaemonSessionManager recovery) and the sandboxed renderer (useTerminal's
// .txt restore path). No `process`, no Node imports.

/**
 * When a session is recovered after its process died, the restored bytes
 * (ring dump or .txt cache) repaint the OLD screen into the emulator — but
 * the freshly spawned shell's ConPTY starts from an empty screen model whose
 * absolute coordinates begin at row 1. Anything left in the viewport is then
 * doomed: plain-text output appends after the restored content (bottom) while
 * absolute-CUP repaints (PSReadLine line editing, prediction lists, TUI
 * redraws) land at the viewport TOP, overwriting restored rows — the
 * "restored history draws garbled / text overlays each other" class.
 *
 * The seam aligns the two coordinate systems at their only common point: an
 * empty viewport. It leaves the alternate screen in case the dump ended
 * inside one, drops any dangling SGR attributes, parks the cursor on the
 * bottom row, feeds one LF per viewport row so every restored row scrolls
 * into scrollback (LF-driven scrolls are the only ones xterm preserves), and
 * homes the cursor. The fresh prompt then paints at (1,1) of an empty
 * viewport — exactly where its ConPTY believes it is — and the restored
 * history sits intact one wheel-notch above.
 */
export function restoreSeam(rows: number): string {
  // Clamp defensively: a hostile/corrupt rows value must not build a
  // megabyte of newlines (bounds mirror what any real pane can be).
  const r = Math.min(512, Math.max(1, Math.trunc(rows) || 1));
  return `\x1b[?1049l\x1b[0m\x1b[${r};1H${'\n'.repeat(r)}\x1b[H`;
}

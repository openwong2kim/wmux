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
 *
 * Before any of that it returns the modes listed in DEAD_PROCESS_MODE_RESETS
 * to their power-on values. Modes outside that list (charsets, insert mode,
 * synchronized output and the like) are left as the dump set them. The seam
 * sits in the stream before the fresh process's first byte (the ring, or the
 * renderer's .txt restore before the PTY connects), and every replay parses
 * in stream order, so nothing the fresh process sets after it is overridden.
 * It is only written when restored bytes precede a new process; a live
 * reattach replays the ring as is and keeps the running program's modes.
 */
export function restoreSeam(rows: number): string {
  // Clamp defensively: a hostile/corrupt rows value must not build a
  // megabyte of newlines (bounds mirror what any real pane can be).
  const r = Math.min(512, Math.max(1, Math.trunc(rows) || 1));
  return `${DEAD_PROCESS_MODE_RESETS}\x1b[${r};1H${'\n'.repeat(r)}\x1b[H`;
}

/**
 * The modes a dead program may have left armed, back at power-on values.
 *
 * - All three alternate-screen switches. xterm leaves the alternate screen on
 *   any of them, but the daemon's mode tracker (outputModeTracker.ts) tracks
 *   each one: after only `?1049l` a dump that entered by `?47h`/`?1047h` still
 *   read as "in the alternate screen", and a later replay window that no
 *   longer held the entry put the client back into it under the fresh shell.
 * - Scroll region and origin mode, BEFORE the line feeds below: inside a
 *   region left by the dead program the feeds only scroll that region, so the
 *   restored rows stayed in the viewport the new process paints over.
 * - Mouse tracking and encodings, focus reports, bracketed paste: input
 *   reporting no fresh process asked for (cf. staleReplayModeReset.ts, which
 *   clears the same set renderer-side when it is still unsure who owns it).
 * - Cursor keys, autowrap and cursor visibility.
 * - Application keypad (DECKPNM), which turns the numeric keypad into
 *   SS3 sequences.
 * - Kitty keyboard flags, on both screens. xterm keeps one flag set and push
 *   stack per screen and swaps the flags on every alt-screen switch, even a
 *   redundant one, so the three exits above leave active the flags parked at
 *   the dead program's last alt-screen entry (Claude Code pushes before it
 *   enters the alternate screen). `CSI < 99 u` pops the main stack to 0;
 *   the `?47` round trip then does the same on the alternate screen and
 *   parks 0 for it, which a later alt-screen program would otherwise
 *   inherit. `?47` because it neither saves nor restores the cursor and
 *   leaves the main screen's content alone, and the daemon's tracker reads
 *   it as off again. Same end state as the
 *   renderer's resetXtermKitty, reached through the parser because the
 *   daemon writes this into the ring.
 */
const DEAD_PROCESS_MODE_RESETS =
  '\x1b[?1049l\x1b[?1047l\x1b[?47l' + // alternate screen, every variant
  '\x1b[r\x1b[?6l' + // DECSTBM full screen, DECOM off
  '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l' + // mouse
  '\x1b[?1004l\x1b[?2004l' + // focus reports, bracketed paste
  '\x1b[?1l\x1b[?7h\x1b[?25h' + // cursor keys normal, autowrap on, cursor visible
  '\x1b>' + // DECKPNM: numeric keypad
  // SGR reset before the round trip: a replay chunk boundary inside it would
  // otherwise render one blank alternate frame on the dead program's colours.
  '\x1b[0m' +
  '\x1b[<99u\x1b[?47h\x1b[<99u\x1b[?47l'; // kitty flags popped on the main, then the alternate screen

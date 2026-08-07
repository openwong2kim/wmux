/**
 * Live tracker for the terminal MODES a PTY's output stream has switched on.
 *
 * The ring buffer holds raw bytes and `/api/stream` paints only the LAST
 * window of it (see web/snapshotWindow.ts). Byte-safety is not enough: a
 * fullscreen TUI sends `ESC[?1049h` once, at startup, and then paints with
 * absolute cursor positioning forever. Hours later that switch is far outside
 * the 256 KB window, so a client replaying the window is still on the normal
 * buffer while the bytes assume the alternate one — absolute-positioned frames
 * land interleaved over scrollback instead of repainting a screen.
 *
 * The local GUI never hits this because HeadlessSnapshot refuses alt-screen and
 * SessionPipe falls back to a full raw replay. The SSE path cannot afford that
 * (that is the whole reason the window exists), so it reconstructs the mode
 * state instead: this tracker is fed every chunk written to the ring — O(chunk)
 * at write time — and answers in O(1) at stream-open time, which keeps
 * snapshotWindow.ts's "work per call is independent of buffer size" invariant.
 *
 * Only DEC private modes that change how SUBSEQUENT bytes are interpreted are
 * tracked. Colors, charsets and cursor position are carried by the window's own
 * bytes and need no reconstruction.
 */

/**
 * The tracked DEC private modes and their power-on values. A mode that is at
 * its default contributes nothing to the preamble.
 */
const MODE_DEFAULTS: ReadonlyMap<number, boolean> = new Map([
  [1, false], // DECCKM — application cursor keys
  [7, true], // DECAWM — autowrap
  [25, true], // DECTCEM — cursor visible
  [47, false], // alt screen (legacy)
  [1047, false], // alt screen (clear-on-exit)
  [1049, false], // alt screen + saved cursor — what modern TUIs use
  [1000, false], // mouse: normal tracking
  [1002, false], // mouse: button-event tracking
  [1003, false], // mouse: any-event tracking
  [1005, false], // mouse encoding: UTF-8
  [1006, false], // mouse encoding: SGR
  [1015, false], // mouse encoding: urxvt
  [2004, false], // bracketed paste
]);

/** The three alt-screen modes, in the order a preamble should assert them. */
const ALT_SCREEN_MODES: readonly number[] = [47, 1047, 1049];

/**
 * Chars kept across feeds so a mode sequence split at a chunk boundary still
 * matches. `ESC[?1000;1002;1003;1005;1006;1015;2004h` is the longest realistic
 * shape; 64 covers it with room to spare. Same technique as
 * ansiStreamScan.ts's REGEX_CARRY_CHARS.
 */
const CARRY_CHARS = 64;

/**
 * DEC private mode set/reset (`CSI ? Ps ; Ps ... h|l`) or RIS (`ESC c`).
 * Matched together so a reset that lands between two set-mode sequences is
 * applied in stream order rather than by group.
 */
// eslint-disable-next-line no-control-regex
const MODE_RE = /\x1b(?:\[\?([0-9;]*)([hl])|c)/g;

export class OutputModeTracker {
  private carry = '';
  private readonly state = new Map<number, boolean>(MODE_DEFAULTS);

  /**
   * Feed one decoded output chunk, in stream order.
   *
   * The carry means a chunk boundary inside a sequence does not lose it, at the
   * cost of re-scanning at most CARRY_CHARS chars per chunk. A sequence that
   * spans the boundary is matched once, on the feed that completes it — the
   * previous feed saw no final `h`/`l` so it could not have matched.
   */
  feed(chunk: string): void {
    if (chunk.length === 0) return;
    const text = this.carry + chunk;
    MODE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODE_RE.exec(text)) !== null) {
      if (m[1] === undefined) {
        this.reset();
        continue;
      }
      const on = m[2] === 'h';
      for (const raw of m[1].split(';')) {
        if (raw === '') continue;
        const mode = Number(raw);
        // Last writer wins, per mode: a stream that toggles 1049 a hundred
        // times leaves the value the last sequence asked for.
        if (this.state.has(mode)) this.state.set(mode, on);
      }
    }
    this.carry = text.slice(-CARRY_CHARS);
  }

  /** Back to power-on defaults, as RIS (`ESC c`) does to a real terminal. */
  reset(): void {
    for (const [mode, def] of MODE_DEFAULTS) this.state.set(mode, def);
  }

  /** Current value of one tracked mode (defaults for anything untracked). */
  isSet(mode: number): boolean {
    return this.state.get(mode) ?? false;
  }

  /** True while the stream is painting into an alternate screen buffer. */
  get altScreen(): boolean {
    return ALT_SCREEN_MODES.some((m) => this.state.get(m) === true);
  }

  /**
   * A sequence that puts a fresh terminal into the mode state this stream is
   * actually in, to be PREPENDED to a capped snapshot. Empty when every tracked
   * mode is at its default, so a plain shell session is byte-identical to
   * before this existed.
   *
   * Alt screen is asserted first and followed by an erase + cursor home: the
   * window that follows was produced by an app that owns the whole screen and
   * repaints by absolute positioning, so it must start from a known-blank grid
   * rather than over whatever the client had.
   *
   * Accepted limitation: an alt-screen app that has been IDLE since before the
   * window starts contributes no repaint of its own, so the client shows only
   * the part of its frame that the window happens to contain until the app next
   * redraws. Mostly-right beats the garbled interleave this replaces.
   */
  preamble(): string {
    let out = '';
    if (this.altScreen) out += '\x1b[?1049h\x1b[2J\x1b[H';
    for (const [mode, def] of MODE_DEFAULTS) {
      if (ALT_SCREEN_MODES.includes(mode)) continue; // handled above
      const value = this.state.get(mode) ?? def;
      if (value === def) continue;
      out += `\x1b[?${mode}${value ? 'h' : 'l'}`;
    }
    return out;
  }
}

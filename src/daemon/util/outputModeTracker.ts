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
 * matches. The longest realistic shape is a full mouse-mode declaration —
 * `ESC[?1000;1001;1002;1003;1004;1005;1006;1007;1015;1016;2004h` is already 60
 * chars — so the old 64 left a boundary a few chars in dropping the ESC and
 * missing the whole sequence. 256 gives real margin. Same technique as
 * ansiStreamScan.ts's REGEX_CARRY_CHARS.
 */
const CARRY_CHARS = 256;

/**
 * DEC private mode set/reset (`CSI ? Ps ; Ps ... h|l`), RIS (`ESC c`) or DECSTR
 * soft reset (`CSI ! p`). Matched together so a reset that lands between two
 * set-mode sequences is applied in stream order rather than by group.
 *
 * DECSTR is not optional: terminfo's `rs2` — what `reset` and `tput init` send
 * — is literally `\E[!p`, so a stream that resets its terminal that way would
 * otherwise leave the tracker asserting modes the remote no longer has.
 */
// eslint-disable-next-line no-control-regex
const MODE_RE = /\x1b(?:\[\?([0-9;]*)([hl])|\[!p|c)/g;

/** RIS — a full power-on reset. */
const RIS = '\x1bc';

export class OutputModeTracker {
  private carry = '';
  private readonly state = new Map<number, boolean>(MODE_DEFAULTS);
  /**
   * Absolute stream offset (in BYTES, in the ring's own coordinate system) of
   * the last alt-screen ENTRY, and which mode performed it. -1 until one is
   * seen. See {@link preamble} for what the offset decides.
   */
  private lastAltEntryOffset = -1;
  private lastAltEntryMode = 0;

  /**
   * Feed one decoded output chunk, in stream order.
   *
   * `streamEndOffset` is the ring's `totalBytesWritten` AFTER this chunk was
   * written to it. The ring's counter is used rather than one this class keeps
   * itself because the two must share a coordinate system with the snapshot
   * window, and only the ring's is authoritative: a recovered session's ring is
   * PRE-FILLED with saved scrollback (DaemonSessionManager.createSession), so a
   * counter started at zero here would be off by the whole prefill and
   * mis-decide every window comparison below.
   *
   * The carry means a chunk boundary inside a sequence does not lose it, at the
   * cost of re-scanning at most CARRY_CHARS chars per chunk. A sequence that
   * spans the boundary is matched once, on the feed that completes it — the
   * previous feed saw no final `h`/`l` so it could not have matched.
   */
  feed(chunk: string, streamEndOffset: number): void {
    if (chunk.length === 0) return;
    const text = this.carry + chunk;
    MODE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    // Char index of the last alt-screen ENTRY in `text`, resolved to a byte
    // offset once after the loop: converting per match would be O(chunk) each
    // time, and only the last entry can be the current one.
    let altEntryIndex = -1;
    while ((m = MODE_RE.exec(text)) !== null) {
      if (m[1] === undefined) {
        if (m[0] === RIS) this.reset();
        else this.softReset(); // DECSTR
        continue;
      }
      const on = m[2] === 'h';
      for (const raw of m[1].split(';')) {
        if (raw === '') continue;
        const mode = Number(raw);
        // Last writer wins, per mode: a stream that toggles 1049 a hundred
        // times leaves the value the last sequence asked for.
        if (!this.state.has(mode)) continue;
        this.state.set(mode, on);
        if (on && ALT_SCREEN_MODES.includes(mode)) {
          altEntryIndex = m.index;
          this.lastAltEntryMode = mode;
        }
      }
    }
    if (altEntryIndex >= 0) {
      // Bytes from the entry's first char to the end of this chunk. `text` is
      // carry + chunk and the carry is a verbatim char-suffix of the PREVIOUS
      // chunk, so subtracting that byte length from the chunk's end offset is
      // exact even when the sequence started before this chunk.
      this.lastAltEntryOffset = streamEndOffset - Buffer.byteLength(text.slice(altEntryIndex), 'utf8');
    }
    this.carry = text.slice(-CARRY_CHARS);
  }

  /** Back to power-on defaults, as RIS (`ESC c`) does to a real terminal. */
  reset(): void {
    for (const [mode, def] of MODE_DEFAULTS) this.state.set(mode, def);
    this.lastAltEntryOffset = -1;
    this.lastAltEntryMode = 0;
  }

  /**
   * DECSTR (`CSI ! p`) — a SOFT reset. Everything tracked here goes back to its
   * default EXCEPT the alt-screen modes: a soft reset does not swap the screen
   * buffer back, so claiming it did would drop a live TUI's client onto the
   * normal buffer while the stream keeps painting absolute frames.
   *
   * Mouse modes are reset even though real terminals vary, because the two
   * failure directions are not symmetric: under-declaring costs the viewer its
   * mouse reporting, while over-declaring types raw mouse escape sequences into
   * whatever is at the prompt.
   */
  private softReset(): void {
    for (const [mode, def] of MODE_DEFAULTS) {
      if (ALT_SCREEN_MODES.includes(mode)) continue;
      this.state.set(mode, def);
    }
  }

  /** Current value of one tracked mode (defaults for anything untracked). */
  isSet(mode: number): boolean {
    return this.state.get(mode) ?? MODE_DEFAULTS.get(mode) ?? false;
  }

  /** True while the stream is painting into an alternate screen buffer. */
  get altScreen(): boolean {
    return ALT_SCREEN_MODES.some((m) => this.state.get(m) === true);
  }

  /**
   * Which alt-screen mode is actually in effect — the one that last ENTERED it
   * when that one is still set, otherwise whichever remains. Replaying the mode
   * the stream really used (rather than normalising everything to 1049) keeps a
   * later `ESC[?47l` / `ESC[?1047l` inside the window meaning what it meant on
   * the remote.
   */
  private activeAltMode(): number | null {
    if (this.state.get(this.lastAltEntryMode) === true) return this.lastAltEntryMode;
    return ALT_SCREEN_MODES.find((m) => this.state.get(m) === true) ?? null;
  }

  /**
   * A sequence that puts a fresh terminal into the mode state this stream is
   * actually in, to be PREPENDED to a capped snapshot. Empty when every tracked
   * mode is at its default, so a plain shell session is byte-identical to
   * before this existed.
   *
   * `windowStartOffset` is the absolute stream offset of the snapshot's FIRST
   * byte (`ringBuffer.totalBytesWritten - snapshot.bytes.length`). It gates the
   * alt-screen half, and nothing else, because that half is the only part that
   * is not idempotent:
   *
   *   This tracker describes the whole stream's final state, but the snapshot
   *   is only the stream's TAIL. When the window ALREADY CONTAINS the app's own
   *   `ESC[?1049h` — the ordinary "launched vim a moment ago" case — asserting
   *   it first would paint the shell scrollback that precedes it INTO the
   *   alternate buffer; the window's own entry then no-ops (xterm's
   *   BufferSet.activateAltBuffer early-returns), and the app's eventual
   *   `ESC[?1049l` drops the user on an empty normal buffer with the whole
   *   scrollback gone. So the entry is asserted only when it fell outside the
   *   window. Note this is an OFFSET comparison, not `!truncated`: the ring
   *   itself wraps, and an entry dropped by the wrap is just as absent.
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
  preamble(windowStartOffset: number): string {
    let out = '';
    const alt = this.activeAltMode();
    if (alt !== null && this.lastAltEntryOffset < windowStartOffset) {
      out += `\x1b[?${alt}h\x1b[2J\x1b[H`;
    }
    for (const [mode, def] of MODE_DEFAULTS) {
      if (ALT_SCREEN_MODES.includes(mode)) continue; // handled above
      const value = this.state.get(mode) ?? def;
      if (value === def) continue;
      out += `\x1b[?${mode}${value ? 'h' : 'l'}`;
    }
    return out;
  }
}

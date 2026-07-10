/**
 * Streaming ANSI scanners for the headless-snapshot path (phase 3 PR-B).
 *
 * All three trackers are fed the SAME decoded text chunks that are written to
 * the headless terminal, in order, and answer questions the public xterm API
 * cannot at snapshot time:
 *
 *  - PartialSequenceTracker — the trailing bytes of the stream that form an
 *    UNFINISHED escape sequence. xterm's parser holds them internally and
 *    SerializeAddon drops them, so a resync cut mid-sequence would make the
 *    next live chunk render the sequence's continuation literally. The tail
 *    is appended verbatim after the serialized snapshot so the renderer's
 *    parser ends up holding the same pending state.
 *
 *  - MarginTracker — DECSTBM scroll margins are not exposed by the public
 *    buffer API and are not serialized. Any set-margin still in effect means
 *    the snapshot would silently lose scroll-region behavior, so the caller
 *    degrades to raw replay ("slower, never wrong").
 *
 *  - SgrMouseEncodingTracker — `terminal.modes.mouseTrackingMode` exposes the
 *    tracking PROTOCOL but not the report ENCODING (?1006 SGR / ?1016 SGR
 *    pixels). Restoring the protocol without the encoding would feed the app
 *    reports in a format it never negotiated.
 */

const ESCAPE = 0x1b;

const enum ScanState {
  Ground,
  Esc,
  EscIntermediate,
  Csi,
  // OSC / DCS / SOS / PM / APC — consumed until BEL or ST (ESC \).
  String,
  StringEsc,
}

/** Longest pending tail we are willing to ship (a giant unterminated OSC is
 * not worth buffering — the caller falls back to raw replay instead). */
export const MAX_PENDING_TAIL_CHARS = 4096;

export class PartialSequenceTracker {
  private state = ScanState.Ground;
  private tail = '';
  private overflowed = false;

  feed(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      const next = this.advance(c);
      if (next === ScanState.Ground) {
        this.state = ScanState.Ground;
        this.tail = '';
        this.overflowed = false;
        continue;
      }
      if (this.state === ScanState.Ground) {
        // Entering a sequence (next is non-Ground here) — start capturing.
        this.tail = '';
        this.overflowed = false;
      }
      this.state = next;
      if (!this.overflowed) {
        if (this.tail.length >= MAX_PENDING_TAIL_CHARS) {
          this.overflowed = true;
          this.tail = '';
        } else {
          this.tail += chunk[i];
        }
      }
    }
  }

  /** True when the stream currently ends inside an escape sequence. */
  get isPending(): boolean {
    return this.state !== ScanState.Ground;
  }

  /**
   * The unfinished sequence's chars, or null when it exceeded the cap and can
   * no longer be reproduced (callers must degrade to raw replay in that case).
   */
  get pendingTail(): string | null {
    if (this.state === ScanState.Ground) return '';
    return this.overflowed ? null : this.tail;
  }

  /** One state-machine step. Returns the state AFTER consuming `c`. */
  private advance(c: number): ScanState {
    switch (this.state) {
      case ScanState.Ground:
        return c === ESCAPE ? ScanState.Esc : ScanState.Ground;
      case ScanState.Esc:
        if (c === 0x5b /* [ */) return ScanState.Csi;
        if (
          c === 0x5d /* ] OSC */ ||
          c === 0x50 /* P DCS */ ||
          c === 0x58 /* X SOS */ ||
          c === 0x5e /* ^ PM */ ||
          c === 0x5f /* _ APC */
        ) {
          return ScanState.String;
        }
        if (c >= 0x20 && c <= 0x2f) return ScanState.EscIntermediate;
        // Final byte (ESC c, ESC =, ...) or a control char aborting the
        // sequence — either way the parser is back at ground.
        return ScanState.Ground;
      case ScanState.EscIntermediate:
        if (c >= 0x20 && c <= 0x2f) return ScanState.EscIntermediate;
        if (c === ESCAPE) return ScanState.Esc;
        return ScanState.Ground; // final byte dispatches (or aborts)
      case ScanState.Csi:
        // Params 0x30-0x3f and intermediates 0x20-0x2f continue the sequence.
        if ((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f)) {
          return ScanState.Csi;
        }
        if (c >= 0x40 && c <= 0x7e) return ScanState.Ground; // final byte
        if (c === ESCAPE) return ScanState.Esc;
        if (c === 0x18 /* CAN */ || c === 0x1a /* SUB */) return ScanState.Ground;
        // Embedded C0 controls execute without ending the sequence.
        return ScanState.Csi;
      case ScanState.String:
        if (c === 0x07 /* BEL */) return ScanState.Ground;
        if (c === ESCAPE) return ScanState.StringEsc;
        if (c === 0x18 || c === 0x1a) return ScanState.Ground;
        return ScanState.String;
      case ScanState.StringEsc:
        if (c === 0x5c /* \ — ST */) return ScanState.Ground;
        // xterm aborts the string and dispatches the ESC with this char.
        this.state = ScanState.Esc;
        return this.advance(c);
    }
  }
}

/** Chars kept across feeds so a sequence split at a chunk boundary still
 * matches (longest pattern of interest is ~12 chars). */
const REGEX_CARRY_CHARS = 16;

// eslint-disable-next-line no-control-regex
const MARGIN_RE = /\x1b(?:\[([0-9;]*)r|\[!p|c)/g;

export class MarginTracker {
  private carry = '';
  private _active = false;

  feed(chunk: string): void {
    const text = this.carry + chunk;
    MARGIN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARGIN_RE.exec(text)) !== null) {
      if (m[1] === undefined) {
        // RIS (ESC c) or DECSTR (CSI ! p) reset margins to full screen.
        this._active = false;
      } else {
        // DECSTBM: params containing a digit narrow the region; a bare
        // `CSI r` (or `CSI ; r`) resets to full screen. We cannot compare
        // against the actual row count here, so any explicit params count
        // as active — conservative (worst case: raw-replay fallback).
        this._active = /\d/.test(m[1]);
      }
    }
    this.carry = text.slice(-REGEX_CARRY_CHARS);
  }

  get active(): boolean {
    return this._active;
  }
}

// eslint-disable-next-line no-control-regex
const SGR_MOUSE_RE = /\x1b(?:\[\?(1006|1016)([hl])|c)/g;

export class SgrMouseEncodingTracker {
  private carry = '';
  private _sgr = false;
  private _sgrPixels = false;

  feed(chunk: string): void {
    const text = this.carry + chunk;
    SGR_MOUSE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SGR_MOUSE_RE.exec(text)) !== null) {
      if (m[1] === undefined) {
        // RIS resets both encodings.
        this._sgr = false;
        this._sgrPixels = false;
      } else if (m[1] === '1006') {
        this._sgr = m[2] === 'h';
      } else {
        this._sgrPixels = m[2] === 'h';
      }
    }
    this.carry = text.slice(-REGEX_CARRY_CHARS);
  }

  get sgr(): boolean {
    return this._sgr;
  }

  get sgrPixels(): boolean {
    return this._sgrPixels;
  }
}

/**
 * Number of bytes at the END of `buf` that form an incomplete UTF-8 sequence.
 * The headless feed decodes per-chunk; a multi-byte char split across chunks
 * must be carried to the next chunk (or, at finalize, appended raw after the
 * snapshot so the byte stream stays contiguous for the renderer).
 */
export function incompleteUtf8SuffixLength(buf: Buffer): number {
  const len = buf.length;
  // A UTF-8 sequence is at most 4 bytes; scan back at most 3 (a lead byte 4
  // bytes back would have all its continuations already).
  for (let back = 1; back <= 3 && back <= len; back++) {
    const b = buf[len - back];
    if ((b & 0b1100_0000) === 0b1000_0000) continue; // continuation — keep looking
    // Found a lead byte `back` bytes from the end.
    let expected = 0;
    if ((b & 0b1000_0000) === 0) expected = 1;
    else if ((b & 0b1110_0000) === 0b1100_0000) expected = 2;
    else if ((b & 0b1111_0000) === 0b1110_0000) expected = 3;
    else if ((b & 0b1111_1000) === 0b1111_0000) expected = 4;
    else return 0; // invalid lead — let the decoder produce U+FFFD as usual
    return expected > back ? back : 0;
  }
  return 0;
}

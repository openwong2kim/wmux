/**
 * Initial-paint window for the browser terminal's SSE snapshot.
 *
 * `handleStream` used to send the WHOLE ring on every stream open. The ring is
 * 8 MB per session by default and configurable up to 64 MB
 * (`session.bufferSizeMb` / `bufferMaxMb` in daemon config), and base64 inflates
 * whatever we send by a third — so a phone that reconnects every time the train
 * passes a tunnel pulled a multi-megabyte payload each time, and the daemon
 * copied the ring to build it. A terminal viewport is ~80x25; the initial paint
 * only has to fill a screen and leave a little scrollback.
 *
 * The hard part is WHERE to cut. The ring holds raw PTY bytes: UTF-8 sequences
 * and ANSI/OSC escapes both span several bytes, and a cut inside either one
 * makes xterm render a replacement char or, worse, swallow the following text
 * as the tail of a broken escape. So the naive offset is only a starting point
 * — `capSnapshot` walks FORWARD from it to a boundary that is safe to start
 * reading at, and never backward, so the result is never larger than the cap.
 *
 * Every scan in here is bounded by a named constant (see below): the total work
 * per call is independent of the buffer size, so a pathological buffer cannot
 * turn a repeated reconnect into a repeated O(n) walk.
 */

/**
 * Default initial-paint window, taken from the END of the ring. Comfortably
 * more than a screenful of scrollback for any sane font size, and ~1/32 of the
 * default ring.
 */
export const DEFAULT_SNAPSHOT_WINDOW_BYTES = 256 * 1024;

/**
 * How far back we look for an escape introducer (ESC, 0x1B) that the cut point
 * might be sitting inside. Every CSI and every reasonable OSC/DCS string is far
 * shorter than this. A string sequence longer than the window (a giant OSC 52
 * clipboard blob is the only realistic one) is not detected, and the cost of
 * that miss is bounded and cosmetic: the first row shows the tail of that
 * string as text. We do not pay an unbounded backward scan to avoid it.
 */
const ESC_LOOKBEHIND_BYTES = 4096;

/**
 * How far forward we will parse a sequence that started before the cut, from
 * its ESC. Twice the lookbehind, so a sequence found at the far edge of the
 * lookbehind window still has a full window of room to terminate in.
 */
const ESC_FORWARD_SCAN_BYTES = ESC_LOOKBEHIND_BYTES * 2;

/**
 * How far forward we will look for a line boundary once we already have a safe
 * offset. Purely cosmetic — it stops the first visible row from being half a
 * line — so it gives up quickly rather than eating into the window.
 */
const LINE_LOOKAHEAD_BYTES = 4096;

export interface CapSnapshotOptions {
  /**
   * Window size in bytes, or `'all'` for the entire buffer.
   *
   * `'all'` is the opt-up escape hatch for a caller that genuinely wants the
   * full ring — the future `?full=1` on `/api/stream`. Nothing wires that query
   * parameter today; the signature just refuses to make it a later rewrite.
   * A value that is not a positive integer falls back to the default.
   */
  maxBytes?: number | 'all';
}

export interface CappedSnapshot {
  /**
   * The window to paint. A VIEW into `buf` (no copy) — callers that base64 it
   * immediately, as `handleStream` does, pay nothing; a caller that RETAINS it
   * pins the whole source buffer and should copy.
   */
  bytes: Buffer;
  /** True when anything was dropped from the front. */
  truncated: boolean;
  /** How many bytes were dropped, so a client can say the paint is partial. */
  omittedBytes: number;
}

/**
 * Cap a ring-buffer snapshot to the last `maxBytes`, cutting only at a boundary
 * that is safe to start reading at.
 *
 * Guarantees: the returned view never exceeds `maxBytes`, never begins inside a
 * UTF-8 sequence, and never begins inside an escape sequence that started
 * within `ESC_LOOKBEHIND_BYTES` of the cut.
 */
export function capSnapshot(buf: Buffer, opts: CapSnapshotOptions = {}): CappedSnapshot {
  const requested = opts.maxBytes ?? DEFAULT_SNAPSHOT_WINDOW_BYTES;
  if (requested === 'all') return whole(buf);
  const maxBytes =
    typeof requested === 'number' && Number.isInteger(requested) && requested > 0
      ? requested
      : DEFAULT_SNAPSHOT_WINDOW_BYTES;
  if (buf.length <= maxBytes) return whole(buf);

  const naive = buf.length - maxBytes;
  let cut = escapeSafeOffset(buf, naive);
  cut = utf8SafeOffset(buf, cut);
  cut = preferLineBoundary(buf, cut);

  return { bytes: buf.subarray(cut), truncated: cut > 0, omittedBytes: cut };
}

function whole(buf: Buffer): CappedSnapshot {
  return { bytes: buf, truncated: false, omittedBytes: 0 };
}

/**
 * Move `offset` past an escape sequence it is sitting inside, if any.
 *
 * Finding the nearest preceding ESC and parsing forward from it is enough: in a
 * well-formed stream escape sequences do not nest, so the nearest ESC before
 * the offset is either the introducer of the sequence covering it or belongs to
 * a sequence that already closed.
 */
function escapeSafeOffset(buf: Buffer, offset: number): number {
  const floor = Math.max(0, offset - ESC_LOOKBEHIND_BYTES);
  let esc = -1;
  for (let i = offset - 1; i >= floor; i--) {
    if (buf[i] === 0x1b) {
      esc = i;
      break;
    }
  }
  if (esc === -1) return offset;
  const end = escapeSequenceEnd(buf, esc);
  // end === -1: unterminated within the forward bound, i.e. not a sequence we
  // can reason about. Leave the offset alone rather than skipping arbitrarily
  // far ahead — the UTF-8 step below still guarantees a character boundary.
  if (end === -1) return offset;
  return end > offset ? end : offset;
}

/**
 * Index just past the escape sequence starting at `start` (where `buf[start]`
 * is ESC), or -1 if it does not terminate within `ESC_FORWARD_SCAN_BYTES`.
 */
function escapeSequenceEnd(buf: Buffer, start: number): number {
  const limit = Math.min(buf.length, start + ESC_FORWARD_SCAN_BYTES);
  let i = start + 1;
  if (i >= limit) return -1;
  const kind = buf[i];

  // CSI: ESC [ , params/intermediates (0x20-0x3F), one final byte (0x40-0x7E).
  if (kind === 0x5b) {
    i++;
    while (i < limit) {
      const b = buf[i];
      if (b >= 0x40 && b <= 0x7e) return i + 1;
      if (b < 0x20 || b > 0x3f) return -1; // not a CSI body byte — malformed
      i++;
    }
    return -1;
  }

  // String sequences — OSC ], DCS P, SOS X, PM ^, APC _ — end at BEL or ST.
  if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
    i++;
    while (i < limit) {
      const b = buf[i];
      if (b === 0x07) return i + 1; // BEL
      if (b === 0x1b && i + 1 < limit && buf[i + 1] === 0x5c) return i + 2; // ST = ESC \
      i++;
    }
    return -1;
  }

  // Everything else: ESC, optional intermediates (0x20-0x2F), one final byte.
  // Covers charset designation (ESC ( B), ESC 7 / ESC 8, and ST itself.
  while (i < limit && buf[i] >= 0x20 && buf[i] <= 0x2f) i++;
  if (i < limit && buf[i] >= 0x30 && buf[i] <= 0x7e) return i + 1;
  return -1;
}

/**
 * Move `offset` forward off a UTF-8 continuation byte. A sequence is at most 4
 * bytes, so at most 3 steps — no bound constant needed, the encoding is one.
 */
function utf8SafeOffset(buf: Buffer, offset: number): number {
  let i = offset;
  let steps = 0;
  while (i < buf.length && steps < 3 && (buf[i] & 0xc0) === 0x80) {
    i++;
    steps++;
  }
  return i;
}

/**
 * Prefer starting just after a newline, so the first visible row is a whole
 * line. Gives up at an escape introducer: crossing one would mean cutting
 * inside a sequence that opened after the safe offset, which is exactly what
 * the step above just guaranteed against.
 */
function preferLineBoundary(buf: Buffer, offset: number): number {
  const limit = Math.min(buf.length, offset + LINE_LOOKAHEAD_BYTES);
  for (let i = offset; i < limit; i++) {
    const b = buf[i];
    if (b === 0x1b) return offset;
    // A trailing newline would leave nothing to paint; keep the safe offset.
    if (b === 0x0a) return i + 1 < buf.length ? i + 1 : offset;
  }
  return offset;
}

/**
 * Bounded output capture for the agent REPL.
 *
 * A REPL runs code the caller wrote seconds ago, so `while (true) console.log(x)`
 * is a routine mistake rather than an exotic one. The MCP server that holds these
 * buffers is the shared broker hosting EVERY agent's connection, so an unbounded
 * accumulator is a cross-agent memory fault, not a local one.
 *
 * OutputBuffer therefore retains a bounded head and a bounded tail and forgets
 * the middle, while still counting every byte that ever arrived:
 *
 *     ┌──────── head (75% of cap) ────────┬─ elided ─┬─ tail (25%) ─┐
 *     │ the first output, where the run    │ counted  │ the last     │
 *     │ announces what it is doing         │ only     │ output, where│
 *     │                                    │          │ it failed    │
 *     └────────────────────────────────────┴──────────┴──────────────┘
 *
 * Both ends matter: the head says what the script started doing, the tail
 * carries the error it died on. Keeping only the head would hide every failure
 * that happens after a chatty loop.
 */

/** Result of rendering a bounded buffer or string back to text. */
export interface TruncatedText {
  /** The retained text, with an elision marker in place of the dropped middle. */
  readonly text: string;
  /** True when anything was dropped. */
  readonly truncated: boolean;
  /** Every byte that ever arrived, including the dropped ones. */
  readonly totalBytes: number;
  /** Bytes dropped from the middle. */
  readonly elidedBytes: number;
}

/**
 * Walk back off a UTF-8 continuation byte so a cut never lands mid-codepoint.
 * Without this a truncated buffer renders a U+FFFD at the seam, which reads as
 * corruption in the tool output rather than as a deliberate cut.
 */
function backOffToCodepointBoundary(buf: Buffer, index: number): number {
  let i = Math.min(index, buf.length);
  // At most 3 continuation bytes can precede a lead byte in valid UTF-8.
  for (let steps = 0; steps < 4 && i > 0; steps++) {
    if ((buf[i] & 0xc0) !== 0x80) break;
    i--;
  }
  return i;
}

/**
 * Walk FORWARD off a UTF-8 continuation byte. The tail of a truncated buffer
 * starts at an arbitrary offset, so its first bytes may be the back half of a
 * codepoint whose lead byte was dropped; those bytes are unrenderable and get
 * skipped rather than turned into U+FFFD.
 */
function skipToCodepointBoundary(buf: Buffer, index: number): number {
  let i = Math.max(0, index);
  for (let steps = 0; steps < 4 && i < buf.length; steps++) {
    if ((buf[i] & 0xc0) !== 0x80) break;
    i++;
  }
  return i;
}

/**
 * Length of `buf` with any trailing INCOMPLETE UTF-8 sequence removed.
 *
 * Distinct from walking back off a continuation byte at a known index: here the
 * buffer already ends wherever the cap fell, so the question is whether its
 * last lead byte got all the continuation bytes it needs. Asking
 * `backOffToCodepointBoundary(buf, buf.length)` cannot answer that — it reads
 * one byte past the end, which is undefined and never looks like a
 * continuation, so it always reports the buffer as already clean.
 */
function trimIncompleteTrailingSequence(buf: Buffer): number {
  const len = buf.length;
  for (let back = 1; back <= 4 && back <= len; back++) {
    const byte = buf[len - back];
    if ((byte & 0xc0) === 0x80) continue; // continuation; keep scanning back
    let needed: number;
    if ((byte & 0x80) === 0) needed = 1;
    else if ((byte & 0xe0) === 0xc0) needed = 2;
    else if ((byte & 0xf0) === 0xe0) needed = 3;
    else if ((byte & 0xf8) === 0xf0) needed = 4;
    else return len; // not valid UTF-8 at all; leave the bytes alone
    return back >= needed ? len : len - back;
  }
  return len;
}

function elisionMarker(bytes: number): string {
  return `\n… ${bytes} bytes elided …\n`;
}

/**
 * Truncate an already-complete string to `capBytes`, keeping head and tail.
 * Used for the inspected return value, which arrives in one piece.
 */
export function truncateText(input: string, capBytes: number): TruncatedText {
  const buf = Buffer.from(input, 'utf8');
  if (buf.length <= capBytes) {
    return { text: input, truncated: false, totalBytes: buf.length, elidedBytes: 0 };
  }
  const headCap = Math.floor(capBytes * 0.75);
  const tailCap = capBytes - headCap;
  const headEnd = backOffToCodepointBoundary(buf, headCap);
  const tailStart = skipToCodepointBoundary(buf, buf.length - tailCap);
  const elidedBytes = tailStart - headEnd;
  return {
    text:
      buf.subarray(0, headEnd).toString('utf8') +
      elisionMarker(elidedBytes) +
      buf.subarray(tailStart).toString('utf8'),
    truncated: true,
    totalBytes: buf.length,
    elidedBytes,
  };
}

/**
 * Streaming accumulator with a hard retention cap. Bytes past the cap are
 * counted and dropped, never buffered, so a runaway logger cannot grow the
 * broker's heap no matter how long it runs.
 */
export class OutputBuffer {
  private readonly headCap: number;
  private readonly tailCap: number;
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;

  constructor(capBytes: number) {
    this.headCap = Math.floor(capBytes * 0.75);
    this.tailCap = Math.max(1, capBytes - this.headCap);
  }

  /**
   * Retained bytes are always COPIED out of the caller's chunk, never held as a
   * subarray of it. Node hands out pipe chunks from a shared pool and a
   * retained slice pins its whole pool block, so a writer producing many small
   * chunks would hold tens of megabytes behind a 64 KB cap — defeating the one
   * guarantee this class exists to make. The copies are bounded by the cap.
   */
  append(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headCap) {
      const take = Math.min(this.headCap - this.headBytes, rest.length);
      this.head.push(Buffer.from(rest.subarray(0, take)));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tail.push(Buffer.from(rest));
    this.tailBytes += rest.length;
    // Drop from the FRONT of the tail so the ring always holds the most recent
    // bytes. A single oversized chunk is sliced rather than kept whole.
    while (this.tailBytes > this.tailCap) {
      const front = this.tail[0];
      const excess = this.tailBytes - this.tailCap;
      if (front.length <= excess) {
        this.tail.shift();
        this.tailBytes -= front.length;
      } else {
        this.tail[0] = front.subarray(excess);
        this.tailBytes -= excess;
      }
    }
  }

  /** Bytes that ever arrived, including dropped ones. */
  get totalBytes(): number {
    return this.total;
  }

  render(): TruncatedText {
    const headBuf = Buffer.concat(this.head, this.headBytes);
    if (this.tailBytes === 0) {
      return {
        text: headBuf.toString('utf8'),
        truncated: false,
        totalBytes: this.total,
        elidedBytes: 0,
      };
    }
    const tailBuf = Buffer.concat(this.tail, this.tailBytes);
    const elidedBytes = this.total - this.headBytes - this.tailBytes;
    if (elidedBytes === 0) {
      // Everything fit; the split between head and tail is an implementation
      // detail the caller must not see as a truncation.
      return {
        text: Buffer.concat([headBuf, tailBuf]).toString('utf8'),
        truncated: false,
        totalBytes: this.total,
        elidedBytes: 0,
      };
    }
    const headEnd = trimIncompleteTrailingSequence(headBuf);
    const tailStart = skipToCodepointBoundary(tailBuf, 0);
    return {
      text:
        headBuf.subarray(0, headEnd).toString('utf8') +
        elisionMarker(elidedBytes + (headBuf.length - headEnd) + tailStart) +
        tailBuf.subarray(tailStart).toString('utf8'),
      truncated: true,
      totalBytes: this.total,
      elidedBytes,
    };
  }
}

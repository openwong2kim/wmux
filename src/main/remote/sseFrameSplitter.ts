/**
 * Splits a byte stream into SSE frames on `\n\n`, counting BYTES.
 *
 * Splitting the decoded string would bound UTF-16 code units, not what came
 * over the wire, and only the unterminated tail. This works on the raw bytes:
 * each complete frame and the pending tail are both held to `maxFrameBytes`
 * before anything is decoded or dispatched. `\n` is ASCII and never part of a
 * multi-byte UTF-8 sequence, so a frame boundary never splits a character.
 *
 * Bytes are kept as the chunks they arrived in and joined once per frame, so a
 * large frame costs one copy, not one per chunk.
 */
export class SseFrameSplitter {
  private chunks: Buffer[] = [];
  private size = 0;
  /** Last pending byte, or -1 when nothing is pending. */
  private last = -1;

  constructor(private readonly maxFrameBytes: number) {}

  /** The complete frames in `chunk` (decoded), or null once a frame or the
   *  pending tail passes the cap. */
  push(value: Uint8Array): string[] | null {
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const frames: string[] = [];
    let start = 0;
    let from = 0;
    for (;;) {
      const i = chunk.indexOf(0x0a, from);
      if (i === -1) break;
      from = i + 1;
      const prev = i > start ? chunk[i - 1] : this.last;
      if (prev !== 0x0a) continue;
      // Frame bytes, separator included; the frame itself is two shorter.
      const total = this.size + (i + 1 - start);
      if (total - 2 > this.maxFrameBytes) return null;
      const joined = this.chunks.length === 0
        ? chunk.subarray(start, i + 1)
        : Buffer.concat([...this.chunks, chunk.subarray(start, i + 1)], total);
      frames.push(joined.subarray(0, total - 2).toString('utf8'));
      this.chunks = [];
      this.size = 0;
      this.last = -1;
      start = i + 1;
    }
    if (start < chunk.length) {
      this.chunks.push(chunk.subarray(start));
      this.size += chunk.length - start;
      this.last = chunk[chunk.length - 1];
      if (this.size > this.maxFrameBytes) return null;
    }
    return frames;
  }
}

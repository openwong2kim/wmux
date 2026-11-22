import { StringDecoder } from 'node:string_decoder';

/**
 * Splits a UTF-8 byte stream into newline-terminated lines.
 *
 * Decoding is streaming: a multi-byte character split across two chunks is
 * held by the decoder until its last byte arrives, instead of each chunk being
 * decoded on its own (which turns both halves into U+FFFD). Only a chunk's own
 * bytes are scanned for the delimiter, and the pieces of an unfinished line are
 * joined once, when it ends, so a response that arrives in many chunks costs
 * linear work rather than a re-split of everything buffered so far per chunk.
 * 0x0A never occurs inside a multi-byte UTF-8 sequence, so scanning bytes is exact.
 */
export class LineFramer {
  private readonly decoder = new StringDecoder('utf8');
  private pending: string[] = [];

  /** The lines this chunk completes, without their '\n'. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      this.pending.push(this.decoder.write(chunk.subarray(start, nl)));
      // Flushes (as U+FFFD) a sequence left incomplete by invalid input, so it
      // cannot bleed into the next line, and resets the decoder.
      this.pending.push(this.decoder.end());
      lines.push(this.pending.join(''));
      this.pending = [];
      start = nl + 1;
    }
    if (start < chunk.length) this.pending.push(this.decoder.write(chunk.subarray(start)));
    return lines;
  }
}

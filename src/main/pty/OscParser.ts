export interface OscEvent {
  code: number;
  data: string;
}

export type OscCallback = (event: OscEvent) => void;

/**
 * Parses OSC (Operating System Command) sequences from terminal data.
 * Handles OSC 7 (CWD), OSC 9/99/777 (notifications).
 */
const MAX_BUFFER = 64 * 1024; // 64 KB

export class OscParser {
  private buffer: string[] = [];
  private inOsc = false;
  /** The last read ended in an ESC whose pair (`]` or `\`) may start the next one. */
  private pendingEsc = false;
  private callbacks: OscCallback[] = [];

  onOsc(callback: OscCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Process terminal data, extract OSC sequences, return cleaned data.
   *
   * Hot path: avoid per-character string concatenation (O(n²)) by tracking
   * the start index of the current non-OSC segment and slicing it in one go
   * whenever an OSC starts or the data ends. OSC payload accumulation also
   * uses slice-based extraction within a chunk; cross-chunk continuation
   * still carries forward via `this.buffer`.
   */
  process(data: string): string {
    if (data.length === 0) return '';
    // A read can end between ESC and `]` or `\`: the ESC held back from the
    // last read goes in front of this one, so the pair is read whole.
    if (this.pendingEsc) {
      this.pendingEsc = false;
      data = '\x1b' + data;
    }
    const len = data.length;
    // Where the bytes this read can settle end: before an ESC it holds back.
    let end = len;

    let result = '';
    let segStart = this.inOsc ? -1 : 0;     // start of current non-OSC segment in `data`
    let oscStart = this.inOsc ? 0 : -1;     // start of current OSC payload in `data`
    let i = 0;

    while (i < len) {
      const ch = data[i];

      if (this.inOsc) {
        // Look for ST (String Terminator): BEL (\x07) or ESC \ (\x1b\x5c)
        if (ch === '\x07') {
          const slice = oscStart >= 0 ? data.slice(oscStart, i) : '';
          const payload = this.buffer.length > 0 ? this.buffer.join('') + slice : slice;
          this.emitOsc(payload);
          this.buffer = [];
          this.inOsc = false;
          i++;
          oscStart = -1;
          segStart = i;
        } else if (ch === '\x1b' && i + 1 < len && data[i + 1] === '\\') {
          const slice = oscStart >= 0 ? data.slice(oscStart, i) : '';
          const payload = this.buffer.length > 0 ? this.buffer.join('') + slice : slice;
          this.emitOsc(payload);
          this.buffer = [];
          this.inOsc = false;
          i += 2;
          oscStart = -1;
          segStart = i;
        } else if (ch === '\x1b' && i + 1 === len) {
          this.pendingEsc = true;
          end = i;
          break;
        } else {
          // Still inside OSC. Cap total size to prevent unbounded growth.
          const currentRun = oscStart >= 0 ? i - oscStart + 1 : 0;
          let bufferedLen = 0;
          for (const part of this.buffer) bufferedLen += part.length;
          if (bufferedLen + currentRun > MAX_BUFFER) {
            this.buffer = [];
            this.inOsc = false;
            oscStart = -1;
            segStart = i + 1; // discard overflowed OSC; resume non-OSC after
          }
          i++;
        }
      } else if (ch === '\x1b' && i + 1 < len && data[i + 1] === ']') {
        // OSC start: ESC ] — flush pending non-OSC segment as one slice
        if (segStart >= 0 && i > segStart) {
          result += data.slice(segStart, i);
        }
        this.inOsc = true;
        this.buffer = [];
        i += 2;
        oscStart = i;
        segStart = -1;
      } else if (ch === '\x1b' && i + 1 === len) {
        // Not output yet: it reaches the output with the next read, unless that
        // read starts with `]`.
        this.pendingEsc = true;
        end = i;
        break;
      } else {
        i++;
      }
    }

    // End of chunk: flush any pending non-OSC tail and carry over OSC bytes
    if (!this.inOsc) {
      if (segStart >= 0 && end > segStart) {
        result += data.slice(segStart, end);
      }
    } else if (oscStart >= 0 && end > oscStart) {
      // OSC continues into next chunk — carry over bytes as a single string
      // (one slice per chunk) so eventual join() stays cheap.
      const carry = data.slice(oscStart, end);
      let bufferedLen = 0;
      for (const part of this.buffer) bufferedLen += part.length;
      if (bufferedLen + carry.length > MAX_BUFFER) {
        this.buffer = [];
        this.inOsc = false;
      } else {
        this.buffer.push(carry);
      }
    }

    return result;
  }

  private emitOsc(raw: string): void {
    // OSC format: code;data
    const semicolonIdx = raw.indexOf(';');
    if (semicolonIdx === -1) return;

    const codeStr = raw.substring(0, semicolonIdx);
    const code = parseInt(codeStr, 10);
    if (isNaN(code)) return;

    const data = raw.substring(semicolonIdx + 1);

    for (const cb of this.callbacks) {
      cb({ code, data });
    }
  }
}

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
  private callbacks: OscCallback[] = [];

  onOsc(callback: OscCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Process terminal data, extract OSC sequences, return cleaned data.
   */
  process(data: string): string {
    let result = '';
    let i = 0;

    while (i < data.length) {
      if (this.inOsc) {
        // Look for ST (String Terminator): BEL (\x07) or ESC \ (\x1b\x5c)
        if (data[i] === '\x07') {
          this.emitOsc(this.buffer.join(''));
          this.buffer = [];
          this.inOsc = false;
          i++;
        } else if (data[i] === '\x1b' && i + 1 < data.length && data[i + 1] === '\\') {
          this.emitOsc(this.buffer.join(''));
          this.buffer = [];
          this.inOsc = false;
          i += 2;
        } else {
          this.buffer.push(data[i]);
          // Prevent unbounded buffer growth
          if (this.buffer.length > MAX_BUFFER) {
            this.buffer = [];
            this.inOsc = false;
          }
          i++;
        }
      } else if (data[i] === '\x1b' && i + 1 < data.length && data[i + 1] === ']') {
        // OSC start: ESC ]
        this.inOsc = true;
        this.buffer = [];
        i += 2;
      } else {
        result += data[i];
        i++;
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

import { describe, it, expect } from 'vitest';
import { decodeOsc52Write } from '../osc52Clipboard';

/** Encode `s` as the base64 an app would put in an OSC 52 Pd field. */
const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

describe('decodeOsc52Write', () => {
  it('decodes a clipboard write with Pc=c', () => {
    expect(decodeOsc52Write(`c;${b64('Hello')}`)).toBe('Hello');
  });

  it('decodes with an empty Pc (default selection)', () => {
    expect(decodeOsc52Write(`;${b64('hi')}`)).toBe('hi');
  });

  it('round-trips UTF-8 (Korean + emoji)', () => {
    const text = '복사됨 😀 가나다';
    expect(decodeOsc52Write(`c;${b64(text)}`)).toBe(text);
  });

  it('always targets the system clipboard regardless of Pc selection chars', () => {
    expect(decodeOsc52Write(`p;${b64('primary')}`)).toBe('primary');
    expect(decodeOsc52Write(`s0;${b64('select0')}`)).toBe('select0');
    expect(decodeOsc52Write(`cp;${b64('both')}`)).toBe('both');
  });

  it('preserves text containing base64-significant chars (+, /, =)', () => {
    const text = 'a+b/c=d and a ; semicolon';
    expect(decodeOsc52Write(`c;${b64(text)}`)).toBe(text);
  });

  it('REFUSES a read request (Pd = "?") — no clipboard exfiltration', () => {
    expect(decodeOsc52Write('c;?')).toBeNull();
    expect(decodeOsc52Write(';?')).toBeNull();
  });

  it('REFUSES a clear request (empty Pd) — no silent wipe', () => {
    expect(decodeOsc52Write('c;')).toBeNull();
    expect(decodeOsc52Write(';')).toBeNull();
  });

  it('REFUSES a malformed payload with no ";"', () => {
    expect(decodeOsc52Write('cYWJj')).toBeNull();
    expect(decodeOsc52Write('')).toBeNull();
  });

  it('REFUSES invalid base64', () => {
    expect(decodeOsc52Write('c;@@@not-base64@@@')).toBeNull();
  });

  it('REFUSES an oversized payload before decoding', () => {
    const huge = 'c;' + 'A'.repeat(2_000_001);
    expect(decodeOsc52Write(huge)).toBeNull();
  });

  it('accepts a payload right at the size limit', () => {
    // 'A'.repeat(LEN) is valid base64; decode succeeds and returns a (large)
    // string rather than refusing. The clipboard IPC's 1 MB cap is the next gate.
    const atLimit = 'c;' + 'A'.repeat(2_000_000);
    expect(decodeOsc52Write(atLimit)).not.toBeNull();
  });
});

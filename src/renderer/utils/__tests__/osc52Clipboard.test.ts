import { describe, it, expect, vi } from 'vitest';
import { createOsc52Handler, decodeOsc52Write } from '../osc52Clipboard';

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

// #998: a copy is an act, and an act cannot be replayed. Reconnects, resyncs
// and scrollback restores write stored output back into xterm; an OSC 52 write
// inside those bytes would overwrite the live clipboard with text copied
// minutes or days earlier — the ring buffer outlives the session that produced
// it, so this could resurrect an old token off disk.
describe('createOsc52Handler — replay gate', () => {
  const payload = `c;${b64('copied text')}`;

  it('writes the clipboard for a live sequence', () => {
    const writeClipboard = vi.fn();
    const handler = createOsc52Handler({ isReplaying: () => false, writeClipboard });
    expect(handler(payload)).toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith('copied text');
  });

  it('writes nothing while a replay is in flight', () => {
    const writeClipboard = vi.fn();
    const handler = createOsc52Handler({ isReplaying: () => true, writeClipboard });
    expect(handler(payload)).toBe(true); // still consumed
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it('does not even decode while replaying (no work on stored bytes)', () => {
    const writeClipboard = vi.fn();
    // A payload that would throw inside decode if it were reached: oversized is
    // refused, but a malformed base64 exercises the try/catch. Either way the
    // gate must return before touching it.
    const handler = createOsc52Handler({ isReplaying: () => true, writeClipboard });
    expect(handler('c;!!!not-base64!!!')).toBe(true);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it('reads the flag per sequence, so the gate opens again after the replay', () => {
    const writeClipboard = vi.fn();
    let replaying = true;
    const handler = createOsc52Handler({ isReplaying: () => replaying, writeClipboard });

    handler(payload);                       // during replay — muted
    expect(writeClipboard).not.toHaveBeenCalled();

    replaying = false;
    handler(payload);                       // afterwards — accepted
    expect(writeClipboard).toHaveBeenCalledTimes(1);
  });

  it('still refuses reads and clears when not replaying', () => {
    const writeClipboard = vi.fn();
    const handler = createOsc52Handler({ isReplaying: () => false, writeClipboard });
    expect(handler('c;?')).toBe(true);  // read request
    expect(handler('c;')).toBe(true);   // clear request
    expect(writeClipboard).not.toHaveBeenCalled();
  });
});

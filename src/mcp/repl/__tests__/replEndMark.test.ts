import { describe, expect, it, vi } from 'vitest';
import { MarkedOutput } from '../ReplSession';

const MARK = Buffer.from('\0end:42\0');

describe('MarkedOutput', () => {
  it('ends the run at its mark, strips it, and keeps what follows for the next take', () => {
    const settled = vi.fn();
    const output = new MarkedOutput(settled);
    output.expect(MARK);
    output.append(Buffer.from('mine'));
    expect(output.settled).toBe(false);
    output.append(Buffer.concat([Buffer.from(' too'), MARK, Buffer.from('later')]));
    expect(output.settled).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    output.append(Buffer.from(' still later'));
    expect(output.take()).toMatchObject({ text: 'mine too', totalBytes: 8 });
    expect(output.take()).toMatchObject({ text: 'later still later', totalBytes: 17 });
  });

  it('finds a mark split across chunks, byte by byte', () => {
    const output = new MarkedOutput();
    output.expect(MARK);
    const stream = Buffer.concat([Buffer.from('a\0en'), MARK, Buffer.from('b')]);
    for (const byte of stream) output.append(Buffer.from([byte]));
    expect(output.take().text).toBe('a\0en');
    expect(output.take().text).toBe('b');
  });

  it('gives back a held possible mark start when the mark never comes', () => {
    const output = new MarkedOutput();
    output.expect(MARK);
    output.append(Buffer.from('x\0end:4'));
    expect(output.settled).toBe(false);
    expect(output.take()).toMatchObject({ text: 'x\0end:4', totalBytes: 7 });
    // No run open: everything passes straight through.
    output.append(MARK);
    expect(output.take().totalBytes).toBe(MARK.length);
  });

  it('settles when the pipe closes before the mark', () => {
    const settled = vi.fn();
    const output = new MarkedOutput(settled);
    output.expect(MARK);
    output.end();
    expect(output.settled).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

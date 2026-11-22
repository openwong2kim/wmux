import { StringDecoder } from 'node:string_decoder';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LineFramer } from '../lineFramer';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LineFramer', () => {
  it('round-trips a Korean response split at every byte offset', () => {
    const response = JSON.stringify({ id: 'a', ok: true, result: { text: '안녕하세요, 세계 🌏 — 한글 응답' } });
    const bytes = Buffer.from(`${response}\n`, 'utf8');
    for (let cut = 0; cut <= bytes.length; cut++) {
      const framer = new LineFramer();
      const lines = [...framer.push(bytes.subarray(0, cut)), ...framer.push(bytes.subarray(cut))];
      expect(lines, `cut at byte ${cut}`).toEqual([response]);
    }
  });

  it('round-trips a response delivered one byte at a time', () => {
    const response = '{"text":"가나다라마바사"}';
    const bytes = Buffer.from(`${response}\n${response}\n`, 'utf8');
    const framer = new LineFramer();
    const lines: string[] = [];
    for (let i = 0; i < bytes.length; i++) lines.push(...framer.push(bytes.subarray(i, i + 1)));
    expect(lines).toEqual([response, response]);
  });

  it('keeps the tail of an unfinished line for the next chunk', () => {
    const framer = new LineFramer();
    expect(framer.push(Buffer.from('one\ntw'))).toEqual(['one']);
    expect(framer.push(Buffer.from('o\n\nthree'))).toEqual(['two', '']);
    expect(framer.push(Buffer.from('\n'))).toEqual(['three']);
  });

  it('decodes each byte of a large multi-chunk response once', () => {
    const write = vi.spyOn(StringDecoder.prototype, 'write');
    const line = JSON.stringify({ id: 'big', ok: true, result: '한'.repeat(1_000_000) });
    const bytes = Buffer.from(`${line}\n`, 'utf8');
    const framer = new LineFramer();
    const lines: string[] = [];
    for (let at = 0; at < bytes.length; at += 64 * 1024) lines.push(...framer.push(bytes.subarray(at, at + 64 * 1024)));
    expect(lines).toEqual([line]);
    // The old reader re-decoded and re-split the whole buffer on every chunk:
    // ~48 chunks of a 3MB line meant ~72MB of work. Each byte is decoded once now.
    const decoded = write.mock.calls.reduce((sum, [chunk]) => sum + (chunk as Buffer).length, 0);
    expect(decoded).toBe(bytes.length - 1);
  });
});

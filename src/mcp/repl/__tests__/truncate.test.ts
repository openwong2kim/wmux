import { describe, expect, it } from 'vitest';
import { OutputBuffer, truncateText } from '../truncate';

describe('truncateText', () => {
  it('leaves text under the cap untouched', () => {
    const result = truncateText('hello world', 1024);
    expect(result.text).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.elidedBytes).toBe(0);
    expect(result.totalBytes).toBe(11);
  });

  it('keeps head and tail and reports the elided byte count', () => {
    const input = `${'a'.repeat(500)}${'b'.repeat(500)}${'c'.repeat(500)}`;
    const result = truncateText(input, 400);
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(1500);
    // Head is 75% of the cap, tail the remainder; the middle is what goes.
    expect(result.text.startsWith('a'.repeat(300))).toBe(true);
    expect(result.text.endsWith('c'.repeat(100))).toBe(true);
    expect(result.elidedBytes).toBe(1100);
    expect(result.text).toContain('1100 bytes elided');
  });

  it('never cuts a multi-byte codepoint in half', () => {
    const input = '한'.repeat(400); // 3 bytes each
    const result = truncateText(input, 100);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('�');
  });
});

describe('OutputBuffer', () => {
  it('renders everything when the total stays under the cap', () => {
    const buf = new OutputBuffer(1024);
    buf.append(Buffer.from('one '));
    buf.append(Buffer.from('two'));
    const result = buf.render();
    expect(result.text).toBe('one two');
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(7);
  });

  it('counts every byte while retaining only head and tail', () => {
    const buf = new OutputBuffer(1000);
    for (let i = 0; i < 1000; i++) buf.append(Buffer.from('0123456789'));
    const result = buf.render();
    expect(result.totalBytes).toBe(10_000);
    expect(result.truncated).toBe(true);
    // Retention is bounded by the cap plus the elision marker, no matter how
    // much arrived — this is the property that protects the shared broker.
    expect(Buffer.byteLength(result.text)).toBeLessThan(1100);
    expect(result.elidedBytes).toBe(9000);
  });

  it('keeps the most recent bytes in the tail', () => {
    const buf = new OutputBuffer(400);
    buf.append(Buffer.from('S'.repeat(1000)));
    buf.append(Buffer.from('END'));
    const result = buf.render();
    expect(result.text.endsWith('END')).toBe(true);
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { compactScrollback, installScrollbackCompactionFor, isLineCompacted, type CompactableTerminal } from '../scrollbackCompaction';

// The renderer's own build (@xterm/xterm, minified) and not only headless:
// the probe must find its BufferLine, and its rows must round-trip.
describe('scrollback compaction on @xterm/xterm', () => {
  it('installs through a probe terminal and packs rows of a terminal built after it', async () => {
    expect(installScrollbackCompactionFor(Terminal)).toBe(true);
    const term = new Terminal({ cols: 30, rows: 5, scrollback: 1000, allowProposedApi: true });
    let data = '';
    for (let i = 0; i < 400; i++) data += `\x1b[3${i % 8}mrow ${i} 한글\x1b[0m\r\n`;
    await new Promise<void>((resolve) => term.write(data, resolve));
    const before = Array.from({ length: term.buffer.normal.length }, (_, i) => term.buffer.normal.getLine(i)?.translateToString(true));
    expect(compactScrollback(term as unknown as CompactableTerminal).compacted).toBeGreaterThan(200);
    const line = (term as unknown as { _core: { buffers: { normal: { lines: { get(i: number): object } } } } })._core.buffers.normal.lines.get(10);
    expect(isLineCompacted(line)).toBe(true);
    const after = Array.from({ length: term.buffer.normal.length }, (_, i) => term.buffer.normal.getLine(i)?.translateToString(true));
    expect(after).toEqual(before);
    expect(term.buffer.normal.getLine(10)?.getCell(0)?.getFgColor()).toBe(2);
    expect(isLineCompacted(line)).toBe(false);
    term.dispose();
  });
});

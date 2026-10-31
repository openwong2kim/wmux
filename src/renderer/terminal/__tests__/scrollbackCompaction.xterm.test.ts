// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  __resetCompactionForTests,
  compactScrollback,
  installScrollbackCompactionFor,
  isCompactionDisabled,
  isLineCompacted,
  type CompactableTerminal,
} from '../scrollbackCompaction';

// The renderer's own build (@xterm/xterm, minified) and not only headless:
// the probe must find its BufferLine, and its rows must round-trip.
describe('scrollback compaction on @xterm/xterm', () => {
  it('a probe that throws, or has no buffer lines, turns compaction off instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class Throws {
      constructor() {
        throw new Error('no terminal');
      }
      dispose = (): void => undefined;
    }
    class NoLines {
      _core = { buffer: {} };
      dispose = (): void => undefined;
    }
    for (const Ctor of [Throws, NoLines]) {
      __resetCompactionForTests();
      expect(installScrollbackCompactionFor(Ctor as never)).toBe(false);
      expect(isCompactionDisabled()).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    __resetCompactionForTests();
  });

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
    // A cell read leaves the row packed; a write into it unpacks it.
    expect(term.buffer.normal.getLine(10)?.getCell(0)?.getFgColor()).toBe(2);
    expect(isLineCompacted(line)).toBe(true);
    (line as unknown as { setCellFromCodepoint(i: number, cp: number, w: number, attrs: object): void }).setCellFromCodepoint(0, 0x5a, 1, {
      fg: 0,
      bg: 0,
      extended: {},
    });
    expect(isLineCompacted(line)).toBe(false);
    expect(term.buffer.normal.getLine(10)?.translateToString(true).startsWith('Zow 10')).toBe(true);
    term.dispose();
  });
});

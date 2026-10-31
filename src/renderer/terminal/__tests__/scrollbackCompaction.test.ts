import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SearchAddon } from '@xterm/addon-search';
import {
  __resetCompactionForTests,
  attachScrollbackCompaction,
  bufferLineClassOf,
  compactLine,
  compactScrollback,
  decodeCells,
  encodeCells,
  installScrollbackCompactionFor,
  isCompactionDisabled,
  isLineCompacted,
  COMPACTION_MARGIN,
  type CompactableTerminal,
} from '../scrollbackCompaction';

// Two copies of @xterm/headless: compaction is installed on the first copy's
// BufferLine only, so the second is xterm with no patch at all.
const req = createRequire(__filename);
const headlessPath = req.resolve('@xterm/headless');
const Patched = req(headlessPath) as typeof import('@xterm/headless');
delete req.cache[headlessPath];
const Plain = req(headlessPath) as typeof import('@xterm/headless');

/* eslint-disable @typescript-eslint/no-explicit-any -- xterm internals */
type Line = any;
type Cell = any;

const IS_COMBINED = 0x200000;
const HAS_EXTENDED = 0x10000000;
const PROTECTED = 0x20000000;
const CM_RGB = 0x3000000;
const CM_P256 = 0x2000000;

let LineClass: new (cols: number, fill?: Cell, isWrapped?: boolean) => Line;
let CellData: new () => Cell;
let ExtendedAttrs: new () => any;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randomColor(r: () => number): number {
  const kind = r();
  if (kind < 0.4) return 0;
  if (kind < 0.7) return CM_P256 | Math.floor(r() * 256);
  return CM_RGB | Math.floor(r() * 0x1000000);
}

function randomCell(r: () => number): Cell {
  const cell = new CellData();
  const kind = r();
  cell.fg = randomColor(r) | (r() < 0.2 ? Math.floor(r() * 256) << 26 : 0);
  cell.bg = randomColor(r);
  if (r() < 0.1) cell.bg |= PROTECTED;
  if (kind < 0.2) {
    cell.content = 1 << 22;
  } else if (kind < 0.55) {
    cell.content = (0x20 + Math.floor(r() * 95)) | (1 << 22);
  } else if (kind < 0.65) {
    cell.content = (0xac00 + Math.floor(r() * 11000)) | (2 << 22);
  } else if (kind < 0.72) {
    cell.content = IS_COMBINED | (1 << 22);
    cell.combinedData = r() < 0.5 ? 'é' : '\u{1F468}‍\u{1F469}';
  } else if (kind < 0.8) {
    cell.content = (0x1f300 + Math.floor(r() * 500)) | ((r() < 0.5 ? 2 : 1) << 22);
  } else if (kind < 0.9) {
    // Any bit pattern must survive, flags included (bits 24-31 of content,
    // which no xterm path sets, are covered by the raw round trip below).
    cell.content = Math.floor(r() * 0x1000000) & ~IS_COMBINED;
    cell.fg = Math.floor(r() * 0x100000000);
    cell.bg = Math.floor(r() * 0x100000000) & ~HAS_EXTENDED;
  } else {
    cell.content = (0x41 + Math.floor(r() * 26)) | (1 << 22);
  }
  if (r() < 0.12) {
    const ext = new ExtendedAttrs();
    ext.underlineStyle = 1 + Math.floor(r() * 5);
    ext.underlineColor = CM_RGB | Math.floor(r() * 0x1000000);
    ext.urlId = 1 + Math.floor(r() * 50);
    cell.extended = ext;
    cell.bg |= HAS_EXTENDED;
  }
  return cell;
}

function randomLine(r: () => number): Line {
  const cols = 1 + Math.floor(r() * 120);
  const line = new LineClass(cols);
  const filled = r() < 0.3 ? cols : Math.floor(r() * cols);
  for (let i = 0; i < filled; i++) {
    const cell = randomCell(r);
    line.setCell(i, cell);
    if (cell.content >>> 22 === 2 && i + 1 < cols) {
      const half = new CellData();
      half.content = 0;
      half.fg = cell.fg;
      half.bg = cell.bg & ~HAS_EXTENDED;
      line.setCell(++i, half);
    }
  }
  if (filled < cols && r() < 0.5) {
    // A trailing run that is not the default blank: bg-coloured or text.
    const tail = randomCell(r);
    tail.content = r() < 0.5 ? 1 << 22 : 0x3d | (1 << 22);
    tail.bg &= ~HAS_EXTENDED;
    for (let i = filled; i < cols; i++) line.setCell(i, tail);
  }
  return line;
}

function packedCopy(line: Line): Line {
  const copy = line.clone();
  expect(compactLine(copy)).toBe(true);
  expect(isLineCompacted(copy)).toBe(true);
  return copy;
}

function cellState(line: Line, i: number): unknown {
  const cell = line.loadCell(i, new CellData());
  return [cell.content, cell.fg, cell.bg, cell.combinedData, JSON.stringify(cell.extended)];
}

function lineState(line: Line): unknown {
  const cells = [];
  for (let i = 0; i < line.length; i++) cells.push(cellState(line, i));
  return { length: line.length, isWrapped: line.isWrapped, text: line.translateToString(false), cells };
}

describe('scrollback compaction', () => {
  beforeAll(() => {
    expect(installScrollbackCompactionFor(Patched.Terminal as never)).toBe(true);
    const probe = new Patched.Terminal({ cols: 4, rows: 2, allowProposedApi: true });
    const line = (probe as any)._core.buffer.lines.get(0);
    LineClass = line.constructor;
    CellData = line.getCell(0).constructor;
    ExtendedAttrs = line.getCell(0).extended.constructor;
    expect(bufferLineClassOf(probe)).toBe(LineClass);
    probe.dispose();
  });

  beforeEach(() => {
    __resetCompactionForTests();
  });

  it('any 96-bit cell pattern round-trips', () => {
    const r = rng(7);
    for (let iter = 0; iter < 2000; iter++) {
      const n = Math.floor(r() * 90);
      const d = new Uint32Array(n * 3);
      for (let i = 0; i < d.length; i++) d[i] = r() < 0.3 ? 0 : Math.floor(r() * 0x100000000);
      if (n > 4 && r() < 0.5) d.copyWithin(3, 0, (n - 1) * 3 - 3 > 0 ? 3 : 0);
      const tailFrom = Math.floor(r() * n);
      for (let i = tailFrom; i < n; i++) d.copyWithin(i * 3, tailFrom * 3, tailFrom * 3 + 3);
      const out = new Uint32Array(n * 3);
      decodeCells(encodeCells(d, n), n, out);
      expect(out).toEqual(d);
    }
  });

  it('a packed row answers every BufferLine method exactly as the original does', async () => {
    const r = rng(1234);
    let resizedPacked = 0;
    for (let iter = 0; iter < 400; iter++) {
      const twin = randomLine(r);
      const n = twin.length;

      // Cell reads leave the rows packed once the task ends. Two packed rows
      // read in turn also check that the shared decode follows the row being read.
      const cellsA = packedCopy(twin);
      const otherTwin = randomLine(r);
      const cellsB = packedCopy(otherTwin);
      for (let i = 0; i < n; i++) {
        expect(cellState(cellsA, i)).toEqual(cellState(twin, i));
        if (i < otherTwin.length) expect(cellState(cellsB, i)).toEqual(cellState(otherTwin, i));
      }
      await Promise.resolve();
      expect([isLineCompacted(cellsA), isLineCompacted(cellsB)]).toEqual([true, true]);
      const packed = packedCopy(twin);
      for (let i = 0; i < n; i++) {
        expect([packed.isCombined(i), packed.getWidth(i), packed.getFg(i), packed.getBg(i)]).toEqual([
          twin.isCombined(i),
          twin.getWidth(i),
          twin.getFg(i),
          twin.getBg(i),
        ]);
      }
      for (const x of [-1, 0, n - 1, n]) {
        expect(packed.getCell(x)?.getAsCharData()).toEqual(twin.getCell(x)?.getAsCharData());
        expect(packed.get(Math.max(0, Math.min(x, n - 1)))).toEqual(twin.get(Math.max(0, Math.min(x, n - 1))));
      }
      await Promise.resolve();
      expect(isLineCompacted(packed)).toBe(true);

      // Read whole rows without inflating them.
      const reader = packedCopy(twin);
      expect(reader.getTrimmedLength()).toBe(twin.getTrimmedLength());
      expect(reader.getNoBgTrimmedLength()).toBe(twin.getNoBgTrimmedLength());
      for (const [trim, start, end] of [
        [false, undefined, undefined],
        [true, undefined, undefined],
        [true, 1, undefined],
        [false, 2, Math.max(2, n - 3)],
      ] as const) {
        const outA: number[] = [];
        const outB: number[] = [];
        expect(reader.translateToString(trim, start, end, outA)).toBe(twin.translateToString(trim, start, end, outB));
        expect(outA).toEqual(outB);
        expect(reader.translateToString(trim, start, end)).toBe(twin.translateToString(trim, start, end));
      }
      expect(isLineCompacted(reader)).toBe(true);
      expect(reader._cache).toBe('');

      // resize: grow, shrink to and below the trimmed length, with blank and coloured fill.
      const trimmed = twin.getTrimmedLength();
      for (const cols of [n + 7, n + 1, Math.max(1, trimmed), Math.max(1, trimmed - 1), Math.max(1, n - 1), 1]) {
        for (const fillKind of [0, 1]) {
          const fill = new CellData();
          fill.content = 1 << 22;
          fill.fg = 0;
          fill.bg = fillKind ? CM_P256 | 4 : 0;
          const a = packedCopy(twin);
          const b = twin.clone();
          a.resize(cols, fill);
          b.resize(cols, fill);
          if (isLineCompacted(a)) resizedPacked++;
          expect(a.getTrimmedLength()).toBe(b.getTrimmedLength());
          expect(lineState(a)).toEqual(lineState(b));
          // A second width change from the resized (possibly still packed) row.
          a.resize(cols + 3, fill);
          b.resize(cols + 3, fill);
          expect(lineState(a)).toEqual(lineState(b));
        }
      }

      // copyFrom in both directions, and clone.
      const other = randomLine(r);
      for (const blank of [false, true]) {
        const a = packedCopy(twin);
        const b = twin.clone();
        a.copyFrom(other, blank);
        b.copyFrom(other, blank);
        expect(lineState(a)).toEqual(lineState(b));
        const c = other.clone();
        const d = other.clone();
        c.copyFrom(packedCopy(twin), blank);
        d.copyFrom(twin, blank);
        expect(lineState(c)).toEqual(lineState(d));
      }
      expect(lineState(packedCopy(twin).clone())).toEqual(lineState(twin.clone()));
    }
    // The no-decode resize paths ran, not only the inflate fallback.
    expect(resizedPacked).toBeGreaterThan(500);
  });

  it('two terminals, one compacting every row after every write, hold the same buffer', async () => {
    const r = rng(42);
    const opts = { cols: 40, rows: 10, scrollback: 400, allowProposedApi: true };
    const a = new Patched.Terminal(opts);
    const b = new Plain.Terminal(opts);
    const write = (t: HeadlessTerminal, data: string) => new Promise<void>((resolve) => t.write(data, resolve));
    const words = ['hello', '세계', '漢字テスト', '\u{1F600}\u{1F680}', 'é', 'a‍b', 'x'.repeat(70), '─'.repeat(45)];
    const sgr = () => {
      const k = r();
      if (k < 0.3) return '\x1b[0m';
      if (k < 0.5) return `\x1b[3${Math.floor(r() * 8)}m`;
      if (k < 0.7) return `\x1b[48;2;${Math.floor(r() * 256)};${Math.floor(r() * 256)};${Math.floor(r() * 256)}m`;
      if (k < 0.8) return `\x1b[4:3m\x1b[58;2;10;20;30m`;
      if (k < 0.9) return `\x1b]8;;https://e.x/${Math.floor(r() * 9)}\x07`;
      return '\x1b[1;7m';
    };
    const compare = () => {
      const la = (a as any)._core.buffers.normal;
      const lb = (b as any)._core.buffers.normal;
      expect([la.lines.length, la.ybase, la.ydisp, la.x, la.y]).toEqual([lb.lines.length, lb.ybase, lb.ydisp, lb.x, lb.y]);
      for (let i = 0; i < la.lines.length; i++) {
        const x = la.lines.get(i);
        const y = lb.lines.get(i);
        expect(x.translateToString(true)).toBe(y.translateToString(true));
        const ca = new CellData();
        for (let c = 0; c < y.length; c++) {
          const cb = y.loadCell(c, new (y.getCell(0).constructor)());
          x.loadCell(c, ca);
          expect([ca.content, ca.fg, ca.bg, ca.combinedData, ca.extended.underlineColor, ca.extended.urlId]).toEqual([
            cb.content,
            cb.fg,
            cb.bg,
            cb.combinedData,
            cb.extended.underlineColor,
            cb.extended.urlId,
          ]);
        }
        expect([x.length, x.isWrapped]).toEqual([y.length, y.isWrapped]);
      }
    };
    let packed = 0;
    let keptPackedByResize = 0;
    const packAll = () => {
      const lines = (a as any)._core.buffers.normal.lines;
      for (let i = 0; i < lines.length; i++) if (compactLine(lines.get(i))) packed++;
    };
    const countPacked = () => {
      const lines = (a as any)._core.buffers.normal.lines;
      let count = 0;
      for (let i = 0; i < lines.length; i++) if (isLineCompacted(lines.get(i))) count++;
      return count;
    };

    for (let step = 0; step < 300; step++) {
      let chunk = '';
      for (let j = 0; j < 12; j++) {
        chunk += sgr() + words[Math.floor(r() * words.length)] + (r() < 0.4 ? '\r\n' : ' ');
      }
      const k = r();
      if (k < 0.03) chunk += '\x1b[2J';
      else if (k < 0.05) chunk += '\x1b[3J';
      else if (k < 0.07) chunk += '\x1b[3S';
      else if (k < 0.09) chunk += '\x1b[2;5r\x1b[5;1H\n\n\x1b[r';
      else if (k < 0.11) chunk += '\x1b[5;3H\x1b[2@\x1b[3P\x1b[4X';
      await write(a, chunk);
      await write(b, chunk);
      packAll();
      if (r() < 0.08) {
        const cols = 20 + Math.floor(r() * 50);
        const rows = 5 + Math.floor(r() * 12);
        a.resize(cols, rows);
        b.resize(cols, rows);
        keptPackedByResize += countPacked();
        packAll();
      }
      if (r() < 0.05) {
        a.scrollLines(-7);
        b.scrollLines(-7);
      }
      if (step % 25 === 0) compare();
    }
    compare();
    expect(packed).toBeGreaterThan(5000);
    expect(keptPackedByResize).toBeGreaterThan(1000);
    expect(isCompactionDisabled()).toBe(false);
    a.dispose();
    b.dispose();
  });

  it('the sweep leaves the rows near the bottom and around a scrolled-up viewport uncompacted', async () => {
    const term = new Patched.Terminal({ cols: 30, rows: 10, scrollback: 2000, allowProposedApi: true });
    let data = '';
    for (let i = 0; i < 1500; i++) data += `line ${i}\r\n`;
    await new Promise<void>((resolve) => term.write(data, resolve));
    term.scrollLines(-700);
    const buf = (term as any)._core.buffers.normal;
    const { compacted } = compactScrollback(term as unknown as CompactableTerminal);
    expect(compacted).toBeGreaterThan(1000);
    for (let i = 0; i < buf.lines.length; i++) {
      const nearBottom = i >= buf.ybase - (term.rows + COMPACTION_MARGIN);
      const nearView = i >= buf.ydisp - COMPACTION_MARGIN && i < buf.ydisp + term.rows + COMPACTION_MARGIN;
      expect(isLineCompacted(buf.lines.get(i))).toBe(!nearBottom && !nearView);
    }
    expect(term.buffer.active.getLine(3)?.translateToString(true)).toBe('line 3');
    expect(isLineCompacted(buf.lines.get(3))).toBe(true);
    term.dispose();
  });

  it('a row that does not survive the round trip stays as it was and turns compaction off once', () => {
    const line = new LineClass(10);
    const cell = new CellData();
    cell.content = 0x41 | (1 << 22);
    line.setCell(0, cell);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = vi.spyOn(String, 'fromCharCode').mockReturnValue('\u0000\u0001\u0000\u0000B');
    expect(compactLine(line)).toBe(false);
    spy.mockRestore();
    expect(isLineCompacted(line)).toBe(false);
    expect(line.translateToString(true)).toBe('A');
    expect(isCompactionDisabled()).toBe(true);
    expect(compactLine(new LineClass(4))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a header that misstates the trimmed length or the shrink bound turns compaction off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // 'A' and nine default blanks: the true header is flags 1, k 2, t 2, m 1.
    for (const header of ['\u0001\u0002\u0005\u0001', '\u0001\u0002\u0002\u0000']) {
      __resetCompactionForTests();
      const line = new LineClass(10);
      const cell = new CellData();
      cell.content = 0x41 | (1 << 22);
      line.setCell(0, cell);
      const spy = vi.spyOn(String, 'fromCharCode').mockReturnValue(`${header}A\u0000`);
      expect(compactLine(line)).toBe(false);
      spy.mockRestore();
      expect(isLineCompacted(line)).toBe(false);
      expect(isCompactionDisabled()).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('a search over packed rows leaves them packed', async () => {
    const term = new Patched.Terminal({ cols: 20, rows: 5, scrollback: 2000, allowProposedApi: true });
    let data = '';
    for (let i = 0; i < 300; i++) data += `${'w'.repeat(30)} ${i} needle\r\n`;
    await new Promise<void>((resolve) => term.write(data, resolve));
    Object.assign(term, { getSelectionPosition: () => undefined, clearSelection: () => undefined, select: () => undefined });
    const search = new SearchAddon();
    term.loadAddon(search as never);
    const { compacted } = compactScrollback(term as unknown as CompactableTerminal);
    expect(search.findNext('absent text')).toBe(false);
    expect(search.findNext('needle')).toBe(true);
    // Rows the scan reread are unpacked until the task ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lines = (term as any)._core.buffers.normal.lines;
    let packed = 0;
    for (let i = 0; i < lines.length; i++) if (isLineCompacted(lines.get(i))) packed++;
    expect(packed).toBe(compacted);
    term.dispose();
  });

  it('a row read again in one task is unpacked until the task ends, then packed unless it changed', async () => {
    const twin = new LineClass(8);
    for (let i = 0; i < 8; i++) twin.setCellFromCodepoint(i, 0x61 + i, 1, { fg: i, bg: 0, extended: new ExtendedAttrs() });
    const kept = packedCopy(twin);
    const written = packedCopy(twin);
    for (const line of [kept, written]) {
      line.getCell(0);
      expect(isLineCompacted(line)).toBe(true);
      line.getCell(1);
      expect(isLineCompacted(line)).toBe(false);
    }
    written._data[0] = 0x5a | (1 << 22);
    await Promise.resolve();
    expect(isLineCompacted(kept)).toBe(true);
    expect(lineState(kept)).toEqual(lineState(twin));
    expect(isLineCompacted(written)).toBe(false);
    expect(written.translateToString(true)).toBe('Zbcdefgh');
  });

  it('a slice that requestIdleCallback runs by its timeout still gets a working budget', async () => {
    const callbacks: Array<(deadline: { didTimeout: boolean; timeRemaining(): number }) => void> = [];
    vi.stubGlobal('requestIdleCallback', (cb: (typeof callbacks)[number]) => callbacks.push(cb));
    vi.stubGlobal('cancelIdleCallback', () => undefined);
    const term = new Patched.Terminal({ cols: 20, rows: 5, scrollback: 2000, allowProposedApi: true });
    const sweep = attachScrollbackCompaction(term as unknown as CompactableTerminal);
    let data = '';
    for (let i = 0; i < 1000; i++) data += `row ${i}\r\n`;
    await new Promise<void>((resolve) => term.write(data, resolve));
    expect(callbacks.length).toBe(1);
    // A frozen clock: the 4 ms budget never runs out, so one slice does all.
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    callbacks[0]({ didTimeout: true, timeRemaining: () => 0 });
    now.mockRestore();
    const buf = (term as any)._core.buffers.normal;
    let packed = 0;
    for (let i = 0; i < buf.lines.length; i++) if (isLineCompacted(buf.lines.get(i))) packed++;
    expect(packed).toBe(buf.ybase - (term.rows + COMPACTION_MARGIN));
    sweep.dispose();
    term.dispose();
    vi.unstubAllGlobals();
  });
});

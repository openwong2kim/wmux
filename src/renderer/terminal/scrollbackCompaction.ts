// Experimental scrollback compaction (off by default; uiSlice
// `terminalCompactScrollback`).
//
// Every xterm row holds `_data = new Uint32Array(cols * 3)`: content, fg and
// bg for each cell, whether the cell is blank or not. At 8 panes of 10k rows
// that is most of the renderer heap, for rows nobody is looking at. This
// module patches xterm's BufferLine at runtime (no rebuild, no vendoring) so
// rows well above the viewport keep the same 96 bits per cell in a one-byte
// string instead, and get their Uint32Array back the moment anything reads
// `_data`:
//
//  - `_data` becomes an accessor on BufferLine.prototype. The constructor's
//    `this._data = ...` goes through the setter into `_rawData`; the getter
//    returns `_rawData`, or decodes `_packed` back into it when the row is
//    compacted. Every xterm method keeps working unchanged, it just inflates
//    the row first.
//  - A few whole-row methods that run over the entire scrollback (resize on a
//    width change, getTrimmedLength during reflow, translateToString for
//    search and the autosave dump, cleanupMemory after a resize) are wrapped
//    to answer from the packed row without inflating it.
//  - An idle sweep, like xterm's own `_memoryCleanupQueue`, compacts rows
//    older than ybase - (rows + MARGIN) and never the rows around ydisp.
//
// Nothing is installed while the setting is off. Each compaction is decoded
// again and compared word for word with the original; a mismatch keeps the
// original row and turns compaction off for the rest of the session.

/** Rows kept uncompacted above the bottom viewport and around ydisp. */
export const COMPACTION_MARGIN = 100;

// Content word layout (xterm common/buffer/Constants.ts).
const CODEPOINT_AND_COMBINED = 0x3fffff;
const WIDTH_SHIFT = 22;
const DEFAULT_CONTENT = 1 << WIDTH_SHIFT; // width 1, no codepoint

// Packed row format, one char per byte (all codes < 256, so V8 keeps it a
// one-byte string):
//   header: flags, varint k, varint t, varint m
//     flags bit 0: the trailing run is the default blank cell (0x400000/0/0)
//     k: cells stored; cells k..length-1 repeat cell k-1 (the trailing run)
//     t: getTrimmedLength() + 1, or 0 when it must be computed
//     m: the smallest width a no-decode shrink may cut to (see `resize`)
//   cells 0..k-1, fg/bg carried over from the previous cell (start 0/0):
//     0x00-0x7f: an ASCII cell of width 1 (content = byte | 0x400000)
//     0x80 | bits: tag
//       bit 0: fg follows (u32 LE)
//       bit 1: bg follows (u32 LE)
//       bits 2-3: content: 0 width 1, 1 width 2, 2 width 0 (each a varint
//         of content & 0x3fffff), 3 raw u32 LE
//       bit 4: varint (count - 2) follows; the cell repeats count times
const FLAG_DEFAULT_TAIL = 1;
const TAG = 0x80;
const TAG_FG = 1;
const TAG_BG = 2;
const TAG_RUN = 0x10;

/** The BufferLine fields this module reads or writes (all survive minification). */
interface CompactableLine {
  _rawData: Uint32Array | null | undefined;
  _packed: string | null | undefined;
  length: number;
  _combined: Record<number, string>;
  _extendedAttrs: Record<number, unknown>;
  _cache: string;
  _cacheValid: boolean;
}

interface FillCell {
  content: number;
  fg: number;
  bg: number;
}

type LineMethod = (this: CompactableLine, ...args: never[]) => unknown;

let installedProto: object | null = null;
let disabled = false;
let warned = false;

let outBytes = new Uint8Array(1024);
let scratch = new Uint32Array(768);
let pos = 0;
// The row whose full decode `scratch` holds, so cell-by-cell reads of one
// packed row (search reads every cell of a match row) decode it once.
let scratchRow: CompactableLine | null = null;
let scratchPacked: string | null = null;
let scratchLength = -1;
let scratchRowView: Uint32Array = scratch;
// A row whose cells are read again in the same task is unpacked until the
// task ends: addon-search walks a whole wrap group again for every row of the
// group, so per-read decodes and the wrapper around every cell read cost more
// than the scan itself. A one-pass scan (the autosave dump, wmux's pane
// search) only fills `readOnce`.
const HELD_BUDGET_WORDS = 2 * 1024 * 1024; // 8 MiB
let readOnce = new Set<CompactableLine>();
let held = new Map<CompactableLine, string>();
let heldWords = 0;
let releaseScheduled = false;
let origGetTrimmedLength: LineMethod | null = null;

function isPacked(line: CompactableLine): boolean {
  return line._rawData === null;
}

function ensureOut(size: number): void {
  if (outBytes.length < size) outBytes = new Uint8Array(Math.max(size, outBytes.length * 2));
}

function scratchView(words: number): Uint32Array {
  scratchRow = null;
  if (scratch.length < words) scratch = new Uint32Array(Math.max(words, scratch.length * 2));
  return scratch.subarray(0, words);
}

function putVarint(o: number, v: number): number {
  while (v >= 0x80) {
    outBytes[o++] = (v & 0x7f) | 0x80;
    v >>>= 7;
  }
  outBytes[o++] = v;
  return o;
}

function putU32(o: number, v: number): number {
  outBytes[o] = v & 0xff;
  outBytes[o + 1] = (v >>> 8) & 0xff;
  outBytes[o + 2] = (v >>> 16) & 0xff;
  outBytes[o + 3] = v >>> 24;
  return o + 4;
}

function readVarint(z: string): number {
  let v = 0;
  let shift = 0;
  let b: number;
  do {
    b = z.charCodeAt(pos++);
    v += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return v;
}

function readU32(z: string): number {
  const v = (z.charCodeAt(pos) | (z.charCodeAt(pos + 1) << 8) | (z.charCodeAt(pos + 2) << 16) | (z.charCodeAt(pos + 3) << 24)) >>> 0;
  pos += 4;
  return v;
}

function bytesToString(len: number): string {
  const CHUNK = 8192;
  if (len <= CHUNK) return String.fromCharCode.apply(null, outBytes.subarray(0, len) as unknown as number[]);
  const parts: string[] = [];
  for (let i = 0; i < len; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, outBytes.subarray(i, Math.min(i + CHUNK, len)) as unknown as number[]));
  }
  return parts.join('');
}

function sameCell(d: Uint32Array, a: number, b: number): boolean {
  return d[a * 3] === d[b * 3] && d[a * 3 + 1] === d[b * 3 + 1] && d[a * 3 + 2] === d[b * 3 + 2];
}

/** Encodes the first `n` cells of `d` (exported for tests). */
export function encodeCells(d: Uint32Array, n: number): string {
  let k = n;
  while (k > 1 && sameCell(d, k - 2, n - 1)) k--;

  // t: trimmed length + 1 when the trailing run is blank, else 0.
  // m: no-decode shrinks to cols >= m keep every content cell, the trimmed
  // length and the width of cell cols - 1 (never 2) exactly as they were.
  let t = 0;
  let m = 0;
  if (n > 0) {
    const tail = (n - 1) * 3;
    let lastContent = -1;
    if (d[tail] & CODEPOINT_AND_COMBINED) {
      lastContent = n - 1;
    } else {
      for (let j = k - 2; j >= 0; j--) {
        if (d[j * 3] & CODEPOINT_AND_COMBINED) {
          lastContent = j;
          break;
        }
      }
      const trimmed = lastContent < 0 ? 0 : lastContent + (d[lastContent * 3] >> WIDTH_SHIFT);
      t = trimmed >= 0 ? trimmed + 1 : 0;
    }
    let lastWide = -1;
    if (d[tail] >> WIDTH_SHIFT === 2) {
      lastWide = n - 1;
    } else {
      for (let j = k - 2; j >= 0; j--) {
        if (d[j * 3] >> WIDTH_SHIFT === 2) {
          lastWide = j;
          break;
        }
      }
    }
    m = Math.max(lastContent + 1, t > 0 ? t - 1 : 0, lastWide + 2);
  }

  ensureOut(16 + k * 18);
  const defaultTail = n > 0 && d[(n - 1) * 3] === DEFAULT_CONTENT && d[(n - 1) * 3 + 1] === 0 && d[(n - 1) * 3 + 2] === 0;
  outBytes[0] = defaultTail ? FLAG_DEFAULT_TAIL : 0;
  let o = putVarint(1, k);
  o = putVarint(o, t);
  o = putVarint(o, m);

  let prevFg = 0;
  let prevBg = 0;
  let i = 0;
  while (i < k) {
    let run = 1;
    while (i + run < k && sameCell(d, i, i + run)) run++;
    const c = d[i * 3];
    const fg = d[i * 3 + 1];
    const bg = d[i * 3 + 2];
    if (fg === prevFg && bg === prevBg && c >>> WIDTH_SHIFT === 1 && (c & CODEPOINT_AND_COMBINED) < 0x80 && run <= 3) {
      for (let r = 0; r < run; r++) outBytes[o++] = c & 0x7f;
      i += run;
      continue;
    }
    const w = c >>> WIDTH_SHIFT;
    const mode = w === 1 ? 0 : w === 2 ? 1 : w === 0 ? 2 : 3;
    let tag = TAG | (mode << 2);
    if (fg !== prevFg) tag |= TAG_FG;
    if (bg !== prevBg) tag |= TAG_BG;
    if (run > 1) tag |= TAG_RUN;
    outBytes[o++] = tag;
    if (tag & TAG_FG) o = putU32(o, fg);
    if (tag & TAG_BG) o = putU32(o, bg);
    o = mode === 3 ? putU32(o, c) : putVarint(o, c & CODEPOINT_AND_COMBINED);
    if (run > 1) o = putVarint(o, run - 2);
    prevFg = fg;
    prevBg = bg;
    i += run;
  }
  return bytesToString(o);
}

/**
 * Decodes a packed row into the first `n * 3` words of `out` (exported for
 * tests). Only cells below `limit` are written.
 */
export function decodeCells(z: string, n: number, out: Uint32Array, limit = n): void {
  n = Math.min(n, limit);
  pos = 1;
  const k = readVarint(z);
  readVarint(z);
  readVarint(z);
  let c = DEFAULT_CONTENT;
  let fg = 0;
  let bg = 0;
  let i = 0;
  while (i < k && i < n) {
    const b = z.charCodeAt(pos++);
    let run = 1;
    if (b < TAG) {
      c = b | DEFAULT_CONTENT;
    } else {
      if (b & TAG_FG) fg = readU32(z);
      if (b & TAG_BG) bg = readU32(z);
      const mode = (b >> 2) & 3;
      if (mode === 3) {
        c = readU32(z);
      } else {
        const w = mode === 0 ? 1 : mode === 1 ? 2 : 0;
        c = (readVarint(z) | (w << WIDTH_SHIFT)) >>> 0;
      }
      if (b & TAG_RUN) run = readVarint(z) + 2;
    }
    for (const end = i + run; i < end; i++) {
      if (i < n) {
        out[i * 3] = c;
        out[i * 3 + 1] = fg;
        out[i * 3 + 2] = bg;
      }
    }
  }
  for (; i < n; i++) {
    out[i * 3] = c;
    out[i * 3 + 1] = fg;
    out[i * 3 + 2] = bg;
  }
}

/** Header fields of a packed row. */
function readHeader(z: string): { flags: number; k: number; t: number; m: number } {
  pos = 1;
  const k = readVarint(z);
  const t = readVarint(z);
  const m = readVarint(z);
  return { flags: z.charCodeAt(0), k, t, m };
}

function inflate(line: CompactableLine): Uint32Array {
  const d = new Uint32Array(line.length * 3);
  decodeCells(line._packed as string, line.length, d);
  line._rawData = d;
  line._packed = null;
  return d;
}

/** The whole row decoded into the shared scratch array, reused while it is the same row. */
function fullScratch(line: CompactableLine): Uint32Array {
  const n = line.length;
  if (scratchRow === line && scratchPacked === line._packed && scratchLength === n) return scratchRowView;
  const view = scratchView(n * 3);
  decodeCells(line._packed as string, n, view);
  scratchRowView = view;
  scratchRow = line;
  scratchPacked = line._packed as string;
  scratchLength = n;
  return view;
}

/** Packs a held row again, unless something changed it while it was held. */
function release(line: CompactableLine, z: string): void {
  const d = line._rawData;
  heldWords -= line.length * 3;
  if (line._packed !== null || !(d instanceof Uint32Array) || d.length !== line.length * 3) return;
  const check = scratchView(d.length);
  decodeCells(z, line.length, check);
  for (let i = 0; i < d.length; i++) if (check[i] !== d[i]) return;
  line._packed = z;
  line._rawData = null;
  line._cache = '';
  line._cacheValid = false;
}

function releaseAll(): void {
  for (const [line, z] of held) release(line, z);
  readOnce = new Set();
  held = new Map();
  heldWords = 0;
  releaseScheduled = false;
}

/** Unpacks a row read for the second time in this task; false leaves it packed. */
function hold(line: CompactableLine): boolean {
  const words = line.length * 3;
  if (!releaseScheduled) {
    releaseScheduled = true;
    queueMicrotask(releaseAll);
  }
  if (!readOnce.has(line)) {
    readOnce.add(line);
    return false;
  }
  if (words > HELD_BUDGET_WORDS) return false;
  // Oldest first out: a wrap group longer than the budget still holds its latest rows.
  for (const [oldest, z] of held) {
    if (heldWords + words <= HELD_BUDGET_WORDS) break;
    held.delete(oldest);
    release(oldest, z);
  }
  const z = line._packed as string;
  const d = new Uint32Array(words);
  decodeCells(z, line.length, d);
  line._rawData = d;
  line._packed = null;
  held.set(line, z);
  heldWords += words;
  return true;
}

/**
 * Runs `fn` with the row decoded into a shared scratch array, leaving it
 * packed. `fn` may read only the cells below `limit`.
 */
function withScratch<T>(line: CompactableLine, fn: () => T, limit = line.length): T {
  let view: Uint32Array;
  if (limit < line.length) {
    view = scratchView(line.length * 3);
    decodeCells(line._packed as string, line.length, view, limit);
  } else {
    view = fullScratch(line);
  }
  line._rawData = view;
  try {
    return fn();
  } finally {
    line._rawData = null;
  }
}

function disable(reason: string): void {
  disabled = true;
  if (!warned) {
    warned = true;
    console.warn(`[wmux:scrollback-compaction] turned off for this session: ${reason}`);
  }
}

/** Whether a row is currently packed (tests and diagnostics). */
export function isLineCompacted(line: object): boolean {
  return isPacked(line as CompactableLine);
}

/** Whether a fail-closed check turned compaction off for this session. */
export function isCompactionDisabled(): boolean {
  return disabled;
}

/**
 * Checks the header facts the no-decode paths rely on against the original
 * cells: t is the trimmed length, and cutting to any cols >= m keeps every
 * content cell and leaves no wide char in the last column.
 */
function checkHeader(line: CompactableLine, z: string, d: Uint32Array, n: number): string | null {
  const { t, m } = readHeader(z);
  if (t > 0) {
    const trimmed = (origGetTrimmedLength as LineMethod).call(line);
    if (t - 1 !== trimmed) return `header trimmed length ${t - 1} != ${String(trimmed)}`;
    if (t - 1 > m) return `header shrink bound ${m} below trimmed length ${t - 1}`;
  }
  for (let j = Math.max(0, m - 1); j < n; j++) {
    const c = d[j * 3];
    if (c >> WIDTH_SHIFT === 2 || (j >= m && c & CODEPOINT_AND_COMBINED)) return `header shrink bound ${m} cuts cell ${j}`;
  }
  return null;
}

/**
 * Packs one row. Returns false when it was not packed: compaction is off or
 * not installed on this row's class, the row is already packed, or the
 * round-trip check failed (which also turns compaction off).
 */
export function compactLine(lineObj: object): boolean {
  const line = lineObj as CompactableLine;
  if (disabled) return false;
  const d = line._rawData;
  // A row being read through withScratch holds the shared scratch array.
  if (!(d instanceof Uint32Array) || d.buffer === scratch.buffer) return false;
  const n = line.length;
  if (d.length !== n * 3) return false;
  let z: string;
  try {
    z = encodeCells(d, n);
    const check = scratchView(n * 3);
    decodeCells(z, n, check);
    for (let i = 0; i < n * 3; i++) {
      if (check[i] !== d[i]) {
        disable(`round-trip mismatch at word ${i} of ${n * 3}`);
        return false;
      }
    }
    const headerError = checkHeader(line, z, d, n);
    if (headerError) {
      disable(headerError);
      return false;
    }
  } catch (err) {
    disable(String(err));
    return false;
  }
  line._packed = z;
  line._rawData = null;
  line._cache = '';
  line._cacheValid = false;
  return true;
}

/**
 * Installs the `_data` accessor and the whole-row wrappers on a BufferLine
 * class. Idempotent. Rows built before the install own a plain `_data` field
 * and are never compacted. Returns false (installing nothing) when the class
 * does not look like the BufferLine this was written against.
 */
export function installScrollbackCompaction(lineClass: { prototype: object }): boolean {
  const proto = lineClass.prototype as Record<string, unknown>;
  if (installedProto === proto) return true;
  if (installedProto !== null) return false;
  const names = ['translateToString', 'getTrimmedLength', 'getNoBgTrimmedLength', 'resize', 'cleanupMemory', 'copyFrom', 'clone', 'loadCell'];
  if (names.some((name) => typeof proto[name] !== 'function') || Object.getOwnPropertyDescriptor(proto, '_data')) {
    return false;
  }
  const orig = Object.fromEntries(names.map((name) => [name, proto[name] as LineMethod])) as Record<string, LineMethod>;
  origGetTrimmedLength = orig.getTrimmedLength;

  Object.defineProperty(proto, '_data', {
    configurable: true,
    get(this: CompactableLine): Uint32Array {
      const d = this._rawData;
      return d !== null ? (d as Uint32Array) : inflate(this);
    },
    set(this: CompactableLine, value: Uint32Array) {
      this._rawData = value;
      this._packed = null;
    },
  });

  // Built without inflating and never cached: the search sweep and the 5 s
  // scrollback dump call this for every row. Only the cells the call reads
  // (below endCol, and below the trimmed length when trimming) are decoded.
  proto.translateToString = function (this: CompactableLine, ...args: never[]): unknown {
    if (!isPacked(this)) return orig.translateToString.apply(this, args);
    const [trimRight, , endCol] = args as unknown as [boolean | undefined, number | undefined, number | undefined];
    const { t } = readHeader(this._packed as string);
    let limit = endCol === undefined || endCol > this.length ? this.length : endCol;
    if (trimRight) limit = t > 0 ? Math.min(limit, t - 1) : this.length;
    return withScratch(
      this,
      () => {
        const result = orig.translateToString.apply(this, args);
        this._cache = '';
        this._cacheValid = false;
        return result;
      },
      limit,
    );
  };

  // Answers from the header, also while translateToString reads a partial
  // scratch decode.
  proto.getTrimmedLength = function (this: CompactableLine): unknown {
    const z = this._packed;
    if (z == null) return orig.getTrimmedLength.call(this);
    const { t } = readHeader(z);
    if (t > 0) return t - 1;
    if (this._rawData !== null) return orig.getTrimmedLength.call(this);
    return withScratch(this, () => orig.getTrimmedLength.call(this));
  };

  proto.getNoBgTrimmedLength = function (this: CompactableLine): unknown {
    if (!isPacked(this)) return orig.getNoBgTrimmedLength.call(this);
    return withScratch(this, () => orig.getNoBgTrimmedLength.call(this));
  };

  // Cell reads copy out of `_data`, so they read a scratch decode too:
  // addon-search calls getCell on the last cell of every row that wraps and
  // on every cell of a match row, and through the getter that unpacked the
  // whole buffer for good.
  const cellReaders = ['get', 'getWidth', 'hasWidth', 'getFg', 'getBg', 'hasContent', 'getCodePoint', 'isCombined', 'getString', 'isProtected', 'loadCell', 'getCell', 'getExtended'];
  // Called per cell, so no closure or rest array; none takes more than two arguments.
  for (const name of cellReaders) {
    const read = proto[name] as ((this: CompactableLine, a: unknown, b: unknown) => unknown) | undefined;
    if (typeof read !== 'function') continue;
    proto[name] = function (this: CompactableLine, a: unknown, b: unknown): unknown {
      if (!isPacked(this) || hold(this)) return read.call(this, a, b);
      this._rawData = fullScratch(this);
      try {
        return read.call(this, a, b);
      } finally {
        this._rawData = null;
      }
    };
  }

  // A width change resizes every row. Growing with the default blank, or
  // shrinking without cutting into content or a wide char, only moves
  // `length`: cells past k repeat the trailing run, and the header knows
  // where the content ends.
  proto.resize = function (this: CompactableLine, cols: number, fill: FillCell): unknown {
    if (!isPacked(this)) return orig.resize.call(this, cols as never, fill as never);
    const { flags, k, t, m } = readHeader(this._packed as string);
    if (cols === this.length) {
      this._cacheValid = false;
      return false;
    }
    if (cols > this.length) {
      if (flags & FLAG_DEFAULT_TAIL && this.length >= k && fill.content === DEFAULT_CONTENT && fill.fg === 0 && fill.bg === 0) {
        this._cacheValid = false;
        this.length = cols;
        return false;
      }
    } else if (t > 0 && cols >= m) {
      this._cacheValid = false;
      for (const key of Object.keys(this._combined)) {
        if (parseInt(key, 10) >= cols) delete this._combined[key as unknown as number];
      }
      for (const key of Object.keys(this._extendedAttrs)) {
        if (parseInt(key, 10) >= cols) delete this._extendedAttrs[key as unknown as number];
      }
      this.length = cols;
      return false;
    }
    return orig.resize.call(this, cols as never, fill as never);
  };

  // Runs over every row after a resize; a packed row has no spare capacity.
  proto.cleanupMemory = function (this: CompactableLine): unknown {
    return isPacked(this) ? 0 : orig.cleanupMemory.call(this);
  };

  // A full scrollback recycles its oldest (packed) row as the new bottom row
  // and overwrites every cell, so there is nothing to decode.
  proto.copyFrom = function (this: CompactableLine, ...args: never[]): unknown {
    if (isPacked(this)) {
      this._rawData = new Uint32Array(this.length * 3);
      this._packed = null;
    }
    return orig.copyFrom.apply(this, args);
  };

  installedProto = proto;
  return true;
}

// ---------------------------------------------------------------------------
// Per-terminal sweep

/** The xterm internals the sweep reads; present on @xterm/xterm and @xterm/headless. */
interface SweepBuffer {
  lines: { length: number; get(i: number): object | undefined };
  ybase: number;
  ydisp: number;
}

export interface CompactableTerminal {
  rows: number;
  onWriteParsed(cb: () => void): { dispose(): void };
  onScroll(cb: () => void): { dispose(): void };
  onResize(cb: () => void): { dispose(): void };
}

function normalBuffer(term: CompactableTerminal): SweepBuffer | undefined {
  return (term as unknown as { _core?: { buffers?: { normal?: SweepBuffer } } })._core?.buffers?.normal;
}

/** The BufferLine class of a live terminal, or undefined if it is not the expected shape. */
export function bufferLineClassOf(term: object): { prototype: object } | undefined {
  const line = (term as { _core?: { buffer?: SweepBuffer } })._core?.buffer?.lines.get(0) as
    | (CompactableLine & { constructor: { prototype: object } })
    | undefined;
  if (!line) return undefined;
  const own = Object.getOwnPropertyDescriptor(line, '_data')?.value;
  const viaAccessor = installedProto !== null && Object.getPrototypeOf(line) === installedProto;
  if (!viaAccessor && !(own instanceof Uint32Array && own.length === line.length * 3)) return undefined;
  return line.constructor;
}

/**
 * Installs compaction on the BufferLine class behind `TerminalCtor`, found
 * through a throwaway 2x1 terminal that is never opened. Call before the
 * first real terminal is built: rows that exist before the install are
 * never compacted.
 */
export function installScrollbackCompactionFor(
  TerminalCtor: new (options: { cols: number; rows: number; scrollback: number }) => { dispose(): void },
): boolean {
  if (installedProto !== null) return true;
  if (disabled) return false;
  // Fail closed: the caller is a store listener during session load.
  let probe: { dispose(): void } | undefined;
  try {
    probe = new TerminalCtor({ cols: 2, rows: 1, scrollback: 0 });
    const lineClass = bufferLineClassOf(probe);
    if (lineClass !== undefined && installScrollbackCompaction(lineClass)) return true;
    disable('xterm BufferLine does not have the expected shape');
    return false;
  } catch (err) {
    disable(`install failed: ${String(err)}`);
    return false;
  } finally {
    try {
      probe?.dispose();
    } catch {
      // The probe is never opened; a failing dispose leaves nothing behind.
    }
  }
}

/**
 * Packs every row of the normal buffer outside the protected window:
 * index < ybase - (rows + margin), and not within margin rows of the
 * viewport at ydisp. Returns the number of rows packed. `shouldYield` is
 * polled every 64 rows; when it answers true the scan stops and the index to
 * resume from is returned as `next`.
 */
export function compactScrollback(
  term: CompactableTerminal,
  margin = COMPACTION_MARGIN,
  start = 0,
  shouldYield?: () => boolean,
): { compacted: number; next: number | null } {
  const buf = normalBuffer(term);
  if (!buf || disabled || installedProto === null) return { compacted: 0, next: null };
  const rows = term.rows;
  const limit = Math.min(buf.ybase - (rows + margin), buf.lines.length);
  const lo = buf.ydisp - margin;
  const hi = buf.ydisp + rows + margin;
  let compacted = 0;
  for (let i = start; i < limit; i++) {
    if (shouldYield && (i & 63) === 0 && i !== start && shouldYield()) return { compacted, next: i };
    if (i >= lo && i < hi) {
      i = hi - 1;
      continue;
    }
    const line = buf.lines.get(i);
    if (line && compactLine(line)) compacted++;
    if (disabled) break;
  }
  return { compacted, next: null };
}

interface IdleDeadlineLike {
  timeRemaining(): number;
}

/** Work per slice when requestIdleCallback fires by its timeout (timeRemaining() is 0 then). */
const TIMEOUT_SLICE_MS = 4;

function requestIdle(cb: (deadline: IdleDeadlineLike) => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(
      (deadline) => {
        if (!deadline.didTimeout) return cb(deadline);
        const end = performance.now() + TIMEOUT_SLICE_MS;
        cb({ timeRemaining: () => end - performance.now() });
      },
      { timeout: 2000 },
    );
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(() => {
    const end = Date.now() + 8;
    cb({ timeRemaining: () => end - Date.now() });
  }, 50);
  return () => clearTimeout(id);
}

const attached = new WeakMap<object, { dispose(): void }>();

/**
 * Runs the idle sweep for one terminal after it writes, scrolls or resizes,
 * while `isEnabled` answers true. Idempotent per terminal, so a parked
 * terminal that is adopted again keeps its one sweep.
 */
export function attachScrollbackCompaction(term: CompactableTerminal, isEnabled: () => boolean = () => true): { dispose(): void } {
  const existing = attached.get(term);
  if (existing) return existing;
  let cancel: (() => void) | null = null;
  let resumeAt = 0;
  let rerun = false;
  let disposed = false;

  const slice = (deadline: IdleDeadlineLike): void => {
    cancel = null;
    if (disposed || disabled || !isEnabled()) return;
    const { next } = compactScrollback(term, COMPACTION_MARGIN, resumeAt, () => deadline.timeRemaining() < 1);
    if (next !== null) {
      resumeAt = next;
      cancel = requestIdle(slice);
      return;
    }
    resumeAt = 0;
    if (rerun) {
      rerun = false;
      cancel = requestIdle(slice);
    }
  };
  const schedule = (): void => {
    if (disposed || disabled || !isEnabled()) return;
    if (cancel) {
      rerun = true;
      return;
    }
    cancel = requestIdle(slice);
  };

  const subs = [term.onWriteParsed(schedule), term.onScroll(schedule), term.onResize(schedule)];
  const handle = {
    dispose(): void {
      disposed = true;
      cancel?.();
      cancel = null;
      for (const sub of subs) sub.dispose();
      attached.delete(term);
    },
  };
  attached.set(term, handle);
  return handle;
}

/** Stops a terminal's sweep (its final disposal; a parked terminal keeps it). */
export function detachScrollbackCompaction(term: object): void {
  attached.get(term)?.dispose();
}

/** Resets module state between tests. TEST-ONLY. */
export function __resetCompactionForTests(): void {
  disabled = false;
  warned = false;
  releaseAll();
}

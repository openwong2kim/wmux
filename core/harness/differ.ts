// E0 conformance harness — M2 differential runner (spec: engine-core-decision-2026-07-09.md §5-2)
//
// Feed recording.bin + events.jsonl to subjects → extract full-cell snapshots → cell-level diff → 4-class ledger
// report. Subjects are abstracted via the Subject interface:
//   (a) @xterm/headless      — current sole implementation (baseline).
//   (b) our core (E1)         — plugs in later with the same shape as XtermSubject.
//   (c) third reference (D2 conditional) — referee axis.
//
// Baseline width model is **explicitly fixed to Unicode 11** (@xterm/addon-unicode11 load + activeVersion='11').
// Aligns with the main renderer width model (lockfile pin).

import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  CellSnapshot,
  DiffClassification,
  DiffEntry,
  DiffReport,
  Geometry,
  GridSnapshot,
  IntendedDiff,
  RecordingEvent,
  ThroughputMetrics,
} from './types';

/**
 * Subject interface. Replays a recording against the events trail and emits a full-grid snapshot.
 * Our core (E1) and third reference plug in later via this interface (current sole impl: XtermSubject).
 */
export interface Subject {
  readonly name: string;
  /**
   * Replays recording.bin against the events trail and returns the final grid snapshot + throughput metrics.
   */
  replay(recording: Uint8Array, events: readonly RecordingEvent[]): Promise<SubjectResult>;
}

export interface SubjectResult {
  readonly grid: GridSnapshot;
  readonly metrics: ThroughputMetrics;
  /**
   * reflow_mode events encountered during replay (R9). xterm.js uses its own reflow policy, so this signal
   * does not change replay discipline ("ignored"), but the fact that it was ignored is recorded honestly in
   * the result — when E1 core plugs in, Subject.replay will pass this signal into actual replay discipline
   * (this list then becomes the basis for that pass-through).
   */
  readonly reflowModeEvents: readonly Extract<RecordingEvent, { type: 'reflow_mode' }>[];
}

/**
 * Event stream invariant validation (R3). Enforced before replay entry — violations throw explicitly, not
 * masked by sorting.
 *   ① First event must be init (initial geometry).
 *   ② byteOffset must be monotonically non-decreasing in **original order** (no reordering to hide violations).
 *   ③ All byteOffsets must lie in [0, recordingLength].
 * On violation, throws indicating a corrupted event file (replay proceeds only on trusted streams).
 */
export function validateEventStream(
  events: readonly RecordingEvent[],
  recordingLength: number,
): void {
  if (events.length === 0) {
    throw new Error('[differ] event stream is empty (init required — recorder invariant violation)');
  }
  // ① First event = init. (Runtime-parsed corrupt files possible, so byteOffset is validated at runtime too —
  // read as number first to avoid type narrowing making init.byteOffset literal 0 and becoming never.)
  const first = events[0];
  const firstOffset: number = first.byteOffset;
  if (first.type !== 'init') {
    throw new Error(`[differ] first event is not init: type=${first.type} (recorder invariant violation)`);
  }
  if (firstOffset !== 0) {
    throw new Error(`[differ] init byteOffset is not 0: ${firstOffset}`);
  }
  // ②③ Monotonic non-decreasing in original order + range.
  let prev = -1;
  for (let i = 0; i < events.length; i++) {
    const off = events[i].byteOffset;
    if (off < 0 || off > recordingLength) {
      throw new Error(
        `[differ] byteOffset out of range: event[${i}] offset=${off} (allowed 0..${recordingLength})`,
      );
    }
    if (off < prev) {
      throw new Error(
        `[differ] byteOffset is not monotonically non-decreasing in original order: event[${i}] offset=${off} < previous ${prev} (corrupt event file)`,
      );
    }
    prev = off;
  }
}

/** Extract initial geometry from the init event (call after validation — trail head is always init). */
function initialGeometryOf(events: readonly RecordingEvent[]): Geometry {
  const init = events.find((e) => e.type === 'init');
  if (!init || init.type !== 'init') {
    throw new Error('[differ] events has no init event (recorder invariant violation)');
  }
  return init.geometry;
}

/**
 * Read intended-diffs.json and load the (d) intended-improvement approval list (R4). Differential run entry
 * and tests pass this result to diffGrids as the intended parameter. File shape: { "intended": IntendedDiff[] };
 * meta keys like _comment are ignored. Missing file / parse failure throws explicitly (no silent empty-list
 * fallback — if the approval list vanishes, all (d) fall to unclassified and the gate gets noisy, so quiet
 * failure is dangerous).
 */
export const INTENDED_DIFFS_PATH = path.join(__dirname, 'intended-diffs.json');

export function loadIntendedDiffs(filePath: string = INTENDED_DIFFS_PATH): IntendedDiff[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`[differ] intended-diffs.json load failed: ${filePath} (${String(e)})`);
  }
  const parsed = JSON.parse(text) as { intended?: unknown };
  const list = parsed.intended;
  if (!Array.isArray(list)) {
    throw new Error('[differ] intended-diffs.json has no intended array');
  }
  // Schema validation: each entry has IntendedDiff fields (workloadName·x·y·field·reason).
  return list.map((raw, i): IntendedDiff => {
    const it = raw as Partial<IntendedDiff>;
    if (
      typeof it.workloadName !== 'string' ||
      typeof it.x !== 'number' ||
      typeof it.y !== 'number' ||
      typeof it.field !== 'string' ||
      typeof it.reason !== 'string'
    ) {
      throw new Error(`[differ] intended-diffs.json entry[${i}] schema mismatch: ${JSON.stringify(raw)}`);
    }
    return { workloadName: it.workloadName, x: it.x, y: it.y, field: it.field, reason: it.reason };
  });
}

/**
 * XtermSubject options. When feedChunkBytes is set, [cursor..offset) is split and fed in that many bytes
 * (default: whole range). Set to 1 to drip one byte at a time and verify parser chunk-boundary robustness
 * (gate ①-b, R10). Only chunk size differs; validation, geometry, resize, and extraction discipline are
 * identical.
 */
export interface XtermSubjectOptions {
  readonly feedChunkBytes?: number;
}

/**
 * @xterm/headless subject. Loads Unicode11Addon and fixes activeVersion='11'.
 * write is callback-based (parser handles async chunks), so replay awaits callbacks and feeds sequentially.
 */
export class XtermSubject implements Subject {
  readonly name: string;
  private readonly feedChunkBytes: number;

  constructor(opts: XtermSubjectOptions = {}) {
    // feedChunkBytes ≤ 0 is meaningless; treat as whole (Infinity equivalent).
    this.feedChunkBytes =
      opts.feedChunkBytes && opts.feedChunkBytes > 0 ? opts.feedChunkBytes : Number.POSITIVE_INFINITY;
    this.name =
      this.feedChunkBytes === Number.POSITIVE_INFINITY
        ? 'xterm.js@6'
        : `xterm.js@6(${this.feedChunkBytes}B-chunked)`;
  }

  async replay(recording: Uint8Array, events: readonly RecordingEvent[]): Promise<SubjectResult> {
    // R3: enforce event stream invariants before replay entry (violation = throw, no sort masking).
    validateEventStream(events, recording.length);
    const initial = initialGeometryOf(events);
    // scrollback 0 — corpus validates viewport state, so viewport only, no history.
    // allowProposedApi: required for Unicode11Addon registration.
    const term = new Terminal({
      cols: initial.cols,
      rows: initial.rows,
      scrollback: 0,
      allowProposedApi: true,
    });
    // Baseline width model = Unicode 11 explicitly fixed (aligned with main renderer).
    // addon types expect @xterm/xterm Terminal but headless Terminal is structurally compatible →
    // loadAddon only requires ITerminalAddon, so runtime-safe (addon touches core only).
    term.loadAddon(new Unicode11Addon() as never);
    term.unicode.activeVersion = '11';

    // Replay order = **original trail order as-is** (no sort — R3). validateEventStream already guarantees
    // monotonic byteOffset, so sort is unnecessary; sort would silently mask corrupt streams. init already
    // consumed for initial geometry, so iterate remaining events only.
    const ordered = events.filter((e) => e.type !== 'init');
    // Collect reflow_mode signals honestly (R9). xterm.js uses its own policy and does not change replay
    // discipline, but records "encountered and ignored" in the result (E1 core will pass this into actual
    // replay discipline).
    const reflowModeEvents: Extract<RecordingEvent, { type: 'reflow_mode' }>[] = [];

    const bytesTotal = recording.length;
    const feedStart = performance.now();

    // Offset-based replay: feed [0..offset), then apply the event (resize) at that offset.
    let cursor = 0;
    const writeChunk = (chunk: Uint8Array): Promise<void> =>
      new Promise<void>((resolve) => term.write(chunk, resolve));
    // Feed [from..to) in feedChunkBytes units (whole range once, or 1 byte at a time when set to 1 — R10).
    const feedRange = async (from: number, to: number): Promise<void> => {
      let at = from;
      while (at < to) {
        const end = Math.min(at + this.feedChunkBytes, to);
        await writeChunk(recording.subarray(at, end));
        at = end;
      }
    };

    for (const ev of ordered) {
      if (ev.byteOffset > cursor) {
        await feedRange(cursor, ev.byteOffset);
        cursor = ev.byteOffset;
      }
      if (ev.type === 'resize') {
        term.resize(ev.geometry.cols, ev.geometry.rows);
      } else if (ev.type === 'reflow_mode') {
        // Honest collection: xterm.js ignores but records in result (R9 — "ignored" stays in output).
        reflowModeEvents.push(ev);
      }
    }
    // Feed remaining tail.
    if (cursor < recording.length) {
      await feedRange(cursor, recording.length);
    }
    const feedMs = performance.now() - feedStart;

    const extractStart = performance.now();
    const grid = extractGrid(term);
    const extractMs = performance.now() - extractStart;

    const metrics: ThroughputMetrics = {
      subject: this.name,
      bytesTotal,
      feedMs,
      feedMBps: feedMs > 0 ? bytesTotal / 1e6 / (feedMs / 1000) : 0,
      extractMs,
      cellCount: grid.cols * grid.rows,
    };

    term.dispose();
    return { grid, metrics, reflowModeEvents };
  }
}

/** Extract all cells of the headless Terminal active buffer as a GridSnapshot. */
export function extractGrid(term: Terminal): GridSnapshot {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  const activeBuffer: 'normal' | 'alternate' = buf.type === 'alternate' ? 'alternate' : 'normal';

  const cells: CellSnapshot[][] = [];
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const row: CellSnapshot[] = [];
    for (let x = 0; x < cols; x++) {
      // getCell without reuse — fresh per cell (xterm recommends reused cell objects, but snapshots need
      // value copies, so extract values immediately).
      const cell = line?.getCell(x);
      if (!cell) {
        row.push(emptyCell());
        continue;
      }
      row.push({
        char: cell.getChars(),
        width: cell.getWidth(),
        code: cell.getCode(),
        fgMode: cell.getFgColorMode(),
        fg: cell.getFgColor(),
        bgMode: cell.getBgColorMode(),
        bg: cell.getBgColor(),
        fgPalette: cell.isFgPalette(),
        fgRGB: cell.isFgRGB(),
        fgDefault: cell.isFgDefault(),
        bgPalette: cell.isBgPalette(),
        bgRGB: cell.isBgRGB(),
        bgDefault: cell.isBgDefault(),
        bold: cell.isBold() !== 0,
        italic: cell.isItalic() !== 0,
        dim: cell.isDim() !== 0,
        underline: cell.isUnderline() !== 0,
        blink: cell.isBlink() !== 0,
        inverse: cell.isInverse() !== 0,
        invisible: cell.isInvisible() !== 0,
        strikethrough: cell.isStrikethrough() !== 0,
        overline: cell.isOverline() !== 0,
      });
    }
    cells.push(row);
  }

  return {
    cols,
    rows,
    activeBuffer,
    cursor: { x: buf.cursorX, y: buf.cursorY },
    cells,
  };
}

function emptyCell(): CellSnapshot {
  return {
    char: '',
    width: 1,
    code: 0,
    fgMode: 0,
    fg: -1,
    bgMode: 0,
    bg: -1,
    fgPalette: false,
    fgRGB: false,
    fgDefault: true,
    bgPalette: false,
    bgRGB: false,
    bgDefault: true,
    bold: false,
    italic: false,
    dim: false,
    underline: false,
    blink: false,
    inverse: false,
    invisible: false,
    strikethrough: false,
    overline: false,
  };
}

/**
 * CellSnapshot diff fields (char, width, portable color representation, 9 flags, code).
 *
 * **fgMode/bgMode (raw color-mode constants) are intentionally excluded** (R6): these integers are xterm.js
 * internal representation — our core and third reference cannot guarantee the same constants; including them
 * in cross-subject comparison creates false mismatches where "representation differs but meaning is the same."
 * Portable color judgment uses fg/bg values + palette/rgb/default booleans (fgMode/bgMode remain reference-only
 * in types.ts).
 */
const CELL_FIELDS: readonly (keyof CellSnapshot)[] = [
  'char',
  'width',
  'code',
  'fg',
  'bg',
  'fgPalette',
  'fgRGB',
  'fgDefault',
  'bgPalette',
  'bgRGB',
  'bgDefault',
  'bold',
  'italic',
  'dim',
  'underline',
  'blink',
  'inverse',
  'invisible',
  'strikethrough',
  'overline',
];

/**
 * Compare two grid snapshots cell-by-cell and emit a mismatch report. (d) intended improvements: only
 * (workload,x,y,field) listed in intended are marked 'intended'; everything else stays 'unclassified'
 * (no implicit (d) — §5-2). Does not auto-classify (a)/(b)/(c): that judgment belongs to humans/third
 * reference; the harness only reports honestly that mismatches exist with coordinates and both-side values.
 */
export function diffGrids(
  workloadName: string,
  a: GridSnapshot,
  b: GridSnapshot,
  subjectA: string,
  subjectB: string,
  intended: readonly IntendedDiff[] = [],
): DiffReport {
  const mismatches: DiffEntry[] = [];
  const intendedKey = (x: number, y: number, field: string): boolean =>
    intended.some(
      (i) => i.workloadName === workloadName && i.x === x && i.y === y && i.field === field,
    );
  const classify = (x: number, y: number, field: string): DiffClassification =>
    intendedKey(x, y, field) ? 'intended' : 'unclassified';

  // Grid shape mismatch recorded separately before cell compare (different shape makes cell coords meaningless).
  if (a.cols !== b.cols || a.rows !== b.rows) {
    mismatches.push({
      x: -1,
      y: -1,
      field: 'grid-shape',
      a: { cols: a.cols, rows: a.rows },
      b: { cols: b.cols, rows: b.rows },
      classification: classify(-1, -1, 'grid-shape'),
    });
  }

  // Active buffer (normal|alternate) mismatch recorded before cell compare (R5). If one subject is on normal
  // and the other on alternate, cell coordinate comparison loses meaning — top-priority signal (surfaces
  // alt-screen enter/exit handling differences early).
  if (a.activeBuffer !== b.activeBuffer) {
    mismatches.push({
      x: -1,
      y: -1,
      field: 'activeBuffer',
      a: a.activeBuffer,
      b: b.activeBuffer,
      classification: classify(-1, -1, 'activeBuffer'),
    });
  }

  // Cursor mismatch.
  if (a.cursor.x !== b.cursor.x || a.cursor.y !== b.cursor.y) {
    mismatches.push({
      x: a.cursor.x,
      y: a.cursor.y,
      field: 'cursor',
      a: a.cursor,
      b: b.cursor,
      classification: classify(a.cursor.x, a.cursor.y, 'cursor'),
    });
  }

  // Cell-by-cell compare — common intersection only (avoids coordinate collapse when shapes differ).
  const rows = Math.min(a.rows, b.rows);
  const cols = Math.min(a.cols, b.cols);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ca = a.cells[y]?.[x];
      const cb = b.cells[y]?.[x];
      if (!ca || !cb) continue;
      for (const field of CELL_FIELDS) {
        if (ca[field] !== cb[field]) {
          mismatches.push({
            x,
            y,
            field,
            a: ca[field],
            b: cb[field],
            classification: classify(x, y, field),
          });
        }
      }
    }
  }

  return {
    workloadName,
    subjectA,
    subjectB,
    gridShape: { cols: a.cols, rows: a.rows },
    totalCells: a.cols * a.rows,
    mismatches,
    identical: mismatches.length === 0,
  };
}

/**
 * Whether two snapshots are fully identical (used by determinism gate ①). With an empty intended list, any
 * mismatch counts as failure — determinism is same-subject twice, so intended cannot apply.
 */
export function snapshotsEqual(a: GridSnapshot, b: GridSnapshot): boolean {
  return diffGrids('__determinism__', a, b, 'run1', 'run2').identical;
}

/**
 * Cross-subject differential run entry (R4). Replays both subjects on the same recording, **auto-loads**
 * intended-diffs.json approval list and wires it into diffGrids, then emits the report. When E1 plugs in our
 * core (subjectB), this function diffs against the xterm.js (subjectA) baseline; only coords listed in the
 * approval list (VS16 width, reflow restore) are promoted to 'intended'. loadIntendedDiffs() lives on this
 * execution path.
 */
export async function runDifferential(
  workloadName: string,
  recording: Uint8Array,
  events: readonly RecordingEvent[],
  subjectA: Subject,
  subjectB: Subject,
  intended: readonly IntendedDiff[] = loadIntendedDiffs(),
): Promise<DiffReport> {
  const [ra, rb] = await Promise.all([
    subjectA.replay(recording, events),
    subjectB.replay(recording, events),
  ]);
  return diffGrids(workloadName, ra.grid, rb.grid, subjectA.name, subjectB.name, intended);
}

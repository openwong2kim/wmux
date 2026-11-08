/**
 * The geometry history's contract, one table run against both rings: the TS
 * ring (node) and the Rust ring (native_core.rs note_geometry), which must
 * record the same marks for the same calls.
 *
 * A mark is applied (a viewer that shows the content took the size, or none
 * is waiting for its replay) or provisional (a viewer attached and its replay
 * is not out yet). Applied marks are kept even with no bytes at them;
 * a provisional one is replaced by the next mark and kept by a settle.
 *
 * The Rust rows need the built module: they skip without it, and fail under
 * WMUX_REQUIRE_RUST_CORE.
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingBuffer } from '../RingBuffer';
import { nativeCorePath } from '../../shared/nativeTerminalCore';

type Op =
  | { note: [number, number]; provisional?: true }
  | { write: number }
  | { settle: true };

interface Case {
  name: string;
  ops: Op[];
  /** Marks as [at, cols, rows], `at` a byte offset into the (unwrapped) ring. */
  marks: Array<[number, number, number]>;
  pending: boolean;
}

const A = (cols: number, rows: number): Op => ({ note: [cols, rows] });
const P = (cols: number, rows: number): Op => ({ note: [cols, rows], provisional: true });
const W = (bytes: number): Op => ({ write: bytes });
const S: Op = { settle: true };

const GEOMETRY_HISTORY_CASES: Case[] = [
  // Case 4: the spawn size, no viewer, program output: kept.
  { name: 'the spawn size with output', ops: [A(80, 24), W(10)], marks: [[0, 80, 24]], pending: false },
  { name: 'a repeat of the current size is ignored', ops: [A(80, 24), W(5), A(80, 24), W(1)], marks: [[0, 80, 24]], pending: false },
  { name: 'an invalid size is ignored', ops: [A(80, 24), W(2), A(0, 24), A(80, 0)], marks: [[0, 80, 24]], pending: false },
  {
    // Case 1: an alternate screen narrowed and widened back with no output
    // between, by a viewer that shows it: both sizes stay, so the replay cuts
    // it as the viewer's terminal did.
    name: 'an applied narrow then widen with no bytes keeps both marks',
    ops: [A(100, 30), W(10), A(60, 30), A(100, 30), W(5)],
    marks: [[0, 100, 30], [10, 60, 30], [10, 100, 30]],
    pending: false,
  },
  {
    // The same with no viewer at all (a CLI resize): the daemon's own
    // terminal applied it, so it is kept the same way.
    name: 'byte-less applied resizes with no viewer are kept',
    ops: [A(80, 24), W(10), A(100, 30), A(120, 30), W(3)],
    marks: [[0, 80, 24], [10, 100, 30], [10, 120, 30]],
    pending: false,
  },
  {
    // Case 2: a size taken before the replay is out, which got a few bytes
    // (a ConPTY repaint), then the applied size: the provisional mark goes,
    // and its bytes count at the size before it.
    name: 'a provisional size with bytes is replaced by the next size',
    ops: [A(118, 44), W(100), P(122, 40), W(4), A(118, 44), W(50)],
    marks: [[0, 118, 44]],
    pending: false,
  },
  {
    name: 'a provisional size is replaced by a different applied size',
    ops: [A(80, 24), W(10), P(122, 40), W(4), A(118, 44), W(5)],
    marks: [[0, 80, 24], [14, 118, 44]],
    pending: false,
  },
  {
    name: 'a provisional size is replaced by the next provisional one',
    ops: [A(80, 24), W(10), P(100, 30), W(3), P(118, 44)],
    marks: [[0, 80, 24], [13, 118, 44]],
    pending: true,
  },
  {
    // Case 3: the size held when the replay went out stays as the base.
    name: 'a settle keeps the provisional size',
    ops: [A(80, 24), W(10), P(118, 44), W(20), S, W(5), A(100, 30)],
    marks: [[0, 80, 24], [10, 118, 44], [35, 100, 30]],
    pending: false,
  },
  {
    name: 'an applied repeat of a provisional size makes it applied',
    ops: [A(80, 24), W(10), P(118, 44), W(2), A(118, 44), A(100, 30)],
    marks: [[0, 80, 24], [10, 118, 44], [12, 100, 30]],
    pending: false,
  },
  {
    name: 'a provisional repeat of an applied size changes nothing',
    ops: [A(80, 24), W(10), P(80, 24), A(100, 30)],
    marks: [[0, 80, 24], [10, 100, 30]],
    pending: false,
  },
  { name: 'a settle with nothing provisional changes nothing', ops: [A(80, 24), W(4), S, A(60, 24)], marks: [[0, 80, 24], [4, 60, 24]], pending: false },
  {
    // Two sizes at the first byte: the newer one applies from it.
    name: 'a provisional size at the first byte becomes the start size',
    ops: [A(80, 24), P(118, 44), W(30)],
    marks: [[0, 118, 44]],
    pending: true,
  },
];

function run(ring: RingBuffer, ops: Op[]): void {
  for (const op of ops) {
    if ('note' in op) ring.noteGeometry(op.note[0], op.note[1], !op.provisional);
    else if ('write' in op) ring.write(Buffer.alloc(op.write, 0x61));
    else ring.settleGeometry();
  }
}

function marksOf(ring: RingBuffer): Array<[number, number, number]> {
  const { geometry } = ring.readAllWithGeometry();
  if (!geometry) return [];
  return [[0, geometry.start.cols, geometry.start.rows], ...geometry.changes.map((c): [number, number, number] => [c.offset, c.cols, c.rows])];
}

const modulePath = nativeCorePath();
const native = fs.existsSync(modulePath);
if (!native && process.env.WMUX_REQUIRE_RUST_CORE) throw new Error(`native core missing: ${modulePath}`);

afterEach(() => vi.unstubAllEnvs());

describe.each([
  { backend: 'node' as const, skip: false },
  { backend: 'rust' as const, skip: !native },
])('the geometry history ($backend ring)', ({ backend, skip }) => {
  it.skipIf(skip).each(GEOMETRY_HISTORY_CASES)('$name', ({ ops, marks, pending }) => {
    if (backend === 'rust') vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', modulePath);
    const ring = new RingBuffer(4096, backend);
    expect(ring.backend).toBe(backend);
    run(ring, ops);
    expect(marksOf(ring)).toEqual(marks);
    expect(ring.geometryPending).toBe(pending);
    ring.dispose();
  });
});

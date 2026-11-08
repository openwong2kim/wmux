/**
 * The geometry history against what a viewer showed: a snapshot built from
 * the ring's marks must restore like a terminal driven through the sizes the
 * viewer applied, with both snapshot backends (xterm's and, with the built
 * module, Rust's).
 *
 * xterm keeps an alternate-screen row's cells past a narrower width and shows
 * them again when it widens; Alacritty drops them. So the Rust backend refuses
 * a narrowing over written alternate-screen cells (unsupported-alt-width) and
 * the xterm fallback restores them; a blank right side stays native.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingBuffer, type ReplayGeometry } from '../RingBuffer';
import { generateSnapshotUnqueued, type SnapshotRequest } from '../HeadlessSnapshot';
import { getAnsiSnapshotBackendDiagnostics } from '../AnsiSnapshotBackend';
import { available, liveDifference, modulePath } from './_rustParity';

type Step = { size: [number, number]; provisional?: true } | { out: string } | { settle: true };

interface Case {
  name: string;
  steps: Step[];
  /** What the viewer showed: the sizes its terminal applied, at their byte offsets. */
  shown: ReplayGeometry;
  /** The Rust backend refuses this history (and xterm restores it). */
  rustRefuses?: true;
}

const rowsOf = (n: number, width: number) => Array.from({ length: n }, (_, i) => `${i}`.padEnd(width, String.fromCharCode(97 + (i % 26)))).join('\r\n');

const CASES: Case[] = (() => {
  const alt = '\x1b[?1049h\x1b[H' + rowsOf(6, 38);
  const altNarrowWrite = '\x1b[3;1Hxy';
  // Leave the alternate screen and save the home cursor: no snapshot carries
  // the cursor its entry saved, which the parity probes would restore.
  const leave = '\x1b[?1049l\x1b[H\x1b7';
  const reenter = '\x1b[?1049l\x1b[H\x1b[?1049hfresh';
  const altBlankRight = '\x1b[?1049h\x1b[H' + rowsOf(6, 18);
  const altDip = '\x1b[?1049h\x1b[H' + rowsOf(8, 12) + '\x1b[8;1H';
  const primary = rowsOf(7, 70) + '\r\n$ ';
  const tall = '\x1b[?1049h\x1b[H' + rowsOf(10, 28);
  const repaint = '\x1b[H\x1b[2J';
  const before = 'prompt$ ls\r\n' + 'file '.repeat(6) + '\r\nprompt$ ';
  const redraw = '\x1b[2J\x1b[Hprompt$ ';
  return [
    {
      name: 'an alternate screen narrowed and widened back with no output between keeps its right side',
      steps: [{ size: [40, 8] }, { out: alt }, { size: [20, 8] }, { size: [40, 8] }, { out: '\x1b[8;1H' }],
      shown: { start: { cols: 40, rows: 8 }, changes: [{ offset: alt.length, cols: 20, rows: 8 }, { offset: alt.length, cols: 40, rows: 8 }] },
      rustRefuses: true,
    },
    {
      // Diverges with or without the geometry history's change: bytes at the
      // narrow width keep the mark under either rule.
      name: 'an alternate screen narrowed, written at the narrow width, then widened keeps its right side',
      steps: [{ size: [40, 8] }, { out: alt }, { size: [20, 8] }, { out: altNarrowWrite }, { size: [40, 8] }],
      shown: { start: { cols: 40, rows: 8 }, changes: [{ offset: alt.length, cols: 20, rows: 8 }, { offset: alt.length + altNarrowWrite.length, cols: 40, rows: 8 }] },
      rustRefuses: true,
    },
    {
      // Leaving the alternate screen drops the cells xterm kept, so the widen
      // cannot differ.
      name: 'an alternate screen narrowed over written cells, then left before the widen, stays native',
      steps: [{ size: [40, 8] }, { out: 'top\r\n' + alt }, { size: [20, 8] }, { out: leave }, { size: [40, 8] }],
      shown: { start: { cols: 40, rows: 8 }, changes: [{ offset: 5 + alt.length, cols: 20, rows: 8 }, { offset: 5 + alt.length + leave.length, cols: 40, rows: 8 }] },
    },
    {
      // Left and entered again with no resize between: the new alternate
      // screen holds none of the cut cells.
      name: 'an alternate screen narrowed over written cells, then left and entered again before the widen, stays native',
      steps: [{ size: [40, 8] }, { out: 'top\r\n' + alt }, { size: [20, 8] }, { out: reenter }, { size: [40, 8] }],
      shown: { start: { cols: 40, rows: 8 }, changes: [{ offset: 5 + alt.length, cols: 20, rows: 8 }, { offset: 5 + alt.length + reenter.length, cols: 40, rows: 8 }] },
    },
    {
      name: 'an alternate screen narrowed over a blank right side stays native',
      steps: [{ size: [40, 8] }, { out: altBlankRight }, { size: [20, 8] }, { out: altNarrowWrite }, { size: [40, 8] }],
      shown: { start: { cols: 40, rows: 8 }, changes: [{ offset: altBlankRight.length, cols: 20, rows: 8 }, { offset: altBlankRight.length + altNarrowWrite.length, cols: 40, rows: 8 }] },
    },
    {
      // The narrow wraps the long lines and pushes rows into scrollback with
      // the cursor near the bottom; the widen joins them again.
      name: 'a primary screen with long lines narrowed and widened back with no output between',
      steps: [{ size: [80, 8] }, { out: primary }, { size: [30, 8] }, { size: [80, 8] }],
      shown: { start: { cols: 80, rows: 8 }, changes: [{ offset: primary.length, cols: 30, rows: 8 }, { offset: primary.length, cols: 80, rows: 8 }] },
    },
    {
      name: 'an alternate screen made shorter and taller back with no output between loses its rows',
      steps: [{ size: [20, 8] }, { out: altDip }, { size: [20, 5] }, { size: [20, 8] }, { out: '\x1b[1;1H' }],
      shown: { start: { cols: 20, rows: 8 }, changes: [{ offset: altDip.length, cols: 20, rows: 5 }, { offset: altDip.length, cols: 20, rows: 8 }] },
    },
    {
      name: 'a size taken before the replay, with a repaint, then the viewer size: never shown',
      steps: [{ size: [30, 10] }, { out: tall }, { size: [34, 6], provisional: true }, { out: repaint }, { size: [30, 10] }, { out: tall }],
      shown: { start: { cols: 30, rows: 10 }, changes: [] },
    },
    {
      name: 'a size taken before the replay is kept by its end',
      steps: [{ size: [20, 6] }, { out: before }, { size: [30, 8], provisional: true }, { out: redraw }, { settle: true }, { out: 'echo hi' }],
      shown: { start: { cols: 20, rows: 6 }, changes: [{ offset: before.length, cols: 30, rows: 8 }] },
    },
  ];
})();

function requestFor(steps: Step[]): SnapshotRequest {
  const ring = new RingBuffer(64 * 1024, 'node');
  let last: [number, number] = [80, 24];
  for (const step of steps) {
    if ('size' in step) { ring.noteGeometry(step.size[0], step.size[1], !step.provisional); last = step.size; }
    else if ('out' in step) ring.write(Buffer.from(step.out));
    else ring.settleGeometry();
  }
  const { data, geometry } = ring.readAllWithGeometry();
  return { cols: last[0], rows: last[1], scrollback: 100, initial: data, geometry };
}

afterEach(() => vi.unstubAllEnvs());

describe.each([
  { backend: 'xterm', mode: 'off', skip: false },
  { backend: 'rust', mode: 'ansi', skip: !available },
])('the geometry history restores what the viewer showed ($backend snapshot)', ({ mode, skip }) => {
  it.skipIf(skip).each(CASES)('$name', async ({ steps, shown, rustRefuses }) => {
    if (mode === 'ansi') vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', modulePath);
    vi.stubEnv('WMUX_RUST_SNAPSHOT', mode);
    const req = requestFor(steps);
    const refusedBefore = getAnsiSnapshotBackendDiagnostics().reasons['unsupported-alt-width'] ?? 0;
    const snapshot = await generateSnapshotUnqueued(req);
    expect(snapshot.ok, JSON.stringify(snapshot)).toBe(true);
    if (!snapshot.ok) return;
    if (mode === 'ansi') {
      expect(getAnsiSnapshotBackendDiagnostics().last?.backend).toBe(rustRefuses ? 'xterm' : 'rust');
      expect((getAnsiSnapshotBackendDiagnostics().reasons['unsupported-alt-width'] ?? 0) - refusedBefore).toBe(rustRefuses ? 1 : 0);
    }
    expect(await liveDifference({ ...req, geometry: shown }, snapshot.payload)).toBeUndefined();
  });
});

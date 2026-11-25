// The delivery frame is the output ring replayed into a headless terminal.
// Claude's fullscreen renderer repaints by cell diff, so once the ring has
// dropped the bytes that last drew a row, a replay of the ring alone shows
// that row blank. The screen checkpoint (screenCheckpoint.ts) keeps the grid
// across the wrap; a cell nothing vouches for stays unknown.
import { describe, expect, it } from 'vitest';
import { cursorInComposer, deliveryFrameOf, readComposer, type DeliveryPhase } from '../deliveryComposer';
import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';
import { enqueueSnapshotJob } from '../HeadlessSnapshot';
import { queuedScreenText } from '../queuedSessionText';
import { noteScreenOutput, screenCheckpointBytes, screenCheckpointCounters, takeScreenCheckpoint } from '../screenCheckpoint';
import { getAnsiSnapshotBackendDiagnostics } from '../AnsiSnapshotBackend';
import { rustTerminalCoreAvailable } from '../../shared/terminalCoreSettings';

const RULE = '─'.repeat(80);
const at = (row: number, col: number, text: string): string => `\x1b[${row};${col}H${text}`;
const COLS = 80;
const ROWS = 10;

interface Pane {
  feed(text: string): Promise<void>;
  /** Whether the bridge notes each write (screenCheckpoint's trigger). */
  checkpoints: boolean;
  ring: RingBuffer;
  modes: OutputModeTracker;
  meta: { cols: number; rows: number };
}

/** A pane whose ring holds `capacity` bytes; `checkpoints`: the bridge notes each write. */
function pane(capacity: number, checkpoints: boolean): Pane {
  const ring = new RingBuffer(capacity, 'node');
  const modes = new OutputModeTracker();
  const meta = { cols: COLS, rows: ROWS };
  return {
    ring, modes, meta, checkpoints,
    async feed(text) {
      ring.write(Buffer.from(text));
      modes.feed(text, ring.totalBytesWritten);
      if (!this.checkpoints) return;
      noteScreenOutput(ring, modes, () => ({ cols: meta.cols, rows: meta.rows }));
      // The event loop between two PTY chunks: a queued checkpoint runs.
      await enqueueSnapshotJob(async () => undefined);
    },
  };
}

/** Claude's frame, then hours of output that repaints only the transcript row and the status line's number. */
async function claudeSession(p: Pane, draft: string): Promise<void> {
  await p.feed('\x1b[?1049h\x1b[2J');
  await p.feed(at(3, 1, RULE) + at(4, 1, `❯\u00a0${draft}`) + at(5, 1, RULE) + at(6, 1, '  Opus · acct · ctx 9% · 7d 68%') + at(7, 1, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'));
  for (let i = 0; i < 400; i++) await p.feed(at(1, 1, `⏺ line ${i}`.padEnd(40)) + at(6, 23, `${10 + (i % 80)}%`));
}

async function read(p: Pane, phase: DeliveryPhase = 'paste') {
  const session = { meta: p.meta, ringBuffer: p.ring, bridge: { outputModes: p.modes } };
  const outcome = await queuedScreenText({ getSession: () => session }, 'pane', true, { keepUnknown: true });
  if (!outcome?.ok) throw new Error('screen read failed');
  const frame = deliveryFrameOf(outcome.rows, outcome.rowsBelowCursor);
  const composer = readComposer(frame, 'claude', phase);
  return { frame, verdict: composer.verdict, cursorIn: cursorInComposer(frame, composer) };
}

describe('a delivery frame replayed from a wrapped ring', () => {
  it('a ring that still holds the whole frame reads the empty composer as plain', async () => {
    const p = pane(1 << 20, false);
    await claudeSession(p, '');
    expect((await read(p)).verdict).toBe('plain');
  });

  it('without a checkpoint, a wrapped ring loses the closing rule and reads unknown, as the affected panes did', async () => {
    const p = pane(4096, false);
    await claudeSession(p, '');
    // The update notice arrives; the top rule and the prompt glyph are redrawn, the cells that did not change are not.
    await p.feed(at(2, 41, '✔ Update installed · /restart to apply') + at(3, 1, RULE) + at(4, 1, '❯'));
    const { frame, verdict } = await read(p);
    expect(frame.rows[3]).toBe('❯');
    expect(frame.rows[4]).toBe('');
    expect(verdict).toBe('unknown');
  });

  it('without a checkpoint, a draft whose cells the ring lost is unknown, not an empty prompt, even with both rules redrawn', async () => {
    const p = pane(4096, false);
    await claudeSession(p, 'my draft');
    await p.feed(at(3, 1, RULE) + at(4, 1, '❯') + at(5, 1, RULE));
    const { frame, verdict } = await read(p);
    // Every other reader sees the lost cells as blanks, as before.
    expect(frame.rows.slice(2, 5)).toEqual([RULE, '❯', RULE]);
    expect(verdict).toBe('unknown');
  });

  it('with checkpoints, the same session reads the idle composer as plain after the wrap', async () => {
    const p = pane(4096, true);
    await claudeSession(p, '');
    await p.feed(at(2, 41, '✔ Update installed · /restart to apply') + at(3, 1, RULE) + at(4, 1, '❯'));
    expect(screenCheckpointBytes(p.ring)).toBeGreaterThan(0);
    const { frame, verdict } = await read(p);
    expect(frame.rows.slice(2, 5)).toEqual([RULE, '❯\u00a0', RULE]);
    expect(frame.rows.unknown).toBeUndefined();
    expect(verdict).toBe('plain');
    expect((await read(p, 'enter')).verdict).toBe('plain');
  });

  it('with checkpoints, a draft drawn before the wrap is read back as a draft', async () => {
    const p = pane(4096, true);
    await claudeSession(p, 'my draft');
    await p.feed(at(3, 1, RULE) + at(4, 1, '❯') + at(5, 1, RULE));
    const { frame, verdict } = await read(p);
    expect(frame.rows[3]).toBe('❯\u00a0my draft');
    expect(verdict).toBe('busy');
  });

  it('a first checkpoint taken after the ring wrapped carries its unknown cells: the hidden draft stays unknown', async () => {
    const p = pane(4096, false);
    await claudeSession(p, 'my draft');
    // The bridge starts noting writes only now (a daemon that took up an already-wrapped ring).
    p.checkpoints = true;
    const rebuiltBefore = screenCheckpointCounters().rebuiltFromWrappedRing;
    for (let i = 0; i < 100; i++) await p.feed(at(1, 1, `⏺ late ${i}`.padEnd(40)));
    expect(screenCheckpointCounters().rebuiltFromWrappedRing).toBeGreaterThan(rebuiltBefore);
    await p.feed(at(3, 1, RULE) + at(4, 1, '❯') + at(5, 1, RULE));
    expect(screenCheckpointBytes(p.ring)).toBeGreaterThan(0);
    expect((await read(p)).verdict).toBe('unknown');
  });

  it('with checkpoints, a dimmed suggestion in the idle prompt still reads empty, and the cursor sits on the prompt', async () => {
    const p = pane(4096, true);
    await claudeSession(p, '\x1b[2mTry "fix lint"\x1b[0m');
    // Claude leaves the cursor in its prompt row.
    await p.feed(at(3, 1, RULE) + at(4, 1, '❯') + at(4, 3, ''));
    const { frame, verdict, cursorIn } = await read(p);
    expect(frame.rows[3]).toBe('❯\u00a0Try "fix lint"');
    expect(verdict).toBe('plain');
    expect(cursorIn).toBe(true);
  });

  it('a ring cleared after its checkpoint (a chunk it refused to store) does not replay across the hole', async () => {
    const p = pane(4096, true);
    await claudeSession(p, '');
    expect(screenCheckpointBytes(p.ring)).toBeGreaterThan(0);
    p.ring.clear();
    await p.feed(at(3, 1, RULE) + at(4, 1, '❯') + at(5, 1, RULE));
    // The cells around the redrawn rows are no longer vouched for.
    expect((await read(p)).verdict).toBe('unknown');
  });

  it('a shrink and a grow back at the checkpoint\'s own byte still invalidate it', async () => {
    const p = pane(4096, true);
    await claudeSession(p, '');
    // A checkpoint at the ring's very end, then no output between the two marks: both sit at its offset, and the size ends where it was.
    expect(await takeScreenCheckpoint(p.ring, p.modes, () => ({ cols: COLS, rows: ROWS }))).toBe(true);
    p.ring.noteGeometry(COLS, 4);
    p.ring.noteGeometry(COLS, ROWS);
    p.checkpoints = false;
    await p.feed(at(1, 1, 'x'));
    expect((await read(p)).verdict).not.toBe('plain');
  });

  it('a checkpoint left at an old size is replaced at once, so the next wrap is still covered', async () => {
    const p = pane(4096, true);
    await claudeSession(p, '');
    // A checkpoint at the ring's end; then the pane grows and Claude repaints its whole frame at the new size.
    expect(await takeScreenCheckpoint(p.ring, p.modes, () => ({ cols: COLS, rows: ROWS }))).toBe(true);
    p.ring.noteGeometry(COLS, ROWS + 2);
    p.meta.rows = ROWS + 2;
    const taken = screenCheckpointCounters().taken;
    await p.feed('\x1b[2J' + at(3, 1, RULE) + at(4, 1, '❯\u00a0') + at(5, 1, RULE));
    // Replaced on the first write at the new size, not a quarter of the ring later.
    expect(screenCheckpointCounters().taken).toBe(taken + 1);
    // Then output that rewrites only the transcript row, past another wrap.
    for (let i = 0; i < 400; i++) await p.feed(at(1, 1, `⏺ grown ${i}`.padEnd(40)));
    expect((await read(p)).verdict).toBe('plain');
  });

  it('a checkpoint does not outlive a resize or the alternate screen', async () => {
    const p = pane(4096, true);
    await claudeSession(p, '');
    expect(screenCheckpointBytes(p.ring)).toBeGreaterThan(0);
    // A resize: the bytes after the checkpoint are at another size, so the ring alone is read.
    p.ring.noteGeometry(COLS, ROWS + 1);
    p.meta.rows = ROWS + 1;
    await p.feed(at(1, 1, 'after resize'));
    expect((await read(p)).verdict).not.toBe('plain');
    // Leaving the alternate screen drops it.
    await p.feed('\x1b[?1049l');
    expect(screenCheckpointBytes(p.ring)).toBe(0);
  });
});

describe('a checkpoint taken mid-sequence', () => {
  const legs = [{ backend: 'xterm', mode: 'off' }, ...(rustTerminalCoreAvailable() ? [{ backend: 'rust', mode: undefined }] : [])];
  it.each(legs)('re-emits an unfinished CSI and an unfinished UTF-8 character on $backend', async ({ backend, mode }) => {
    const prev = process.env.WMUX_RUST_SNAPSHOT;
    if (mode === undefined) delete process.env.WMUX_RUST_SNAPSHOT;
    else process.env.WMUX_RUST_SNAPSHOT = mode;
    try {
      const p = pane(1 << 20, false);
      await claudeSession(p, '');
      const size = () => ({ cols: COLS, rows: ROWS });
      const bytes = (data: Buffer): void => p.ring.write(data);
      // The ring ends inside `\x1b[4;3H`.
      bytes(Buffer.from('\x1b[4;'));
      const nativeBefore = getAnsiSnapshotBackendDiagnostics().native;
      expect(await takeScreenCheckpoint(p.ring, p.modes, size)).toBe(true);
      // The leg ran on the serializer it names.
      expect(getAnsiSnapshotBackendDiagnostics().native - nativeBefore).toBe(backend === 'rust' ? 1 : 0);
      bytes(Buffer.from('3Hab'));
      // Then inside the three bytes of `가`.
      const ga = Buffer.from('가');
      bytes(Buffer.concat([Buffer.from(at(4, 5, '')), ga.subarray(0, 1)]));
      expect(await takeScreenCheckpoint(p.ring, p.modes, size)).toBe(true);
      bytes(ga.subarray(1));
      const { frame } = await read(p);
      expect(frame.rows[3]).toBe('❯\u00a0ab가');
    } finally {
      if (prev === undefined) delete process.env.WMUX_RUST_SNAPSHOT;
      else process.env.WMUX_RUST_SNAPSHOT = prev;
    }
  });
});

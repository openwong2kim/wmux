// A tail answer is for display and estimates only. It must never reach a
// whole-ring reader (the approval gate's screen read, a text read, the
// verifier's 'pane' frame) through screenReadCache's reuse or a join, nor the
// reverse, and only the two opted-in sites may ask for one.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingBuffer } from '../RingBuffer';
import { OutputModeTracker } from '../util/outputModeTracker';
import { enqueueSnapshotJob, type TextSnapshotOutcome } from '../HeadlessSnapshot';
import { fencedRead, resetScreenReadCounters, screenReadCounters, snapshotQueueCounters } from '../screenReadCache';
import { resetTailReadCounters, tailReadCounters } from '../guardedTailRead';
import * as guarded from '../guardedTailRead';
import { queuedScreenTail, queuedScreenText, queuedTextSnapshot, queuedTextTail, type TextReadSession } from '../queuedSessionText';

vi.mock('../guardedTailRead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../guardedTailRead')>();
  return { ...actual, guardedTailRead: vi.fn(actual.guardedTailRead) };
});

/** A ring past the tail, served by it (the pages erase, so the tail knows every cell). */
function servedSession(): TextReadSession {
  const ringBuffer = new RingBuffer(2 * 1024 * 1024);
  const outputModes = new OutputModeTracker();
  const write = (chunk: string) => { ringBuffer.write(Buffer.from(chunk)); outputModes.feed(chunk, ringBuffer.totalBytesWritten); };
  for (let i = 0; i < 360; i++) write(`\x1b[H\x1b[2J${`\x1b[5;1H${'y'.repeat(70)}`.repeat(14)}\x1b[1;1Hframe ${i}`);
  return { meta: { cols: 80, rows: 24 }, ringBuffer, bridge: { outputModes } };
}

/** Same, but with margins left on before the cut, so the tail read falls back. */
function fallbackSession(): TextReadSession {
  const s = servedSession();
  const ringBuffer = new RingBuffer(2 * 1024 * 1024);
  const outputModes = new OutputModeTracker();
  const write = (chunk: string) => { ringBuffer.write(Buffer.from(chunk)); outputModes.feed(chunk, ringBuffer.totalBytesWritten); };
  write('\x1b[1;20r');
  write(s.ringBuffer.readAll().toString('utf8'));
  return { meta: { cols: 80, rows: 24 }, ringBuffer, bridge: { outputModes } };
}

const table = (s: TextReadSession) => ({ getSession: (id: string) => (id === 'pane' ? s : undefined) });
const rows = (o: TextSnapshotOutcome | null) => (o?.ok ? o.rows.map((r) => r.text) : null);

function holdQueue(): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { release, done: enqueueSnapshotJob(() => held) };
}

afterEach(() => { resetScreenReadCounters(); resetTailReadCounters(); vi.mocked(guarded.guardedTailRead).mockClear(); });

describe('guarded tail isolation', () => {
  it('a whole-ring screen read after a tail read at the same fence misses and parses, and the reverse', async () => {
    const s = servedSession();
    const tail = await queuedScreenTail(table(s), 'pane', 'stallwatch');
    expect(tail?.via).toBe('tail');
    const full = await queuedScreenText(table(s), 'pane');
    expect(screenReadCounters()).toMatchObject({ 'screen-tail': { misses: 1, hits: 0, joins: 0 }, screen: { misses: 1, hits: 0, joins: 0 } });
    expect(full).not.toHaveProperty('via');

    const t = servedSession();
    await queuedScreenText(table(t), 'pane');
    await queuedScreenTail(table(t), 'pane', 'stallwatch');
    expect(screenReadCounters()).toMatchObject({ 'screen-tail': { misses: 2, hits: 0 }, screen: { misses: 2, hits: 0 } });
  });

  it('a tail fallback is cached under the tail kind only: a whole-ring text read at its fence still misses, and the reverse', async () => {
    const s = fallbackSession();
    const tail = await queuedTextTail(table(s), 'pane', 80, 'fleet');
    expect(tail?.via).toBe('full');
    expect(tailReadCounters().fleet.fallbacks).toEqual({ margins: 1 });
    const full = await queuedTextSnapshot(table(s), 'pane', 80);
    expect(screenReadCounters()).toMatchObject({ 'text-tail': { misses: 1, hits: 0 }, text: { misses: 1, hits: 0 } });
    expect(rows(full)).toEqual(rows(tail));
    // The tail kind reuses its own fallback answer at the same fence.
    const again = await queuedTextTail(table(s), 'pane', 80, 'fleet');
    expect(again?.via).toBe('full');
    expect(screenReadCounters()['text-tail']).toMatchObject({ misses: 1, hits: 1 });

    const t = fallbackSession();
    await queuedTextSnapshot(table(t), 'pane', 80);
    await queuedTextTail(table(t), 'pane', 80, 'fleet');
    expect(screenReadCounters()).toMatchObject({ 'text-tail': { misses: 2 }, text: { misses: 2, hits: 0 } });
  });

  it('a tail read and a whole-ring read in flight together are two jobs, never joined', async () => {
    const s = servedSession();
    const queue = holdQueue();
    const before = snapshotQueueCounters().jobs;
    const tail = queuedScreenTail(table(s), 'pane', 'stallwatch');
    const full = queuedScreenText(table(s), 'pane');
    queue.release();
    await queue.done;
    expect((await tail)?.via).toBe('tail');
    expect(await full).not.toHaveProperty('via');
    expect(snapshotQueueCounters().jobs - before).toBe(3);
    expect(screenReadCounters()).toMatchObject({ 'screen-tail': { joins: 0 }, screen: { joins: 0 } });
  });

  it('concurrent tail reads of one fence share one job', async () => {
    const s = servedSession();
    const queue = holdQueue();
    const before = snapshotQueueCounters().jobs;
    const reads = [queuedScreenTail(table(s), 'pane', 'stallwatch'), queuedScreenTail(table(s), 'pane', 'stallwatch')];
    queue.release();
    await queue.done;
    const [a, b] = await Promise.all(reads);
    expect(a).toBe(b);
    expect(snapshotQueueCounters().jobs - before).toBe(2);
    expect(tailReadCounters().stallwatch.reads).toBe(1);
  });

  it("the verifier's 'pane' frame never reuses a tail answer at the same fence", async () => {
    const s = servedSession();
    await queuedScreenTail(table(s), 'pane', 'stallwatch');
    const fence = `${s.ringBuffer.totalBytesWritten}:80x24:x`;
    const read = vi.fn(async () => 'pane frame');
    expect(await fencedRead(s, 'pane', fence, read, () => fence)).toBe('pane frame');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('the whole-ring reads never call the guarded tail', async () => {
    const s = servedSession();
    await queuedScreenText(table(s), 'pane');
    await queuedScreenText(table(s), 'pane', true);
    await queuedTextSnapshot(table(s), 'pane', 80);
    expect(guarded.guardedTailRead).not.toHaveBeenCalled();
    await queuedScreenTail(table(s), 'pane', 'stallwatch');
    expect(guarded.guardedTailRead).toHaveBeenCalledTimes(1);
  });

  it('in the daemon, only StallWatch and the opted-in readSessionText ask for a tail', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    expect(source.match(/queuedScreenTail\(/g)).toHaveLength(1);
    expect(source.match(/queuedTextTail\(/g)).toHaveLength(1);
    expect(source).toMatch(/readScreen: async \(id\) => \{\s*const outcome = await queuedScreenTail\(sessionManager, id, 'stallwatch'/);
    expect(source).toMatch(/p\.tail === true\s*\?\s*await queuedTextTail\(sessionManager, p\.id, scrollback, 'fleet'\)\s*:\s*await queuedTextSnapshot\(/);
    // The approval gate keeps the whole ring.
    expect(source).toMatch(/readScreenTail: async \(sessionId\) => \{\s*const outcome = await queuedScreenText\(sessionManager, sessionId\);/);
  });
});

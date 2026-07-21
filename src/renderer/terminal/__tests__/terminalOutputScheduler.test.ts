import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeTerminalOutput,
  flushTerminalOutput,
  noteTerminalInput,
  discardTerminalOutput,
  getQueuedCharCount,
  promoteTerminalToPriorityDrain,
  __resetTerminalOutputSchedulerForTests,
  type SchedulableTerminal,
} from '../terminalOutputScheduler';

/** Fake terminal capturing every write; optionally throws (disposed race). */
function makeTerminal(): SchedulableTerminal & { writes: string[]; disposed: boolean } {
  const t = {
    writes: [] as string[],
    disposed: false,
    write(data: string) {
      if (t.disposed) throw new Error('disposed');
      t.writes.push(data);
    },
  };
  return t;
}

function joined(t: { writes: string[] }): string {
  return t.writes.join('');
}

describe('terminalOutputScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetTerminalOutputSchedulerForTests();
  });

  afterEach(() => {
    __resetTerminalOutputSchedulerForTests();
    vi.useRealTimers();
  });

  it('foreground write inside the interactive window writes directly (echo parity)', () => {
    const t = makeTerminal();
    noteTerminalInput(t); // user just typed → echo takes the direct path
    writeTerminalOutput(t, 'abc', { foreground: true });
    expect(t.writes).toEqual(['abc']);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('foreground streaming with NO recent input is queued + coordinated, not direct', () => {
    const t = makeTerminal();
    // No noteTerminalInput → this is streaming output (agent torrent), not echo.
    writeTerminalOutput(t, 'stream', { foreground: true });
    expect(t.writes).toEqual([]); // did NOT pin the thread with a direct write
    expect(getQueuedCharCount(t)).toBe(6); // queued for coordinated drain
    vi.runAllTimers();
    expect(joined(t)).toBe('stream'); // delivered in order via the drain
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('background write is deferred, then drained in order', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'one', { foreground: false });
    writeTerminalOutput(t, 'two', { foreground: false });
    expect(t.writes).toEqual([]);
    expect(getQueuedCharCount(t)).toBe(6);
    vi.runAllTimers();
    expect(joined(t)).toBe('onetwo');
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('promoteTerminalToPriorityDrain drains a non-retained backlog in order, no data loss', () => {
    const t = makeTerminal();
    // A non-retained hidden backlog (reveal-budgeted-catchup case): can't be
    // discarded, must be drained without a synchronous burst.
    writeTerminalOutput(t, 'alpha', { foreground: false });
    writeTerminalOutput(t, 'beta', { foreground: false });
    expect(t.writes).toEqual([]);
    promoteTerminalToPriorityDrain(t);
    vi.runAllTimers();
    expect(joined(t)).toBe('alphabeta'); // all bytes delivered, order preserved
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('promoteTerminalToPriorityDrain is a no-op on an empty queue', () => {
    const t = makeTerminal();
    promoteTerminalToPriorityDrain(t); // nothing queued
    vi.runAllTimers();
    expect(t.writes).toEqual([]);
  });

  it('an oversized foreground chunk is batch-chunked, not written in one parse', () => {
    const t = makeTerminal();
    const flood = 'F'.repeat(100 * 1024); // > 64KB foreground-direct threshold
    writeTerminalOutput(t, flood, { foreground: true });
    // Not handed over in one giant write — routed through the drain instead.
    expect(t.writes).toEqual([]);
    expect(getQueuedCharCount(t)).toBe(flood.length);
    vi.runAllTimers();
    // Delivered in bounded slices, in order, in full.
    expect(joined(t)).toBe(flood);
    for (const w of t.writes) expect(w.length).toBeLessThanOrEqual(16 * 1024);
    expect(t.writes.length).toBeGreaterThan(1);
  });

  it('a foreground chunk at the threshold still takes the direct path (in-window)', () => {
    const t = makeTerminal();
    noteTerminalInput(t);
    const atLimit = 'G'.repeat(64 * 1024); // == threshold, still direct
    writeTerminalOutput(t, atLimit, { foreground: true });
    expect(t.writes).toEqual([atLimit]);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('foreground write behind a queued backlog preserves per-terminal order', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'hidden', { foreground: false });
    // Pane just became visible mid-backlog: fg byte must NOT overtake.
    writeTerminalOutput(t, 'fg', { foreground: true });
    expect(t.writes).toEqual([]);
    vi.runAllTimers();
    expect(joined(t)).toBe('hiddenfg');
  });

  it('onWritten fires with the handed-off char count (direct and drained)', () => {
    const t = makeTerminal();
    const written: number[] = [];
    noteTerminalInput(t); // direct-path write (in interactive window)
    writeTerminalOutput(t, 'abcd', { foreground: true, onWritten: (n) => written.push(n) });
    expect(written).toEqual([4]);
    writeTerminalOutput(t, 'ef', { foreground: false, onWritten: (n) => written.push(n) });
    vi.runAllTimers();
    expect(written).toEqual([4, 2]);
  });

  it('drains large backlogs in bounded chunks across ticks, order preserved', () => {
    const t = makeTerminal();
    const big = 'x'.repeat(100 * 1024) + 'END';
    writeTerminalOutput(t, big, { foreground: false });
    vi.advanceTimersByTime(50); // first background flush window
    expect(t.writes.length).toBeGreaterThan(0);
    // Each hand-off is bounded (16 KB chunk size).
    for (const w of t.writes) expect(w.length).toBeLessThanOrEqual(16 * 1024);
    expect(getQueuedCharCount(t)).toBeGreaterThan(0); // not all in one tick
    vi.runAllTimers();
    expect(joined(t)).toBe(big);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('round-robins across terminals so one flood cannot monopolize the drain', () => {
    const a = makeTerminal();
    const b = makeTerminal();
    writeTerminalOutput(a, 'a'.repeat(64 * 1024), { foreground: false });
    writeTerminalOutput(b, 'b'.repeat(64 * 1024), { foreground: false });
    // After a few ticks BOTH terminals must have made progress.
    vi.advanceTimersByTime(50 + 16 * 2);
    expect(a.writes.length).toBeGreaterThan(0);
    expect(b.writes.length).toBeGreaterThan(0);
    vi.runAllTimers();
    expect(joined(a)).toBe('a'.repeat(64 * 1024));
    expect(joined(b)).toBe('b'.repeat(64 * 1024));
  });

  it('priority (foreground-queued) entries drain before background entries', () => {
    const bg = makeTerminal();
    const fg = makeTerminal();
    writeTerminalOutput(bg, 'bg1', { foreground: false });
    writeTerminalOutput(fg, 'seed', { foreground: false });
    writeTerminalOutput(fg, 'fast', { foreground: true }); // marks fg entry priority
    // The zero-delay drain must service the priority terminal first.
    vi.advanceTimersByTime(0);
    expect(joined(fg)).toBe('seedfast');
    vi.runAllTimers();
    expect(joined(bg)).toBe('bg1');
  });

  it('overflow past the queue cap flushes everything (no data loss, baseline parity)', () => {
    const t = makeTerminal();
    const chunk = 'y'.repeat(1024 * 1024);
    writeTerminalOutput(t, chunk, { foreground: false });
    writeTerminalOutput(t, chunk, { foreground: false });
    expect(t.writes).toEqual([]); // still under 2 MB cap
    writeTerminalOutput(t, 'z', { foreground: false }); // crosses the cap
    // Overflow hands the whole queue to xterm synchronously.
    expect(joined(t)).toBe(chunk + chunk + 'z');
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('flushTerminalOutput hands over all queued bytes synchronously in order', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'AA', { foreground: false });
    writeTerminalOutput(t, 'BB', { foreground: false });
    flushTerminalOutput(t);
    expect(joined(t)).toBe('AABB');
    // Nothing left for the timer to write.
    vi.runAllTimers();
    expect(joined(t)).toBe('AABB');
  });

  it('discardTerminalOutput drops the queue without writing', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'gone', { foreground: false });
    discardTerminalOutput(t);
    vi.runAllTimers();
    expect(t.writes).toEqual([]);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('a disposed terminal mid-drain does not break other terminals', () => {
    const dead = makeTerminal();
    const alive = makeTerminal();
    writeTerminalOutput(dead, 'doomed', { foreground: false });
    writeTerminalOutput(alive, 'ok', { foreground: false });
    dead.disposed = true;
    vi.runAllTimers();
    expect(joined(alive)).toBe('ok');
    expect(getQueuedCharCount(dead)).toBe(0); // entry dropped, not stuck
  });

  it('a disposed terminal on the direct foreground path does not throw', () => {
    const dead = makeTerminal();
    dead.disposed = true;
    expect(() => writeTerminalOutput(dead, 'x', { foreground: true })).not.toThrow();
  });

  it('empty data is a no-op', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, '', { foreground: false });
    vi.runAllTimers();
    expect(t.writes).toEqual([]);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('foreground direct write resumes once the backlog fully drains (in-window)', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'queued', { foreground: false });
    vi.runAllTimers();
    expect(joined(t)).toBe('queued');
    // Queue is empty again AND the user typed → back on the direct path.
    noteTerminalInput(t);
    writeTerminalOutput(t, '!', { foreground: true });
    expect(joined(t)).toBe('queued!');
  });
});

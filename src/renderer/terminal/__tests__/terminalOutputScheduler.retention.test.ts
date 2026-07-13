// Phase 3 (PR-A) — hidden-pane retention policy: hidden bytes are queued but
// never drained (zero renderer parsing), overflow discards + marks dirty, and
// the dirty flag drives the owner's daemon resync. See the module header of
// terminalOutputScheduler.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeTerminalOutput,
  flushTerminalOutput,
  noteTerminalInput,
  discardTerminalOutput,
  getQueuedCharCount,
  isTerminalDirty,
  markTerminalDirty,
  markTerminalClean,
  __resetTerminalOutputSchedulerForTests,
  type SchedulableTerminal,
} from '../terminalOutputScheduler';

const MAX_QUEUE_CHARS = 2 * 1024 * 1024; // scheduler cap (kept in sync manually)

function makeTerminal(): SchedulableTerminal & { writes: string[] } {
  const t = {
    writes: [] as string[],
    write(data: string) {
      t.writes.push(data);
    },
  };
  return t;
}

function joined(t: { writes: string[] }): string {
  return t.writes.join('');
}

describe('terminalOutputScheduler — hidden-pane retention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetTerminalOutputSchedulerForTests();
  });

  afterEach(() => {
    __resetTerminalOutputSchedulerForTests();
    vi.useRealTimers();
  });

  it('retained hidden bytes are NEVER drained by timers', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'hidden1', { foreground: false, retainWhenHidden: true });
    writeTerminalOutput(t, 'hidden2', { foreground: false, retainWhenHidden: true });
    vi.advanceTimersByTime(60_000);
    expect(t.writes).toEqual([]);
    expect(getQueuedCharCount(t)).toBe(14);
    expect(isTerminalDirty(t)).toBe(false);
  });

  it('a retained backlog does not stall other terminals’ background drain', () => {
    const retained = makeTerminal();
    const normal = makeTerminal();
    writeTerminalOutput(retained, 'held', { foreground: false, retainWhenHidden: true });
    writeTerminalOutput(normal, 'flows', { foreground: false });
    vi.runAllTimers();
    expect(joined(normal)).toBe('flows');
    expect(retained.writes).toEqual([]);
  });

  it('a large retained backlog does not promote the drain cadence (no priority leak)', () => {
    const retained = makeTerminal();
    const normal = makeTerminal();
    // Past LARGE_BACKLOG_CHARS (512KB) but under the 2MB cap — retained, so it
    // must neither drain nor drive the priority cadence for others.
    writeTerminalOutput(retained, 'r'.repeat(600 * 1024), { foreground: false, retainWhenHidden: true });
    writeTerminalOutput(normal, 'n', { foreground: false });
    vi.runAllTimers();
    expect(retained.writes).toEqual([]);
    expect(joined(normal)).toBe('n');
  });

  it('flushTerminalOutput (clean reveal) hands over the retained backlog in order', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'AA', { foreground: false, retainWhenHidden: true });
    writeTerminalOutput(t, 'BB', { foreground: false, retainWhenHidden: true });
    flushTerminalOutput(t);
    expect(joined(t)).toBe('AABB');
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('a foreground write releases the retained backlog ahead of itself (order preserved)', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'held', { foreground: false, retainWhenHidden: true });
    // Pane became visible; a keystroke echo arrives before the reveal flush.
    writeTerminalOutput(t, '!', { foreground: true, retainWhenHidden: true });
    vi.runAllTimers();
    expect(joined(t)).toBe('held!');
  });

  it('overflow past the cap discards the backlog and marks the terminal dirty (no parse storm)', () => {
    const t = makeTerminal();
    const half = 'y'.repeat(MAX_QUEUE_CHARS / 2);
    writeTerminalOutput(t, half, { foreground: false, retainWhenHidden: true });
    writeTerminalOutput(t, half, { foreground: false, retainWhenHidden: true });
    expect(isTerminalDirty(t)).toBe(false);
    writeTerminalOutput(t, 'z', { foreground: false, retainWhenHidden: true }); // crosses cap
    // Unlike the non-retained overflow (flush-to-xterm baseline), retention
    // NEVER hands the flood to the parser — it discards and flags.
    expect(t.writes).toEqual([]);
    expect(getQueuedCharCount(t)).toBe(0);
    expect(isTerminalDirty(t)).toBe(true);
  });

  it('while dirty, further retained bytes are dropped outright', () => {
    const t = makeTerminal();
    markTerminalDirty(t);
    writeTerminalOutput(t, 'lost', { foreground: false, retainWhenHidden: true });
    expect(getQueuedCharCount(t)).toBe(0);
    vi.runAllTimers();
    expect(t.writes).toEqual([]);
    expect(isTerminalDirty(t)).toBe(true);
  });

  it('markTerminalClean re-arms retention accumulation', () => {
    const t = makeTerminal();
    markTerminalDirty(t);
    markTerminalClean(t);
    writeTerminalOutput(t, 'fresh', { foreground: false, retainWhenHidden: true });
    expect(getQueuedCharCount(t)).toBe(5);
    expect(isTerminalDirty(t)).toBe(false);
  });

  it('markTerminalDirty discards any queued bytes for the terminal', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'stale-replay', { foreground: false, retainWhenHidden: true });
    markTerminalDirty(t);
    expect(getQueuedCharCount(t)).toBe(0);
    vi.runAllTimers();
    expect(t.writes).toEqual([]);
  });

  it('discardTerminalOutput (teardown) clears the dirty flag too', () => {
    const t = makeTerminal();
    markTerminalDirty(t);
    discardTerminalOutput(t);
    expect(isTerminalDirty(t)).toBe(false);
  });

  it('without retainWhenHidden the hidden path behaves exactly as before (batched drain)', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, 'legacy', { foreground: false });
    vi.runAllTimers();
    expect(joined(t)).toBe('legacy');
    expect(isTerminalDirty(t)).toBe(false);
  });

  it('foreground direct path is unaffected by the retention option (in-window)', () => {
    const t = makeTerminal();
    noteTerminalInput(t); // interactive window → direct path (retention is hidden-only)
    writeTerminalOutput(t, 'echo', { foreground: true, retainWhenHidden: true });
    expect(t.writes).toEqual(['echo']);
  });
});

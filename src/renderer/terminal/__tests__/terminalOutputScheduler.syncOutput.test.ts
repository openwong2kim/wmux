import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  writeTerminalOutput,
  flushTerminalOutput,
  noteTerminalInput,
  discardTerminalOutput,
  getQueuedCharCount,
  __resetTerminalOutputSchedulerForTests,
  type SchedulableTerminal,
} from '../terminalOutputScheduler';

// DEC 2026 synchronized-output coalescing (GPU repaint-burst fix, 2026-07-21).
// A TUI wraps a full-screen repaint in BEGIN…END; the scheduler holds the
// intermediate chunks out of xterm and releases them in ONE drain on END, so
// Chromium rasters the frame once instead of once per intermediate chunk.
const BEGIN = '\x1b[?2026h';
const END = '\x1b[?2026l';

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

describe('terminalOutputScheduler — DEC 2026 synchronized output', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetTerminalOutputSchedulerForTests();
  });

  afterEach(() => {
    __resetTerminalOutputSchedulerForTests();
    vi.useRealTimers();
  });

  it('holds intermediate frame chunks out of xterm until the END marker', () => {
    const t = makeTerminal();
    // Frame opens; body arrives across two chunks; nothing should reach xterm yet.
    writeTerminalOutput(t, `${BEGIN}row1`, { foreground: true });
    writeTerminalOutput(t, 'row2', { foreground: true });
    writeTerminalOutput(t, 'row3', { foreground: true });
    expect(t.writes).toEqual([]); // held — no raster of transient states
    expect(getQueuedCharCount(t)).toBeGreaterThan(0);

    // END arrives → one coalesced release.
    writeTerminalOutput(t, `row4${END}`, { foreground: true });
    vi.runAllTimers();
    expect(joined(t)).toBe(`${BEGIN}row1row2row3row4${END}`);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('releases the held frame on the safety timeout, closing sync mode with a synthetic END', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, `${BEGIN}partial`, { foreground: true });
    expect(t.writes).toEqual([]); // held

    // No END marker. The bounded safety timer must release the hold so the pane
    // never wedges mid-frame — and append a synthetic END so xterm (which honors
    // DEC 2026 natively) exits its own synchronized-output hold and paints.
    vi.runAllTimers();
    expect(joined(t)).toBe(`${BEGIN}partial${END}`);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('does NOT postpone the absolute safety deadline when body chunks keep arriving', () => {
    const t = makeTerminal();
    // Non-interactive frame (250ms deadline). A frame that opens and then keeps
    // streaming body must still release at ~250ms from OPEN — the deadline is
    // absolute, not re-armed per chunk (else a busy unclosed frame stays blank
    // until the 2MB overflow cap).
    writeTerminalOutput(t, `${BEGIN}a`, { foreground: true });
    vi.advanceTimersByTime(100);
    writeTerminalOutput(t, 'b', { foreground: true });
    vi.advanceTimersByTime(100);
    writeTerminalOutput(t, 'c', { foreground: true });
    expect(t.writes).toEqual([]); // still held at t=200, no END
    // t=260 (> 250 from open): the absolute deadline fires despite the body at
    // t=100 and t=200. If the timer were re-armed per chunk it would fire at
    // 200+250=450 and this would still be blank.
    vi.advanceTimersByTime(60);
    expect(joined(t)).toBe(`${BEGIN}abc${END}`);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('a complete BEGIN…END inside one chunk is not specially held (already one parse)', () => {
    const t = makeTerminal();
    noteTerminalInput(t); // interactive → direct path eligible
    writeTerminalOutput(t, `${BEGIN}whole frame${END}`, { foreground: true });
    // Single atomic chunk: no open frame remains, so it takes the normal path.
    expect(joined(t)).toBe(`${BEGIN}whole frame${END}`);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('preserves byte order across the hold → release boundary', () => {
    const t = makeTerminal();
    // Some normal streaming, THEN a synchronized frame — order must be intact.
    writeTerminalOutput(t, 'pre', { foreground: true });
    writeTerminalOutput(t, `${BEGIN}a`, { foreground: true });
    writeTerminalOutput(t, 'b', { foreground: true });
    writeTerminalOutput(t, `c${END}`, { foreground: true });
    vi.runAllTimers();
    expect(joined(t)).toBe(`pre${BEGIN}abc${END}`);
  });

  it('a hidden write mid-frame abandons the hold (retention takes over)', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, `${BEGIN}held`, { foreground: true });
    expect(t.writes).toEqual([]);
    // Pane goes hidden with retention: the sync hold + its safety timer must be
    // torn down so the timer never fires into a hidden pane.
    writeTerminalOutput(t, 'hidden', { foreground: false, retainWhenHidden: true });
    vi.runAllTimers();
    // Nothing rastered (retained, not parsed); no crash from a stale timer.
    expect(t.writes).toEqual([]);
    discardTerminalOutput(t);
  });

  it('flushTerminalOutput ends an open frame and hands everything over in order', () => {
    const t = makeTerminal();
    writeTerminalOutput(t, `${BEGIN}buffered`, { foreground: true });
    expect(t.writes).toEqual([]);
    // A forced reveal/reconnect flush must release the held bytes immediately,
    // closing xterm's sync mode with a synthetic END (the held bytes carry an
    // unmatched BEGIN).
    flushTerminalOutput(t);
    expect(joined(t)).toBe(`${BEGIN}buffered${END}`);
    expect(getQueuedCharCount(t)).toBe(0);
    // The (now cleared) safety timer must not fire a second release.
    vi.runAllTimers();
    expect(joined(t)).toBe(`${BEGIN}buffered${END}`);
  });

  it('an interactive-opened frame releases on the short safety deadline', () => {
    const t = makeTerminal();
    noteTerminalInput(t); // user is typing → frame is echo/redraw, latency-sensitive
    writeTerminalOutput(t, `${BEGIN}echo`, { foreground: true });
    expect(t.writes).toEqual([]); // held

    // Short (interactive) safety window elapses; typed echo must paint fast and
    // not wait the long autonomous-flood fallback. (+1ms lets the release's
    // scheduled drain run — the safety timer fires at 32 and re-schedules a
    // zero-delay drain, well before the 250ms non-interactive window.)
    vi.advanceTimersByTime(33);
    expect(joined(t)).toBe(`${BEGIN}echo${END}`);
    expect(getQueuedCharCount(t)).toBe(0);
  });

  it('a non-interactive frame does NOT release on the short deadline', () => {
    const t = makeTerminal();
    // No noteTerminalInput → autonomous agent flood, long safety window.
    writeTerminalOutput(t, `${BEGIN}flood`, { foreground: true });
    vi.advanceTimersByTime(32);
    expect(t.writes).toEqual([]); // still held past the interactive deadline
    vi.runAllTimers();
    expect(joined(t)).toBe(`${BEGIN}flood${END}`);
  });
});

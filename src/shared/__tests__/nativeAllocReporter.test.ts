import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_ALLOC_LOG_INTERVAL_MS,
  createNativeAllocReporter,
  isNativeAllocFailure,
} from '../nativeTerminalCore';

/**
 * #3440: a refused native allocation is logged once per window per owner,
 * and the refusals counted inside a window are reported when it ends, even
 * when no further refusal follows.
 */
const refusal = (n: number) => new Error(`ALLOC_FAILED: could not allocate ${n} bytes for ring copy`);

describe('isNativeAllocFailure', () => {
  it('matches the ALLOC_FAILED prefix only', () => {
    expect(isNativeAllocFailure(refusal(8))).toBe(true);
    expect(isNativeAllocFailure('ALLOC_FAILED: could not allocate 8 bytes for x')).toBe(true);
    expect(isNativeAllocFailure(new Error('PTY_CLOSED: gone'))).toBe(false);
    expect(isNativeAllocFailure(new Error('x ALLOC_FAILED: y'))).toBe(false);
    expect(isNativeAllocFailure(undefined)).toBe(false);
  });
});

describe('createNativeAllocReporter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('logs the first refusal at once and reports the suppressed count when the window ends', () => {
    const lines: string[] = [];
    const report = createNativeAllocReporter('ring', () => 'session-a', (l) => lines.push(l));
    report(refusal(1), 'first');
    report(refusal(2), 'second');
    report(refusal(3), 'third');
    expect(lines).toEqual(['[terminal-core] ring session=session-a: ALLOC_FAILED: could not allocate 1 bytes for ring copy; first']);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(NATIVE_ALLOC_LOG_INTERVAL_MS - 1);
    expect(lines).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('[terminal-core] ring session=session-a: 2 more refused since the last line, the last: ALLOC_FAILED: could not allocate 3 bytes for ring copy; third');
    // Nothing held: no timer left behind.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps no timer when no refusal was suppressed', () => {
    const lines: string[] = [];
    const report = createNativeAllocReporter('ring', () => undefined, (l) => lines.push(l));
    report(refusal(1));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(NATIVE_ALLOC_LOG_INTERVAL_MS * 3);
    expect(lines).toEqual(['[terminal-core] ring session=unknown: ALLOC_FAILED: could not allocate 1 bytes for ring copy']);
  });

  it('under steady refusals logs one line per window', () => {
    const lines: string[] = [];
    const report = createNativeAllocReporter('output-interpreter', () => 'session-b', (l) => lines.push(l));
    for (let second = 0; second < 180; second++) {
      report(refusal(second));
      vi.advanceTimersByTime(1000);
    }
    // The first line, then one per elapsed window (at 60 s, 120 s, 180 s).
    expect(lines).toHaveLength(4);
    expect(lines.slice(1).every((l) => /: \d+ more refused since the last line, the last: ALLOC_FAILED: /.test(l))).toBe(true);
  });

  it('a refusal after the window carries the count when the timer has not run yet', () => {
    const lines: string[] = [];
    let clock = 0;
    const report = createNativeAllocReporter('ring', () => 'session-c', (l) => lines.push(l), () => clock);
    report(refusal(1));
    report(refusal(2));
    // The event loop was busy past the window: the next refusal logs first.
    clock = NATIVE_ALLOC_LOG_INTERVAL_MS;
    report(refusal(3));
    expect(lines[1]).toMatch(/could not allocate 3 bytes for ring copy \(\+1 more since the last line\)$/);
    // The timer finds nothing left to report.
    vi.runOnlyPendingTimers();
    expect(lines).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

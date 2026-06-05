import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleInitialCommand } from '../scheduleInitialCommand';

describe('scheduleInitialCommand', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is a no-op for an empty command (onFirstData never writes)', () => {
    const write = vi.fn();
    const s = scheduleInitialCommand('   ', { write });
    s.onFirstData();
    vi.runAllTimers();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes once after first data + settle', () => {
    const write = vi.fn();
    const s = scheduleInitialCommand('claude', { write, settleMs: 100 });
    s.onFirstData();
    expect(write).not.toHaveBeenCalled(); // settle not elapsed yet
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('claude');
  });

  it('does not double-fire when first data and the fallback both occur', () => {
    const write = vi.fn();
    const s = scheduleInitialCommand('claude', { write, settleMs: 10, fallbackMs: 50 });
    s.onFirstData();
    vi.advanceTimersByTime(10);
    expect(write).toHaveBeenCalledTimes(1);
    // Let the (cleared) fallback window pass — must not fire again.
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('fires via fallback when no data ever arrives', () => {
    const write = vi.fn();
    scheduleInitialCommand('codex', { write, settleMs: 10, fallbackMs: 200 });
    vi.advanceTimersByTime(199);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1 + 10);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('retries while the write reports "not delivered", then succeeds', () => {
    let calls = 0;
    const write = vi.fn(() => { calls++; return calls >= 3; }); // false, false, true
    const onExhausted = vi.fn();
    const s = scheduleInitialCommand('claude', {
      write, onExhausted, settleMs: 10, retryDelayMs: 20, retryAttempts: 15,
    });
    s.onFirstData();
    vi.advanceTimersByTime(10);   // attempt 1 → false
    vi.advanceTimersByTime(20);   // attempt 2 → false
    vi.advanceTimersByTime(20);   // attempt 3 → true
    expect(write).toHaveBeenCalledTimes(3);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('calls onExhausted after the retry budget is spent undelivered', () => {
    const write = vi.fn(() => false);
    const onExhausted = vi.fn();
    const s = scheduleInitialCommand('claude', {
      write, onExhausted, settleMs: 10, retryDelayMs: 20, retryAttempts: 3,
    });
    s.onFirstData();
    vi.advanceTimersByTime(10 + 20 * 3);
    expect(write).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('treats a void return as delivered (local mode) — no retry', () => {
    const write = vi.fn(() => undefined);
    const onExhausted = vi.fn();
    const s = scheduleInitialCommand('claude', { write, onExhausted, settleMs: 10 });
    s.onFirstData();
    vi.advanceTimersByTime(10);
    expect(write).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('stops on a thrown write (pane closed) without exhausting', () => {
    const write = vi.fn(() => { throw new Error('pane gone'); });
    const onExhausted = vi.fn();
    const s = scheduleInitialCommand('claude', { write, onExhausted, settleMs: 10 });
    s.onFirstData();
    vi.advanceTimersByTime(10);
    expect(write).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
  });
});

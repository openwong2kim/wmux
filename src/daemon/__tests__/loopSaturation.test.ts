import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOOP_SATURATED_ENTER_MS as ENTER,
  LOOP_SATURATED_EXIT_MS as EXIT,
  isLoopSaturated,
  noteLoopLag,
  resetLoopSaturationForTests,
  startLoopSaturationMonitor,
} from '../loopSaturation';

describe('loop saturation: hysteresis', () => {
  afterEach(() => {
    resetLoopSaturationForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('marks a tick later than the enter threshold, not one exactly at it', () => {
    noteLoopLag(ENTER);
    expect(isLoopSaturated()).toBe(false);
    noteLoopLag(ENTER + 0.1);
    expect(isLoopSaturated()).toBe(true);
  });

  it('once marked, stays marked down to the exit threshold and clears just under it', () => {
    noteLoopLag(ENTER + 1);
    noteLoopLag(ENTER);
    expect(isLoopSaturated()).toBe(true);
    noteLoopLag(EXIT);
    expect(isLoopSaturated()).toBe(true);
    noteLoopLag(EXIT - 0.1);
    expect(isLoopSaturated()).toBe(false);
  });

  it('unmarked, a tick between the thresholds leaves it unmarked', () => {
    noteLoopLag((ENTER + EXIT) / 2);
    expect(isLoopSaturated()).toBe(false);
  });

  it('the monitor marks a late tick and clears on a timely one', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    startLoopSaturationMonitor();
    now = 20;
    vi.advanceTimersByTime(20);
    expect(isLoopSaturated()).toBe(false);
    // A turn that kept the loop 15 ms past the tick.
    now = 55;
    vi.advanceTimersByTime(20);
    expect(isLoopSaturated()).toBe(true);
    now = 75;
    vi.advanceTimersByTime(20);
    expect(isLoopSaturated()).toBe(false);
  });
});

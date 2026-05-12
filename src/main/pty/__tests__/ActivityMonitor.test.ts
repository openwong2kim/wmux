import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivityMonitor } from '../ActivityMonitor';

/**
 * ActivityMonitor active→idle detection + reschedule throttle.
 *
 * Uses fake timers so timing is deterministic and the 100ms reschedule
 * throttle can be observed without real wall-clock skew.
 */
describe('ActivityMonitor', () => {
  let monitor: ActivityMonitor;
  let fired: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new ActivityMonitor();
    fired = [];
    monitor.onActiveToIdle((id) => fired.push(id));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire when output stays below the active threshold', () => {
    monitor.start('p1');
    // 500 bytes is well below the 2000 byte active threshold
    monitor.feed('p1', 500);
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
  });

  it('fires once on active→idle after a sustained burst', () => {
    monitor.start('p1');
    // Push past threshold to enter active state
    monitor.feed('p1', 3000);
    // Idle period elapses (5s default)
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual(['p1']);
  });

  it('does not re-fire from cursor blink redraws after notify', () => {
    monitor.start('p1');
    monitor.feed('p1', 3000);
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual(['p1']);

    // Tiny redraws (≤ threshold) must not trigger another notification
    for (let i = 0; i < 10; i++) {
      monitor.feed('p1', 50);
      vi.advanceTimersByTime(500);
    }
    expect(fired).toEqual(['p1']);
  });

  it('re-arms and fires again after a fresh sustained burst', () => {
    monitor.start('p1');
    monitor.feed('p1', 3000);
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual(['p1']);

    // New burst > threshold should re-arm
    monitor.feed('p1', 3000);
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual(['p1', 'p1']);
  });

  it('handles rapid feed calls without errors and still detects idle', () => {
    monitor.start('p1');
    // Simulate the hot-path: many sub-threshold chunks within a short window
    // that together cross the active threshold. The throttle should keep
    // setTimeout/clearTimeout churn down without breaking idle detection.
    for (let i = 0; i < 1000; i++) {
      monitor.feed('p1', 10); // 10 bytes × 1000 = 10_000 bytes total
      vi.advanceTimersByTime(1); // 1ms apart
    }
    // Now go quiet — idle delay (5s) should fire exactly once
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual(['p1']);
  });

  it('throttles reschedule of the idle timer (calls clearTimeout sparingly)', () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    monitor.start('p1');

    // Cross threshold first to enter active state
    monitor.feed('p1', 3000);

    const baselineClears = clearSpy.mock.calls.length;

    // 50 feeds, each 10ms apart → 500ms of activity. With the 100ms throttle
    // the monitor should reschedule at most ~5 times (not 50).
    for (let i = 0; i < 50; i++) {
      monitor.feed('p1', 100);
      vi.advanceTimersByTime(10);
    }
    const newClears = clearSpy.mock.calls.length - baselineClears;
    expect(newClears).toBeLessThanOrEqual(8);
    clearSpy.mockRestore();
  });

  it('stop() clears the idle timer and forgets the pty', () => {
    monitor.start('p1');
    monitor.feed('p1', 3000);
    monitor.stop('p1');
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
  });

  it('feed() on an unknown pty is a no-op', () => {
    // Should not throw
    monitor.feed('does-not-exist', 5000);
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
  });

  it('isolates state per pty', () => {
    monitor.start('p1');
    monitor.start('p2');
    monitor.feed('p1', 3000);
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual(['p1']);

    monitor.feed('p2', 3000);
    vi.advanceTimersByTime(5000);
    expect(fired).toEqual(['p1', 'p2']);
  });

  describe('onActive (burst start signal)', () => {
    let activeFired: string[];

    beforeEach(() => {
      activeFired = [];
      monitor.onActive((id) => activeFired.push(id));
    });

    it('fires once when output crosses the threshold', () => {
      monitor.start('p1');
      monitor.feed('p1', 3000);
      expect(activeFired).toEqual(['p1']);
    });

    it('does NOT fire again within the same active cycle (IPC spam guard)', () => {
      monitor.start('p1');
      monitor.feed('p1', 3000);
      expect(activeFired).toEqual(['p1']);
      // Continued bursting in the same cycle: still 1 fire
      monitor.feed('p1', 5000);
      monitor.feed('p1', 5000);
      expect(activeFired).toEqual(['p1']);
    });

    it('re-arms after onActiveToIdle so the next cycle can fire again', () => {
      monitor.start('p1');
      monitor.feed('p1', 3000);
      expect(activeFired).toEqual(['p1']);

      // Idle out
      vi.advanceTimersByTime(5000);
      expect(fired).toEqual(['p1']);

      // New burst — onActive should fire exactly once again
      monitor.feed('p1', 3000);
      expect(activeFired).toEqual(['p1', 'p1']);
    });

    it('returns an unsubscribe function that stops further fires', () => {
      const cb = vi.fn();
      const unsub = monitor.onActive(cb);
      monitor.start('p1');
      monitor.feed('p1', 3000);
      expect(cb).toHaveBeenCalledTimes(1);

      unsub();
      vi.advanceTimersByTime(5000); // idle out so the next cycle can fire
      monitor.feed('p1', 3000);
      expect(cb).toHaveBeenCalledTimes(1); // not 2
    });
  });
});

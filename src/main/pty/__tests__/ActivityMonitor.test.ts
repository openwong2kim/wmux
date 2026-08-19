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

  // beginTurn is the explicit-input counterpart to passive throughput
  // detection. Byte volume is a heuristic for "the agent is working"; a
  // submitted Enter is PROOF. A short reply ("Done.") never crosses the 2 KB
  // threshold, so without this the pane stays stuck in the previous
  // waiting/complete state for the whole turn.
  describe('beginTurn (explicit submitted-input boundary)', () => {
    let activeFired: string[];

    beforeEach(() => {
      activeFired = [];
      monitor.onActive((id) => activeFired.push(id));
    });

    it('does not fire anything on its own — output must still arrive', () => {
      monitor.start('p1');
      monitor.beginTurn('p1');
      expect(activeFired).toEqual([]);
      expect(fired).toEqual([]);
    });

    it('makes the FIRST output byte emit active, even far below the threshold', () => {
      monitor.start('p1');
      monitor.beginTurn('p1');
      monitor.feed('p1', 1); // one byte
      expect(activeFired).toEqual(['p1']);
    });

    it('without beginTurn, a sub-threshold reply emits nothing (the bug it fixes)', () => {
      monitor.start('p1');
      monitor.feed('p1', 1);
      expect(activeFired).toEqual([]);
    });

    it('re-arms a cycle that had already notified idle', () => {
      monitor.start('p1');
      monitor.feed('p1', 3000);
      vi.advanceTimersByTime(5000);
      expect(fired).toEqual(['p1']);
      activeFired.length = 0;

      // A new human turn: a tiny reply must still be reported as running, and
      // must be able to reach idle again afterwards.
      monitor.beginTurn('p1');
      monitor.feed('p1', 5);
      expect(activeFired).toEqual(['p1']);
      vi.advanceTimersByTime(5000);
      expect(fired).toEqual(['p1', 'p1']);
    });

    it('clears a pending idle timer so the previous cycle cannot fire late', () => {
      monitor.start('p1');
      monitor.feed('p1', 3000);
      // Half-way through the old idle countdown, a new turn starts.
      vi.advanceTimersByTime(2_500);
      monitor.beginTurn('p1');
      // The old timer must be gone; nothing arrives, so nothing fires.
      vi.advanceTimersByTime(10_000);
      expect(fired).toEqual([]);
    });

    it('is per-pty and does not arm a sibling', () => {
      monitor.start('p1');
      monitor.start('p2');
      monitor.beginTurn('p1');
      monitor.feed('p2', 1);
      expect(activeFired).toEqual([]);
      monitor.feed('p1', 1);
      expect(activeFired).toEqual(['p1']);
    });

    it('is a no-op for an unknown pty', () => {
      expect(() => monitor.beginTurn('does-not-exist')).not.toThrow();
      vi.advanceTimersByTime(10_000);
      expect(fired).toEqual([]);
      expect(activeFired).toEqual([]);
    });

    it('is a no-op after stop() (no resurrection of a disposed pane)', () => {
      monitor.start('p1');
      monitor.stop('p1');
      monitor.beginTurn('p1');
      monitor.feed('p1', 5000);
      vi.advanceTimersByTime(10_000);
      expect(activeFired).toEqual([]);
      expect(fired).toEqual([]);
    });
  });

  // endTurn is the turn-END counterpart. The cycle otherwise re-arms only
  // inside the idle timer, which needs IDLE_DELAY_MS of byte silence — a TUI
  // painting a live counter every second never reaches it, so the `complete`
  // written at the turn end sticks through the pane's next turn.
  describe('endTurn (authoritative turn-end boundary)', () => {
    let activeFired: string[];

    beforeEach(() => {
      activeFired = [];
      monitor.onActive((id) => activeFired.push(id));
    });

    it('fires nothing by itself', () => {
      monitor.start('p1');
      monitor.feed('p1', 3000);
      activeFired.length = 0;
      monitor.endTurn('p1');
      vi.advanceTimersByTime(10_000);
      expect(activeFired).toEqual([]);
      expect(fired).toEqual([]);
    });

    it('lets the NEXT burst report running on a pane that never went silent', () => {
      monitor.start('p1');
      monitor.feed('p1', 3000);
      expect(activeFired).toEqual(['p1']);

      // A live elapsed-time counter: sub-threshold repaints every second keep
      // rescheduling the idle timer, so the cycle never re-arms on its own.
      for (let i = 0; i < 30; i += 1) {
        vi.advanceTimersByTime(1000);
        monitor.feed('p1', 40);
      }
      expect(fired).toEqual([]);        // never idled
      expect(activeFired).toEqual(['p1']); // and never re-fired

      // Stop hook lands, then the agent starts a new turn by itself.
      monitor.endTurn('p1');
      monitor.feed('p1', 3000);
      expect(activeFired).toEqual(['p1', 'p1']);
    });

    it('does NOT let idle chrome flip the pane back to running', () => {
      monitor.start('p1');
      monitor.feed('p1', 3000);
      activeFired.length = 0;
      monitor.endTurn('p1');

      // Sub-threshold repaints of a pane that is genuinely done must not read
      // as a new turn — this is the difference from beginTurn, where the first
      // byte counts because submitted input already proved a turn started.
      monitor.feed('p1', 40);
      monitor.feed('p1', 40);
      expect(activeFired).toEqual([]);
    });

    it('clears a pending idle timer so the old cycle cannot fire late', () => {
      monitor.start('p1');
      monitor.feed('p1', 3000);
      vi.advanceTimersByTime(2_500);
      monitor.endTurn('p1');
      vi.advanceTimersByTime(10_000);
      expect(fired).toEqual([]);
    });

    it('leaves the pane able to reach idle again after the next burst', () => {
      monitor.start('p1');
      monitor.endTurn('p1');
      monitor.feed('p1', 3000);
      expect(activeFired).toEqual(['p1']);
      vi.advanceTimersByTime(5000);
      expect(fired).toEqual(['p1']);
    });

    it('is per-pty and does not arm a sibling', () => {
      monitor.start('p1');
      monitor.start('p2');
      monitor.feed('p1', 3000);
      monitor.feed('p2', 3000);
      activeFired.length = 0;

      monitor.endTurn('p1');
      monitor.feed('p2', 3000);
      expect(activeFired).toEqual([]);   // p2's cycle is untouched
      monitor.feed('p1', 3000);
      expect(activeFired).toEqual(['p1']);
    });

    it('is a no-op for an unknown pty and after stop()', () => {
      expect(() => monitor.endTurn('does-not-exist')).not.toThrow();
      monitor.start('p1');
      monitor.stop('p1');
      monitor.endTurn('p1');
      monitor.feed('p1', 5000);
      vi.advanceTimersByTime(10_000);
      expect(activeFired).toEqual([]);
      expect(fired).toEqual([]);
    });
  });
});

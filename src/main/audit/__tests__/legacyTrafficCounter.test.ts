import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MILESTONES,
  LegacyTrafficCounter,
  MAX_TRACKED_METHODS,
} from '../legacyTrafficCounter';

describe('LegacyTrafficCounter.record', () => {
  it('fires sink at the default milestones (1, 10, 100, ...)', () => {
    const sink = vi.fn();
    const counter = new LegacyTrafficCounter({ sink });
    for (let i = 0; i < 100; i++) counter.record('pane.list');
    // Expect calls at 1, 10, 100 (3 milestones)
    expect(sink).toHaveBeenCalledTimes(3);
    expect(sink.mock.calls.map((c) => c[0].count)).toEqual([1, 10, 100]);
  });

  it('does not fire on counts between milestones', () => {
    const sink = vi.fn();
    const counter = new LegacyTrafficCounter({ sink });
    counter.record('pane.list');
    counter.record('pane.list');
    counter.record('pane.list');
    // After 3 calls, only the 1st milestone fired.
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('counts methods independently', () => {
    const sink = vi.fn();
    const counter = new LegacyTrafficCounter({ sink });
    counter.record('pane.list');
    counter.record('pane.focus');
    counter.record('pane.list');
    expect(counter.getCount('pane.list')).toBe(2);
    expect(counter.getCount('pane.focus')).toBe(1);
    expect(sink).toHaveBeenCalledTimes(2); // 1st call for each method
  });

  it('respects custom milestones', () => {
    const sink = vi.fn();
    const counter = new LegacyTrafficCounter({ sink, milestones: [3, 5] });
    for (let i = 0; i < 7; i++) counter.record('pane.list');
    expect(sink.mock.calls.map((c) => c[0].count)).toEqual([3, 5]);
  });

  it('keeps counting past the last milestone but stops emitting', () => {
    const sink = vi.fn();
    const counter = new LegacyTrafficCounter({ sink, milestones: [1, 10] });
    for (let i = 0; i < 1000; i++) counter.record('pane.list');
    expect(counter.getCount('pane.list')).toBe(1000);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('caps tracked methods (DoS guard)', () => {
    const sink = vi.fn();
    const counter = new LegacyTrafficCounter({
      sink,
      maxTrackedMethods: 3,
    });
    counter.record('pane.list');
    counter.record('pane.focus');
    counter.record('events.poll');
    // 4th distinct method gets dropped silently.
    counter.record('input.send');
    expect(counter.getCount('pane.list')).toBe(1);
    expect(counter.getCount('input.send')).toBe(0);
    // Existing methods still increment.
    counter.record('pane.list');
    expect(counter.getCount('pane.list')).toBe(2);
  });

  it('swallows sink errors so audit telemetry never breaks the caller', () => {
    const counter = new LegacyTrafficCounter({
      sink: () => {
        throw new Error('disk full');
      },
    });
    expect(() => counter.record('pane.list')).not.toThrow();
    expect(counter.getCount('pane.list')).toBe(1);
  });

  it('exports the documented DEFAULT_MILESTONES + MAX_TRACKED_METHODS', () => {
    // Pinning the constants so a future refactor can't silently drop a
    // milestone (which would invalidate cross-version log analysis).
    expect(DEFAULT_MILESTONES).toEqual([1, 10, 100, 1000, 10000]);
    expect(MAX_TRACKED_METHODS).toBeGreaterThanOrEqual(96);
  });
});

describe('LegacyTrafficCounter.reset', () => {
  it('drops all state and re-fires the 1st milestone on the next record', () => {
    const sink = vi.fn();
    const counter = new LegacyTrafficCounter({ sink });
    counter.record('pane.list');
    counter.reset();
    counter.record('pane.list');
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1][0].count).toBe(1);
    expect(counter.getCount('pane.list')).toBe(1);
  });
});

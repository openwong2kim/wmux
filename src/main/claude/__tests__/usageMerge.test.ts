import { describe, it, expect } from 'vitest';
import { mergeUsage, mergeWindow, updateFromSnapshot } from '../usageMerge';
import type { UsageSnapshot } from '../UsageApi';

const NOW_SEC = 1_800_000_000;
const NOW_MS = NOW_SEC * 1000;
const HOUR = 3600;

function snap(sessionPct: number, sessionReset: number, weeklyPct: number, weeklyReset: number): UsageSnapshot {
  return {
    sessionPct,
    sessionResetEpochSec: sessionReset,
    weeklyPct,
    weeklyResetEpochSec: weeklyReset,
    fetchedAtMs: NOW_MS - 60_000,
  };
}

describe('mergeWindow', () => {
  it('keeps the max within one window', () => {
    const prev = { pct: 40, resetEpochSec: NOW_SEC + HOUR };
    expect(mergeWindow(prev, { pct: 55, resetEpochSec: NOW_SEC + HOUR }, NOW_SEC)).toEqual({ pct: 55, resetEpochSec: NOW_SEC + HOUR });
    // A lower reading of the same window changes nothing (same reference).
    expect(mergeWindow(prev, { pct: 30, resetEpochSec: NOW_SEC + HOUR + 20 }, NOW_SEC)).toBe(prev);
  });

  it('replaces with a later window and ignores an older one', () => {
    const prev = { pct: 90, resetEpochSec: NOW_SEC + HOUR };
    const newer = { pct: 5, resetEpochSec: NOW_SEC + 6 * HOUR };
    expect(mergeWindow(prev, newer, NOW_SEC)).toBe(newer);
    expect(mergeWindow(newer, prev, NOW_SEC)).toBe(newer);
  });

  it('drops a window whose reset is already past', () => {
    const prev = { pct: 10, resetEpochSec: NOW_SEC + HOUR };
    expect(mergeWindow(prev, { pct: 99, resetEpochSec: NOW_SEC - 10 }, NOW_SEC)).toBe(prev);
    expect(mergeWindow(null, { pct: 99, resetEpochSec: NOW_SEC - 10 }, NOW_SEC)).toBeNull();
  });

  it('treats a reset of 0 as unknown, not as 1970', () => {
    const prev = { pct: 20, resetEpochSec: NOW_SEC + HOUR };
    expect(mergeWindow(prev, { pct: 25, resetEpochSec: 0 }, NOW_SEC)).toEqual({ pct: 25, resetEpochSec: NOW_SEC + HOUR });
    expect(mergeWindow(null, { pct: 25, resetEpochSec: 0 }, NOW_SEC)).toEqual({ pct: 25, resetEpochSec: 0 });
  });
});

describe('mergeUsage', () => {
  it('a stale live sample from pane A does not overwrite pane B\'s newer window', () => {
    // B already reported the new 5h window; A still renders the old one.
    const fromB = mergeUsage(null, {
      session: { pct: 3, resetEpochSec: NOW_SEC + 5 * HOUR },
      weekly: { pct: 40, resetEpochSec: NOW_SEC + 100 * HOUR },
    }, NOW_MS);
    const afterA = mergeUsage(fromB, {
      session: { pct: 97, resetEpochSec: NOW_SEC + 60 },
      weekly: { pct: 39, resetEpochSec: NOW_SEC + 100 * HOUR },
    }, NOW_MS);
    expect(afterA).toBe(fromB);
    expect(afterA?.sessionPct).toBe(3);
  });

  it('needs both windows when there is nothing to merge onto', () => {
    expect(mergeUsage(null, { session: { pct: 5, resetEpochSec: NOW_SEC + HOUR } }, NOW_MS)).toBeNull();
  });

  it('keeps HTTP scoped limits when a live sample (no scoped) is merged', () => {
    const http: UsageSnapshot = {
      ...snap(10, NOW_SEC + HOUR, 20, NOW_SEC + 50 * HOUR),
      scoped: [{ kind: 'weekly_scoped', group: 'weekly', pct: 33, resetEpochSec: null, scope: 'Opus' }],
    };
    const merged = mergeUsage(http, { session: { pct: 12, resetEpochSec: NOW_SEC + HOUR } }, NOW_MS);
    expect(merged?.sessionPct).toBe(12);
    expect(merged?.weeklyPct).toBe(20);
    expect(merged?.scoped).toEqual(http.scoped);
    expect(merged?.fetchedAtMs).toBe(NOW_MS);
  });

  it('an HTTP response for an older window loses to a newer live one', () => {
    const live = snap(4, NOW_SEC + 5 * HOUR, 41, NOW_SEC + 90 * HOUR);
    const http = snap(88, NOW_SEC + 120, 40, NOW_SEC + 90 * HOUR);
    const merged = mergeUsage(live, updateFromSnapshot(http), NOW_MS);
    expect(merged?.sessionPct).toBe(4);
    expect(merged?.sessionResetEpochSec).toBe(NOW_SEC + 5 * HOUR);
    expect(merged?.weeklyPct).toBe(41);
  });
});

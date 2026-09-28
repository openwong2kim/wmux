import { describe, it, expect } from 'vitest';
import { mergeLive, mergeLiveWindow } from '../usageMerge';
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

const SCOPED: UsageSnapshot['scoped'] = [
  { kind: 'weekly_scoped', group: 'weekly', pct: 33, resetEpochSec: null, scope: 'Opus' },
];

describe('mergeLiveWindow', () => {
  it('keeps the max within one window', () => {
    const prev = { pct: 40, resetEpochSec: NOW_SEC + HOUR };
    expect(mergeLiveWindow(prev, { pct: 55, resetEpochSec: NOW_SEC + HOUR }, NOW_SEC)).toEqual({ pct: 55, resetEpochSec: NOW_SEC + HOUR });
    // A lower reading of the same window changes nothing (same reference).
    expect(mergeLiveWindow(prev, { pct: 30, resetEpochSec: NOW_SEC + HOUR + 20 }, NOW_SEC)).toBe(prev);
  });

  it('replaces with a later window and ignores an older one', () => {
    const prev = { pct: 90, resetEpochSec: NOW_SEC + HOUR };
    const newer = { pct: 5, resetEpochSec: NOW_SEC + 6 * HOUR };
    expect(mergeLiveWindow(prev, newer, NOW_SEC)).toBe(newer);
    expect(mergeLiveWindow(newer, prev, NOW_SEC)).toBe(newer);
  });

  it('drops a window whose reset is already past', () => {
    const prev = { pct: 10, resetEpochSec: NOW_SEC + HOUR };
    expect(mergeLiveWindow(prev, { pct: 99, resetEpochSec: NOW_SEC - 10 }, NOW_SEC)).toBe(prev);
    expect(mergeLiveWindow(null, { pct: 99, resetEpochSec: NOW_SEC - 10 }, NOW_SEC)).toBeNull();
  });

  it('a known reset replaces an unknown one (0), even with a lower pct', () => {
    const prev = { pct: 80, resetEpochSec: 0 };
    const next = { pct: 25, resetEpochSec: NOW_SEC + HOUR };
    expect(mergeLiveWindow(prev, next, NOW_SEC)).toBe(next);
  });
});

describe('mergeLive', () => {
  it('a stale live sample from pane A does not overwrite pane B\'s newer window', () => {
    const fromB = mergeLive(null, {
      session: { pct: 3, resetEpochSec: NOW_SEC + 5 * HOUR },
      weekly: { pct: 40, resetEpochSec: NOW_SEC + 100 * HOUR },
    }, NOW_MS);
    const afterA = mergeLive(fromB, {
      session: { pct: 97, resetEpochSec: NOW_SEC + 60 },
      weekly: { pct: 39, resetEpochSec: NOW_SEC + 100 * HOUR },
    }, NOW_MS);
    expect(afterA).toBe(fromB);
    expect(afterA?.sessionPct).toBe(3);
  });

  it('a partial sample with nothing to merge onto is not applied', () => {
    expect(mergeLive(null, { session: { pct: 5, resetEpochSec: NOW_SEC + HOUR } }, NOW_MS)).toBeNull();
  });

  it('keeps scoped limits while the weekly window is unchanged', () => {
    const http: UsageSnapshot = { ...snap(10, NOW_SEC + HOUR, 20, NOW_SEC + 50 * HOUR), scoped: SCOPED };
    const merged = mergeLive(http, { session: { pct: 12, resetEpochSec: NOW_SEC + HOUR } }, NOW_MS);
    expect(merged?.sessionPct).toBe(12);
    expect(merged?.weeklyPct).toBe(20);
    expect(merged?.scoped).toEqual(SCOPED);
    expect(merged?.fetchedAtMs).toBe(NOW_MS);
  });

  it('drops scoped limits when the sample moves the weekly window on', () => {
    const http: UsageSnapshot = { ...snap(10, NOW_SEC + HOUR, 90, NOW_SEC + 60), scoped: SCOPED };
    const merged = mergeLive(http, { weekly: { pct: 1, resetEpochSec: NOW_SEC + 160 * HOUR } }, NOW_MS);
    expect(merged?.weeklyPct).toBe(1);
    expect(merged?.scoped).toBeUndefined();
  });
});

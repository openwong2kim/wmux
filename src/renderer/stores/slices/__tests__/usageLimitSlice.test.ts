import { describe, it, expect } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createUsageLimitSlice, type UsageLimitSlice } from '../usageLimitSlice';
import { planUsageLimitAutoResume, updateUsageLimit } from '../../../hooks/useUsageLimitBridge';
import type { PaneUsageLimit } from '../../../../shared/usageLimit';

function createTestStore() {
  return create<UsageLimitSlice>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createUsageLimitSlice(...args),
    })),
  );
}

const limit = (ptyId: string, extra: Partial<PaneUsageLimit> = {}): PaneUsageLimit => ({
  ptyId, provider: 'claude', detectedAt: 1_000, source: 'hook', ...extra,
});

describe('usageLimitSlice', () => {
  it('sets, clears and hydrates (hydration drops stale ptyIds)', () => {
    const store = createTestStore();
    store.getState().setUsageLimit('a', limit('a'));
    store.getState().setUsageLimit('b', limit('b'));
    store.getState().setUsageLimit('a', null);
    expect(Object.keys(store.getState().usageLimits)).toEqual(['b']);
    store.getState().hydrateUsageLimits([limit('c', { resetsAt: 5_000 })]);
    expect(store.getState().usageLimits).toEqual({ c: limit('c', { resetsAt: 5_000 }) });
  });
});

describe('planUsageLimitAutoResume', () => {
  it('arms only undecided limits, only while the setting is on, once per occurrence', () => {
    const applied = new Set<string>();
    const limits = { a: limit('a'), b: limit('b', { autoResume: false }), c: limit('c', { autoResume: true }) };
    expect(planUsageLimitAutoResume(limits, false, applied)).toEqual([]);
    expect(planUsageLimitAutoResume(limits, true, applied)).toEqual(['a']);
    // The daemon has not echoed yet (still undefined): no repeat send.
    expect(planUsageLimitAutoResume(limits, true, applied)).toEqual([]);
    // A NEW limit on the same pane (new detectedAt) is a new decision.
    expect(planUsageLimitAutoResume({ a: limit('a', { detectedAt: 2_000 }) }, true, applied)).toEqual(['a']);
  });

  it('forgets cleared limits so the same occurrence key cannot leak', () => {
    const applied = new Set<string>();
    planUsageLimitAutoResume({ a: limit('a') }, true, applied);
    planUsageLimitAutoResume({}, true, applied);
    expect(applied.size).toBe(0);
  });
});

describe('updateUsageLimit', () => {
  it('resolves true only when the daemon applied the patch', async () => {
    const g = globalThis as unknown as { window?: { electronAPI?: unknown } };
    const prev = g.window;
    const results = [{ ok: true }, { ok: false }];
    g.window = { electronAPI: { usageLimit: { update: async () => results.shift() } } };
    try {
      expect(await updateUsageLimit('p', { autoResume: true })).toBe(true);
      expect(await updateUsageLimit('p', { autoResume: true })).toBe(false);
    } finally {
      g.window = prev;
    }
  });
});

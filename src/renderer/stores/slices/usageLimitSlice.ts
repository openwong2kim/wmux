// Usage-limit slice — renderer mirror of the daemon's per-pane usage-limit
// hold (shared/usageLimit), keyed by ptyId. Drives the pane-header chip and
// the Fleet row detail.
//
// TRANSIENT: never enters buildSessionData. The daemon owns the state; this
// slice is hydrated from `usageLimit.list()` on mount + every
// `daemon:connected`, then kept live by `usageLimit.onChanged`
// (useUsageLimitBridge).

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { PaneUsageLimit } from '../../../shared/usageLimit';

export interface UsageLimitSlice {
  /** Held panes by ptyId. Absent key = the pane is not at a usage limit. */
  usageLimits: Record<string, PaneUsageLimit>;
  /** Set or replace one pane's limit; `null` clears it. */
  setUsageLimit: (ptyId: string, limit: PaneUsageLimit | null) => void;
  /** Replace the whole map from a `list()` snapshot (drops stale ptyIds). */
  hydrateUsageLimits: (limits: readonly PaneUsageLimit[]) => void;
}

export const createUsageLimitSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  UsageLimitSlice
> = (set) => ({
  usageLimits: {},

  setUsageLimit: (ptyId, limit) => set((draft: StoreState) => {
    if (limit) draft.usageLimits[ptyId] = limit;
    else delete draft.usageLimits[ptyId];
  }),

  hydrateUsageLimits: (limits) => set((draft: StoreState) => {
    const next: Record<string, PaneUsageLimit> = {};
    for (const limit of limits) {
      if (limit && typeof limit.ptyId === 'string') next[limit.ptyId] = limit;
    }
    draft.usageLimits = next;
  }),
});

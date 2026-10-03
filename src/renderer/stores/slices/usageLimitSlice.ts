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
import { getLeafPanes } from '../../../shared/paneUtils';
import { usageLimitHolds, usageLimitHoldEndsAt, type PaneUsageLimit } from '../../../shared/usageLimit';

/**
 * ptyId → true while the pane is quietly waiting out its limit: the hold still
 * stands. Such a pane is not an error and does not need the user — Fleet,
 * the sidebar and the attention counts show it as Waiting. Once the hold ends
 * and the limit is still there (the reset passed without a release, or the
 * continue failed after it), it drops out of this map and reads as attention again.
 */
export function usageLimitWaitingMap(limits: Record<string, PaneUsageLimit>, now: number): Record<string, true> {
  const out: Record<string, true> = {};
  for (const [ptyId, limit] of Object.entries(limits)) if (usageLimitHolds(limit, now)) out[ptyId] = true;
  return out;
}

/** The earliest future instant a waiting pane stops waiting, or null. */
export function nextUsageLimitWaitingChange(limits: Record<string, PaneUsageLimit>, now: number): number | null {
  let next: number | null = null;
  for (const limit of Object.values(limits)) {
    const end = usageLimitHoldEndsAt(limit);
    if (end > now && (next === null || end < next)) next = end;
  }
  return next;
}

/** Whether any terminal surface of the workspace is waiting out a usage limit. */
export function workspaceHasUsageLimitWaiting(
  state: Pick<StoreState, 'workspaces' | 'usageLimitWaiting'>,
  workspaceId: string,
): boolean {
  if (Object.keys(state.usageLimitWaiting).length === 0) return false;
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return false;
  return getLeafPanes(ws.rootPane).some((leaf) => leaf.surfaces.some((s) => !!s.ptyId && state.usageLimitWaiting[s.ptyId] === true));
}

function sameWaiting(a: Record<string, true>, b: Record<string, true>): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => b[k]);
}

export interface UsageLimitSlice {
  /** Held panes by ptyId. Absent key = the pane is not at a usage limit. */
  usageLimits: Record<string, PaneUsageLimit>;
  /** Set or replace one pane's limit; `null` clears it. */
  setUsageLimit: (ptyId: string, limit: PaneUsageLimit | null) => void;
  /** Replace the whole map from a `list()` snapshot (drops stale ptyIds). */
  hydrateUsageLimits: (limits: readonly PaneUsageLimit[]) => void;
  /** See usageLimitWaitingMap. Kept as its own map (replaced only when it
   *  changes) so selectors can memoize on it without reading the clock. */
  usageLimitWaiting: Record<string, true>;
  /** Recompute `usageLimitWaiting` at `now` (the bridge calls it when a hold ends). */
  refreshUsageLimitWaiting: (now?: number) => void;
}

export const createUsageLimitSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  UsageLimitSlice
> = (set) => ({
  usageLimits: {},
  usageLimitWaiting: {},

  setUsageLimit: (ptyId, limit) => set((draft: StoreState) => {
    if (limit) draft.usageLimits[ptyId] = limit;
    else delete draft.usageLimits[ptyId];
    const waiting = usageLimitWaitingMap(draft.usageLimits, Date.now());
    if (!sameWaiting(waiting, draft.usageLimitWaiting)) draft.usageLimitWaiting = waiting;
  }),

  refreshUsageLimitWaiting: (now = Date.now()) => set((draft: StoreState) => {
    const waiting = usageLimitWaitingMap(draft.usageLimits, now);
    if (!sameWaiting(waiting, draft.usageLimitWaiting)) draft.usageLimitWaiting = waiting;
  }),

  hydrateUsageLimits: (limits) => set((draft: StoreState) => {
    const next: Record<string, PaneUsageLimit> = {};
    for (const limit of limits) {
      if (limit && typeof limit.ptyId === 'string') next[limit.ptyId] = limit;
    }
    draft.usageLimits = next;
    const waiting = usageLimitWaitingMap(next, Date.now());
    if (!sameWaiting(waiting, draft.usageLimitWaiting)) draft.usageLimitWaiting = waiting;
  }),
});

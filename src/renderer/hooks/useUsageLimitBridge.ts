import { useEffect } from 'react';
import { useStore } from '../stores';
import type { PaneUsageLimit, PaneUsageLimitPatch } from '../../shared/usageLimit';
import { nextUsageLimitWaitingChange } from '../stores/slices/usageLimitSlice';

// ─── Usage-limit bridge ──────────────────────────────────────────────────────
//
// The single owner of the `usageLimit` IPC subscription, mounted once in
// AppLayout. Hydrates the slice from `list()` on mount and on every
// `daemon:connected`, then follows `onChanged`.
//
// It also applies the global "continue after a usage limit resets" setting:
// a limit whose `autoResume` is still undefined (nobody decided for that pane)
// is armed once while the setting is on. It runs on both inputs — the limits
// map AND the setting — because at boot `list()` can resolve before the saved
// session restores the setting. Each ptyId+detectedAt is applied at most once,
// so a pane the user later disarms is never re-armed for the same limit.

/** Dedup key of one limit occurrence. */
export function usageLimitApplyKey(limit: Pick<PaneUsageLimit, 'ptyId' | 'detectedAt'>): string {
  return `${limit.ptyId}:${limit.detectedAt}`;
}

/**
 * The ptyIds to arm with the global setting. Pure: marks what it returns in
 * `applied` and forgets keys whose limit is gone, so the caller only sends.
 */
export function planUsageLimitAutoResume(
  limits: Record<string, PaneUsageLimit>,
  settingOn: boolean,
  applied: Set<string>,
): string[] {
  const live = new Set<string>();
  const out: string[] = [];
  for (const limit of Object.values(limits)) {
    const key = usageLimitApplyKey(limit);
    live.add(key);
    if (!settingOn || limit.autoResume !== undefined || applied.has(key)) continue;
    applied.add(key);
    out.push(limit.ptyId);
  }
  for (const key of applied) if (!live.has(key)) applied.delete(key);
  return out;
}

/** Send one patch; resolves whether the daemon applied it. Failures are logged. */
export function updateUsageLimit(ptyId: string, patch: PaneUsageLimitPatch): Promise<boolean> {
  const api = window.electronAPI?.usageLimit;
  if (!api) return Promise.resolve(false);
  return api.update(ptyId, patch).then((res) => res?.ok === true, (err: unknown) => {
    console.warn('[usageLimit] update failed', err);
    return false;
  });
}

export function useUsageLimitBridge(): void {
  useEffect(() => {
    const api = window.electronAPI?.usageLimit;
    if (!api) return; // older preload bundles do not expose this channel

    const hydrate = () => {
      void api.list().then((limits) => {
        useStore.getState().hydrateUsageLimits(Array.isArray(limits) ? limits : []);
      }).catch(() => { /* best-effort — the next daemon:connected retries */ });
    };
    hydrate();
    const offConnected = window.electronAPI.daemon?.onConnected?.(hydrate);
    const offChanged = api.onChanged(({ ptyId, limit }) => {
      useStore.getState().setUsageLimit(ptyId, limit);
    });

    // Re-derive `usageLimitWaiting` when the next hold ends, so a pane whose
    // reset passed without a release turns back into attention on time.
    let waitingTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleWaiting = (limits: Record<string, PaneUsageLimit>) => {
      if (waitingTimer) clearTimeout(waitingTimer);
      waitingTimer = undefined;
      const next = nextUsageLimitWaitingChange(limits, Date.now());
      if (next === null) return;
      // Capped: a long timer drifts across sleep, and the next pass reschedules.
      waitingTimer = setTimeout(() => {
        useStore.getState().refreshUsageLimitWaiting();
        scheduleWaiting(useStore.getState().usageLimits);
      }, Math.min(Math.max(next - Date.now() + 50, 1_000), 60_000));
    };
    scheduleWaiting(useStore.getState().usageLimits);

    const applied = new Set<string>();
    const apply = (state: ReturnType<typeof useStore.getState>) => {
      for (const ptyId of planUsageLimitAutoResume(state.usageLimits, state.usageLimitAutoResume, applied)) {
        const limit = state.usageLimits[ptyId];
        // Claimed up front so an overlapping pass does not send twice; a send
        // the daemon did not apply gives the claim back, so the next pass retries.
        void updateUsageLimit(ptyId, { autoResume: true }).then((ok) => {
          if (!ok && limit) applied.delete(usageLimitApplyKey(limit));
        });
      }
    };
    apply(useStore.getState());
    const offStore = useStore.subscribe((state, prev) => {
      if (state.usageLimits !== prev.usageLimits || state.usageLimitAutoResume !== prev.usageLimitAutoResume) {
        apply(state);
      }
      if (state.usageLimits !== prev.usageLimits) scheduleWaiting(state.usageLimits);
    });

    return () => {
      offConnected?.();
      offChanged();
      offStore();
      if (waitingTimer) clearTimeout(waitingTimer);
    };
  }, []);
}

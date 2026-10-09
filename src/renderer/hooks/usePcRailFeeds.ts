/**
 * PC rail — the renderer half of the host feeds. Mount once while the
 * computer column is shown (PR3 mounts it with the column).
 *
 *   subscribe ──▶ main polls every web-paired host + one SSE per host
 *   feed event      ──▶ applyPcRailFeedEvent (rows, status, tick reconcile)
 *   attention frame ──▶ applyPcRailAttention; refetch → approvals in 1 s (debounced per host)
 *   stream open/reopen ──▶ approvals now (frames missed while down are not replayed)
 *   mutedPcs changes ──▶ MUTES_SET, so main holds back that host's toasts
 *   attached remote workspaces ──▶ migrateAttachedRemoteWorkspaces
 */
import { useEffect } from 'react';
import { useStore } from '../stores';
import { PC_RAIL_REFETCH_DEBOUNCE_MS } from '../../shared/pcRail';
import type { PcRailBridge } from '../../preload/preload';

function bridge(): PcRailBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window.electronAPI as unknown as { pcRail?: PcRailBridge } | undefined)?.pcRail;
}

export function usePcRailFeeds(): void {
  useEffect(() => {
    const api = bridge();
    if (!api) return undefined;
    let disposed = false;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const reconcile = (hostId: string): void => {
      void api.approvalsList({ hostId }).then((result) => {
        if (!disposed && result.ok) useStore.getState().reconcilePcRailHostApprovals(hostId, result.approvals);
      }).catch(() => undefined);
    };
    const reconcileSoon = (hostId: string): void => {
      if (timers.has(hostId)) return;
      timers.set(hostId, setTimeout(() => {
        timers.delete(hostId);
        if (!disposed) reconcile(hostId);
      }, PC_RAIL_REFETCH_DEBOUNCE_MS));
    };

    const offFeed = api.onFeed((event) => useStore.getState().applyPcRailFeedEvent(event));
    const offAttention = api.onAttention((event) => {
      if (useStore.getState().applyPcRailAttention(event)) reconcileSoon(event.hostId);
    });
    const offStream = api.onStream((event) => {
      if (event.state !== 'closed') reconcile(event.hostId);
    });
    const release = api.subscribe();

    let lastMutes: string[] | null = null;
    const pushMutes = (mutedPcs: string[]): void => {
      if (mutedPcs === lastMutes) return;
      lastMutes = mutedPcs;
      void api.setMutes({ hostIds: [...mutedPcs] }).catch(() => undefined);
    };
    pushMutes(useStore.getState().pcRail.mutedPcs);

    let lastAttached = useStore.getState().remoteWorkspaces;
    useStore.getState().migrateAttachedRemoteWorkspaces();
    const offStore = useStore.subscribe((state) => {
      pushMutes(state.pcRail.mutedPcs);
      if (state.remoteWorkspaces !== lastAttached) {
        lastAttached = state.remoteWorkspaces;
        state.migrateAttachedRemoteWorkspaces();
      }
    });

    return () => {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      offStore();
      offFeed();
      offAttention();
      offStream();
      release();
    };
  }, []);
}

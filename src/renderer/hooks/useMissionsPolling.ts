// ─── Mission (WorkTask) polling hook (NB2 wave 2 cycle C) ─────────────────────────────
//
// Mount once in AppLayout (parallel to useChannelsHydration). Fills mission cache via
// workTaskSlice. Why pure pull + sparse polling — see workTaskSlice header:
//   - daemon WorkTaskService emits nothing on EventBus → no push.
//   - fan-out materialization (paneGroupId, etc.) commits synchronously before FanOutService.start()
//     returns → topology complete at completion. Remaining drift is status (open→closed) only (low frequency).
// Triggers:
//   1. Mount + workspace list (id set) change → immediate refetch (all parent candidates).
//   2. Sparse background polling (MISSION_POLL_INTERVAL_MS) → status drift.
//   3. daemon (re)connect → rehydrate after cold boot / respawn.
// Immediate refetch after fan-out completion is FanOutDialog calling refreshMissions directly.
//
// listMissions is owner-scoped — no need to know which workspace is parent upfront; query every
// existing workspace id (workspaces without fan-out return empty arrays harmlessly — sidebar
// section renders nothing from empty cache).

import { useEffect } from 'react';
import { useStore } from '../stores';

/**
 * Sparse background polling interval to catch mission status drift (open→closed). Intentionally
 * different from channel unread 1Hz events.poll (live message delivery) — missions are low-frequency
 * state closed occasionally by humans/agents; 15s is enough and owner-scoped map queries are light on daemon.
 */
export const MISSION_POLL_INTERVAL_MS = 15_000;

/** Refetch missions for all current workspace ids (each owner-scoped query). */
function refreshAllParents(): void {
  const state = useStore.getState();
  const ids = state.workspaces.map((w) => w.id);
  for (const id of ids) {
    void state.refreshMissions(id);
  }
}

/**
 * Mount once in AppLayout. Owns no React state — dispatches to store only.
 * Rehydrates when workspace id set changes; sparse background polling keeps status fresh.
 */
export function useMissionsPolling(): void {
  // Id set string: re-run effect only on workspace add/remove (not name/meta changes).
  const workspaceIdsKey = useStore((s) => s.workspaces.map((w) => w.id).join(','));

  useEffect(() => {
    // Immediate refetch on mount + id set change.
    refreshAllParents();

    // Sparse background polling (status drift).
    const timer = setInterval(refreshAllParents, MISSION_POLL_INTERVAL_MS);

    // Rehydrate after daemon (re)connect (cold boot / respawn).
    let disposed = false;
    void window.electronAPI.daemon.whenReady().then(() => {
      if (!disposed) refreshAllParents();
    });
    const offConnected = window.electronAPI.daemon.onConnected(() => {
      if (!disposed) refreshAllParents();
    });

    return () => {
      disposed = true;
      clearInterval(timer);
      offConnected();
    };
  }, [workspaceIdsKey]);
}

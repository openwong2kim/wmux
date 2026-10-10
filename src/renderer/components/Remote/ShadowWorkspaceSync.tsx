// PC rail, PR4: keeps shadow workspaces in step with their computers.
//
// Renders nothing. It owns four reactions, all on store changes:
//   - a host's feed changed       → reconcile that host's shadows (host-owned membership)
//   - a host left the roster      → close its shadows
//   - the selected computer moved → show that computer's last workspace, or this one's
//   - the active workspace moved  → remember it per computer, mark a host's as seen
//
// Reconcile reads the slice's feed, never a raw push: a failed tick keeps the
// previous rows, so an unreachable host never empties a shadow.

import { useEffect } from 'react';
import { useStore } from '../../stores';
import { LOCAL_PC_ID, isPcRailFeedStale, isShadowWorkspaceId, parseShadowWorkspaceId } from '../../../shared/pcRail';
import type { Pane } from '../../../shared/types';

function hasEmptyLeaf(pane: Pane): boolean {
  return pane.type === 'leaf' ? pane.surfaces.length === 0 : pane.children.some(hasEmptyLeaf);
}

export default function ShadowWorkspaceSync() {
  useEffect(() => {
    // The local workspace to come back to when This computer is selected again.
    let lastLocal: string | null = null;
    {
      const st = useStore.getState();
      if (!isShadowWorkspaceId(st.activeWorkspaceId)) lastLocal = st.activeWorkspaceId;
    }
    return useStore.subscribe((state, prev) => {
      if (state.pcRailFeeds !== prev.pcRailFeeds) {
        for (const hostId of Object.keys(state.pcRailFeeds)) {
          if (state.pcRailFeeds[hostId] !== prev.pcRailFeeds[hostId]) useStore.getState().reconcileShadowWorkspaces(hostId);
        }
      }
      if (state.pcRailHosts !== prev.pcRailHosts && state.pcRailHostsLoaded) {
        const live = new Set(state.pcRailHosts.map((h) => h.id));
        for (const ws of state.workspaces) {
          const b = parseShadowWorkspaceId(ws.id);
          if (b && !live.has(b.hostId)) useStore.getState().closeShadowWorkspace(ws.id);
        }
      }
      if (state.activeWorkspaceId !== prev.activeWorkspaceId || state.workspaces !== prev.workspaces) {
        const active = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        // A local split inside a shadow leaves an empty leaf: fold it right away.
        const b = active ? parseShadowWorkspaceId(active.id) : null;
        if (b && active && hasEmptyLeaf(active.rootPane)) useStore.getState().reconcileShadowWorkspaces(b.hostId);
      }
      if (state.activeWorkspaceId !== prev.activeWorkspaceId) {
        const b = parseShadowWorkspaceId(state.activeWorkspaceId);
        const st = useStore.getState();
        if (b) {
          st.rememberPcWorkspace(b.hostId, b.remoteId);
          st.markPcWorkspaceSeen(b.hostId, b.remoteId);
        } else if (state.activeWorkspaceId) {
          lastLocal = state.activeWorkspaceId;
          st.rememberPcWorkspace(LOCAL_PC_ID, state.activeWorkspaceId);
        }
      }
      if (state.pcRail.activePcId !== prev.pcRail.activePcId) {
        const pc = state.pcRail.activePcId;
        const st = useStore.getState();
        if (pc === LOCAL_PC_ID) {
          if (isShadowWorkspaceId(st.activeWorkspaceId)) {
            const back = st.workspaces.find((w) => w.id === lastLocal)
              ?? st.workspaces.find((w) => !isShadowWorkspaceId(w.id));
            if (back) st.setActiveWorkspace(back.id);
          }
        } else {
          // Reopen only from a fresh list: an offline computer shows its rows
          // muted and opens nothing.
          const remoteId = st.pcRail.lastWorkspaceByPc[pc];
          const feed = st.pcRailFeeds[pc];
          if (remoteId && feed && !isPcRailFeedStale(feed)) st.openShadowWorkspace(pc, remoteId);
        }
      }
    });
  }, []);
  return null;
}

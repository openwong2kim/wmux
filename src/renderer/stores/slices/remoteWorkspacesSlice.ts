/**
 * Task 6 — renderer state for attached remote workspaces (Remote Workspace
 * Attach plan). Deliberately a SEPARATE array from `workspaces[]` so
 * `removeWorkspace`, `duplicateWorkspace`, pane-tree actions, and session
 * persistence can never reach a remote entry by construction — a remote
 * workspace is a live mirror of another host's daemon, not a local pane tree.
 *
 * NOT persisted: attach is per-app-run (re-attach is one click from the host
 * list), so this slice never touches SessionData / loadSession.
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { RemotePaneSummary } from '../../../shared/remoteHosts';

export interface AttachedRemoteWorkspace {
  key: string;                    // `${hostId}:${workspaceId}` — selection + dedup key
  hostId: string;
  hostLabel: string;
  workspaceId: string;
  name: string;                   // remote name snapshot ('' → UI falls back to workspaceId prefix)
  panes: RemotePaneSummary[];     // refreshed on re-attach / manual refresh
}

export interface RemoteWorkspacesSlice {
  remoteWorkspaces: AttachedRemoteWorkspace[];
  /** Which sidebar entry is selected: a local workspace id (existing
   * activeWorkspaceId) or a remote key. Remote selection does NOT touch
   * activeWorkspaceId — WorkspaceCenter checks this field first. */
  activeRemoteKey: string | null;
  /** Dedup by key (re-attach refreshes the existing entry's snapshot in
   * place), then select it. */
  attachRemoteWorkspace: (w: AttachedRemoteWorkspace) => void;
  /** Remove the entry; clears activeRemoteKey only if it was the active one. */
  detachRemoteWorkspace: (key: string) => void;
  /** Selecting a LOCAL workspace calls this with null. */
  setActiveRemoteKey: (key: string | null) => void;
}

export const createRemoteWorkspacesSlice: StateCreator<StoreState, [['zustand/immer', never]], [], RemoteWorkspacesSlice> = (set) => ({
  remoteWorkspaces: [],
  activeRemoteKey: null,

  attachRemoteWorkspace: (w) => set((state: StoreState) => {
    const idx = state.remoteWorkspaces.findIndex((r: AttachedRemoteWorkspace) => r.key === w.key);
    if (idx === -1) {
      state.remoteWorkspaces.push(w);
    } else {
      state.remoteWorkspaces[idx] = w;
    }
    state.activeRemoteKey = w.key;
  }),

  detachRemoteWorkspace: (key) => set((state: StoreState) => {
    const idx = state.remoteWorkspaces.findIndex((r: AttachedRemoteWorkspace) => r.key === key);
    if (idx === -1) return;
    state.remoteWorkspaces.splice(idx, 1);
    if (state.activeRemoteKey === key) state.activeRemoteKey = null;
  }),

  setActiveRemoteKey: (key) => set((state: StoreState) => {
    state.activeRemoteKey = key;
  }),
});

/**
 * Task 6 — renderer state for attached remote workspaces (Remote Workspace
 * Attach plan). Deliberately a SEPARATE array from `workspaces[]` so
 * `removeWorkspace`, `duplicateWorkspace`, pane-tree actions, and session
 * persistence can never reach a remote entry by construction — a remote
 * workspace is a live mirror of another host's daemon, not a local pane tree.
 *
 * This array itself stays out of SessionData / loadSession. What survives a
 * reload and an app restart is the DESCRIPTOR (no panes), persisted in the
 * main process by RemoteAttachmentsStore and replayed on boot by
 * useRemoteAttachmentsLifecycle — the panes are always re-fetched, never
 * restored from disk.
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { RemoteAttachmentDescriptor, RemotePaneSummary } from '../../../shared/remoteHosts';

export interface AttachedRemoteWorkspace {
  key: string;                    // `${hostId}:${workspaceId}` — selection + dedup key
  hostId: string;
  hostLabel: string;
  workspaceId: string;
  name: string;                   // remote name snapshot ('' → UI falls back to workspaceId prefix)
  panes: RemotePaneSummary[];     // refreshed on re-attach / exit event / poll
  /** The host could not be reached, or the workspace is gone from it. The
   *  entry deliberately STAYS in the sidebar — dropping a user's attachment
   *  because a laptop slept would be silent data loss — it just renders
   *  disconnected until a refresh succeeds or the user detaches. */
  stale?: boolean;
}

/** Fire-and-forget descriptor persistence. Guarded for the node test
 *  environment (no `window`) and for a preload without the remote bridge. */
function persistApi() {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI?.remote;
}

function toDescriptor(w: AttachedRemoteWorkspace): RemoteAttachmentDescriptor {
  return {
    key: w.key,
    hostId: w.hostId,
    hostLabel: w.hostLabel,
    workspaceId: w.workspaceId,
    name: w.name,
  };
}

/** Merges a freshly fetched pane set into the current one with STABLE
 *  ordering: panes that are still there keep their slot (so the mirror grid
 *  never reshuffles when an unrelated pane closes), panes that are gone drop
 *  out, and newly opened panes append at the end. Field updates (shell/cwd)
 *  from the fetch always win. */
export function mergePaneSets(
  current: RemotePaneSummary[],
  next: RemotePaneSummary[],
): RemotePaneSummary[] {
  const nextById = new Map(next.map((p) => [p.sessionId, p]));
  const kept: RemotePaneSummary[] = [];
  for (const pane of current) {
    const fresh = nextById.get(pane.sessionId);
    if (fresh) kept.push(fresh);
  }
  const currentIds = new Set(current.map((p) => p.sessionId));
  const added = next.filter((p) => !currentIds.has(p.sessionId));
  return [...kept, ...added];
}

/** Whether a merge result is indistinguishable from what is already in the
 *  store — the 10s poll runs forever, so an unchanged fetch must not push a
 *  new array identity and re-render every mirror. */
function samePanes(a: RemotePaneSummary[], b: RemotePaneSummary[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((pane, i) =>
    pane.sessionId === b[i].sessionId && pane.shell === b[i].shell && pane.cwd === b[i].cwd);
}

export interface RemoteWorkspacesSlice {
  remoteWorkspaces: AttachedRemoteWorkspace[];
  /** Which sidebar entry is selected: a local workspace id (existing
   * activeWorkspaceId) or a remote key. Remote selection does NOT touch
   * activeWorkspaceId — WorkspaceCenter checks this field first. */
  activeRemoteKey: string | null;
  /** Dedup by key (re-attach refreshes the existing entry's snapshot in
   * place), then select it. Also persists the descriptor so the attachment
   * survives a reload. */
  attachRemoteWorkspace: (w: AttachedRemoteWorkspace) => void;
  /** Boot-time replay of a persisted descriptor: adds the entry WITHOUT
   * selecting it (a restore must not steal the user's view) and without
   * re-persisting what it just read. */
  restoreRemoteWorkspace: (w: AttachedRemoteWorkspace) => void;
  /** Remove the entry AND its persisted descriptor; clears activeRemoteKey
   * only if it was the active one. */
  detachRemoteWorkspace: (key: string) => void;
  /** Applies a freshly fetched pane set (exit event / poll) with stable
   * ordering, and clears `stale` — a successful fetch means reachable. No-ops
   * when nothing changed. */
  setRemoteWorkspacePanes: (key: string, panes: RemotePaneSummary[]) => void;
  /** Marks the entry unreachable (or reachable again) without dropping it. */
  setRemoteWorkspaceStale: (key: string, stale: boolean) => void;
  /** Selecting a LOCAL workspace calls this with null. */
  setActiveRemoteKey: (key: string | null) => void;
}

export const createRemoteWorkspacesSlice: StateCreator<StoreState, [['zustand/immer', never]], [], RemoteWorkspacesSlice> = (set) => ({
  remoteWorkspaces: [],
  activeRemoteKey: null,

  attachRemoteWorkspace: (w) => {
    set((state: StoreState) => {
      const idx = state.remoteWorkspaces.findIndex((r: AttachedRemoteWorkspace) => r.key === w.key);
      if (idx === -1) {
        state.remoteWorkspaces.push(w);
      } else {
        state.remoteWorkspaces[idx] = w;
      }
      state.activeRemoteKey = w.key;
    });
    // Fire-and-forget: a failed write only costs this attachment its
    // restore-after-reload, and the attach itself has already happened. The
    // method check covers an older preload bundle without these routes.
    const api = persistApi();
    if (api?.attachmentsAdd) void api.attachmentsAdd(toDescriptor(w)).catch(() => { /* see above */ });
  },

  restoreRemoteWorkspace: (w) => set((state: StoreState) => {
    const idx = state.remoteWorkspaces.findIndex((r: AttachedRemoteWorkspace) => r.key === w.key);
    if (idx === -1) state.remoteWorkspaces.push(w);
    else state.remoteWorkspaces[idx] = w;
  }),

  detachRemoteWorkspace: (key) => {
    set((state: StoreState) => {
      const idx = state.remoteWorkspaces.findIndex((r: AttachedRemoteWorkspace) => r.key === key);
      if (idx === -1) return;
      state.remoteWorkspaces.splice(idx, 1);
      if (state.activeRemoteKey === key) state.activeRemoteKey = null;
    });
    const api = persistApi();
    if (api?.attachmentsRemove) void api.attachmentsRemove(key).catch(() => { /* fire-and-forget, as above */ });
  },

  setRemoteWorkspacePanes: (key, panes) => set((state: StoreState) => {
    const entry = state.remoteWorkspaces.find((r: AttachedRemoteWorkspace) => r.key === key);
    if (!entry) return;
    const merged = mergePaneSets(entry.panes, panes);
    if (!samePanes(entry.panes, merged)) entry.panes = merged;
    if (entry.stale) entry.stale = false;
  }),

  setRemoteWorkspaceStale: (key, stale) => set((state: StoreState) => {
    const entry = state.remoteWorkspaces.find((r: AttachedRemoteWorkspace) => r.key === key);
    if (!entry || entry.stale === stale) return;
    entry.stale = stale;
  }),

  setActiveRemoteKey: (key) => set((state: StoreState) => {
    state.activeRemoteKey = key;
  }),
});

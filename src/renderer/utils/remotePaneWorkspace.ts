// ─── New workspace whose first pane is remote (#1323) ────────────────────────
// The + menu's "Empty" row makes a workspace with one blank LOCAL pane. When at
// least one host is paired, the menu also offers "Empty — remote": the same
// blank single pane, but running on the host. It rides the path the ⋮ menu's
// "Split right/down — remote" entries already use (#1100/#1141) —
// AddRemotePaneModal mints the session, then the store's addRemoteSurface puts
// it in a pane as an OWNED remote-terminal surface — and differs only in which
// pane receives it: the leaf of a workspace created for it, not a split.
//
// Store surface injected (browserPane.ts pattern) so the ordering contract is
// testable against a plain object as well as the real store.

import type { Pane, Workspace } from '../../shared/types';
import { findLeaf, getLeafPanes, type RemoteSessionRef } from '../../shared/paneUtils';
import { isShadowWorkspaceId } from '../../shared/pcRail';
import { findRemoteSurface } from '../stores/shadowWorkspace';
import { moaHqId } from '../stores/slices/moaSlice';

/** The session AddRemotePaneModal minted, exactly as its onCreated reports it. */
export interface MintedRemoteSession {
  hostId: string;
  sessionId: string;
  /** The workspace id the session lives in ON THE HOST (#1329), not a local one. */
  remoteWorkspaceId: string;
}

/** Structural subset of StoreState — the caller passes useStore.getState. */
export interface RemotePaneWorkspaceStoreApi {
  workspaces: ReadonlyArray<{ id: string; rootPane: Pane }>;
  addWorkspace: () => void;
  addRemoteSurface: (
    paneId: string,
    hostId: string,
    sessionId: string,
    shell?: string,
    cwd?: string,
    workspaceId?: string,
    owned?: boolean,
    remoteWorkspaceId?: string,
  ) => void;
}

/**
 * Create (and activate) a new local workspace and attach `minted` to its single
 * leaf. Returns the new workspace id, or null when there was no leaf to attach
 * to — in which case the session is destroyed on the host.
 *
 * addWorkspace and addRemoteSurface MUST run in the same synchronous tick, with
 * no await between them: addWorkspace creates an EMPTY leaf, and
 * EmptyLeafFunnel spawns a local PTY into any empty leaf of the active
 * workspace once React commits. By the time it can look, the leaf already
 * carries the remote surface — the same reason Pane.tsx's handleRemoteCreated
 * calls splitPane and addRemoteSurface back to back.
 *
 * The session is minted BEFORE this runs (the modal awaits the host), so a
 * failed mint never leaves an empty workspace behind.
 */
export function createWorkspaceWithRemotePane(
  getState: () => RemotePaneWorkspaceStoreApi,
  destroy: (refs: readonly RemoteSessionRef[]) => void,
  minted: MintedRemoteSession,
): string | null {
  const { hostId, sessionId, remoteWorkspaceId } = minted;
  // Found by diffing ids rather than reading activeWorkspaceId back: the new
  // workspace is identified by what addWorkspace added, not by what it happens
  // to activate.
  const before = new Set(getState().workspaces.map((w) => w.id));
  getState().addWorkspace();
  const ws = getState().workspaces.find((w) => !before.has(w.id));
  if (!ws || ws.rootPane.type !== 'leaf') {
    // With no surface to carry the remoteOwned record, nothing would ever reap
    // this session (#1129) — same fallback as a split refused after the mint.
    destroy([{ hostId, sessionId }]);
    return null;
  }
  // owned: true — this desktop minted the session, so closing the tab is what
  // destroys it on the host (#1129).
  getState().addRemoteSurface(ws.rootPane.id, hostId, sessionId, undefined, undefined, ws.id, true, remoteWorkspaceId);
  return ws.id;
}

// ─── A mirror-grid session opened as a tab (#1323 item 2) ────────────────────
// The mirror grid (RemoteWorkspaceView) only watches another computer's
// workspace. #1091 left one bridge for later: "open this session as a tab in
// my workspace". This is it, on the same store action as every other remote
// tab, with one difference: nothing is minted. The session is someone's
// running work on the host, so the tab is a view of it and NOT owned —
// closing the tab detaches and never destroys the session (#1129).

/** A session the mirror grid is showing. */
export interface MirroredRemoteSession {
  hostId: string;
  sessionId: string;
  /** The host-side workspace the mirror is attached to (#1329's roster feed). */
  remoteWorkspaceId: string;
}

/** Structural subset of StoreState — the caller passes useStore.getState. */
export type RemoteSessionTabStoreApi = Parameters<typeof moaHqId>[0] & {
  workspaces: readonly Workspace[];
  addRemoteSurface: RemotePaneWorkspaceStoreApi['addRemoteSurface'];
};

/**
 * Add `session` as a remote-terminal tab to the active pane of `workspaceId`
 * (its first pane when the active id does not resolve). Returns the id of the
 * tab that shows the session, or null when the workspace is not one of the
 * operator's own (unknown, the Moa HQ, or another computer's shadow).
 *
 * A session already open as a tab is not opened twice (addRemoteSurface's
 * one-viewer rule): the tab that already shows it is returned instead.
 */
export function openRemoteSessionAsTab(
  getState: () => RemoteSessionTabStoreApi,
  workspaceId: string,
  session: MirroredRemoteSession,
): string | null {
  const { hostId, sessionId, remoteWorkspaceId } = session;
  if (isShadowWorkspaceId(workspaceId) || workspaceId === moaHqId(getState())) return null;
  const ws = getState().workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;
  const pane = findLeaf(ws.rootPane, ws.activePaneId) ?? getLeafPanes(ws.rootPane)[0];
  if (!pane) return null;
  // owned: false — see the section comment. The host-side workspace id rides
  // along so the tab gets its agent in the sidebar roster and pane_list (#1329).
  getState().addRemoteSurface(pane.id, hostId, sessionId, undefined, undefined, ws.id, false, remoteWorkspaceId);
  return findRemoteSurface(getState(), hostId, sessionId)?.surfaceId ?? null;
}

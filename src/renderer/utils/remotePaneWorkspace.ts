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

import type { Pane } from '../../shared/types';
import type { RemoteSessionRef } from '../../shared/paneUtils';

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

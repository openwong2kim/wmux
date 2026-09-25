import type { Pane, Workspace } from '../../shared/types';
import { collectPaneTreePtyIds, getWorkspacePtyIds } from '../../shared/paneUtils';
import { destroyPaneTreeRemoteSessions, destroyWorkspaceRemoteSessions } from './remoteSessionTeardown';

/** Dispose all PTYs inside a pane tree — plus every remote session the tree
 *  owns (#1129), which carries no ptyId and would otherwise survive the pane
 *  that was running it. */
export function disposePanePtys(pane: Pane): void {
  for (const ptyId of collectPaneTreePtyIds(pane)) window.electronAPI.pty.dispose(ptyId);
  destroyPaneTreeRemoteSessions(pane);
}

/**
 * Dispose every PTY a workspace owns, before the workspace is removed.
 *
 * Workspace-wide (#977): closing a workspace kills everything it owns, and a
 * stashed pane's session is very much owned. Missing it would leave an orphan
 * daemon session burning tokens with no window left to show it.
 */
export function disposeWorkspacePtys(ws: Workspace): void {
  for (const ptyId of getWorkspacePtyIds(ws)) window.electronAPI.pty.dispose(ptyId);
  // #1129 — a remote-terminal surface owns a session on another machine and
  // carries no ptyId, so the walk above is blind to it. Same orphan argument
  // as the stash: nothing else on the host will ever reap it.
  destroyWorkspaceRemoteSessions(ws);
}

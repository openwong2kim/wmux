import type { Pane, Surface } from '../../shared/types';
import {
  collectPaneTreeRemoteSessions,
  getWorkspaceRemoteSessions,
  type RemoteSessionRef,
  type WorkspacePaneOwner,
} from '../../shared/paneUtils';

/**
 * #1129 — the remote half of "closing this destroys what it was running".
 *
 * A remote-terminal surface has no ptyId, so every `pty.dispose` teardown path
 * in the renderer walks straight past it: closing the tab detached the SSE
 * stream and left the shell — and the one-shot `remote-pane-*` workspace row
 * the remote daemon derives from that shell's `WMUX_WORKSPACE_ID` — alive on
 * the host with nothing that would ever reap it.
 *
 * TWO DELIBERATE LIMITS, both from #1091's direction call ("tab = mine to
 * operate, mirror = watching"):
 *
 *  1. ONLY OWNED SESSIONS. `Surface.remoteOwned` marks a session THIS desktop
 *     minted. A tab that merely views a session started elsewhere is left
 *     strictly alone — closing your view of somebody's running work must
 *     never end it.
 *  2. CLOSE, NOT UNMOUNT. These are called from the explicit close paths
 *     (tab X, Ctrl+W, pane/workspace teardown) only, never from a React
 *     cleanup: a remount, a reload, a tab switch, or a workspace switch must
 *     keep the session alive — that constraint is what makes the surface
 *     model re-attachable at all.
 *
 * Best-effort by design, like `pty.dispose`: the tab is already gone from the
 * layout by the time the DELETE lands, so a failure (host offline, or a host
 * running without `--allow-input`, which refuses a close) has nothing to
 * report to and must not reject into the caller.
 */
export function destroyRemoteSessions(refs: readonly RemoteSessionRef[]): void {
  // `typeof window` rather than a bare reference: createPrefixActions (the
  // one caller that takes an injected electronAPI) is unit-tested in a node
  // environment with no window at all, and a teardown detail must not be what
  // decides whether a keyboard action can run there.
  const remote = typeof window === 'undefined' ? undefined : window.electronAPI?.remote;
  if (!remote?.sessionClose) return;
  for (const ref of refs) {
    void remote.sessionClose(ref.hostId, ref.sessionId).catch(() => { /* see doc comment */ });
  }
}

/** Destroy the remote session behind ONE surface, if it owns one. */
export function destroySurfaceRemoteSession(surface: Surface | undefined): void {
  if (!surface) return;
  if (surface.surfaceType !== 'remote-terminal') return;
  if (!surface.remoteOwned || !surface.remoteHostId || !surface.remoteSessionId) return;
  destroyRemoteSessions([{ hostId: surface.remoteHostId, sessionId: surface.remoteSessionId }]);
}

/** Destroy every owned remote session under a pane subtree (pane teardown). */
export function destroyPaneTreeRemoteSessions(pane: Pane): void {
  destroyRemoteSessions(collectPaneTreeRemoteSessions(pane));
}

/** Destroy every owned remote session a workspace holds — visible tree plus
 *  stash — for the workspace-delete paths. */
export function destroyWorkspaceRemoteSessions(ws: WorkspacePaneOwner): void {
  destroyRemoteSessions(getWorkspaceRemoteSessions(ws));
}

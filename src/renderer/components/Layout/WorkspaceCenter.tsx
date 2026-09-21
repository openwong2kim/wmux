// ─── WorkspaceCenter — central area (pane grid)────────────────────────────────
//
// IA decision (2026-07-20, owner revert): drop the central Git/Review surface variant
// and move back to tabs in the right-hand deck (ChannelDock) — the center returns to
// being pane-grid-only.

import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { WorkspaceViewport } from './WorkspaceViewport';
import RemoteWorkspaceView from '../Remote/RemoteWorkspaceView';
import {
  isRemoteMirrorVisible,
  selectAttachedRemoteWorkspaces,
} from '../../stores/slices/remoteWorkspacesSlice';

export function WorkspaceCenter() {
  // #1329 — the ephemeral rows behind remote-terminal PANES are poll inputs,
  // not mirrors. Mounting one would open a second RemoteWorkspaceView onto the
  // same host and double-attach the SSE stream the pane is already reading.
  // useShallow so those rows' 10s poll churn cannot re-render every mirror.
  const remoteWorkspaces = useStore(useShallow(selectAttachedRemoteWorkspaces));
  const activeRemoteKey = useStore((s) => s.activeRemoteKey);
  // #1086 — one predicate decides the local-vs-remote gate (and a dangling key
  // reads as "local", never as a blank centre). Selecting a local workspace
  // drops activeRemoteKey in the store (activateLocalWorkspace), so the local
  // tree comes back on the FIRST click.
  const remoteVisible = useStore(isRemoteMirrorVisible);

  return (
    <div className="wmux-workspace-frame flex-1 min-h-0 relative">
      {/* Local pane tree — stays mounted even when a remote view is active
          (same hidden-but-alive discipline WorkspaceViewport already uses
          for individual workspaces), just toggled to display:none. */}
      <div
        className="absolute inset-0 flex flex-col"
        data-pane-grid-wrapper
        style={{ display: remoteVisible ? 'none' : 'flex' }}
      >
        <WorkspaceViewport />
      </div>

      {/* Every attached remote workspace stays mounted too — unmounting on
          switch would re-attach every SSE stream and repaint the full
          snapshot each time. Only the active one is visible. */}
      {remoteWorkspaces.map((rw) => (
        <div
          key={rw.key}
          className="absolute inset-0 flex flex-col"
          style={{ display: remoteVisible && rw.key === activeRemoteKey ? 'flex' : 'none' }}
        >
          <RemoteWorkspaceView workspace={rw} />
        </div>
      ))}
    </div>
  );
}

export default WorkspaceCenter;

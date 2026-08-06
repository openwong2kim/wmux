// ─── WorkspaceCenter — central area (pane grid)────────────────────────────────
//
// IA decision (2026-07-20, owner revert): drop the central Git/Review surface variant
// and move back to tabs in the right-hand deck (ChannelDock) — the center returns to
// being pane-grid-only.

import { useStore } from '../../stores';
import { WorkspaceViewport } from './WorkspaceViewport';
import RemoteWorkspaceView from '../Remote/RemoteWorkspaceView';

export function WorkspaceCenter() {
  const remoteWorkspaces = useStore((s) => s.remoteWorkspaces);
  const activeRemoteKey = useStore((s) => s.activeRemoteKey);

  return (
    <div className="flex-1 min-h-0 relative">
      {/* Local pane tree — stays mounted even when a remote view is active
          (same hidden-but-alive discipline WorkspaceViewport already uses
          for individual workspaces), just toggled to display:none. */}
      <div
        className="absolute inset-0 flex flex-col"
        data-pane-grid-wrapper
        style={{ display: activeRemoteKey ? 'none' : 'flex' }}
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
          style={{ display: rw.key === activeRemoteKey ? 'flex' : 'none' }}
        >
          <RemoteWorkspaceView workspace={rw} />
        </div>
      ))}
    </div>
  );
}

export default WorkspaceCenter;

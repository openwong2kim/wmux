// ─── WorkspaceViewport — the ONLY part of the layout that owns the workspaces
//     subscription (2026-07-13, measured perf fix) ─────────────────────────────
//
// All workspaces stay mounted (inactive ones display:none) so their terminals
// keep scrollback/PTY state. This component owns `useStore(s => s.workspaces)`;
// AppLayout does NOT (it subscribes only to derived-stable selectors — see
// stores/selectors/appLayout.ts). So a pane metadata/surface update re-renders
// THIS small component (the map + memoized slots, unchanged slots bail) instead
// of AppLayout's ~1300-line chrome. Before this split, that churn re-created the
// whole chrome on every update and drove CPU to 53% at 5 workspaces.
//
// Both layouts use a React.memo slot so an unchanged workspace bails: immer keeps
// an untouched workspace referentially stable, and `isActive` is a bool that
// flips for only two slots on a switch.

import { memo } from 'react';
import { useStore } from '../../stores';
import PaneContainer from '../Pane/PaneContainer';
import type { Workspace } from '../../../shared/types';

/** One single-view workspace pane subtree. Inactive → display:none (kept mounted). */
export const WorkspaceSlot = memo(function WorkspaceSlot({
  workspace,
  isActive,
}: {
  workspace: Workspace;
  isActive: boolean;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: isActive ? 'flex' : 'none',
        flexDirection: 'column',
      }}
    >
      <PaneContainer pane={workspace.rootPane} workspace={workspace} isWorkspaceVisible={isActive} />
    </div>
  );
});

/** One multiview grid tile. Memoized on the SAME terms as WorkspaceSlot so
 *  metadata churn re-renders only the changed tile (eng review — the multiview
 *  grid previously rendered PaneContainer directly and re-ran every tile). */
const MultiviewWorkspaceSlot = memo(function MultiviewWorkspaceSlot({
  workspace,
  isActive,
  multiviewCount,
  onActivate,
  onRemove,
}: {
  workspace: Workspace;
  isActive: boolean;
  /** Count of multiview members — the close handler needs it to hand off focus. */
  multiviewCount: number;
  onActivate: (id: string) => void;
  onRemove: (id: string, isActive: boolean, multiviewCount: number) => void;
}) {
  return (
    <div
      className="relative flex flex-col min-w-0 min-h-0 overflow-hidden cursor-pointer"
      style={{
        border: isActive ? '2px solid var(--accent-blue)' : '2px solid transparent',
        backgroundColor: 'var(--bg-base)',
      }}
      onClick={() => onActivate(workspace.id)}
    >
      <div
        className="flex items-center gap-1.5 px-2 py-0.5 shrink-0 text-xs"
        style={{
          backgroundColor: isActive ? 'var(--accent-blue)' : 'var(--bg-mantle)',
          color: isActive ? 'var(--bg-base)' : 'var(--text-sub2)',
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        <span className="flex-1">{workspace.name}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(workspace.id, isActive, multiviewCount);
          }}
          className="ml-auto opacity-60 hover:opacity-100"
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            padding: '0 2px',
            fontSize: 14,
            lineHeight: 1,
          }}
          title="Remove from multiview"
          aria-label={`Remove ${workspace.name} from multiview`}
        >
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
          <PaneContainer pane={workspace.rootPane} workspace={workspace} isWorkspaceVisible={true} />
        </div>
      </div>
    </div>
  );
});

export function WorkspaceViewport({
  activeWorkspaceId,
  multiviewIds,
  paneGate,
  t,
  setActiveWorkspace,
  removeMultiviewWorkspace,
}: {
  activeWorkspaceId: string;
  multiviewIds: string[];
  paneGate: 'pending' | 'ready' | string;
  t: (key: string) => string;
  setActiveWorkspace: (id: string) => void;
  removeMultiviewWorkspace: (id: string) => void;
}) {
  // The ONE workspaces subscription. Confined here so the chrome (AppLayout)
  // stays out of the metadata-churn re-render path.
  const workspaces = useStore((s) => s.workspaces);

  // Close a multiview tile. If closing the ACTIVE tile with others remaining,
  // hand focus to a neighbor first — otherwise the grid gate
  // (multiviewIds.includes(activeId)) fails the next render and the view
  // collapses to the just-closed workspace (reads as "the window reset").
  const handleRemoveTile = (id: string, isActive: boolean, count: number) => {
    if (isActive && count > 2) {
      const removedIdx = multiviewIds.indexOf(id);
      const nextActive = multiviewIds[removedIdx + 1] ?? multiviewIds[removedIdx - 1];
      if (nextActive) setActiveWorkspace(nextActive);
    }
    removeMultiviewWorkspace(id);
  };

  // Fix 0 — while startup reconcile is in flight, show a placeholder. Chrome
  // stays mounted (it's AppLayout, not here) so the user sees wmux is alive.
  if (paneGate === 'pending') {
    return (
      <div
        className="flex-1 min-h-0 flex items-center justify-center text-sm"
        style={{ color: 'var(--text-sub2)' }}
      >
        {t('app.restoringPanes') || 'Restoring panes…'}
      </div>
    );
  }

  if (multiviewIds.length >= 2 && multiviewIds.includes(activeWorkspaceId)) {
    const tiles = multiviewIds
      .map((id) => workspaces.find((w) => w.id === id))
      .filter((ws): ws is Workspace => ws !== undefined);
    return (
      <div
        className="flex-1 min-h-0"
        style={{
          display: 'grid',
          gridTemplateColumns:
            multiviewIds.length === 2 ? '1fr 1fr' : multiviewIds.length <= 4 ? '1fr 1fr' : 'repeat(3, 1fr)',
          gridAutoRows: '1fr',
          gap: '2px',
          backgroundColor: 'var(--bg-surface)',
        }}
      >
        {tiles.map((ws) => (
          <MultiviewWorkspaceSlot
            key={ws.id}
            workspace={ws}
            isActive={ws.id === activeWorkspaceId}
            multiviewCount={multiviewIds.length}
            onActivate={setActiveWorkspace}
            onRemove={handleRemoveTile}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 relative">
      {workspaces.map((ws) => (
        <WorkspaceSlot key={ws.id} workspace={ws} isActive={ws.id === activeWorkspaceId} />
      ))}
    </div>
  );
}

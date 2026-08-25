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

import { memo, useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import PaneContainer from '../Pane/PaneContainer';
import { multiviewGridStyle, type MultiviewArrangement } from '../../utils/multiviewGrid';
import { workspaceColorHex } from '../../../shared/workspaceColors';
import type { Workspace } from '../../../shared/types';

/** One single-view workspace pane subtree. Inactive → display:none (kept mounted).
 *
 * Cold-park (TASK-9): when `parked` is true the PaneContainer is NOT rendered —
 * unmounting it disposes the workspace's xterm/WebGL/registry entries (useTerminal
 * cleanup) WITHOUT touching the daemon PTY, so RAM stops scaling with hidden
 * workspace count. A parked slot is always hidden (parked ⇒ not active), so the
 * placeholder is never visible; it exists only to keep the mount slot alive.
 * Only terminal-only workspaces are ever parked (sweepColdPark gates on
 * isTerminalOnlyWorkspace), so unmounting here can never drop a browser webview
 * session or unsaved editor state — those have no daemon-side replay. */
export const WorkspaceSlot = memo(function WorkspaceSlot({
  workspace,
  isActive,
  parked,
}: {
  workspace: Workspace;
  isActive: boolean;
  parked?: boolean;
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
      {parked ? null : (
        <PaneContainer pane={workspace.rootPane} workspace={workspace} isWorkspaceVisible={isActive} />
      )}
    </div>
  );
});

/** One multiview grid tile. Memoized on the SAME terms as WorkspaceSlot so
 *  metadata churn re-renders only the changed tile (eng review — the multiview
 *  grid previously rendered PaneContainer directly and re-ran every tile). */
export const MultiviewWorkspaceSlot = memo(function MultiviewWorkspaceSlot({
  workspace,
  isActive,
  multiviewCount,
  arrangement,
  onActivate,
  onRemove,
}: {
  workspace: Workspace;
  isActive: boolean;
  /** Count of multiview members — a change here can reflow this tile out of view. */
  multiviewCount: number;
  /** Current grid arrangement — a layout change can move this tile out of view. */
  arrangement: MultiviewArrangement;
  onActivate: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  // An explicit arrangement lets the grid scroll (see multiviewGrid.ts), so a
  // tile reached by Ctrl+Shift+Arrow can be off-screen. `nearest` scrolls the
  // minimum needed: nothing at all for a fully visible tile, and just enough to
  // reveal a partially visible one. Re-run on arrangement and tile count too —
  // switching auto→columns can push the active tile out of view without
  // `isActive` ever changing, which would strand the user on a tile they can't
  // see. Under `auto` the container doesn't scroll, so this is inert there.
  const t = useT();
  const tileRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isActive) tileRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [isActive, arrangement, multiviewCount]);
  // Purely visual tag (see shared/workspaceColors.ts) — undefined for the
  // untagged majority, so most tiles render exactly as before.
  const tagColor = workspaceColorHex(workspace.color);

  return (
    <div
      ref={tileRef}
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
        <span className="flex-1 flex items-center gap-1.5 min-w-0">
          {tagColor && (
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              // The 1px --bg-base ring is what keeps the dot legible on the
              // ACTIVE tile, whose header is filled with --accent-blue: every
              // tag hue lands at ~1.0–1.45 contrast against that fill (teal
              // and green at exactly 1.0), so the raw dot vanishes precisely
              // on the tile being looked at. --bg-base matches the active
              // header's text color, so the ring reuses its foreground.
              style={{ background: tagColor, boxShadow: '0 0 0 1px var(--bg-base)' }}
              aria-hidden="true"
            />
          )}
          <span className="truncate">{workspace.name}</span>
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(workspace.id);
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
          title={t('workspaceViewport.removeFromMultiview')}
          aria-label={t('workspaceViewport.removeFromMultiviewFor', { name: workspace.name })}
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

export function WorkspaceViewport() {
  // The ONE workspaces subscription. Confined here so the chrome (AppLayout)
  // stays out of the metadata-churn re-render path. `activeWorkspaceId` is
  // subscribed HERE too (not passed from AppLayout) so a workspace SWITCH
  // re-renders only this viewport — the chrome no longer subscribes to it
  // (2026-07-13 switch-lag fix; #437 covered the array but not the switch axis).
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const multiviewIds = useStore((s) => s.multiviewIds);
  const multiviewArrangement = useStore((s) => s.multiviewArrangement);
  // Cold-park (TASK-9): parked ids render a placeholder instead of PaneContainer.
  const parkedWorkspaceIds = useStore((s) => s.parkedWorkspaceIds);
  const paneGate = useStore((s) => s.paneGate);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const removeMultiviewWorkspace = useStore((s) => s.removeMultiviewWorkspace);
  const t = useT();

  // The focus handoff that used to live here — activate a neighbour before
  // removing the active tile, so the grid gate doesn't collapse the whole view —
  // moved into removeMultiviewWorkspace (#752). The sidebar's Ctrl+click path
  // had no equivalent and lost the grid; keeping one copy in the store is what
  // stops the two from drifting apart again.

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
          // Track count comes from `tiles`, not `multiviewIds` — an id whose
          // workspace is gone is filtered out above, and counting it would
          // leave an empty column in the grid.
          ...multiviewGridStyle(tiles.length, multiviewArrangement),
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
            arrangement={multiviewArrangement}
            onActivate={setActiveWorkspace}
            onRemove={removeMultiviewWorkspace}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 relative">
      {workspaces.map((ws) => (
        <WorkspaceSlot
          key={ws.id}
          workspace={ws}
          isActive={ws.id === activeWorkspaceId}
          // Visible ⇒ never rendered as parked, regardless of the parked set.
          // activeWorkspaceId is assigned directly by several handoff paths
          // (removeWorkspace, company destroy/removeDept, loadSession) that
          // don't run the un-park action, so a parked id promoted to active
          // would otherwise render a blank viewport until the 30s sweep. This
          // render guard covers every current and future promotion path; the
          // slice still converges its state via the clears in those sites.
          parked={
            parkedWorkspaceIds[ws.id] === true &&
            ws.id !== activeWorkspaceId &&
            !multiviewIds.includes(ws.id)
          }
        />
      ))}
    </div>
  );
}

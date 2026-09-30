/**
 * The browser build's shell (wmux web `/app`): the desktop's own Sidebar /
 * MiniSidebar and WorkspaceViewport (PaneContainer → Pane → SurfaceTabs),
 * without the desktop-only chrome AppLayout mounts around them (titlebar,
 * channel dock, dialogs, IPC hooks).
 *
 * Phone width: the rail (MiniSidebar) stays, the full Sidebar opens as a drawer
 * over the content, and only the focused pane is shown — it reuses the app's
 * own pane zoom, and a pane picker switches which pane that is. The desktop's
 * split is kept in the store untouched; at 390 px it would be unreadable.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../stores';
import Sidebar from '../components/Sidebar/Sidebar';
import MiniSidebar from '../components/Sidebar/MiniSidebar';
import { WorkspaceViewport } from '../components/Layout/WorkspaceViewport';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { getLeafPanes } from '../../shared/paneUtils';
import { FOCUS_RING } from '../components/focusRing';

export const PHONE_QUERY = '(max-width: 640px)';

function subscribeNarrow(cb: () => void): () => void {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(PHONE_QUERY).matches);
}

/** Phone only: which pane of the active workspace is shown. */
function PanePicker() {
  const leaves = useStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    if (!ws) return [] as string[];
    return getLeafPanes(ws.rootPane).map((l) => {
      const tab = l.surfaces.find((x) => x.id === l.activeSurfaceId) ?? l.surfaces[0];
      return `${l.id}\u0000${tab?.title ?? ''}`;
    });
  }));
  const activePaneId = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.activePaneId ?? '');
  const setActivePane = useStore((s) => s.setActivePane);
  if (leaves.length < 2) return null;
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto px-2 py-1 border-b" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-mantle)' }} data-web-pane-picker>
      {leaves.map((entry, i) => {
        const [id, title] = entry.split('\u0000');
        const active = id === activePaneId;
        return (
          <button
            key={id}
            type="button"
            className={`shrink-0 max-w-[40vw] truncate rounded px-2 py-1 text-xs ${FOCUS_RING}`}
            style={{ color: active ? 'var(--text-main)' : 'var(--text-sub2)', background: active ? 'var(--bg-surface)' : 'transparent' }}
            aria-pressed={active}
            onClick={() => setActivePane(id)}
          >
            {`${i + 1} · ${title || 'Pane'}`}
          </button>
        );
      })}
    </div>
  );
}

export function WebApp() {
  const narrow = useNarrow();
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const activePaneId = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.activePaneId ?? null);

  // Phone: one pane at a time, through the app's own zoom.
  useEffect(() => {
    useStore.setState({ zoomedPaneId: narrow ? activePaneId : null });
  }, [narrow, activePaneId]);

  // Phone: the drawer starts closed and closes after a workspace is picked.
  useEffect(() => {
    if (narrow) useStore.getState().setSidebarVisible(false);
  }, [narrow, activeWorkspaceId]);

  return (
    <ErrorBoundary name="WebApp">
      <div className="flex flex-col h-screen w-screen bg-[var(--bg-base)] overflow-hidden" data-web-app>
        <div className="wmux-shell-body relative flex flex-1 min-h-0">
          <ErrorBoundary name="Sidebar">
            {narrow ? <MiniSidebar /> : sidebarVisible ? <Sidebar /> : <MiniSidebar />}
          </ErrorBoundary>
          {narrow && sidebarVisible && (
            <div className="absolute inset-0 flex" style={{ zIndex: 'var(--z-overlay)' as unknown as number }} data-web-drawer>
              <ErrorBoundary name="SidebarDrawer">
                <Sidebar />
              </ErrorBoundary>
              <button
                type="button"
                className="flex-1"
                style={{ background: 'rgba(0,0,0,0.45)' }}
                aria-label="Close sidebar"
                onClick={() => useStore.getState().setSidebarVisible(false)}
              />
            </div>
          )}
          <ErrorBoundary name="Main">
            <div className="flex-1 min-w-0 flex flex-col relative">
              {narrow && <PanePicker />}
              <div className="wmux-workspace-frame flex-1 min-h-0 relative">
                <div className="absolute inset-0 flex flex-col" data-pane-grid-wrapper>
                  <WorkspaceViewport />
                </div>
              </div>
            </div>
          </ErrorBoundary>
        </div>
      </div>
    </ErrorBoundary>
  );
}

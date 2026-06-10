import { useCallback, useEffect, useState, useMemo } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import type { PaneLeaf, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import TerminalComponent from '../Terminal/Terminal';
import BrowserPanel from '../Browser/BrowserPanel';
import EditorPanel from '../Editor/EditorPanel';
import SurfaceTabs from './SurfaceTabs';
import { ErrorBoundary } from '../ErrorBoundary';
import { resolveStartupCwd, withDefaultShell, withWorkspaceProfile } from '../../utils/ptyCreateOptions';
import { tokenAttrs } from '../../themes';

interface PaneProps {
  pane: PaneLeaf;
  // The workspace this leaf pane belongs to. Required so SurfaceTabs can
  // build a drag-export payload that names the correct workspace even in
  // multiview, where useStore(activeWorkspaceId) would pick the focused
  // tile and mis-attribute drags from sibling tiles (codex P1).
  workspace: Workspace;
  isActive: boolean;
  isWorkspaceVisible?: boolean;
}

/**
 * Ring state produced by the T8 notification listener policy and stored in
 * paneSlice's `paneNotificationRing[paneId]`. `flash` is a one-shot 500ms
 * transition (newly arrived); `glow` is the steady "still unseen" indicator.
 */
export type PaneRingState = 'flash' | 'glow' | null | undefined;

/**
 * Pure className composer for the pane container. Extracted so the wiring
 * is testable without mounting the full Pane (Terminal / SurfaceTabs pull
 * in xterm.js, electronAPI mocks, etc).
 *
 * Toggle model (OPTION C — see T11 brief):
 *   - `notificationRingEnabled` gates the LEGACY unread-count pulse (callers
 *     fold this into `hasUnread` before passing it in).
 *   - `paneRingEnabled` gates the NEW state-machine flash/glow visual. When
 *     it's false the flash/glow classes are dropped regardless of `ringState`.
 */
export function composePaneClassName(opts: {
  hasUnread: boolean;
  ringState: PaneRingState;
  paneRingEnabled: boolean;
  flashing: boolean;
  /** B8: pane's active surface has a completed/awaiting agent and the pane is
   *  not focused — blink the border for attention. Takes precedence over the
   *  generic notification ring (the completion blink IS the signal for that
   *  pane, so showing both the blue glow and the green blink would be noisy). */
  completeBlink?: boolean;
}): string {
  const { hasUnread, ringState, paneRingEnabled, flashing, completeBlink } = opts;
  const classes = ['flex', 'flex-col', 'h-full', 'w-full', 'relative', 'box-border'];
  if (hasUnread) classes.push('notification-ring');
  if (completeBlink) {
    classes.push('pane-complete-blink');
  } else {
    if (paneRingEnabled && ringState === 'flash') classes.push('pane-ring-flash');
    if (paneRingEnabled && ringState === 'glow') classes.push('pane-ring-glow');
  }
  if (flashing) classes.push('pane-flash');
  return classes.join(' ');
}

export default function PaneComponent({ pane, workspace, isActive, isWorkspaceVisible = true }: PaneProps) {
  const t = useT();
  const [flashing, setFlashing] = useState(false);
  const setActivePane = useStore((s) => s.setActivePane);
  const setActiveSurface = useStore((s) => s.setActiveSurface);
  const addSurface = useStore((s) => s.addSurface);
  const closeSurface = useStore((s) => s.closeSurface);
  const updateSurfacePtyId = useStore((s) => s.updateSurfacePtyId);
  const markRead = useStore((s) => s.markRead);
  const setPaneNotificationRing = useStore((s) => s.setPaneNotificationRing);

  // count만 가져와 불필요한 배열 참조 안정성 문제 방지
  const unreadCount = useStore((s) =>
    s.notifications.filter(
      (n) => !n.read && pane.surfaces.some((surf) => surf.id === n.surfaceId),
    ).length,
  );
  const notificationRingEnabled = useStore((s) => s.notificationRingEnabled);
  const hasUnread = !isActive && unreadCount > 0 && notificationRingEnabled;

  // ─── T11: state-machine ring (driven by T8 listener policy) ──────────────
  // T3 (paneNotificationRing) and T5 (paneRingEnabled) are merged — read
  // directly from the typed store. `paneRingEnabled` defaults true in uiSlice
  // so the new visual is on by default until the user disables it.
  const ringState = useStore((s) => s.paneNotificationRing[pane.id]);
  const paneRingEnabled = useStore((s) => s.paneRingEnabled);

  // ─── B8: completed-terminal blink ────────────────────────────────────────
  // The pane's active surface ptyId drives the border blink. When that
  // surface's agent reaches a "needs attention" status (complete / waiting /
  // awaiting_input) AND this pane is not focused, the border blinks green.
  // Visiting the pane clears the status (the effect below), so the blink is a
  // one-shot "you haven't looked yet" cue rather than a permanent decoration.
  const activeSurfacePtyId = pane.surfaces.find((s) => s.id === pane.activeSurfaceId)?.ptyId;
  const setSurfaceAgentStatus = useStore((s) => s.setSurfaceAgentStatus);
  const activeSurfaceStatus = useStore((s) =>
    activeSurfacePtyId ? s.surfaceAgentStatus[activeSurfacePtyId] : undefined,
  );
  const completeBlink = !isActive && !!activeSurfaceStatus;

  // Clear the attention status once the user is actually on the pane (covers
  // both "navigated to a blinking pane" and "agent finished while I was
  // watching"). Keyboard nav sets isActive without firing handleClick, so the
  // clear must live here rather than only in the click handler.
  useEffect(() => {
    if (isActive && activeSurfacePtyId && activeSurfaceStatus) {
      setSurfaceAgentStatus(activeSurfacePtyId, null);
    }
  }, [isActive, activeSurfacePtyId, activeSurfaceStatus, setSurfaceAgentStatus]);

  // Ctrl+Shift+H: flash the active pane
  useEffect(() => {
    if (!isActive) return;
    const handler = () => {
      setFlashing(true);
      setTimeout(() => setFlashing(false), 500);
    };
    document.addEventListener('wmux:flash-pane', handler);
    return () => document.removeEventListener('wmux:flash-pane', handler);
  }, [isActive]);

  const handleClick = useCallback(() => {
    setActivePane(pane.id);
    // 최신 state에서 직접 읽어 stale closure 방지
    const { notifications } = useStore.getState();
    const surfaceIds = new Set(pane.surfaces.map((s) => s.id));
    let markedAny = false;
    for (const n of notifications) {
      if (!n.read && n.surfaceId !== undefined && surfaceIds.has(n.surfaceId)) {
        markRead(n.id);
        markedAny = true;
      }
    }
    // Clear the visual ring only when we actually marked something read.
    // A plain pane-focus click with no unread notifications shouldn't wipe a
    // fresh 'flash' from a notification that arrived 50ms ago and hasn't
    // been "seen" yet — the listener-driven flash→glow timeline owns that.
    if (markedAny) {
      setPaneNotificationRing(pane.id, null);
    }
  }, [pane.id, pane.surfaces, setActivePane, markRead, setPaneNotificationRing]);

  const defaultShell = useStore((s) => s.defaultShell);
  const { invoke: ipcInvoke } = useIpc();
  const handleAddSurface = useCallback(async () => {
    // Use the owning workspace id from the prop, NOT global activeWorkspaceId
    // — multiview can leave this Pane mounted while a different tile holds
    // focus, and the global value would tag the new PTY with the wrong
    // workspace. Codex P1 fix 2026-05-24.
    //
    // Read the profile FRESH from the store rather than closing over
    // `workspace.profile`: this callback is memoized on workspace.id, so after
    // the user saves a profile the stale closure would spawn the "+" terminal
    // with the OLD profile, violating the "applies to new panes" contract.
    // Mirrors Terminal.tsx's create path, which also reads the live profile.
    const profile = useStore.getState().workspaces.find((w) => w.id === workspace.id)?.profile;
    // Issue #175: new tabs honor profile.startupCwd > global startupDirectory.
    const cwd = resolveStartupCwd({ splitInheritsCwd: false, profile, startupDirectory: useStore.getState().startupDirectory });
    const result = await ipcInvoke<{ id: string }>(() =>
      window.electronAPI.pty.create(withWorkspaceProfile(withDefaultShell({ workspaceId: workspace.id, cwd }, defaultShell), profile))
    );
    if (result.ok) {
      addSurface(pane.id, result.data.id, 'Terminal', '');
    }
    // On failure, useIpc already surfaced a toast. No-op here.
  }, [pane.id, addSurface, workspace.id, defaultShell, ipcInvoke]);

  const closePane = useStore((s) => s.closePane);

  // Issue #182: zoomed badge. Without a visual cue, a zoomed pane reads as
  // "all my other panes vanished" — mirror tmux's status-line Z marker.
  const isZoomed = useStore((s) => s.zoomedPaneId === pane.id);

  const handleCloseSurface = useCallback((surfaceId: string) => {
    const surface = pane.surfaces.find((s) => s.id === surfaceId);
    if (surface?.ptyId) {
      window.electronAPI.pty.dispose(surface.ptyId);
    }
    closeSurface(pane.id, surfaceId);

    // 마지막 Surface가 닫히면 Pane도 자동 제거
    if (pane.surfaces.length <= 1) {
      closePane(pane.id);
    }
  }, [pane.id, pane.surfaces, closeSurface, closePane]);

  return (
    <div
      className={composePaneClassName({ hasUnread, ringState, paneRingEnabled, flashing, completeBlink })}
      style={{
        border: `1px solid ${isActive ? 'var(--accent-cursor)' : 'var(--bg-surface)'}`,
      }}
      onClick={handleClick}
      data-onboarding-target="pane-area"
      {...tokenAttrs('accent', 'border')}
      data-derived="accentCursor"
    >
      <ErrorBoundary name="pane">
      {isZoomed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().togglePaneZoom(pane.id);
          }}
          title={t('settings.prefix.toggleZoom')}
          aria-label={t('settings.prefix.toggleZoom')}
          style={{
            position: 'absolute',
            top: 4,
            right: 6,
            zIndex: 20,
            padding: '1px 6px',
            fontSize: 10,
            fontFamily: 'ui-monospace, monospace',
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: 'var(--bg-main)',
            backgroundColor: 'var(--accent-cursor)',
            border: 'none',
            borderRadius: 3,
            cursor: 'pointer',
            opacity: 0.85,
          }}
        >
          ZOOM
        </button>
      )}
      <SurfaceTabs
        surfaces={pane.surfaces}
        activeSurfaceId={pane.activeSurfaceId}
        workspace={workspace}
        paneId={pane.id}
        onSelect={(surfaceId) => setActiveSurface(pane.id, surfaceId)}
        onClose={handleCloseSurface}
        onAdd={handleAddSurface}
      />

      <SplitSurfaceView
        pane={pane}
        workspaceId={workspace.id}
        activeSurfaceId={pane.activeSurfaceId}
        isWorkspaceVisible={isWorkspaceVisible}
        onCloseSurface={handleCloseSurface}
        onPtyCreated={(surfaceId, ptyId) => updateSurfacePtyId(pane.id, surfaceId, ptyId)}
        emptyMessage={t('pane.empty')}
      />
      </ErrorBoundary>
    </div>
  );
}

/** Renders surfaces with a resizable split when both terminals and browsers coexist */
function SplitSurfaceView({
  pane,
  workspaceId,
  activeSurfaceId,
  isWorkspaceVisible,
  onCloseSurface,
  onPtyCreated,
  emptyMessage,
}: {
  pane: PaneLeaf;
  /** Owning workspace id — threaded through to TerminalComponent so PTY
   *  create uses the correct WMUX_WORKSPACE_ID env (Codex P1 2026-05-24). */
  workspaceId: string;
  activeSurfaceId: string;
  isWorkspaceVisible: boolean;
  onCloseSurface: (id: string) => void;
  onPtyCreated: (surfaceId: string, ptyId: string) => void;
  emptyMessage: string;
}) {
  const terminals = useMemo(
    () => pane.surfaces.filter((s) => !s.surfaceType || s.surfaceType === 'terminal'),
    [pane.surfaces],
  );
  const browsers = useMemo(
    () => pane.surfaces.filter((s) => s.surfaceType === 'browser'),
    [pane.surfaces],
  );

  const hasBoth = terminals.length > 0 && browsers.length > 0;

  if (pane.surfaces.length === 0) {
    return (
      <div className="flex-1 relative overflow-hidden flex items-center justify-center text-[var(--text-muted)] text-sm" {...tokenAttrs('textMuted', 'text')}>
        {emptyMessage}
      </div>
    );
  }

  // Only terminals or only browsers — no split needed
  if (!hasBoth) {
    return (
      <div className="flex-1 relative overflow-hidden">
        {pane.surfaces.map((surface) =>
          surface.surfaceType === 'editor' ? (
            <EditorPanel
              key={surface.id}
              filePath={surface.editorFilePath || ''}
              isActive={surface.id === activeSurfaceId}
              surfaceId={surface.id}
            />
          ) : surface.surfaceType === 'browser' ? (
            <BrowserPanel
              key={`${surface.id}:${surface.browserPartition || 'persist:wmux-default'}`}
              surfaceId={surface.id}
              initialUrl={surface.browserUrl || 'https://google.com'}
              partition={surface.browserPartition || 'persist:wmux-default'}
              isActive={surface.id === activeSurfaceId}
              onClose={() => onCloseSurface(surface.id)}
            />
          ) : (
            <TerminalComponent
              key={surface.id}
              ptyId={surface.ptyId || undefined}
              cwd={surface.cwd || undefined}
              isActive={surface.id === activeSurfaceId}
              isWorkspaceVisible={isWorkspaceVisible}
              onPtyCreated={(ptyId) => onPtyCreated(surface.id, ptyId)}
              scrollbackFile={surface.scrollbackFile}
              workspaceId={workspaceId}
              surfaceId={surface.id}
            />
          ),
        )}
      </div>
    );
  }

  // Both terminals and browsers exist — resizable split
  return (
    <div className="flex-1 relative overflow-hidden">
      <Group orientation="horizontal" className="h-full w-full" resizeTargetMinimumSize={{ coarse: 37, fine: 16 }}>
        {/* Terminal panel */}
        <Panel defaultSize={50} minSize={20}>
          <div className="h-full w-full relative overflow-hidden">
            {terminals.map((surface) => (
              <TerminalComponent
                key={surface.id}
                ptyId={surface.ptyId || undefined}
                cwd={surface.cwd || undefined}
                isActive={surface.id === activeSurfaceId}
                isWorkspaceVisible={isWorkspaceVisible}
                onPtyCreated={(ptyId) => onPtyCreated(surface.id, ptyId)}
                scrollbackFile={surface.scrollbackFile}
                workspaceId={workspaceId}
                surfaceId={surface.id}
              />
            ))}
          </div>
        </Panel>

        <Separator className="w-1.5 bg-[var(--bg-surface)] hover:bg-[var(--accent-blue)] transition-colors cursor-col-resize" />

        {/* Browser panel */}
        <Panel defaultSize={50} minSize={20}>
          <div className="h-full w-full relative overflow-hidden">
            {browsers.map((surface) => (
              <BrowserPanel
                key={`${surface.id}:${surface.browserPartition || 'persist:wmux-default'}`}
                surfaceId={surface.id}
                initialUrl={surface.browserUrl || 'https://google.com'}
                partition={surface.browserPartition || 'persist:wmux-default'}
                isActive={surface.id === activeSurfaceId}
                onClose={() => onCloseSurface(surface.id)}
              />
            ))}
          </div>
        </Panel>
      </Group>
    </div>
  );
}

import { useCallback, useEffect, useState, useMemo } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import type { PaneLeaf } from '../../../shared/types';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import TerminalComponent from '../Terminal/Terminal';
import BrowserPanel from '../Browser/BrowserPanel';
import EditorPanel from '../Editor/EditorPanel';
import SurfaceTabs from './SurfaceTabs';
import { ErrorBoundary } from '../ErrorBoundary';

interface PaneProps {
  pane: PaneLeaf;
  isActive: boolean;
  isWorkspaceVisible?: boolean;
}

export default function PaneComponent({ pane, isActive, isWorkspaceVisible = true }: PaneProps) {
  const t = useT();
  const [flashing, setFlashing] = useState(false);
  const setActivePane = useStore((s) => s.setActivePane);
  const setActiveSurface = useStore((s) => s.setActiveSurface);
  const addSurface = useStore((s) => s.addSurface);
  const closeSurface = useStore((s) => s.closeSurface);
  const updateSurfacePtyId = useStore((s) => s.updateSurfacePtyId);
  const markRead = useStore((s) => s.markRead);

  // count만 가져와 불필요한 배열 참조 안정성 문제 방지
  const unreadCount = useStore((s) =>
    s.notifications.filter(
      (n) => !n.read && pane.surfaces.some((surf) => surf.id === n.surfaceId),
    ).length,
  );
  const notificationRingEnabled = useStore((s) => s.notificationRingEnabled);
  const hasUnread = !isActive && unreadCount > 0 && notificationRingEnabled;

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
    for (const n of notifications) {
      if (!n.read && surfaceIds.has(n.surfaceId)) {
        markRead(n.id);
      }
    }
  }, [pane.id, pane.surfaces, setActivePane, markRead]);

  const handleAddSurface = useCallback(() => {
    window.electronAPI.pty.create().then((result: { id: string }) => {
      addSurface(pane.id, result.id, 'Terminal', '');
    });
  }, [pane.id, addSurface]);

  const closePane = useStore((s) => s.closePane);

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
      className={`flex flex-col h-full w-full relative ${
        isActive ? 'ring-1 ring-[rgba(var(--accent-blue-rgb),0.5)]' : ''
      } ${hasUnread ? 'notification-ring' : ''} ${flashing ? 'pane-flash' : ''}`}
      onClick={handleClick}
    >
      <ErrorBoundary name="pane">
      <SurfaceTabs
        surfaces={pane.surfaces}
        activeSurfaceId={pane.activeSurfaceId}
        onSelect={(surfaceId) => setActiveSurface(pane.id, surfaceId)}
        onClose={handleCloseSurface}
        onAdd={handleAddSurface}
      />

      <SplitSurfaceView
        pane={pane}
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
  activeSurfaceId,
  isWorkspaceVisible,
  onCloseSurface,
  onPtyCreated,
  emptyMessage,
}: {
  pane: PaneLeaf;
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
      <div className="flex-1 relative overflow-hidden flex items-center justify-center text-[var(--text-muted)] text-sm">
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
              key={surface.id}
              surfaceId={surface.id}
              initialUrl={surface.browserUrl || 'https://google.com'}
              isActive={surface.id === activeSurfaceId}
              onClose={() => onCloseSurface(surface.id)}
            />
          ) : (
            <TerminalComponent
              key={surface.id}
              ptyId={surface.ptyId || undefined}
              isActive={surface.id === activeSurfaceId}
              isWorkspaceVisible={isWorkspaceVisible}
              onPtyCreated={(ptyId) => onPtyCreated(surface.id, ptyId)}
              scrollbackFile={surface.scrollbackFile}
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
                isActive={surface.id === activeSurfaceId}
                isWorkspaceVisible={isWorkspaceVisible}
                onPtyCreated={(ptyId) => onPtyCreated(surface.id, ptyId)}
                scrollbackFile={surface.scrollbackFile}
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
                key={surface.id}
                surfaceId={surface.id}
                initialUrl={surface.browserUrl || 'https://google.com'}
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

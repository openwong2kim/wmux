import { useCallback, useEffect, useState } from 'react';
import type { PaneLeaf } from '../../../shared/types';
import { useStore } from '../../stores';
import TerminalComponent from '../Terminal/Terminal';
import BrowserPanel from '../Browser/BrowserPanel';
import SurfaceTabs from './SurfaceTabs';

interface PaneProps {
  pane: PaneLeaf;
  isActive: boolean;
}

export default function PaneComponent({ pane, isActive }: PaneProps) {
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
  const hasUnread = !isActive && unreadCount > 0;

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
        isActive ? 'ring-1 ring-[#89b4fa]/50' : ''
      } ${hasUnread ? 'notification-ring' : ''} ${flashing ? 'pane-flash' : ''}`}
      onClick={handleClick}
    >
      <SurfaceTabs
        surfaces={pane.surfaces}
        activeSurfaceId={pane.activeSurfaceId}
        onSelect={(surfaceId) => setActiveSurface(pane.id, surfaceId)}
        onClose={handleCloseSurface}
        onAdd={handleAddSurface}
      />

      <div className="flex-1 relative overflow-hidden">
        {pane.surfaces.map((surface) =>
          surface.surfaceType === 'browser' ? (
            <BrowserPanel
              key={surface.id}
              surfaceId={surface.id}
              initialUrl={surface.browserUrl || 'https://google.com'}
              isActive={surface.id === pane.activeSurfaceId}
              onClose={() => handleCloseSurface(surface.id)}
            />
          ) : (
            <TerminalComponent
              key={surface.id}
              ptyId={surface.ptyId || undefined}
              isActive={surface.id === pane.activeSurfaceId}
              onPtyCreated={(ptyId) => updateSurfacePtyId(pane.id, surface.id, ptyId)}
            />
          )
        )}

        {pane.surfaces.length === 0 && (
          <div className="flex items-center justify-center h-full text-[#585b70] text-sm">
            Empty pane
          </div>
        )}
      </div>
    </div>
  );
}

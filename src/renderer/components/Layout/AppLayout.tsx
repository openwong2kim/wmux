import { useEffect, useState, useRef } from 'react';
import { useStore } from '../../stores';
import Sidebar from '../Sidebar/Sidebar';
import MiniSidebar from '../Sidebar/MiniSidebar';
import PaneContainer from '../Pane/PaneContainer';
import StatusBar from '../StatusBar/StatusBar';
import NotificationPanel from '../Notification/NotificationPanel';
import CommandPalette from '../Palette/CommandPalette';
import SettingsPanel from '../Settings/SettingsPanel';
import ApprovalDialog from '../Company/ApprovalDialog';
import CompanyView from '../Company/CompanyView';
import MessageFeedPanel from '../Company/MessageFeedPanel';
import { useKeyboard } from '../../hooks/useKeyboard';
import { useNotificationListener } from '../../hooks/useNotificationListener';
import { useRpcBridge } from '../../hooks/useRpcBridge';
import type { SessionData, PaneLeaf } from '../../../shared/types';

export default function AppLayout() {
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const companyViewVisible = useStore((s) => s.companyViewVisible);
  const setCompanyViewVisible = useStore((s) => s.setCompanyViewVisible);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const addSurface = useStore((s) => s.addSurface);

  const multiviewIds = useStore((s) => s.multiviewIds);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  useKeyboard();
  useNotificationListener();
  useRpcBridge();

  // ─── File drop — handled in preload where File.path is accessible ──────
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    // File drop via preload onFileDrop (reliable cross-platform)
    const removeDrop = window.electronAPI.onFileDrop((paths) => {
      setIsDragging(false);
      dragCounterRef.current = 0;

      const state = useStore.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (!ws) return;

      const findLeaf = (pane: typeof ws.rootPane): PaneLeaf | null => {
        if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
        for (const child of pane.children) {
          const found = findLeaf(child);
          if (found) return found;
        }
        return null;
      };
      const leaf = findLeaf(ws.rootPane);
      if (!leaf) return;

      const activeSurface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
      if (!activeSurface || activeSurface.surfaceType === 'browser') return;

      const text = paths.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
      window.electronAPI.pty.write(activeSurface.ptyId, text);
    });

    // Visual drag overlay
    const onEnter = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      dragCounterRef.current++;
      if (dragCounterRef.current === 1) setIsDragging(true);
    };
    const onLeave = () => {
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDragging(false);
      }
    };
    document.addEventListener('dragenter', onEnter, true);
    document.addEventListener('dragleave', onLeave, true);
    return () => {
      removeDrop();
      document.removeEventListener('dragenter', onEnter, true);
      document.removeEventListener('dragleave', onLeave, true);
    };
  }, []);

  // 앱 시작 시 세션 복원
  useEffect(() => {
    window.electronAPI.session.load().then((saved: SessionData | null) => {
      if (!saved) return;
      useStore.getState().loadSession(saved);
    });
  }, []);

  // Save session on beforeunload
  useEffect(() => {
    const saveSession = () => {
      const state = useStore.getState();
      // Strip dangerous flags from session persistence
      const companySafe = state.company ? { ...state.company, skipPermissions: undefined } : null;
      const data: SessionData = {
        workspaces: state.workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
        sidebarVisible: state.sidebarVisible,
        sidebarMode: state.sidebarMode,
        company: companySafe,
        memberCosts: state.memberCosts,
        sessionStartTime: state.sessionStartTime,
        // User preferences
        theme: state.theme,
        locale: state.locale,
        terminalFontSize: state.terminalFontSize,
        terminalFontFamily: state.terminalFontFamily,
        defaultShell: state.defaultShell,
        scrollbackLines: state.scrollbackLines,
        sidebarPosition: state.sidebarPosition,
        notificationSoundEnabled: state.notificationSoundEnabled,
        toastEnabled: state.toastEnabled,
        notificationRingEnabled: state.notificationRingEnabled,
        customKeybindings: state.customKeybindings,
      };
      window.electronAPI.session.save(data);
    };

    window.addEventListener('beforeunload', saveSession);
    return () => window.removeEventListener('beforeunload', saveSession);
  }, []);

  // Auto-create initial surface for empty leaf panes
  // 세션 복원된 경우: surfaces가 이미 있으므로 이 effect는 실행되지 않음
  // 브라우저 surface만 있는 pane: surfaceType이 'browser'이면 PTY 생성 스킵
  useEffect(() => {
    if (!activeWorkspace) return;
    const root = activeWorkspace.rootPane;
    if (root.type !== 'leaf') return;

    // surfaces가 비어있을 때만 새 PTY 생성
    if (root.surfaces.length === 0) {
      let cancelled = false;
      const paneId = root.id;
      window.electronAPI.pty.create().then((result: { id: string }) => {
        if (cancelled) {
          window.electronAPI.pty.dispose(result.id);
          return;
        }
        addSurface(paneId, result.id, 'Terminal', '');
      });
      return () => { cancelled = true; };
    }

    // surfaces가 있지만 모두 browser 타입인 경우 PTY 생성 스킵
    const hasTerminalSurface = root.surfaces.some(
      (s) => !s.surfaceType || s.surfaceType === 'terminal'
    );
    if (!hasTerminalSurface) {
      // 브라우저만 있는 pane — PTY 불필요, 아무것도 하지 않음
      return;
    }
  }, [activeWorkspace?.id]);

  if (!activeWorkspace) return null;

  return (
    <div className={`flex h-screen w-screen bg-[var(--bg-base)] overflow-hidden ${sidebarPosition === 'right' ? 'flex-row-reverse' : ''}`}>
      {sidebarVisible ? <Sidebar /> : <MiniSidebar />}
      <div className="flex-1 min-w-0 flex flex-col">
        <StatusBar />
        {/* Render workspaces: single view or multiview grid (Ctrl+click selected) */}
        {multiviewIds.length >= 2 ? (
          <div
            className="flex-1 min-h-0"
            style={{
              display: 'grid',
              gridTemplateColumns: multiviewIds.length === 2 ? '1fr 1fr'
                : multiviewIds.length <= 4 ? '1fr 1fr'
                : 'repeat(3, 1fr)',
              gridAutoRows: '1fr',
              gap: '2px',
              backgroundColor: 'var(--bg-surface)',
            }}
          >
            {workspaces.filter((ws) => multiviewIds.includes(ws.id)).map((ws) => (
              <div
                key={ws.id}
                className="relative flex flex-col min-w-0 min-h-0 overflow-hidden cursor-pointer"
                style={{
                  border: ws.id === activeWorkspaceId
                    ? '2px solid var(--accent-blue)'
                    : '2px solid transparent',
                  backgroundColor: 'var(--bg-base)',
                }}
                onClick={() => setActiveWorkspace(ws.id)}
              >
                {/* Workspace label */}
                <div
                  className="flex items-center gap-1.5 px-2 py-0.5 shrink-0 text-xs"
                  style={{
                    backgroundColor: ws.id === activeWorkspaceId ? 'var(--accent-blue)' : 'var(--bg-mantle)',
                    color: ws.id === activeWorkspaceId ? '#fff' : 'var(--text-sub2)',
                    fontFamily: 'ui-monospace, monospace',
                  }}
                >
                  {ws.name}
                </div>
                <div className="flex-1 min-h-0 relative">
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
                    <PaneContainer pane={ws.rootPane} isWorkspaceVisible={true} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex-1 min-h-0 relative">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: ws.id === activeWorkspaceId ? 'flex' : 'none',
                  flexDirection: 'column',
                }}
              >
                <PaneContainer pane={ws.rootPane} isWorkspaceVisible={ws.id === activeWorkspaceId} />
              </div>
            ))}
          </div>
        )}
      </div>
      <NotificationPanel />
      <MessageFeedPanel />
      <CommandPalette />
      <SettingsPanel />
      <ApprovalDialog />
      {companyViewVisible && (
        <CompanyView onClose={() => setCompanyViewVisible(false)} />
      )}

      {/* Visual drag indicator — pointer-events always 'none' so it never
          blocks clicks, scrolling, or keyboard. Drop handling is done entirely
          via the window-level listeners registered in the useEffect above. */}
      {isDragging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            pointerEvents: 'none',
            backgroundColor: 'rgba(137, 180, 250, 0.08)',
          }}
        />
      )}
    </div>
  );
}

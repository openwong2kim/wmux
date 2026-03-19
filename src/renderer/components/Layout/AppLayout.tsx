import { useEffect } from 'react';
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
import type { SessionData } from '../../../shared/types';

export default function AppLayout() {
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const companyViewVisible = useStore((s) => s.companyViewVisible);
  const setCompanyViewVisible = useStore((s) => s.setCompanyViewVisible);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const addSurface = useStore((s) => s.addSurface);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  useKeyboard();
  useNotificationListener();
  useRpcBridge();

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
    <div className="flex h-screen w-screen bg-[#1e1e2e] overflow-hidden" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
      {sidebarVisible ? <Sidebar /> : <MiniSidebar />}
      <div className="flex-1 min-w-0 flex flex-col">
        <StatusBar />
        {/* Render ALL workspaces but only show the active one.
            This preserves xterm Terminal instances (and their scroll state)
            across workspace switches — same pattern as surface tab switching. */}
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
      </div>
      <NotificationPanel />
      <MessageFeedPanel />
      <CommandPalette />
      <SettingsPanel />
      <ApprovalDialog />
      {companyViewVisible && (
        <CompanyView onClose={() => setCompanyViewVisible(false)} />
      )}
    </div>
  );
}

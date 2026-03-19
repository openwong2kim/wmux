import { useRef } from 'react';
import { useStore } from '../../stores';
import WorkspaceItem from './WorkspaceItem';
import type { Pane } from '../../../shared/types';

// Pane 트리에서 모든 leaf의 PTY를 dispose
function disposeAllPtys(pane: Pane) {
  if (pane.type === 'leaf') {
    for (const s of pane.surfaces) {
      if (s.ptyId) window.electronAPI.pty.dispose(s.ptyId);
    }
  } else {
    for (const child of pane.children) disposeAllPtys(child);
  }
}

export default function Sidebar() {
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const reorderWorkspace = useStore((s) => s.reorderWorkspace);
  const splitPane = useStore((s) => s.splitPane);

  // Ctrl+클릭으로 분할에 추가된 워크스페이스 ID 추적
  const splitWsIds = useRef(new Set<string>());

  const handleCtrlSelect = (wsId: string) => {
    // 이미 분할에 추가된 워크스페이스면 무시 (중복 방지)
    if (wsId === activeWorkspaceId || splitWsIds.current.has(wsId)) return;

    const state = useStore.getState();
    const activeWs = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
    if (!activeWs) return;

    // 분할
    splitPane(activeWs.activePaneId, 'horizontal');
    splitWsIds.current.add(wsId);

    // 분할 후 새 Pane에 터미널 생성
    const newState = useStore.getState();
    const newWs = newState.workspaces.find((w) => w.id === newState.activeWorkspaceId);
    if (!newWs) return;

    window.electronAPI.pty.create().then((result: { id: string }) => {
      useStore.getState().addSurface(newWs.activePaneId, result.id, 'Terminal', '');
    });
  };

  const handleClose = (wsId: string) => {
    // 삭제 전 해당 워크스페이스의 모든 PTY 정리
    const ws = workspaces.find((w) => w.id === wsId);
    if (ws) disposeAllPtys(ws.rootPane);

    // 분할 추적에서도 제거
    splitWsIds.current.delete(wsId);

    removeWorkspace(wsId);
  };

  return (
    <div className="flex flex-col h-full bg-[#181825] border-r border-[#313244]" style={{ width: 240 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#313244]">
        <span className="text-sm font-bold text-[#cdd6f4] tracking-widest font-mono">WMUX</span>
        <button
          className="text-[#6c7086] hover:text-[#a6e3a1] text-lg leading-none transition-colors"
          onClick={() => addWorkspace()}
          title="New workspace (Ctrl+N)"
        >
          +
        </button>
      </div>

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
        {workspaces.map((ws, i) => (
          <WorkspaceItem
            key={ws.id}
            workspace={ws}
            isActive={ws.id === activeWorkspaceId}
            index={i}
            onSelect={() => setActiveWorkspace(ws.id)}
            onCtrlSelect={() => handleCtrlSelect(ws.id)}
            onRename={(name) => renameWorkspace(ws.id, name)}
            onClose={() => handleClose(ws.id)}
            onReorder={reorderWorkspace}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-[#313244] text-[10px] font-mono text-[#585b70]">
        <span>{workspaces.length} workspace{workspaces.length !== 1 ? 's' : ''}</span>
        <button
          className="text-[#585b70] hover:text-[#cdd6f4] transition-colors"
          onClick={() => useStore.getState().toggleSidebar()}
          title="Hide sidebar (Ctrl+B)"
        >
          ◀
        </button>
      </div>
    </div>
  );
}

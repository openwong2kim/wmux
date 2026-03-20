import { useStore } from '../../stores';
import WorkspaceItem from './WorkspaceItem';
import type { Pane } from '../../../shared/types';
import { useT } from '../../hooks/useT';

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
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const reorderWorkspace = useStore((s) => s.reorderWorkspace);
  const toggleMultiviewWorkspace = useStore((s) => s.toggleMultiviewWorkspace);
  const multiviewIds = useStore((s) => s.multiviewIds);
  const toggleFileTree = useStore((s) => s.toggleFileTree);
  const fileTreeVisible = useStore((s) => s.fileTreeVisible);

  const handleCtrlSelect = (wsId: string) => {
    toggleMultiviewWorkspace(wsId);
  };

  const handleClose = (wsId: string) => {
    // 삭제 전 해당 워크스페이스의 모든 PTY 정리
    const ws = workspaces.find((w) => w.id === wsId);
    if (ws) disposeAllPtys(ws.rootPane);

    removeWorkspace(wsId);
  };

  return (
    <div className={`flex flex-col h-full bg-[var(--bg-mantle)] ${sidebarPosition === 'right' ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`} style={{ width: 240 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--bg-surface)]">
        <span className="text-sm font-bold text-[var(--text-main)] tracking-widest font-mono">WMUX</span>
        <div className="flex items-center gap-1.5">
          {/* File tree button hidden - feature unstable
          <button
            className={`text-sm leading-none transition-colors ${fileTreeVisible ? 'text-[var(--accent-blue)]' : 'text-[var(--text-subtle)] hover:text-[var(--accent-green)]'}`}
            onClick={() => toggleFileTree()}
            title={t('sidebar.fileTreeTooltip') || 'Toggle file tree'}
          >
            {'\u{1F4C1}'}
          </button>
          */}
          <button
            className="text-[var(--text-subtle)] hover:text-[var(--accent-green)] text-lg leading-none transition-colors"
            onClick={() => addWorkspace()}
            title={t('sidebar.newWorkspaceTooltip')}
          >
            +
          </button>
        </div>
      </div>

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
        {workspaces.map((ws, i) => (
          <WorkspaceItem
            key={ws.id}
            workspace={ws}
            isActive={ws.id === activeWorkspaceId}
            isMultiview={multiviewIds.includes(ws.id)}
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
      <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--bg-surface)] text-[10px] font-mono text-[var(--text-muted)]">
        <span>{workspaces.length} {t('sidebar.workspaces')}</span>
        <button
          className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
          onClick={() => useStore.getState().toggleSidebar()}
          title={t('sidebar.hideTooltip')}
        >
          ◀
        </button>
      </div>
    </div>
  );
}

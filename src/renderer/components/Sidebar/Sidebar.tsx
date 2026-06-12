import { useState, useCallback } from 'react';
import { useStore } from '../../stores';
import WorkspaceItem from './WorkspaceItem';
import PresetPicker from './PresetPicker';
import type { Pane } from '../../../shared/types';
import { useT } from '../../hooks/useT';
import { buildWorkspaceMarkdown } from '../../utils/sessionInfoMarkdown';
import { tokenAttrs } from '../../themes';
import { collapseDirection } from './sidebarGlyphs';
import { IconPlus, IconChevronDir } from '../icons';
import { FOCUS_RING } from '../focusRing';
import PluginPanels from '../../plugins/PluginPanels';

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
  const duplicateWorkspace = useStore((s) => s.duplicateWorkspace);
  const reorderWorkspace = useStore((s) => s.reorderWorkspace);
  const toggleMultiviewWorkspace = useStore((s) => s.toggleMultiviewWorkspace);
  const multiviewIds = useStore((s) => s.multiviewIds);
  const toggleFileTree = useStore((s) => s.toggleFileTree);
  const fileTreeVisible = useStore((s) => s.fileTreeVisible);
  const company = useStore((s) => s.company);

  const [pickerOpen, setPickerOpen] = useState(false);
  const togglePicker = useCallback(() => setPickerOpen((v) => !v), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  const handleCtrlSelect = (wsId: string) => {
    toggleMultiviewWorkspace(wsId);
  };

  const handleCopySessionInfo = async (wsId: string) => {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;

    await window.clipboardAPI.writeText(buildWorkspaceMarkdown(ws));

    // Toast feedback
    const toast = document.createElement('div');
    toast.textContent = t('workspace.copied');
    toast.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);background:var(--bg-surface);color:var(--text-main);padding:4px 12px;border-radius:4px;font-size:12px;z-index:9999;opacity:0;transition:opacity .2s';
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 200); }, 1500);
  };

  const handleClose = (wsId: string) => {
    // 삭제 전 해당 워크스페이스의 모든 PTY 정리
    const ws = workspaces.find((w) => w.id === wsId);
    if (ws) disposeAllPtys(ws.rootPane);

    removeWorkspace(wsId);
  };

  return (
    <div
      className={`flex flex-col h-full bg-[var(--bg-mantle)] ${sidebarPosition === 'right' ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`}
      style={{ width: 240, borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgMantle', 'bg')} {...tokenAttrs('bgSurface', 'border')}
    >
      {/* Header */}
      <div className="relative flex items-center justify-between px-4 py-3 border-b border-[var(--bg-surface)]" style={{ borderColor: 'var(--border-soft)' }}>
        <span className="text-sm font-bold text-[var(--text-main)] tracking-widest font-mono" {...tokenAttrs('textMain', 'text')}>WMUX</span>
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
            className={`flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-subtle)] hover:text-[var(--accent-green)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
            onClick={togglePicker}
            title={t('sidebar.newWorkspaceTooltip')}
            aria-label={t('sidebar.newWorkspaceTooltip')}
            data-onboarding-target="add-workspace"
            {...tokenAttrs('textSub', 'text')}
            {...tokenAttrs('success', 'accent')}
            data-derived="textSubtle"
          >
            <IconPlus size={13} />
          </button>
        </div>
        {pickerOpen && <PresetPicker onClose={closePicker} />}
      </div>

      {/* Workspace list */}
      {/* The list container absorbs dragover for sidebar-internal reorder
          drags so the gaps between WorkspaceItem rows (and the empty area
          below the last row) don't paint a 🚫 cursor mid-drag. External
          drags hover-through the container untouched. */}
      <div
        className="flex-1 overflow-y-auto py-2 space-y-0.5"
        onDragOver={(e) => {
          if (useStore.getState().draggedWorkspaceIndex !== null) {
            e.preventDefault();
          }
        }}
      >
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
            onCopyInfo={() => handleCopySessionInfo(ws.id)}
            onDuplicate={() => duplicateWorkspace(ws.id)}
            onReorder={reorderWorkspace}
          />
        ))}
      </div>

      {/* Plugin sidebar panels (B-1 ui.sidebar contribution point) */}
      <PluginPanels />

      {/* Footer — when docked right, mirror the row so the collapse arrow sits
          on the inner edge facing the content area (issue #151). */}
      <div className={`flex items-center justify-between px-4 py-2 border-t border-[var(--bg-surface)] text-[10px] font-mono text-[var(--text-muted)] ${sidebarPosition === 'right' ? 'flex-row-reverse' : ''}`} style={{ borderColor: 'var(--border-soft)' }} {...tokenAttrs('textMuted', 'text')}>
        <span>{workspaces.length} {t('sidebar.workspaces')}</span>
        <button
          className={`flex items-center justify-center w-5 h-5 rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
          onClick={() => useStore.getState().toggleSidebar()}
          title={t('sidebar.hideTooltip')}
        >
          <IconChevronDir dir={collapseDirection(sidebarPosition)} />
        </button>
      </div>
    </div>
  );
}

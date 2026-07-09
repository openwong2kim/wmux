import { useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import WorkspaceItem from './WorkspaceItem';
import MissionsSection from './MissionsSection';
import PresetPicker from './PresetPicker';
import type { Pane } from '../../../shared/types';
import { useT } from '../../hooks/useT';
import { buildWorkspaceMarkdown } from '../../utils/sessionInfoMarkdown';
import { tokenAttrs } from '../../themes';
import { collapseDirection } from './sidebarGlyphs';
import { IconPlus, IconChevronDir } from '../icons';
import { FOCUS_RING } from '../focusRing';
import PluginPanels from '../../plugins/PluginPanels';
import CompanyPanel from './CompanyPanel';
import { COMPANY_MODE_ENABLED } from '../../../shared/featureFlags';

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
  // A1: 통트리 구독 해체. Sidebar는 목록 구조(id·name·순서)만 구독하고, 각
  // WorkspaceItem이 자기 ws를 self-subscribe한다. 배경 ws의 metadata/surface
  // churn은 이 컴포넌트를 리렌더하지 않는다(이름/추가/삭제/재정렬 시에만).
  const workspaces = useStore(useShallow(selectWorkspaceIdName));
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
  // sidebarMode toggles the sidebar's central content between the workspace
  // list and the company tree (CompanyPanel). The palette's "Company: …"
  // commands flip this to 'company'; without a consumer here the flip was a
  // no-op (the bug: company commands appeared to do nothing). The header
  // toggle below is the UI entry/exit point.
  const sidebarMode = useStore((s) => s.sidebarMode);
  const setSidebarMode = useStore((s) => s.setSidebarMode);
  const pushToast = useStore((s) => s.pushToast);

  const [pickerOpen, setPickerOpen] = useState(false);
  const togglePicker = useCallback(() => setPickerOpen((v) => !v), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  // A1: 콜백을 useCallback으로 안정화해 memo(WorkspaceItem)가 실효하게 한다.
  // 요약만 구독하므로 개별 ws는 getState()로 명령형 조회한다(구독 다이어트).
  const handleCtrlSelect = useCallback((wsId: string) => {
    toggleMultiviewWorkspace(wsId);
  }, [toggleMultiviewWorkspace]);

  const handleCopySessionInfo = useCallback(async (wsId: string) => {
    const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
    if (!ws) return;

    await window.clipboardAPI.writeText(buildWorkspaceMarkdown(ws));

    // 정본 토스트(toastSlice)로 피드백 — 기존 수동 DOM 토스트는 store 우회였다.
    pushToast({ level: 'info', message: t('workspace.copied') });
  }, [t, pushToast]);

  const handleClose = useCallback((wsId: string) => {
    // 삭제 전 해당 워크스페이스의 모든 PTY 정리
    const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
    if (ws) disposeAllPtys(ws.rootPane);

    removeWorkspace(wsId);
  }, [removeWorkspace]);

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
          {/* Workspaces ⇄ Company toggle. Entry/exit for company mode — the
              palette commands set sidebarMode but there was no UI affordance
              to flip it back (or discover it). */}
          {COMPANY_MODE_ENABLED && (
          <button
            className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors duration-150 hover:bg-[rgba(var(--bg-surface-rgb),0.6)] ${FOCUS_RING} ${
              sidebarMode === 'company'
                ? 'text-[var(--accent-blue)]'
                : 'text-[var(--text-subtle)] hover:text-[var(--accent-blue)]'
            }`}
            onClick={() => setSidebarMode(sidebarMode === 'company' ? 'workspaces' : 'company')}
            title={
              sidebarMode === 'company'
                ? (t('sidebar.showWorkspaces') || 'Show workspaces')
                : (t('sidebar.showCompany') || 'Show company')
            }
            aria-label={
              sidebarMode === 'company'
                ? (t('sidebar.showWorkspaces') || 'Show workspaces')
                : (t('sidebar.showCompany') || 'Show company')
            }
            aria-pressed={sidebarMode === 'company'}
            data-company-toggle
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="5.5" cy="5" r="2" />
              <circle cx="11" cy="6" r="1.5" />
              <path d="M2 13c0-2 1.6-3.3 3.5-3.3S9 11 9 13" />
              <path d="M10 13c0-1.7.8-2.7 2-2.7s2 1 2 2.3" />
            </svg>
          </button>
          )}
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

      {/* Central content: company tree when in company mode, else the
          workspace list. This is the consumer of `sidebarMode` that was
          missing — CompanyPanel was orphaned (never rendered) so the
          palette's company commands had no visible surface. */}
      {COMPANY_MODE_ENABLED && sidebarMode === 'company' ? (
        <CompanyPanel />
      ) : (
      /* The list container absorbs dragover for sidebar-internal reorder
          drags so the gaps between WorkspaceItem rows (and the empty area
          below the last row) don't paint a 🚫 cursor mid-drag. External
          drags hover-through the container untouched. */
      <div
        className="flex-1 overflow-y-auto py-2 space-y-0.5"
        onDragOver={(e) => {
          if (useStore.getState().draggedWorkspaceIndex !== null) {
            e.preventDefault();
          }
        }}
      >
        {/* 사이클 C — fan-out 미션 섹션. 미션이 없으면(일반 워크스페이스) 아무
            것도 렌더하지 않아 공간을 차지하지 않는다(MissionsSection이 null 반환).
            worktree 배지(⊕)와 공존 — 배지는 저수준 사실, 이 섹션은 상위 개념. */}
        <MissionsSection />
        {/* A1/A2: 각 항목에 id + 안정 콜백만 내린다. 콜백은 모두 id 인자를 받는
            스토어 액션/useCallback 핸들러라 렌더마다 새로 만들어지지 않아
            memo(WorkspaceItem)가 실효한다. 항목 내용은 WorkspaceItem이 자기
            ws를 self-subscribe해 반영한다. */}
        {workspaces.map((ws, i) => (
          <WorkspaceItem
            key={ws.id}
            workspaceId={ws.id}
            isActive={ws.id === activeWorkspaceId}
            isMultiview={multiviewIds.includes(ws.id)}
            index={i}
            onSelect={setActiveWorkspace}
            onCtrlSelect={handleCtrlSelect}
            onRename={renameWorkspace}
            onClose={handleClose}
            onCopyInfo={handleCopySessionInfo}
            onDuplicate={duplicateWorkspace}
            onReorder={reorderWorkspace}
          />
        ))}
      </div>
      )}

      {/* Plugin sidebar panels (B-1 ui.sidebar contribution point) */}
      <PluginPanels />

      {/* Channels moved to the right-side ChannelDock (Approach A) — the list
          + conversation now live together opposite the workspace sidebar. */}

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

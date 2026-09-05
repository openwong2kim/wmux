import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import WorkspaceItem from './WorkspaceItem';
import RemoteWorkspaceItem from './RemoteWorkspaceItem';
import MissionsSection from './MissionsSection';
import PresetPicker from './PresetPicker';
import type { Workspace } from '../../../shared/types';
import { getWorkspacePtyIds } from '../../../shared/paneUtils';
import { destroyWorkspaceRemoteSessions } from '../../utils/remoteSessionTeardown';
import { useT } from '../../hooks/useT';
import { buildWorkspaceMarkdown } from '../../utils/sessionInfoMarkdown';
import { tokenAttrs } from '../../themes';
import { collapseDirection } from './sidebarGlyphs';
import { IconPlus, IconChevronDir } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { HIT_TARGET_24 } from '../hitArea';
import PluginPanels from '../../plugins/PluginPanels';
import CompanyPanel from './CompanyPanel';
import { COMPANY_MODE_ENABLED } from '../../../shared/featureFlags';

// 워크스페이스가 소유한 모든 PTY를 dispose
// (traversal is the shared canonical walk; the dispose policy stays local)
//
// Workspace-wide (#977): closing a workspace kills everything it owns, and a
// stashed pane's session is very much owned. Missing it would leave an orphan
// daemon session burning tokens with no window left to show it.
function disposeAllPtys(ws: Workspace) {
  for (const ptyId of getWorkspacePtyIds(ws)) window.electronAPI.pty.dispose(ptyId);
  // #1129 — a remote-terminal surface owns a session on another machine and
  // carries no ptyId, so the walk above is blind to it. Same orphan argument
  // as the stash: nothing else on the host will ever reap it.
  destroyWorkspaceRemoteSessions(ws);
}

export default function Sidebar() {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  // A1: 통트리 구독 해체. Sidebar는 목록 구조(id·name·순서)만 구독하고, 각
  // WorkspaceItem이 자기 ws를 self-subscribe한다. 배경 ws의 metadata/surface
  // churn은 이 컴포넌트를 리렌더하지 않는다(이름/추가/삭제/재정렬 시에만).
  const workspaces = useStore(useShallow(selectWorkspaceIdName));
  const [wsSearch, setWsSearch] = useState('');
  const wsSearchRef = useRef<HTMLInputElement>(null);
  const filteredWorkspaces = useMemo(() => {
    if (!wsSearch.trim()) return workspaces;
    const q = wsSearch.toLowerCase();
    return workspaces.filter((ws) => ws.name.toLowerCase().includes(q));
  }, [workspaces, wsSearch]);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const remoteWorkspaces = useStore((s) => s.remoteWorkspaces);
  const activeRemoteKey = useStore((s) => s.activeRemoteKey);
  const setActiveRemoteKey = useStore((s) => s.setActiveRemoteKey);
  const detachRemoteWorkspace = useStore((s) => s.detachRemoteWorkspace);
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

  // Ctrl+F → focus workspace search, but only while focus is already inside
  // the sidebar. A document-level listener would collide with the global
  // Ctrl+F terminal-search shortcut (useKeyboard), so this is scoped to the
  // sidebar root via onKeyDown and stops propagation so the global handler
  // does not also fire.
  const handleSidebarKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'f' && (e.ctrlKey || e.metaKey) && workspaces.length >= 3) {
      e.preventDefault();
      e.stopPropagation();
      wsSearchRef.current?.focus();
    }
  }, [workspaces.length]);

  // The search input hides below 3 workspaces; clear any leftover query so
  // the list can't stay filtered with no visible way to reset it.
  useEffect(() => {
    if (workspaces.length < 3) setWsSearch('');
  }, [workspaces.length]);

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
    if (ws) disposeAllPtys(ws);

    removeWorkspace(wsId);
  }, [removeWorkspace]);

  return (
    <div
      className={`flex flex-col h-full bg-[var(--bg-mantle)] ${sidebarPosition === 'right' ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`}
      style={{ width: 240, borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgMantle', 'bg')} {...tokenAttrs('bgSurface', 'border')}
      onKeyDown={handleSidebarKeyDown}
    >
      {pickerOpen && <PresetPicker onClose={closePicker} />}

      {/* Workspace search input — only visible when 3+ workspaces */}
      {workspaces.length >= 3 && (
        <div className="px-2 pt-2">
          <input
            ref={wsSearchRef}
            type="text"
            value={wsSearch}
            onChange={(e) => setWsSearch(e.target.value)}
            placeholder={t('sidebar.searchPlaceholder')}
            className="w-full px-2 py-1 text-xs bg-[var(--bg-surface)] text-[var(--text-main)] border border-[var(--bg-surface)] rounded outline-none focus:border-[var(--text-muted)] placeholder:text-[var(--text-muted)]"
          />
        </div>
      )}

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
        {/* 사이클 C — fan-out 미션 섹션. It always renders its collapsible header
            (with a zero count and, when expanded, an empty line) — it does not
            return null. Coexists with the worktree badge (⊕): the badge is the
            low-level fact, this section is the higher-level concept. */}
        <MissionsSection />
        {/* A1/A2: 각 항목에 id + 안정 콜백만 내린다. 콜백은 모두 id 인자를 받는
            스토어 액션/useCallback 핸들러라 렌더마다 새로 만들어지지 않아
            memo(WorkspaceItem)가 실효한다. 항목 내용은 WorkspaceItem이 자기
            ws를 self-subscribe해 반영한다. */}
        {/* index must be the position in the UNFILTERED list — reorder and
            the Ctrl+number labels are defined against it. */}
        {filteredWorkspaces.map((ws) => (
          <WorkspaceItem
            key={ws.id}
            workspaceId={ws.id}
            isActive={ws.id === activeWorkspaceId}
            isMultiview={multiviewIds.includes(ws.id)}
            index={workspaces.indexOf(ws)}
            onSelect={setActiveWorkspace}
            onCtrlSelect={handleCtrlSelect}
            onRename={renameWorkspace}
            onClose={handleClose}
            onCopyInfo={handleCopySessionInfo}
            onDuplicate={duplicateWorkspace}
            onReorder={reorderWorkspace}
          />
        ))}

        {/* Remote section — attached mirrors from other wmux hosts, rendered
            under the local workspace rows. A remote workspace is never part
            of `workspaces[]` (see remoteWorkspacesSlice), so it gets its own
            row type here instead of joining the map above. */}
        {remoteWorkspaces.length > 0 && (
          <div className="pt-2 mt-1 border-t space-y-0.5" style={{ borderColor: 'var(--border-soft)' }}>
            {remoteWorkspaces.map((rw) => (
              <RemoteWorkspaceItem
                key={rw.key}
                workspace={rw}
                isActive={rw.key === activeRemoteKey}
                onSelect={setActiveRemoteKey}
                onDetach={detachRemoteWorkspace}
              />
            ))}
          </div>
        )}
      </div>
      )}

      {/* Plugin sidebar panels (B-1 ui.sidebar contribution point) */}
      <PluginPanels />

      {/* Agent · Git · Channels · web moved onto the deck's own icon strip
          (Deck/DeckTabs.tsx; collapsed, the deck is reopened from the
          titlebar's DeckToggle) — owner decisions 2026-08-14 / 2026-08-18.
          They all command the
          right-hand deck, and as rows here they cost 144px of the workspace
          list and vanished entirely when the sidebar collapsed. */}

      {/* Footer — when docked right, mirror the row so the collapse arrow sits
          on the inner edge facing the content area (issue #151). */}
      <div className={`flex items-center justify-between h-9 shrink-0 px-4 border-t border-[var(--bg-surface)] text-[11px] font-mono text-[var(--text-muted)] ${sidebarPosition === 'right' ? 'flex-row-reverse' : ''}`} style={{ borderColor: 'var(--border-soft)' }} {...tokenAttrs('textMuted', 'text')}>
        <span>{workspaces.length} {t('sidebar.workspaces')}</span>
        <button
          data-sidebar-collapse
          className={`${HIT_TARGET_24} rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
          onClick={() => useStore.getState().toggleSidebar()}
          title={t('sidebar.hideTooltip')}
          aria-label={t('sidebar.hideTooltip')}
        >
          <IconChevronDir dir={collapseDirection(sidebarPosition)} />
        </button>
      </div>
    </div>
  );
}

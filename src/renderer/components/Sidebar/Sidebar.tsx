import { Fragment, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import { useGlanceBoardOrder } from './useGlanceBoardOrder';
import { buildSidebarTree, ORPHAN_GROUP_KEY } from './sidebarTree';
import SidebarTaskGroup from './SidebarTaskGroup';
import SidebarResizeHandle from './SidebarResizeHandle';
import { resolveTaskLink } from '../../utils/fanoutProvenance';
import WorkspaceItem from './WorkspaceItem';
import RemoteWorkspaceItem from './RemoteWorkspaceItem';
import OrphanSessions from './OrphanSessions';
import ArchivedWorkspaces from './ArchivedWorkspaces';
import MissionsSection from './MissionsSection';
import type { Workspace } from '../../../shared/types';
import { getWorkspacePtyIds } from '../../../shared/paneUtils';
import { destroyWorkspaceRemoteSessions } from '../../utils/remoteSessionTeardown';
import { selectAttachedRemoteWorkspaces } from '../../stores/slices/remoteWorkspacesSlice';
import { useT } from '../../hooks/useT';
import { buildWorkspaceMarkdown } from '../../utils/sessionInfoMarkdown';
import { tokenAttrs } from '../../themes';
import { collapseDirection } from './sidebarGlyphs';
import { IconPlus, IconChevronDir, IconGear } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { HIT_TARGET_24 } from '../hitArea';
import PluginPanels from '../../plugins/PluginPanels';
import CompanyPanel from './CompanyPanel';
import SidebarNavigation from './SidebarNavigation';
import PresetPicker from './PresetPicker';
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

  // #1481 — fan-out nesting. Both maps change only when a fan-out lands, a
  // task closes or detaches, or the audit log is re-read — not on output.
  const missionByPaneGroup = useStore((s) => s.missionByPaneGroup);
  const fanoutLineage = useStore((s) => s.fanoutLineage);
  const fanoutSpawnOwner = useStore((s) => s.fanoutSpawnOwner);
  const fanoutSettled = useStore((s) => s.fanoutRefreshSettled);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  // One-time notice when this load moved a Manual list to Attention: sessions
  // saved before the choice was recorded cannot prove Manual was chosen, so
  // they are told once and can take it back.
  const sortMigrated = useStore((s) => s.sidebarSortMigrated);
  useEffect(() => {
    if (!sortMigrated) return;
    const st = useStore.getState();
    st.clearSidebarSortMigrated();
    st.pushToast({
      level: 'info',
      message: t('sidebar.sortMigrated'),
      durationMs: 15_000,
      action: { label: t('sidebar.sortMigratedUndo'), onClick: () => useStore.getState().setSidebarSortMode('manual') },
    });
  }, [sortMigrated, t]);
  // Glance board (2026-09-25): Attention by default, applied only after a
  // settle, or when the pointer / focus leaves the list (useSettledOrder).
  // Nested fan-out tasks lift their owner: the owner scores as its most urgent
  // task (see useGlanceBoardOrder).
  const nestedOwnerOf = useCallback((id: string) => {
    const liveIds = new Set(workspaces.map((w) => w.id));
    const link = resolveTaskLink(missionByPaneGroup[id], fanoutLineage[id], fanoutSpawnOwner[id]);
    if (!link || link.detached) return undefined;
    // A task whose owner is gone renders in the "From closed workspace"
    // group, so it takes no top-level slot either (it lifts no owner).
    if (!link.ownerId || link.ownerId === id || !liveIds.has(link.ownerId)) return ORPHAN_GROUP_KEY;
    return link.ownerId;
  }, [workspaces, missionByPaneGroup, fanoutLineage, fanoutSpawnOwner]);
  const {
    ordered: orderedWorkspaces,
    onPointerEnter: onListPointerEnter,
    onPointerLeave: onListPointerLeave,
    onFocusCapture: onListFocus,
    onBlurCapture: onListBlur,
  } = useGlanceBoardOrder(filteredWorkspaces, nestedOwnerOf);
  const tree = useMemo(() => {
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    return buildSidebarTree(
      orderedWorkspaces,
      (id) => {
        const ws = byId.get(id);
        return ws ? resolveTaskLink(missionByPaneGroup[id], fanoutLineage[id], fanoutSpawnOwner[id]) : null;
      },
      new Set(workspaces.map((w) => w.id)),
    );
  }, [orderedWorkspaces, workspaces, missionByPaneGroup, fanoutLineage, fanoutSpawnOwner]);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  // #1329 — rows that only exist to poll a remote-terminal PANE's host are not
  // attachments and must not render here: the user never asked for a mirror,
  // and a row they cannot detach (nothing persists it) would be a ghost.
  // useShallow, not a bare subscription: those invisible rows are rewritten on
  // every poll round, and this list must not re-render the sidebar for them.
  const remoteWorkspaces = useStore(useShallow(selectAttachedRemoteWorkspaces));
  const activeRemoteKey = useStore((s) => s.activeRemoteKey);
  const setActiveRemoteKey = useStore((s) => s.setActiveRemoteKey);
  const detachRemoteWorkspace = useStore((s) => s.detachRemoteWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const archiveWorkspace = useStore((s) => s.archiveWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const duplicateWorkspace = useStore((s) => s.duplicateWorkspace);
  const reorderWorkspace = useStore((s) => s.reorderWorkspace);
  const toggleMultiviewWorkspace = useStore((s) => s.toggleMultiviewWorkspace);
  const multiviewIds = useStore((s) => s.multiviewIds);
  // sidebarMode toggles the sidebar's central content between the workspace
  // list and the company tree (CompanyPanel). The palette's "Company: …"
  // commands flip this to 'company'; without a consumer here the flip was a
  // no-op (the bug: company commands appeared to do nothing). The palette
  // remains the entry/exit point for company mode.
  const sidebarMode = useStore((s) => s.sidebarMode);
  const settingsPanelVisible = useStore((s) => s.settingsPanelVisible);
  const pushToast = useStore((s) => s.pushToast);

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const [pickerAnchor, setPickerAnchor] = useState({ left: 8, top: 180 });
  const togglePicker = useCallback(() => {
    const rect = pickerButtonRef.current?.getBoundingClientRect();
    if (rect) setPickerAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 216)),
      top: rect.bottom + 4,
    });
    setPickerOpen((v) => !v);
  }, []);
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

  // #1011 — archive: the same teardown as Close (sessions die — quieting the
  // sidebar is the point), but the configuration snapshot survives and lists
  // in the Archived section for one-click restore.
  const handleArchive = useCallback((wsId: string) => {
    const { workspaces: all } = useStore.getState();
    const ws = all.find((w) => w.id === wsId);
    // archiveWorkspace refuses the last workspace; disposing first would kill
    // its sessions and then leave the workspace in place, emptied.
    if (!ws || all.length <= 1) return;
    disposeAllPtys(ws);
    archiveWorkspace(wsId);
  }, [archiveWorkspace]);

  const workspaceById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);
  const renderTask = useCallback((id: string) => (
    <WorkspaceItem
      workspaceId={id}
      isActive={id === activeWorkspaceId}
      isMultiview={multiviewIds.includes(id)}
      index={workspaces.findIndex((w) => w.id === id)}
      onSelect={setActiveWorkspace}
      onCtrlSelect={handleCtrlSelect}
      onRename={renameWorkspace}
      onClose={handleClose}
      onArchive={handleArchive}
      onCopyInfo={handleCopySessionInfo}
      onDuplicate={duplicateWorkspace}
      onReorder={reorderWorkspace}
      taskRow
    />
  ), [activeWorkspaceId, multiviewIds, workspaces, setActiveWorkspace, handleCtrlSelect, renameWorkspace, handleClose, handleArchive, handleCopySessionInfo, duplicateWorkspace, reorderWorkspace]);

  return (
    <div
      className="wmux-sidebar relative flex flex-col h-full shrink-0 bg-[var(--bg-mantle)]"
      style={{ width: sidebarWidth, borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgMantle', 'bg')} {...tokenAttrs('bgSurface', 'border')}
      onKeyDown={handleSidebarKeyDown}
    >
      {pickerOpen && <PresetPicker onClose={closePicker} anchorStyle={pickerAnchor} />}
      <SidebarResizeHandle />
      <SidebarNavigation />
      <div className="wmux-sidebar-section">
        <span className="truncate">{t('sidebar.workspaces')}</span>
        <span className="wmux-sidebar-total">{workspaces.length}</span>
        <button
          ref={pickerButtonRef}
          type="button"
          className={`ui-icon-btn ml-auto h-7 w-7 ${FOCUS_RING}`}
          onClick={togglePicker}
          title={t('sidebar.newWorkspace')}
          aria-label={t('sidebar.newWorkspace')}
          aria-expanded={pickerOpen}
        ><IconPlus size={15} /></button>
      </div>

      {/* Workspace search input — only visible when 3+ workspaces */}
      {workspaces.length >= 3 && (
        <div className="px-3 pb-1">
          <input
            ref={wsSearchRef}
            type="text"
            value={wsSearch}
            onChange={(e) => setWsSearch(e.target.value)}
            placeholder={t('sidebar.searchPlaceholder')}
            aria-label={t('sidebar.searchPlaceholder')}
            className="ui-input h-8 text-[13px]"
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
        className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1"
        onPointerEnter={onListPointerEnter}
        onPointerLeave={onListPointerLeave}
        onFocusCapture={onListFocus}
        onBlurCapture={onListBlur}
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
            the Ctrl+number labels are defined against it. That also settles
            drops on a pinned row: `index` is the row's real position, so a
            reorder onto it lands where the row actually lives, not where the
            needs-you sort happens to be showing it. */}
        {/* #1481 — fan-out tasks nest under the workspace that fanned them
            out (SidebarTaskGroup: rollup, fold, close-finished). Detached
            tasks are ordinary rows; tasks whose owner is gone collect in the
            "From closed workspace" group below. */}
        {tree.top.map((node) => {
          const ws = workspaceById.get(node.id);
          if (!ws) return null;
          // A task whose owner is only hidden by the search filter still
          // renders as a task row (prefix stripped, provenance, no drag).
          if (tree.taskIds.has(node.id)) return <Fragment key={node.id}>{renderTask(node.id)}</Fragment>;
          return (
            <Fragment key={node.id}>
              <WorkspaceItem
                workspaceId={ws.id}
                isActive={ws.id === activeWorkspaceId}
                isMultiview={multiviewIds.includes(ws.id)}
                index={workspaces.indexOf(ws)}
                onSelect={setActiveWorkspace}
                onCtrlSelect={handleCtrlSelect}
                onRename={renameWorkspace}
                onClose={handleClose}
                onArchive={handleArchive}
                onCopyInfo={handleCopySessionInfo}
                onDuplicate={duplicateWorkspace}
                onReorder={reorderWorkspace}
              />
              {node.taskIds.length > 0 && (
                <SidebarTaskGroup
                  groupKey={node.id}
                  taskIds={node.taskIds}
                  ownerName={ws.name}
                  ownerActive={node.id === activeWorkspaceId}
                  renderTask={renderTask}
                  onCloseWorkspace={handleClose}
                />
              )}
            </Fragment>
          );
        })}
        {/* Until the first lineage + ledger refresh lands, a task whose owner
            is not yet known to be gone is not called orphaned: it waits as a
            plain task row instead of flashing into the group. */}
        {!fanoutSettled && tree.orphanTaskIds.map((id) => <Fragment key={id}>{renderTask(id)}</Fragment>)}
        {fanoutSettled && tree.orphanTaskIds.length > 0 && (
          <SidebarTaskGroup
            groupKey={ORPHAN_GROUP_KEY}
            taskIds={tree.orphanTaskIds}
            // Open by default: these are the tasks nobody is watching.
            ownerActive
            label={t('sidebar.tasks.orphanGroup')}
            ownerName={t('sidebar.tasks.orphanGroup')}
            renderTask={renderTask}
            onCloseWorkspace={handleClose}
          />
        )}

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

        {/* #1011 — put-away workspaces: configuration snapshots, one click
            back to live. Collapsed by default; empty → invisible. */}
        <ArchivedWorkspaces />

        {/* #1101 — daemon sessions that outlived their pane: still running,
            owned by nothing. Click a row to bring one back, ✕ to kill it.
            Renders nothing when the list is empty. */}
        <OrphanSessions />
      </div>
      )}

      {/* Plugin sidebar panels (B-1 ui.sidebar contribution point) */}
      <PluginPanels />

      {/* Footer — when docked right, mirror the row so the collapse arrow sits
          on the inner edge facing the content area (issue #151). */}
      <div className={`wmux-sidebar-footer flex items-center shrink-0 gap-1 ${sidebarPosition === 'right' ? 'flex-row-reverse' : ''}`} {...tokenAttrs('textMuted', 'text')}>
        <button
          type="button"
          className={`wmux-nav-button flex-1 ${FOCUS_RING}`}
          aria-label={t('settings.title')}
          data-onboarding-target="settings-button"
          aria-pressed={settingsPanelVisible}
          onClick={() => useStore.getState().toggleSettingsPanel()}
        >
          <IconGear size={16} />
          <span>{t('settings.title')}</span>
        </button>
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

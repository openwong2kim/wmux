// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/shell/Sidebar.tsx), MIT License, Copyright (c) 2026 Nick
import { Fragment, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import { useGlanceBoardOrder } from './useGlanceBoardOrder';
import { buildSidebarTree, ORPHAN_GROUP_KEY, type SidebarTreeNode } from './sidebarTree';
import { partitionWorkspaceSettle, workspaceSettleGroupOf } from './workspaceSettleGroups';
import WorkspaceSettleGroup from './WorkspaceSettleGroup';
import SidebarTaskGroup, { ClosedPaneTaskGroup } from './SidebarTaskGroup';
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
import { selectAttachedRemoteWorkspaces, remoteWorkspaceDisplayName, type AttachedRemoteWorkspace } from '../../stores/slices/remoteWorkspacesSlice';
import { remoteWorkspaceAttentionScore } from '../../stores/selectors/fleet';
import { useT } from '../../hooks/useT';
import { buildWorkspaceMarkdown } from '../../utils/sessionInfoMarkdown';
import { tokenAttrs } from '../../themes';
import { collapseDirection } from './sidebarGlyphs';
import { nextRowIndex } from './sidebarRowKeys';
import SidebarSortMenu from './SidebarSortMenu';
import { IconPlus, IconChevronDir, IconGear } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { HIT_TARGET_24 } from '../hitArea';
import PluginPanels from '../../plugins/PluginPanels';
import CompanyPanel from './CompanyPanel';
import SidebarNavigation from './SidebarNavigation';
import WorkspaceFilterPopover, { filterChipKey } from './WorkspaceFilterPopover';
import {
  EMPTY_FILTER, factsFromKey, filterChips, isFilterActive, matchesFilter, selectWorkspaceFactKeys, toggleFacet,
} from './workspaceFilter';

import PresetPicker from './PresetPicker';
import { COMPANY_MODE_ENABLED } from '../../../shared/featureFlags';
import { workspaceShortcutNumber } from '../../../shared/keymap';
import { listedWorkspaces, moaHqId as selectMoaHqId, refuseWorkspaceClose } from '../Moa/moaHqGuard';

/** Namespaces a remote row's id in the shared glance order. */
const REMOTE_ROW_PREFIX = 'remote:';


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

/** No facts are read while no facet is on. */
const NO_FACTS: Record<string, string> = {};

/**
 * `chrome="sheet"` (desktop): the sidebar inside the floating sheet. Its
 * global shortcuts and footer (Settings, collapse) live on the icon rail
 * (MiniSidebar `rail`), so the Workspaces header, search and list take the
 * full height. The default keeps them (the web mirror).
 */
export default function Sidebar({ chrome = 'full' }: { chrome?: 'full' | 'sheet' } = {}) {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  // A1: 통트리 구독 해체. Sidebar는 목록 구조(id·name·순서)만 구독하고, 각
  // WorkspaceItem이 자기 ws를 self-subscribe한다. 배경 ws의 metadata/surface
  // churn은 이 컴포넌트를 리렌더하지 않는다(이름/추가/삭제/재정렬 시에만).
  const workspaces = useStore(useShallow(selectWorkspaceIdName));
  // Moa's HQ is app-owned and never part of the list (nor its count, filter,
  // or Ctrl+N numbering). While it is the active workspace it shows as its
  // own row above the list, so the operator sees where they are.
  const moaHqId = useStore(selectMoaHqId);
  const listed = useMemo(() => listedWorkspaces(workspaces, moaHqId), [workspaces, moaHqId]);
  const [wsSearch, setWsSearch] = useState('');
  const wsSearchRef = useRef<HTMLInputElement>(null);
  // The header's filter button (or Ctrl/Cmd+F) opens the filter popover: the
  // text search on top, facet checks below. Facets live in the store for the
  // session; the list only changes what it shows.
  const [wsSearchOpen, setWsSearchOpen] = useState(false);
  const openWsSearch = useCallback(() => {
    setWsSearchOpen(true);
    requestAnimationFrame(() => wsSearchRef.current?.focus());
  }, []);
  const closeWsSearch = useCallback(() => {
    setWsSearchOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-sidebar-search-toggle]')?.focus());
  }, []);
  const wsFilter = useStore((s) => s.sidebarFilter);
  const filterOn = isFilterActive(wsFilter);
  // Facts are read only while a facet is on, so an unfiltered sidebar does
  // not re-render for status or git changes.
  const factKeys = useStore(useShallow((s) => (filterOn ? selectWorkspaceFactKeys(s) : NO_FACTS)));
  const filteredWorkspaces = useMemo(() => {
    const q = wsSearch.trim().toLowerCase();
    return listed.filter((ws) => (!q || ws.name.toLowerCase().includes(q))
      && (!filterOn || (factKeys[ws.id] !== undefined && matchesFilter(wsFilter, factsFromKey(factKeys[ws.id])))));
  }, [listed, wsSearch, filterOn, wsFilter, factKeys]);

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
  // Snoozed and settled rows leave the main list for the two groups at its
  // foot BEFORE the glance-board order, so they take no slot there. Pinned
  // wins; a nested task goes where its owner goes (workspaceSettleGroups).
  const settleStates = useStore((s) => s.workspaceSettle.states);
  const pinnedIds = useStore((s) => s.sidebarPinnedIds);
  const settleSplit = useMemo(() => {
    const now = Date.now();
    return partitionWorkspaceSettle(filteredWorkspaces, {
      groupOf: (id) => workspaceSettleGroupOf(settleStates[id], now),
      pinned: new Set(pinnedIds),
      nestedOwnerOf,
    });
  }, [filteredWorkspaces, settleStates, pinnedIds, nestedOwnerOf]);
  // #1329 — rows that only exist to poll a remote-terminal PANE's host are not
  // attachments and must not render here: the user never asked for a mirror,
  // and a row they cannot detach (nothing persists it) would be a ghost.
  // useShallow, not a bare subscription: those invisible rows are rewritten on
  // every poll round, and this list must not re-render the sidebar for them.
  const remoteWorkspaces = useStore(useShallow(selectAttachedRemoteWorkspaces));
  // Attached mirrors share the one glance list (they are never part of
  // `workspaces[]` — see remoteWorkspacesSlice — so they keep their own row
  // type). Row ids are namespaced so they cannot collide with a local id.
  const remoteByRowId = useMemo(() => {
    // Same query rule as the local rows above; a remote row also matches on
    // its host, which it shows under its name.
    const q = wsSearch.trim() ? wsSearch.toLowerCase() : '';
    const fallbackHost = t('remote.hostFallback');
    const byRowId = new Map<string, AttachedRemoteWorkspace>();
    // Facets describe local workspaces; a remote mirror is hidden while any is on.
    if (filterOn) return byRowId;
    for (const rw of remoteWorkspaces) {
      const name = remoteWorkspaceDisplayName(rw);
      const host = rw.hostLabel || fallbackHost;
      if (q && !name.toLowerCase().includes(q) && !host.toLowerCase().includes(q)) continue;
      byRowId.set(`${REMOTE_ROW_PREFIX}${rw.key}`, rw);
    }
    return byRowId;
  }, [remoteWorkspaces, wsSearch, filterOn, t]);
  const remoteRows = useMemo(
    () => [...remoteByRowId].map(([id, rw]) => ({ id, name: remoteWorkspaceDisplayName(rw) })),
    [remoteByRowId],
  );
  const remoteScores = useMemo(
    () => Object.fromEntries([...remoteByRowId].map(([id, rw]) => [id, remoteWorkspaceAttentionScore(rw)])),
    [remoteByRowId],
  );
  const {
    ordered: orderedWorkspaces,
    onPointerEnter: onListPointerEnter,
    onPointerLeave: onListPointerLeave,
    onFocusCapture: onListFocus,
    onBlurCapture: onListBlur,
  } = useGlanceBoardOrder(settleSplit.main, nestedOwnerOf, remoteRows, remoteScores);
  // Remote row ids are no workspace: linkOf finds none, so each one is a plain
  // top-level node in its sorted slot.
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
  // The groups keep the stored order and nest the same way, so a grouped
  // owner keeps its task group.
  const settleTrees = useMemo(() => {
    const liveIds = new Set(workspaces.map((w) => w.id));
    const linkOf = (id: string) => resolveTaskLink(missionByPaneGroup[id], fanoutLineage[id], fanoutSpawnOwner[id]);
    return {
      snoozed: buildSidebarTree(settleSplit.snoozed, linkOf, liveIds),
      settled: buildSidebarTree(settleSplit.settled, linkOf, liveIds),
    };
  }, [settleSplit, workspaces, missionByPaneGroup, fanoutLineage, fanoutSpawnOwner]);
  const activeRemoteKey = useStore((s) => s.activeRemoteKey);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  // While a mirror is on screen the local selection is only remembered, not
  // shown: with remote rows in the same list, marking both would show two
  // selected rows. Task-group folding still follows the real selection.
  const shownActiveId = activeRemoteKey ? null : activeWorkspaceId;
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
  // Browser mirror (wmux web /app): creation, restore, kill and the
  // desktop-only destinations are not offered.
  const readOnly = useStore((s) => s.readOnly);

  // Ctrl+F → focus workspace search, but only while focus is already inside
  // the sidebar. A document-level listener would collide with the global
  // Ctrl+F terminal-search shortcut (useKeyboard), so this is scoped to the
  // sidebar root via onKeyDown and stops propagation so the global handler
  // does not also fire.
  // Remote rows share the list and the query, so they count toward showing it.
  const listedCount = listed.length + remoteWorkspaces.length;
  const handleSidebarKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'f' && (e.ctrlKey || e.metaKey) && listedCount >= 3) {
      e.preventDefault();
      e.stopPropagation();
      openWsSearch();
    }
  }, [listedCount, openWsSearch]);

  // The search input hides below 3 workspaces; clear any leftover query so
  // the list can't stay filtered with no visible way to reset it.
  useEffect(() => {
    if (listedCount < 3) {
      setWsSearch('');
      setWsSearchOpen(false);
      if (isFilterActive(useStore.getState().sidebarFilter)) useStore.getState().setSidebarFilter(EMPTY_FILTER);
    }
  }, [listedCount]);

  // A1: 콜백을 useCallback으로 안정화해 memo(WorkspaceItem)가 실효하게 한다.
  // 요약만 구독하므로 개별 ws는 getState()로 명령형 조회한다(구독 다이어트).
  const handleCtrlSelect = useCallback((wsId: string) => {
    toggleMultiviewWorkspace(wsId);
  }, [toggleMultiviewWorkspace]);

  const handleCopySessionInfo = useCallback(async (wsId: string) => {
    const state = useStore.getState();
    const ws = state.workspaces.find((w) => w.id === wsId);
    if (!ws) return;

    await window.clipboardAPI.writeText(buildWorkspaceMarkdown(ws, state.surfaceAgent, state));

    // 정본 토스트(toastSlice)로 피드백 — 기존 수동 DOM 토스트는 store 우회였다.
    pushToast({ level: 'info', message: t('workspace.copied') });
  }, [t, pushToast]);

  const handleClose = useCallback((wsId: string) => {
    // Refused before any session is torn down: the store keeps the HQ and the
    // operator's last workspace, and would refuse only after the dispose.
    if (refuseWorkspaceClose(wsId)) return;
    // 삭제 전 해당 워크스페이스의 모든 PTY 정리
    const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
    if (ws) disposeAllPtys(ws);

    removeWorkspace(wsId);
  }, [removeWorkspace]);

  // #1011 — archive: the same teardown as Close (sessions die — quieting the
  // sidebar is the point), but the configuration snapshot survives and lists
  // in the Archived section for one-click restore.
  const handleArchive = useCallback((wsId: string) => {
    // archiveWorkspace refuses the HQ and the last workspace; disposing first
    // would kill its sessions and then leave the workspace in place, emptied.
    if (refuseWorkspaceClose(wsId)) return;
    const ws = useStore.getState().workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    disposeAllPtys(ws);
    archiveWorkspace(wsId);
  }, [archiveWorkspace]);

  const workspaceById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);
  // Filtering only changes what the list shows; the header counts what is left.
  const narrowed = filterOn || wsSearch.trim() !== '';
  const shownCount = filteredWorkspaces.length + remoteByRowId.size;
  const hqActive = !!moaHqId && !activeRemoteKey && activeWorkspaceId === moaHqId
    && workspaces.some((w) => w.id === moaHqId);
  const activeHidden = !activeRemoteKey && !hqActive && !filteredWorkspaces.some((w) => w.id === activeWorkspaceId);
  const clearFilters = useCallback(() => {
    setWsSearch('');
    useStore.getState().setSidebarFilter(EMPTY_FILTER);
  }, []);
  // Keyboard (roving tabindex, the rail's arrow-key pattern): the list is one
  // Tab stop — the row the keyboard was last on while inside, else the
  // selected row, else the first — and ↑ ↓ Home End move between rows in
  // screen order, nested task and remote rows included. Each row handles its
  // own Enter, → / ← and Shift+F10 (WorkspaceItem.tsx).
  const [keyRowId, setKeyRowId] = useState<string | null>(null);
  const activeRowId = activeRemoteKey ? `${REMOTE_ROW_PREFIX}${activeRemoteKey}` : activeWorkspaceId;
  const firstRowId = tree.top[0]?.id ?? null;
  const tabStopId = keyRowId
    ?? (activeRowId && (filteredWorkspaces.some((w) => w.id === activeRowId) || remoteByRowId.has(activeRowId)) ? activeRowId : firstRowId);
  const onTreeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.hasAttribute('data-sidebar-row')) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-sidebar-row]')]
      .filter((el) => el.getClientRects().length > 0);
    const next = nextRowIndex(e.key, rows.indexOf(target), rows.length);
    if (next === null) return;
    e.preventDefault();
    rows[next].focus();
    rows[next].scrollIntoView?.({ block: 'nearest' });
  }, []);
  const onTreeFocus = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const id = (e.target as HTMLElement).getAttribute('data-sidebar-row');
    if (id) setKeyRowId(id);
  }, []);
  const onTreeBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    // Leaving the list hands the stop back to the selected row.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyRowId(null);
  }, []);
  // The stop must always sit on a row that is on screen. A row can leave
  // without a blur — closed, filtered, snoozed, or folded away with its group
  // while focus was elsewhere — and rows mount and unmount inside their own
  // components without re-rendering this one, so the tree is watched: when no
  // visible row holds the stop, it moves to the selected row, else the first.
  const [treeEl, setTreeEl] = useState<HTMLDivElement | null>(null);
  const activeRowIdRef = useRef(activeRowId);
  activeRowIdRef.current = activeRowId;
  useEffect(() => {
    const el = treeEl;
    if (!el) return;
    const ensureStop = () => {
      const rows = [...el.querySelectorAll<HTMLElement>('[data-sidebar-row]')].filter((r) => r.getClientRects().length > 0);
      if (rows.length === 0 || rows.some((r) => r.tabIndex === 0)) return;
      const next = rows.find((r) => r.getAttribute('data-sidebar-row') === activeRowIdRef.current) ?? rows[0];
      setKeyRowId(next.getAttribute('data-sidebar-row'));
    };
    ensureStop();
    const observer = new MutationObserver(ensureStop);
    observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['tabindex'] });
    return () => observer.disconnect();
  }, [treeEl]);

  const renderTask = useCallback((id: string) => (
    <WorkspaceItem
      workspaceId={id}
      isActive={id === shownActiveId}
      isMultiview={multiviewIds.includes(id)}
      index={workspaces.findIndex((w) => w.id === id)}
      shortcutNumber={workspaceShortcutNumber(listed.findIndex((w) => w.id === id), listed.length)}
      onSelect={setActiveWorkspace}
      onCtrlSelect={handleCtrlSelect}
      onRename={renameWorkspace}
      onClose={handleClose}
      onArchive={handleArchive}
      onCopyInfo={handleCopySessionInfo}
      onDuplicate={duplicateWorkspace}
      onReorder={reorderWorkspace}
      taskRow
      tabStop={id === tabStopId}
    />
  ), [tabStopId, shownActiveId, multiviewIds, workspaces, listed, setActiveWorkspace, handleCtrlSelect, renameWorkspace, handleClose, handleArchive, handleCopySessionInfo, duplicateWorkspace, reorderWorkspace]);

  // One top-level node: a remote mirror, a task row whose owner is filtered
  // out, or a workspace row with its nested tasks. `inSettleGroup` rows sit
  // out of stored order, so they draw no Ctrl+N hint.
  const renderNode = (node: SidebarTreeNode, taskIds: ReadonlySet<string>, inSettleGroup = false) => {
    const rw = remoteByRowId.get(node.id);
    if (rw) {
      return (
        <RemoteWorkspaceItem
          key={node.id}
          rowId={node.id}
          tabStop={node.id === tabStopId}
          workspace={rw}
          isActive={rw.key === activeRemoteKey}
          onSelect={setActiveRemoteKey}
          onDetach={detachRemoteWorkspace}
        />
      );
    }
    const ws = workspaceById.get(node.id);
    if (!ws) return null;
    // A task whose owner is only hidden by the search filter still
    // renders as a task row (prefix stripped, provenance, no drag).
    if (taskIds.has(node.id)) return <Fragment key={node.id}>{renderTask(node.id)}</Fragment>;
    return (
      <Fragment key={node.id}>
        <WorkspaceItem
          workspaceId={ws.id}
          isActive={ws.id === shownActiveId}
          isMultiview={multiviewIds.includes(ws.id)}
          index={workspaces.indexOf(ws)}
          shortcutNumber={workspaceShortcutNumber(listed.indexOf(ws), listed.length)}
          onSelect={setActiveWorkspace}
          onCtrlSelect={handleCtrlSelect}
          onRename={renameWorkspace}
          onClose={handleClose}
          onArchive={handleArchive}
          onCopyInfo={handleCopySessionInfo}
          onDuplicate={duplicateWorkspace}
          onReorder={reorderWorkspace}
          shortcutHintHidden={inSettleGroup}
          tabStop={ws.id === tabStopId}
          nestedTaskIds={node.taskIds.length > 0 ? node.taskIds : undefined}
          renderTask={node.taskIds.length > 0 ? renderTask : undefined}
          onCloseTask={node.taskIds.length > 0 ? handleClose : undefined}
        />
        {node.taskIds.length > 0 && (
          <ClosedPaneTaskGroup
            ownerId={node.id}
            ownerName={ws.name}
            taskIds={node.taskIds}
            ownerActive={node.id === activeWorkspaceId}
            renderTask={renderTask}
            onCloseWorkspace={handleClose}
          />
        )}
      </Fragment>
    );
  };

  return (
    <div
      className="wmux-sidebar relative flex flex-col h-full shrink-0 bg-[var(--bg-mantle)]"
      style={{ width: sidebarWidth, borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgMantle', 'bg')} {...tokenAttrs('bgSurface', 'border')}
      onKeyDown={handleSidebarKeyDown}
    >
      {pickerOpen && <PresetPicker onClose={closePicker} anchorStyle={pickerAnchor} />}
      <SidebarResizeHandle />
      {!readOnly && chrome === 'full' && <SidebarNavigation />}
      {hqActive && moaHqId && (
        <div className="shrink-0 pt-1" data-moa-hq-row>
          <WorkspaceItem
            workspaceId={moaHqId}
            isActive
            isMultiview={multiviewIds.includes(moaHqId)}
            index={workspaces.findIndex((w) => w.id === moaHqId)}
            onSelect={setActiveWorkspace}
            onCtrlSelect={handleCtrlSelect}
            onRename={renameWorkspace}
            onClose={handleClose}
            onArchive={handleArchive}
            onCopyInfo={handleCopySessionInfo}
            onDuplicate={duplicateWorkspace}
            onReorder={reorderWorkspace}
            moaHq
          />
        </div>
      )}
      <div className="wmux-sidebar-section">
        <span className="truncate">{t('sidebar.workspaces')}</span>
        <span className="wmux-sidebar-total" data-sidebar-total>
          {narrowed ? t('sidebar.filter.count', { shown: shownCount, total: listedCount }) : listedCount}
        </span>
        {/* The order is a visible choice here, not only in Settings. */}
        {listedCount >= 2 && <span className="ml-auto flex">
          <SidebarSortMenu />
        </span>}
        {listedCount >= 3 && <button
          type="button"
          className={`ui-icon-btn relative h-7 w-7 ${FOCUS_RING}`}
          onClick={() => (wsSearchOpen ? closeWsSearch() : openWsSearch())}
          data-filter-active={narrowed ? 'true' : undefined}
          // A filter for this list — distinct from the rail's Search &
          // commands, which opens the command palette.
          title={t('sidebar.filterWorkspaces')}
          aria-label={t('sidebar.filterWorkspaces')}
          aria-expanded={wsSearchOpen}
          aria-haspopup="dialog"
          data-sidebar-search-toggle
        ><svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 3h10L8.2 7.6V11L5.8 12V7.6Z" /></svg>
          {narrowed && <span className="wmux-ws-filter-dot" aria-hidden="true" />}</button>}
        {!readOnly && <button
          ref={pickerButtonRef}
          type="button"
          className={`ui-icon-btn ${listedCount >= 2 ? '' : 'ml-auto '}h-7 w-7 ${FOCUS_RING}`}
          onClick={togglePicker}
          title={t('sidebar.newWorkspace')}
          aria-label={t('sidebar.newWorkspace')}
          aria-expanded={pickerOpen}
        ><IconPlus size={15} /></button>}
      </div>

      {listedCount >= 3 && wsSearchOpen && (
        <WorkspaceFilterPopover
          query={wsSearch}
          onQuery={setWsSearch}
          filter={wsFilter}
          onToggle={(chip) => useStore.getState().setSidebarFilter(toggleFacet(useStore.getState().sidebarFilter, chip))}
          onClose={closeWsSearch}
          searchRef={wsSearchRef}
        />
      )}
      {/* The checks in force, one removable chip each. */}
      {narrowed && (
        <div className="wmux-ws-filter-chips" data-ws-filter-chips>
          {wsSearch.trim() && (
            <span className="wmux-ws-filter-chip">
              “{wsSearch.trim()}”
              <button type="button" aria-label={t('sidebar.filter.remove', { name: wsSearch.trim() })} onClick={() => setWsSearch('')}>×</button>
            </span>
          )}
          {filterChips(wsFilter).map((chip) => (
            <span key={filterChipKey(chip)} className="wmux-ws-filter-chip" data-ws-filter-chip={filterChipKey(chip)}>
              {t(filterChipKey(chip))}
              <button type="button" aria-label={t('sidebar.filter.remove', { name: t(filterChipKey(chip)) })}
                onClick={() => useStore.getState().setSidebarFilter(toggleFacet(useStore.getState().sidebarFilter, chip))}>×</button>
            </span>
          ))}
          <button type="button" className="wmux-ws-filter-clear" onClick={clearFilters} data-ws-filter-clear>{t('sidebar.filter.clear')}</button>
        </div>
      )}
      {narrowed && activeHidden && (
        <p className="wmux-ws-filter-note" role="status" data-ws-filter-hidden-active>{t('sidebar.filter.activeHidden')}</p>
      )}
      {narrowed && shownCount === 0 && (
        <div className="wmux-ws-filter-empty" data-ws-filter-empty>
          <p>{t('sidebar.filter.noMatch')}</p>
          <button type="button" className="wmux-ws-filter-clear" onClick={clearFilters}>{t('sidebar.filter.clearAll')}</button>
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
          drags hover-through the container untouched.
          `overflow-y-auto` alone computes overflow-x to auto: a row a few px
          too wide made the whole list swipe sideways, cutting the status marks
          at the left edge. The list never scrolls horizontally. */
      <div
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-0 pb-2 space-y-0.5"
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
            the Ctrl+number labels are defined against it. The pinned group
            leads that list and is shown as stored, so inside it the row's
            real position and its place on screen agree. */}
        {/* #1481 — fan-out tasks nest under the workspace that fanned them
            out; since 2026-09-27 under the roster row of the pane that
            requested them (PaneTaskGroup: rollup, fold, close-finished), with
            the rest in the owner's trailing "From closed pane" group.
            Detached tasks are ordinary rows; tasks whose owner is gone
            collect in the "From closed workspace" group below. */}
        <div
          ref={setTreeEl}
          role="tree"
          aria-label={t('sidebar.workspaces')}
          className="space-y-0.5"
          onKeyDown={onTreeKeyDown}
          onFocus={onTreeFocus}
          onBlur={onTreeBlur}
          data-sidebar-tree
        >
        {tree.top.map((node) => renderNode(node, tree.taskIds))}
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

        {/* Snoozed, then settled: rows main took out of the main list. Still
            live — nothing is closed; any activity brings a row back. */}
        {(['snoozed', 'settled'] as const).map((kind) => (
          <WorkspaceSettleGroup
            key={kind}
            kind={kind}
            count={settleTrees[kind].top.length}
            containsActive={!!activeWorkspaceId && settleSplit[kind].some((w) => w.id === activeWorkspaceId)}
          >
            {settleTrees[kind].top.map((node) => renderNode(node, settleTrees[kind].taskIds, true))}
          </WorkspaceSettleGroup>
        ))}
        </div>

        {/* #1011 — put-away workspaces: configuration snapshots, one click
            back to live. Collapsed by default; empty → invisible. */}
        {!readOnly && <ArchivedWorkspaces />}

        {/* #1101 — daemon sessions that outlived their pane: still running,
            owned by nothing. Click a row to bring one back, ✕ to kill it.
            Renders nothing when the list is empty. */}
        {!readOnly && <OrphanSessions />}
      </div>
      )}

      {/* Plugin sidebar panels (B-1 ui.sidebar contribution point) */}
      {!readOnly && <PluginPanels />}

      {/* Footer — when docked right, mirror the row so the collapse arrow sits
          on the inner edge facing the content area (issue #151). */}
      {chrome === 'full' && <div className={`wmux-sidebar-footer flex items-center shrink-0 gap-1 ${sidebarPosition === 'right' ? 'flex-row-reverse' : ''}`} {...tokenAttrs('textMuted', 'text')}>
        {readOnly ? <span className="flex-1" /> : <button
          type="button"
          className={`wmux-nav-button flex-1 ${FOCUS_RING}`}
          aria-label={t('settings.title')}
          data-onboarding-target="settings-button"
          aria-pressed={settingsPanelVisible}
          onClick={() => useStore.getState().toggleSettingsPanel()}
        >
          <IconGear size={16} />
          <span>{t('settings.title')}</span>
        </button>}
        <button
          data-sidebar-collapse
          className={`${HIT_TARGET_24} rounded-md text-[color-mix(in_srgb,var(--text-main)_50%,transparent)] hover:text-[var(--text-main)] hover:bg-[var(--hover-fill)] transition-colors duration-150 ${FOCUS_RING}`}
          onClick={() => useStore.getState().toggleSidebar()}
          title={t('sidebar.hideTooltip')}
          aria-label={t('sidebar.hideTooltip')}
        >
          <IconChevronDir dir={collapseDirection(sidebarPosition)} />
        </button>
      </div>}
    </div>
  );
}

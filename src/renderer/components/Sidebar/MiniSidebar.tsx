// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/shell/Sidebar.tsx), MIT License, Copyright (c) 2026 Nick
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceRailSummary } from '../../stores/selectors/workspaceProjections';
import { formatStaleMinutes, selectAllWorkspaceAgentStatus, selectAllWorkspaceUnverifiableMinutes, selectWorkspaceAttentionClasses } from '../../stores/selectors/fleet';
import { StatusMarkView } from './AgentMarks';
import { useT } from '../../hooks/useT';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import { useGlanceBoardOrder } from './useGlanceBoardOrder';
import { partitionWorkspaceSettle, workspaceSettleGroupOf } from './workspaceSettleGroups';
import { resolveTaskLink } from '../../utils/fanoutProvenance';
import { tokenAttrs } from '../../themes';
import { expandDirection } from './sidebarGlyphs';
import { IconPlus, IconChevronDir, IconGear } from '../icons';
import { FOCUS_RING } from '../focusRing';
import SidebarNavigation from './SidebarNavigation';
import { workspaceColorHex } from '../../../shared/workspaceColors';
import PresetPicker from './PresetPicker';
import RailMoreMenu from './RailMoreMenu';
import { PcSwitcherRailItem } from './PcSwitcher';
import { HostRailAvatars } from './HostWorkspaceList';
import { LOCAL_PC_ID } from '../../../shared/pcRail';
import { listedWorkspaces, moaHqId as selectMoaHqId } from '../Moa/moaHqGuard';
import { workspaceShortcutNumber } from '../../../shared/keymap';

/** PresetPicker width (w-52), used to keep the flyout on-screen. */
const PICKER_MENU_WIDTH = 208;

/**
 * `rail` (desktop): the icon rail on the window frame, beside the sheet —
 * the pages Workspaces, Fleet, Schedules and Remote on top, the More menu
 * alone at the foot (Settings lives in it; the sidebar toggle and Search live
 * in the titlebar). While the in-sheet sidebar is open (`collapsed` false) the
 * rail carries no workspace list; collapsed, it adds the workspace avatars,
 * so the collapsed mode and the rail are one column. Arrow keys move focus
 * between its buttons. Adapted from MonoCode (hardbeat920/monocode@6bd432ca,
 * src/app/shell/Sidebar.tsx), MIT License, Copyright (c) 2026 Nick.
 * Without `rail` (the web mirror) it is the original collapsed sidebar.
 */
export default function MiniSidebar({ rail = false, collapsed = true }: { rail?: boolean; collapsed?: boolean } = {}) {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  // A1: 레일은 id/name + 에이전트 상태만 그린다 — 요약 투영만 구독해 cwd/git/
  // port 변경에는 리렌더되지 않게 한다.
  const allWorkspaces = useStore(useShallow(selectWorkspaceRailSummary));
  // Moa's HQ is not one of the operator's workspaces: the rail lists (and
  // numbers) the same rows as the full sidebar. It is reached from its own
  // rail entry instead.
  const moaHqId = useStore(selectMoaHqId);
  // PC rail: another computer's shadow workspaces are never rail avatars.
  const workspaces = useMemo(
    () => listedWorkspaces(allWorkspaces, moaHqId),
    [allWorkspaces, moaHqId],
  );
  // Dot source (agent-status-dot fix): whole-workspace roll-up, same derivation
  // as WorkspaceItem — not the active-pane-only `ws.agentStatus` projection.
  const agentStatusById = useStore(useShallow(selectAllWorkspaceAgentStatus));
  // Workspaces whose 'running' has gone unreported past the hook-authority
  // window, in whole minutes of silence. Same roll-up, minute-granular so the
  // shallow compare holds between clock ticks.
  const unverifiableMinutesById = useStore(useShallow(selectAllWorkspaceUnverifiableMinutes));
  // The full row's rule: plain `waiting` with no question is idle, so the rail
  // draws it as idle too.
  const attentionClassById = useStore(useShallow(selectWorkspaceAttentionClasses));
  // Needs-you-first ordering (attentionOrder.ts) — display only, same setting
  // and same roll-up as the full sidebar so the two surfaces never disagree.
  // #1481 — the same three-way order as the full sidebar; reorder pauses for
  // any non-manual mode (the drop is judged in display order), except among
  // pinned rows.
  const sidebarSortMode = useStore((s) => s.sidebarSortMode);
  const sidebarAttentionFirst = sidebarSortMode !== 'manual';
  // Pinned to top: the pinned group shows as stored in every order, so its
  // rows stay draggable among themselves while the rest is sorted.
  const pinnedIds = useStore((s) => s.sidebarPinnedIds);
  // Same glance-board order and settle rule as the full sidebar.
  const { ordered: boardWorkspaces, onPointerEnter: onRailPointerEnter, onPointerLeave: onRailPointerLeave, onFocusCapture: onRailFocus, onBlurCapture: onRailBlur } =
    useGlanceBoardOrder(workspaces);
  // Snoozed and settled workspaces have no groups on the rail: they just move
  // to the end of it, in the same order. Same placement rule as the sidebar:
  // pinned wins, and a fan-out task goes where its live owner goes.
  const settleStates = useStore((s) => s.workspaceSettle.states);
  const missionByPaneGroup = useStore((s) => s.missionByPaneGroup);
  const fanoutLineage = useStore((s) => s.fanoutLineage);
  const fanoutSpawnOwner = useStore((s) => s.fanoutSpawnOwner);
  const orderedWorkspaces = useMemo(() => {
    const now = Date.now();
    const liveIds = new Set(workspaces.map((w) => w.id));
    const split = partitionWorkspaceSettle(boardWorkspaces, {
      groupOf: (id) => workspaceSettleGroupOf(settleStates[id], now),
      pinned: new Set(pinnedIds),
      nestedOwnerOf: (id) => {
        const link = resolveTaskLink(missionByPaneGroup[id], fanoutLineage[id], fanoutSpawnOwner[id]);
        return link && !link.detached && link.ownerId && link.ownerId !== id && liveIds.has(link.ownerId) ? link.ownerId : undefined;
      },
    });
    return [...split.main, ...split.snoozed, ...split.settled];
  }, [boardWorkspaces, workspaces, settleStates, pinnedIds, missionByPaneGroup, fanoutLineage, fanoutSpawnOwner]);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const toggleMultiviewWorkspace = useStore((s) => s.toggleMultiviewWorkspace);
  const multiviewIds = useStore((s) => s.multiviewIds);
  const reorderWorkspace = useStore((s) => s.reorderWorkspace);
  const notifications = useStore((s) => s.notifications);
  const settingsPanelVisible = useStore((s) => s.settingsPanelVisible);
  // Browser mirror (wmux web /app): no creation, reorder or desktop-only destinations.
  const readOnly = useStore((s) => s.readOnly);
  // The rail beside an open sidebar shows no workspace list (the sidebar has it).
  const showWorkspaces = !rail || collapsed;
  // PC switcher: with a paired computer selected the collapsed rail lists its
  // workspaces, as the expanded sidebar does. Unknown ids read as this computer.
  const railHostId = useStore((s) => {
    if (!rail || readOnly) return null;
    const id = s.pcRail.activePcId;
    return id !== LOCAL_PC_ID && s.pcRailHosts.some((h) => h.id === id) ? id : null;
  });
  // Arrow keys move between the rail's buttons; Tab still walks them in order.
  const onRailKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? buttons.length - 1
      : (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }, []);

  // #1284 — the rail's + opens the same PresetPicker as the titlebar +. With
  // the sidebar collapsed the titlebar + is clipped by its 48px segment, so
  // this is the only way to reach "Attach remote workspace…" (the picker's
  // last row). The picker flies out beside the 48px rail — measured at open
  // time, on the side facing the content area, clamped to the window.
  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState({ left: 8, top: 8 });
  const togglePicker = useCallback(() => {
    setPickerOpen((v) => {
      if (!v) {
        const r = plusBtnRef.current?.getBoundingClientRect();
        if (r) {
          const desired = sidebarPosition === 'right' ? r.left - PICKER_MENU_WIDTH - 4 : r.right + 4;
          setPickerAnchor({
            left: Math.max(8, Math.min(desired, window.innerWidth - PICKER_MENU_WIDTH - 8)),
            top: Math.max(8, r.top),
          });
        }
      }
      return !v;
    });
  }, [sidebarPosition]);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  // Drag state per render — refs avoid re-render on every dragover tick.
  const dragStartTimeRef = useRef<number>(0);
  // Id of the rail row being dragged; null when no rail drag is in flight.
  // Only such a drag may drop here: dataTransfer text is anything dragged in
  // from outside, and an id (not an index) survives a close mid-drag.
  const dragIdRef = useRef<string | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ index: number; side: 'above' | 'below' } | null>(null);

  return (
    <div
      className={rail
        ? 'wmux-rail flex flex-col shrink-0 h-full'
        : `wmux-sidebar flex flex-col shrink-0 h-full bg-[var(--bg-mantle)] ${sidebarPosition === 'right' ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`}
      style={rail ? undefined : { width: 48, borderColor: 'var(--border-soft)' }}
      onKeyDown={rail ? onRailKeyDown : undefined}
      data-sidebar-rail={rail ? '' : undefined}
      {...(rail ? {} : { ...tokenAttrs('bgMantle', 'bg'), ...tokenAttrs('bgSurface', 'border') })}
    >
      {!readOnly && <SidebarNavigation compact home={rail} />}
      {showWorkspaces && <>
      {/* PC switcher, collapsed: one item, only with a paired computer. */}
      {rail && !readOnly && <PcSwitcherRailItem />}
      {/* Header — new workspace button (this computer only) */}
      {!readOnly && !railHostId && <button
        ref={plusBtnRef}
        className={`flex items-center justify-center h-10 text-[var(--text-subtle)] hover:text-[var(--accent-green)] transition-colors duration-150 border-b border-[var(--bg-surface)] font-mono text-lg leading-none ${FOCUS_RING}`}
        style={{ borderColor: 'var(--border-soft)' }}
        onClick={togglePicker}
        data-mini-add-workspace
        title={t('sidebar.newWorkspaceTooltip')}
        aria-label={t('sidebar.newWorkspaceTooltip')}
        data-onboarding-target="add-workspace"
        {...tokenAttrs('textSub', 'text')}
        {...tokenAttrs('success', 'accent')}
        data-derived="textSubtle"
      >
        <IconPlus size={14} />
      </button>}
      {pickerOpen && <PresetPicker onClose={closePicker} anchorStyle={pickerAnchor} />}

      {/* Workspace dots — a selected paired computer's own, like the expanded list */}
      {railHostId ? <HostRailAvatars hostId={railHostId} /> : (
      <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-1" onPointerEnter={onRailPointerEnter} onPointerLeave={onRailPointerLeave} onFocusCapture={onRailFocus} onBlurCapture={onRailBlur}>
        {orderedWorkspaces.map((ws, i) => {
          // `i` is the DISPLAY position and drives only the drop indicator.
          // Everything the user reads or reorders against — the Ctrl+N label,
          // the tooltip, the reorder payload — uses the unfiltered position, so
          // a pinned row keeps its real number and drops land where it lives.
          const railIndex = workspaces.indexOf(ws);
          const shortcutNumber = workspaceShortcutNumber(railIndex, workspaces.length);
          const isActive = ws.id === activeWorkspaceId;
          const isMultiview = multiviewIds.includes(ws.id);
          const isDragging = draggingIndex === i;
          const isPinned = pinnedIds.includes(ws.id);
          const reorderOff = readOnly || (sidebarAttentionFirst && !isPinned);
          // A sorted rail only takes pinned-to-pinned drops.
          const dropAllowed = (fromId: string) =>
            !sidebarAttentionFirst || (isPinned && pinnedIds.includes(fromId));
          const unreadCount = notifications.filter((n) => !n.read && n.workspaceId === ws.id).length;
          const rolled = agentStatusById[ws.id] ?? 'idle';
          const agentStatus = rolled === 'waiting' && attentionClassById[ws.id] !== 'needsYou' ? 'idle' : rolled;
          // Unverifiable: the rail's filled glyph goes hollow and stops
          // pulsing — the same "running, but nobody has heard from it" ring the
          // full sidebar draws, in the one glyph this 48px rail can afford.
          const unverifiableMinutes = unverifiableMinutesById[ws.id] ?? 0;
          // Initial + position so workspaces with identical prefixes (W, W, W…)
          // remain distinguishable in the 48px rail.
          const label = `${ws.name.charAt(0).toUpperCase()}${railIndex + 1}`;
          const railColor = workspaceColorHex(ws.color);
          // Status by shape (the sidebar's StatusMarkView), and in words for
          // the accessible name: "name, status".
          const statusText = unverifiableMinutes
            ? t('workspace.agentUnverifiable', { time: formatStaleMinutes(unverifiableMinutes) })
            : attentionClassById[ws.id] === 'needsYou' && (agentStatus === 'waiting' || agentStatus === 'awaiting_input') ? t('workspace.needsYou')
              : agentStatus !== 'idle' ? t(AGENT_STATUS_ICON[agentStatus].labelKey) : undefined;
          const railName = [ws.name, statusText].filter(Boolean).join(', ');

          const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
            // Suppress click that fires immediately after a drag.
            if (Date.now() - dragStartTimeRef.current < 200) return;
            // 멀티뷰 토글: 플랫폼 주 보조키 + 클릭 (cmdOrCtrl 패턴, WorkspaceItem과 동일).
            // macOS=⌘, Win/Linux=Ctrl.
            const cmdOrCtrl = window.electronAPI?.platform === 'darwin' ? e.metaKey : e.ctrlKey;
            if (cmdOrCtrl) {
              e.preventDefault();
              toggleMultiviewWorkspace(ws.id);
              // The multiview grid lives on the Workspaces page: from Fleet or
              // Settings the toggle would re-grid terminals behind the page.
              useStore.getState().setAppRoute('workspaces');
            } else {
              setActiveWorkspace(ws.id);
              // Picking a workspace on the rail means "show me that workspace".
              useStore.getState().setAppRoute('workspaces');
            }
          };

          const handleDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
            if (reorderOff) return;
            dragStartTimeRef.current = Date.now();
            e.dataTransfer.setData('text/plain', String(railIndex));
            dragIdRef.current = ws.id;
            e.dataTransfer.effectAllowed = 'move';
            setDraggingIndex(i);
          };

          const handleDragEnd = () => {
            dragIdRef.current = null;
            setDraggingIndex(null);
            setDropIndicator(null);
          };

          const handleDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
            // Not a rail drag (external text, a full-sidebar row): no drop
            // target and no indicator, rather than a promise the drop breaks.
            // A row closed mid-drag may never get its dragend, so also check
            // the source still exists.
            const fromId = dragIdRef.current;
            if (reorderOff || fromId === null || !dropAllowed(fromId)) return;
            if (!useStore.getState().workspaces.some((w) => w.id === fromId)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = e.currentTarget.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            setDropIndicator({ index: i, side: e.clientY < midY ? 'above' : 'below' });
          };

          const handleDragLeave = (e: React.DragEvent<HTMLButtonElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDropIndicator((prev) => (prev?.index === i ? null : prev));
            }
          };

          const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
            const fromId = dragIdRef.current;
            if (reorderOff || fromId === null) return;
            e.preventDefault();
            setDropIndicator(null);
            // Resolve both ends now, by id: a close mid-drag shifts indexes.
            const all = useStore.getState().workspaces;
            const fromIndex = all.findIndex((w) => w.id === fromId);
            const railIndex = all.findIndex((w) => w.id === ws.id);
            if (fromIndex === -1 || railIndex === -1 || fromIndex === railIndex || !dropAllowed(fromId)) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const toIndex = e.clientY < midY
              ? (fromIndex < railIndex ? railIndex - 1 : railIndex)
              : (fromIndex > railIndex ? railIndex + 1 : railIndex);
            reorderWorkspace(fromIndex, toIndex, isPinned);
          };

          const showIndicator = dropIndicator?.index === i;

          return (
            <div key={ws.id} className="relative w-8">
              {/* Color tag rail — in the 48px rail the label is 2 characters,
                  so color is the only thing that tells "CTO" from "CSO" at a
                  glance. Shifts right of the multiview border when both apply. */}
              {railColor && (
                <div
                  className="absolute top-1 bottom-1 w-[3px] rounded-full z-[1] pointer-events-none"
                  style={{ left: isMultiview ? 2 : 0, background: railColor }}
                  aria-hidden="true"
                />
              )}
              {showIndicator && dropIndicator.side === 'above' && (
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--accent-blue)] rounded-full z-10 -translate-y-px" />
              )}
              <button
                // Paused while needs-you-first ordering is on: the rail's drop
                // is judged in display order but reorders the array position.
                // Pinned rows are exempt — the group is shown as stored.
                draggable={!reorderOff}
                className={`relative w-8 h-8 rounded-md flex items-center justify-center text-[10px] font-bold font-mono select-none transition-colors ${
                  isActive
                    ? 'bg-[var(--selection)] text-[var(--text-main)]'
                    : 'text-[color-mix(in_srgb,var(--text-main)_50%,transparent)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-main)]'
                } ${isDragging ? 'opacity-40' : 'opacity-100'}`}
                style={isMultiview ? { borderLeft: '2px solid var(--accent-blue)' } : undefined}
                {...tokenAttrs('bgSurface', 'bg')}
                {...tokenAttrs('textMain', 'text')}
                onClick={handleClick}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                title={shortcutNumber === undefined ? railName : `${railName} (Ctrl+${shortcutNumber})`}
                aria-label={railName}
                aria-current={isActive ? 'true' : undefined}
                data-rail-workspace={ws.id}
              >
                {label}
                {unreadCount > 0 && (
                  <span
                    className="absolute -top-0.5 -right-0.5 bg-[var(--selection-emphasis)] text-[var(--text-main)] text-[10px] font-semibold tabular-nums rounded-full min-w-[14px] h-3.5 flex items-center justify-center px-0.5 leading-none ring-1 ring-[var(--border-soft)]"
                    title={t('sidebar.unreadCount', { count: unreadCount })}
                    {...tokenAttrs('bgSurface', 'bg')}
                    {...tokenAttrs('textMain', 'text')}
                  >
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
                {statusText && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-[var(--bg-mantle)]" data-rail-status>
                    <StatusMarkView status={agentStatus} unverifiable={unverifiableMinutes > 0} />
                  </span>
                )}
              </button>
              {showIndicator && dropIndicator.side === 'below' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent-blue)] rounded-full z-10 translate-y-px" />
              )}
            </div>
          );
        })}
      </div>
      )}
      </>}
      {!showWorkspaces && <div className="flex-1" />}

      {/* Footer — expand + status */}
      <div className="flex flex-col items-center gap-2 py-2 border-t border-[var(--bg-surface)]" style={{ borderColor: 'var(--border-soft)' }}>
        {/* The rail's foot holds the More menu (Settings, shortcuts, updates,
            version); the sidebar toggle lives in the titlebar. The web
            mirror has no titlebar, so it keeps its gear and chevron. */}
        {rail ? <RailMoreMenu /> : <>
        {!readOnly && <button
          type="button"
          className={`ui-icon-btn w-8 h-8 ${FOCUS_RING}`}
          aria-label={t('settings.title')}
          title={t('settings.title')}
          data-onboarding-target="settings-button"
          aria-pressed={settingsPanelVisible}
          onClick={() => useStore.getState().toggleSettingsPanel()}
        >
          <IconGear size={16} />
        </button>}
        <button
          className={`w-8 h-8 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--hover-fill)] transition-colors duration-150 font-mono text-caption ${FOCUS_RING}`}
          onClick={toggleSidebar}
          title={t('sidebar.expandTooltip')}
          aria-label={t('sidebar.expandTooltip')}
        >
          <IconChevronDir dir={expandDirection(sidebarPosition)} />
        </button>
        </>}
      </div>
    </div>
  );
}

import { useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceRailSummary } from '../../stores/selectors/workspaceProjections';
import { formatStaleMinutes, selectAllWorkspaceAgentStatus, selectAllWorkspaceUnverifiableMinutes } from '../../stores/selectors/fleet';
import { useT } from '../../hooks/useT';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import { orderByAttention } from './attentionOrder';
import { tokenAttrs } from '../../themes';
import { expandDirection } from './sidebarGlyphs';
import { IconPlus, IconChevronDir } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { workspaceColorHex } from '../../../shared/workspaceColors';

export default function MiniSidebar() {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  // A1: 레일은 id/name + 에이전트 상태만 그린다 — 요약 투영만 구독해 cwd/git/
  // port 변경에는 리렌더되지 않게 한다.
  const workspaces = useStore(useShallow(selectWorkspaceRailSummary));
  // Dot source (agent-status-dot fix): whole-workspace roll-up, same derivation
  // as WorkspaceItem — not the active-pane-only `ws.agentStatus` projection.
  const agentStatusById = useStore(useShallow(selectAllWorkspaceAgentStatus));
  // Workspaces whose 'running' has gone unreported past the hook-authority
  // window, in whole minutes of silence. Same roll-up, minute-granular so the
  // shallow compare holds between clock ticks.
  const unverifiableMinutesById = useStore(useShallow(selectAllWorkspaceUnverifiableMinutes));
  // Needs-you-first ordering (attentionOrder.ts) — display only, same setting
  // and same roll-up as the full sidebar so the two surfaces never disagree.
  const sidebarAttentionFirst = useStore((s) => s.sidebarAttentionFirst);
  const orderedWorkspaces = useMemo(
    () => orderByAttention(workspaces, (id) => agentStatusById[id] ?? 'idle', sidebarAttentionFirst),
    [workspaces, agentStatusById, sidebarAttentionFirst],
  );
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const toggleMultiviewWorkspace = useStore((s) => s.toggleMultiviewWorkspace);
  const multiviewIds = useStore((s) => s.multiviewIds);
  const reorderWorkspace = useStore((s) => s.reorderWorkspace);
  const notifications = useStore((s) => s.notifications);
  const totalUnread = notifications.filter((n) => !n.read).length;
  // A2A channels (U7) — aggregated unread across every channel the
  // current renderer is a member of. The slice's `channelUnread` map
  // is keyed by channelId; we sum here. Mirrors `sumUnread` in
  // ChannelsPanel.tsx — duplicated rather than shared because the two
  // surfaces have different store-read cadences (panel re-renders on
  // every channel slice mutation, MiniSidebar only on its own
  // selectors).
  const channelUnread = useStore((s) => s.channelUnread);
  const totalChannelUnread = Object.values(channelUnread).reduce(
    (acc, n) => acc + (n > 0 ? n : 0),
    0,
  );

  const addWorkspace = useStore((s) => s.addWorkspace);

  // Drag state per render — refs avoid re-render on every dragover tick.
  const dragStartTimeRef = useRef<number>(0);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ index: number; side: 'above' | 'below' } | null>(null);

  return (
    <div className={`flex flex-col h-full bg-[var(--bg-mantle)] ${sidebarPosition === 'right' ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`} style={{ width: 48, borderColor: 'var(--border-soft)' }} {...tokenAttrs('bgMantle', 'bg')} {...tokenAttrs('bgSurface', 'border')}>
      {/* Header — new workspace button */}
      <button
        className={`flex items-center justify-center h-10 text-[var(--text-subtle)] hover:text-[var(--accent-green)] transition-colors duration-150 border-b border-[var(--bg-surface)] font-mono text-lg leading-none ${FOCUS_RING}`}
        style={{ borderColor: 'var(--border-soft)' }}
        onClick={() => addWorkspace()}
        title={t('sidebar.newWorkspaceTooltip')}
        aria-label={t('sidebar.newWorkspaceTooltip')}
        data-onboarding-target="add-workspace"
        {...tokenAttrs('textSub', 'text')}
        {...tokenAttrs('success', 'accent')}
        data-derived="textSubtle"
      >
        <IconPlus size={14} />
      </button>

      {/* Workspace dots */}
      <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-1">
        {orderedWorkspaces.map((ws, i) => {
          // `i` is the DISPLAY position and drives only the drop indicator.
          // Everything the user reads or reorders against — the Ctrl+N label,
          // the tooltip, the reorder payload — uses the unfiltered position, so
          // a pinned row keeps its real number and drops land where it lives.
          const railIndex = workspaces.indexOf(ws);
          const isActive = ws.id === activeWorkspaceId;
          const isMultiview = multiviewIds.includes(ws.id);
          const isDragging = draggingIndex === i;
          const unreadCount = notifications.filter((n) => !n.read && n.workspaceId === ws.id).length;
          const agentStatus = agentStatusById[ws.id] ?? 'idle';
          const agentIcon = agentStatus !== 'idle' ? AGENT_STATUS_ICON[agentStatus] : null;
          // Unverifiable: the rail's filled glyph goes hollow and stops
          // pulsing — the same "running, but nobody has heard from it" ring the
          // full sidebar draws, in the one glyph this 48px rail can afford.
          const unverifiableMinutes = unverifiableMinutesById[ws.id] ?? 0;
          // Initial + position so workspaces with identical prefixes (W, W, W…)
          // remain distinguishable in the 48px rail.
          const label = `${ws.name.charAt(0).toUpperCase()}${railIndex + 1}`;
          const railColor = workspaceColorHex(ws.color);

          const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
            // Suppress click that fires immediately after a drag.
            if (Date.now() - dragStartTimeRef.current < 200) return;
            // 멀티뷰 토글: 플랫폼 주 보조키 + 클릭 (cmdOrCtrl 패턴, WorkspaceItem과 동일).
            // macOS=⌘, Win/Linux=Ctrl.
            const cmdOrCtrl = window.electronAPI?.platform === 'darwin' ? e.metaKey : e.ctrlKey;
            if (cmdOrCtrl) {
              e.preventDefault();
              toggleMultiviewWorkspace(ws.id);
            } else {
              setActiveWorkspace(ws.id);
            }
          };

          const handleDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
            if (sidebarAttentionFirst) return;
            dragStartTimeRef.current = Date.now();
            e.dataTransfer.setData('text/plain', String(railIndex));
            e.dataTransfer.effectAllowed = 'move';
            setDraggingIndex(i);
          };

          const handleDragEnd = () => {
            setDraggingIndex(null);
            setDropIndicator(null);
          };

          const handleDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
            if (sidebarAttentionFirst) return;
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
            if (sidebarAttentionFirst) return;
            e.preventDefault();
            setDropIndicator(null);
            const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
            if (isNaN(fromIndex) || fromIndex === railIndex) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const toIndex = e.clientY < midY
              ? (fromIndex < railIndex ? railIndex - 1 : railIndex)
              : (fromIndex > railIndex ? railIndex + 1 : railIndex);
            reorderWorkspace(fromIndex, toIndex);
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
                draggable={!sidebarAttentionFirst}
                className={`relative w-8 h-8 rounded-md flex items-center justify-center text-[10px] font-bold font-mono select-none transition-colors ${
                  isActive
                    ? 'bg-[var(--bg-surface)] text-[var(--text-main)]'
                    : 'text-[var(--text-muted)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)] hover:text-[var(--text-sub)]'
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
                title={`${ws.name} (Ctrl+${railIndex + 1})`}
              >
                {label}
                {unreadCount > 0 && (
                  <span
                    className="absolute -top-0.5 -right-0.5 bg-[var(--bg-surface)] text-[var(--text-main)] text-[10px] font-bold rounded-full min-w-[14px] h-3.5 flex items-center justify-center px-0.5 leading-none ring-1 ring-[var(--border-soft)]"
                    title={t('sidebar.unreadCount', { count: unreadCount })}
                    {...tokenAttrs('bgSurface', 'bg')}
                    {...tokenAttrs('textMain', 'text')}
                  >
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
                {agentIcon && (
                  <span
                    // The cross gets a box sized to its own glyph, mirroring the
                    // full row: the dot's footprint is 6px and the ✕ is 10px.
                    className={`absolute -bottom-0.5 -right-0.5 text-[10px] leading-none ${agentIcon.shape === 'cross' ? 'w-2.5 h-2.5 flex items-center justify-center font-bold' : ''} ${agentIcon.className} ${agentStatus === 'running' && !unverifiableMinutes ? 'animate-pulse' : ''}`}
                    title={unverifiableMinutes
                      ? t('workspace.agentUnverifiable', { time: formatStaleMinutes(unverifiableMinutes) })
                      : `${ws.agentName ? `${ws.agentName} — ` : ''}${t(agentIcon.labelKey)}`}
                  >
                    {/* Error is the one red status told apart by FORM, not hue
                        (agentStatusIcon.ts) — the rail mirrors that ✕. A silent
                        running agent is the hollow ring. */}
                    {unverifiableMinutes ? '○' : agentIcon.shape === 'cross' ? '✕' : agentIcon.dot}
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

      {/* Footer — expand + status */}
      <div className="flex flex-col items-center gap-2 py-2 border-t border-[var(--bg-surface)]" style={{ borderColor: 'var(--border-soft)' }}>
        {/* A2A channels aggregated unread (U7). Sits above the
            notification badge so the channels icon gets first dibs
            on user attention — a channel-message unread is a higher
            signal than a generic terminal notification. */}
        {totalChannelUnread > 0 && (
          <button
            className="w-8 h-8 rounded-[4px] flex items-center justify-center bg-[var(--bg-surface)] text-[var(--text-sub)] text-[10px] font-bold"
            onClick={() => useStore.getState().toggleSidebar()}
            title={
              t('sidebar.channelUnreadCount', { count: totalChannelUnread }) ??
              `${totalChannelUnread} unread channel ${totalChannelUnread === 1 ? 'message' : 'messages'}`
            }
            aria-label={
              t('sidebar.channelUnreadCount', { count: totalChannelUnread }) ??
              `${totalChannelUnread} unread channel ${totalChannelUnread === 1 ? 'message' : 'messages'}`
            }
            data-mini-channel-unread
          >
            <span aria-hidden="true">#</span>
            <span className="ml-0.5" data-mini-channel-unread-count>
              {totalChannelUnread > 99 ? '99+' : totalChannelUnread}
            </span>
          </button>
        )}

        {/* Unread badge */}
        {totalUnread > 0 && (
          <button
            className="w-8 h-8 rounded-[4px] flex items-center justify-center bg-[var(--bg-surface)] text-[var(--text-sub)] text-[10px] font-bold"
            onClick={() => useStore.getState().toggleNotificationPanel()}
            title={t('sidebar.unreadCount', { count: totalUnread })}
            // The visible content is a bare number; the sibling channel badge
            // one row up already names itself, and a screen reader announcing
            // "3, button" beside "3 unread channel messages, button" cannot
            // tell the two apart.
            aria-label={t('sidebar.unreadCount', { count: totalUnread })}
          >
            {totalUnread > 99 ? '99+' : totalUnread}
          </button>
        )}

        {/* Expand sidebar button — same position as collapse button in full sidebar */}
        <button
          className={`w-8 h-8 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 font-mono text-caption ${FOCUS_RING}`}
          onClick={toggleSidebar}
          title={t('sidebar.expandTooltip')}
          aria-label={t('sidebar.expandTooltip')}
        >
          <IconChevronDir dir={expandDirection(sidebarPosition)} />
        </button>
      </div>
    </div>
  );
}

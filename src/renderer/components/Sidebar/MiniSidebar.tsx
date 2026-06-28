import { useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import { tokenAttrs } from '../../themes';
import { expandDirection } from './sidebarGlyphs';
import { IconPlus, IconChevronDir } from '../icons';
import { FOCUS_RING } from '../focusRing';

export default function MiniSidebar() {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const workspaces = useStore((s) => s.workspaces);
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
        {workspaces.map((ws, i) => {
          const isActive = ws.id === activeWorkspaceId;
          const isMultiview = multiviewIds.includes(ws.id);
          const isDragging = draggingIndex === i;
          const unreadCount = notifications.filter((n) => !n.read && n.workspaceId === ws.id).length;
          const agentStatus = ws.metadata?.agentStatus;
          const agentIcon = agentStatus && agentStatus !== 'idle' ? AGENT_STATUS_ICON[agentStatus] : null;
          // Initial + position so workspaces with identical prefixes (W, W, W…)
          // remain distinguishable in the 48px rail.
          const label = `${ws.name.charAt(0).toUpperCase()}${i + 1}`;

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
            dragStartTimeRef.current = Date.now();
            e.dataTransfer.setData('text/plain', String(i));
            e.dataTransfer.effectAllowed = 'move';
            setDraggingIndex(i);
          };

          const handleDragEnd = () => {
            setDraggingIndex(null);
            setDropIndicator(null);
          };

          const handleDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
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
            e.preventDefault();
            setDropIndicator(null);
            const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
            if (isNaN(fromIndex) || fromIndex === i) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const toIndex = e.clientY < midY
              ? (fromIndex < i ? i - 1 : i)
              : (fromIndex > i ? i + 1 : i);
            reorderWorkspace(fromIndex, toIndex);
          };

          const showIndicator = dropIndicator?.index === i;

          return (
            <div key={ws.id} className="relative w-8">
              {showIndicator && dropIndicator.side === 'above' && (
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--accent-blue)] rounded-full z-10 -translate-y-px" />
              )}
              <button
                draggable
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
                title={`${ws.name} (Ctrl+${i + 1})`}
              >
                {label}
                {unreadCount > 0 && (
                  <span
                    className="absolute -top-0.5 -right-0.5 bg-[var(--accent-blue)] text-[var(--bg-base)] text-[8px] font-bold rounded-full min-w-[12px] h-3 flex items-center justify-center px-0.5 leading-none"
                    title={t('sidebar.unreadCount', { count: unreadCount })}
                    {...tokenAttrs('accent', 'accent')}
                    {...tokenAttrs('bgBase', 'bg')}
                  >
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
                {agentIcon && (
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 text-[8px] leading-none ${agentIcon.className} ${agentStatus === 'running' ? 'animate-pulse' : ''}`}
                    title={`${ws.metadata?.agentName ? `${ws.metadata.agentName} — ` : ''}${t(agentIcon.labelKey)}`}
                  >
                    {agentIcon.dot}
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
            className="w-8 h-8 rounded-md flex items-center justify-center bg-[rgba(var(--accent-green-rgb),0.18)] text-[var(--accent-green)] text-[10px] font-bold"
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
            className="w-8 h-8 rounded-md flex items-center justify-center bg-[rgba(var(--accent-blue-rgb),0.2)] text-[var(--accent-blue)] text-[10px] font-bold"
            onClick={() => useStore.getState().toggleNotificationPanel()}
            title={t('sidebar.unreadCount', { count: totalUnread })}
          >
            {totalUnread > 99 ? '99+' : totalUnread}
          </button>
        )}

        {/* Expand sidebar button — same position as collapse button in full sidebar */}
        <button
          className={`w-8 h-8 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 font-mono text-[11px] ${FOCUS_RING}`}
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

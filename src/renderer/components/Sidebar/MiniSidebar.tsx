import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';

export default function MiniSidebar() {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const totalUnread = useStore((s) =>
    s.notifications.filter((n) => !n.read).length,
  );

  const addWorkspace = useStore((s) => s.addWorkspace);

  return (
    <div className={`flex flex-col h-full bg-[var(--bg-mantle)] ${sidebarPosition === 'right' ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`} style={{ width: 48 }}>
      {/* Header — new workspace button */}
      <button
        className="flex items-center justify-center h-10 text-[var(--text-subtle)] hover:text-[var(--accent-green)] transition-colors border-b border-[var(--bg-surface)] font-mono text-lg leading-none"
        onClick={() => addWorkspace()}
        title={t('sidebar.newWorkspaceTooltip')}
      >
        +
      </button>

      {/* Workspace dots */}
      <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-1">
        {workspaces.map((ws, i) => {
          const isActive = ws.id === activeWorkspaceId;
          const initial = ws.name.charAt(0).toUpperCase();

          return (
            <button
              key={ws.id}
              className={`w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold font-mono transition-colors ${
                isActive
                  ? 'bg-[var(--bg-surface)] text-[var(--text-main)]'
                  : 'text-[var(--text-muted)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)] hover:text-[var(--text-sub)]'
              }`}
              onClick={() => setActiveWorkspace(ws.id)}
              title={`${ws.name} (Ctrl+${i + 1})`}
            >
              {initial}
            </button>
          );
        })}
      </div>

      {/* Footer — expand + status */}
      <div className="flex flex-col items-center gap-2 py-2 border-t border-[var(--bg-surface)]">
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
          className="w-8 h-8 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors font-mono text-[11px]"
          onClick={toggleSidebar}
          title={t('sidebar.expandTooltip')}
        >
          ▶
        </button>
      </div>
    </div>
  );
}

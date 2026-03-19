import { useStore } from '../../stores';

export default function MiniSidebar() {
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const totalUnread = useStore((s) =>
    s.notifications.filter((n) => !n.read).length,
  );

  return (
    <div className="flex flex-col h-full bg-[#181825] border-r border-[#313244]" style={{ width: 48 }}>
      {/* Expand button */}
      <button
        className="flex items-center justify-center h-10 text-[#585b70] hover:text-[#cdd6f4] transition-colors border-b border-[#313244] font-mono text-[11px]"
        onClick={toggleSidebar}
        title="Expand sidebar (Ctrl+B)"
      >
        ›
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
                  ? 'bg-[#313244] text-[#cdd6f4]'
                  : 'text-[#585b70] hover:bg-[#313244]/50 hover:text-[#bac2de]'
              }`}
              onClick={() => setActiveWorkspace(ws.id)}
              title={`${ws.name} (Ctrl+${i + 1})`}
            >
              {initial}
            </button>
          );
        })}
      </div>

      {/* Status area */}
      <div className="flex flex-col items-center gap-2 py-2 border-t border-[#313244]">
        {/* Unread badge */}
        {totalUnread > 0 && (
          <button
            className="w-8 h-8 rounded-md flex items-center justify-center bg-[#89b4fa]/20 text-[#89b4fa] text-[10px] font-bold"
            onClick={() => useStore.getState().toggleNotificationPanel()}
            title={`${totalUnread} unread`}
          >
            {totalUnread > 99 ? '99+' : totalUnread}
          </button>
        )}

        {/* Workspace count */}
        <span className="text-[9px] font-mono text-[#585b70]">{workspaces.length}</span>
      </div>
    </div>
  );
}

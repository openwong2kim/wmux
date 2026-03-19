import { useMemo } from 'react';
import { useStore } from '../../stores';

export default function NotificationPanel() {
  const notifications = useStore((s) => s.notifications);
  const notificationPanelVisible = useStore((s) => s.notificationPanelVisible);
  const toggleNotificationPanel = useStore((s) => s.toggleNotificationPanel);
  const markRead = useStore((s) => s.markRead);
  const markAllReadForWorkspace = useStore((s) => s.markAllReadForWorkspace);
  const clearNotifications = useStore((s) => s.clearNotifications);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);

  const sorted = useMemo(
    () => [...notifications].sort((a, b) => b.timestamp - a.timestamp),
    [notifications],
  );
  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  if (!notificationPanelVisible) return null;

  const handleNotifClick = (notif: typeof sorted[0]) => {
    markRead(notif.id);
    if (notif.workspaceId !== activeWorkspaceId) {
      setActiveWorkspace(notif.workspaceId);
    }
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const typeIcon = (type: string) => {
    switch (type) {
      case 'agent': return '🤖';
      case 'error': return '❌';
      case 'warning': return '⚠️';
      default: return 'ℹ️';
    }
  };

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-[#181825] border-l border-[#313244] z-50 flex flex-col shadow-2xl notification-panel-enter">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#313244]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[#cdd6f4]">Notifications</span>
          {unreadCount > 0 && (
            <span className="bg-[#89b4fa] text-[#1e1e2e] text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {notifications.length > 0 && (
            <>
              <button
                className="text-[10px] text-[#6c7086] hover:text-[#89b4fa] transition-colors"
                onClick={() => markAllReadForWorkspace(activeWorkspaceId)}
              >
                Mark all read
              </button>
              <button
                className="text-[10px] text-[#6c7086] hover:text-[#f38ba8] transition-colors"
                onClick={clearNotifications}
              >
                Clear
              </button>
            </>
          )}
          <button
            className="text-[#6c7086] hover:text-[#cdd6f4] text-sm transition-colors"
            onClick={toggleNotificationPanel}
          >
            ✕
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[#585b70] text-sm">
            No notifications
          </div>
        ) : (
          sorted.map((notif) => (
            <div
              key={notif.id}
              className={`px-4 py-3 border-b border-[#313244]/50 cursor-pointer hover:bg-[#313244]/30 transition-colors ${
                notif.read ? 'opacity-60' : ''
              }`}
              onClick={() => handleNotifClick(notif)}
            >
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">{typeIcon(notif.type)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-medium truncate ${notif.read ? 'text-[#6c7086]' : 'text-[#cdd6f4]'}`}>
                      {notif.title}
                    </span>
                    <span className="text-[10px] text-[#585b70] flex-shrink-0 ml-2">
                      {formatTime(notif.timestamp)}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#a6adc8] mt-0.5 truncate">{notif.body}</p>
                </div>
                {!notif.read && (
                  <div className="w-1.5 h-1.5 rounded-full bg-[#89b4fa] mt-1.5 flex-shrink-0" />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-[#313244] text-[10px] text-[#585b70]">
        Ctrl+I to toggle
      </div>
    </div>
  );
}

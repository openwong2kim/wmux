import { useMemo } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';

export default function NotificationPanel() {
  const t = useT();
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
    <div className="fixed right-0 top-0 h-full w-80 bg-[var(--bg-mantle)] border-l border-[var(--bg-surface)] z-50 flex flex-col shadow-2xl notification-panel-enter">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--bg-surface)]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[var(--text-main)]">{t('notification.title')}</span>
          {unreadCount > 0 && (
            <span className="bg-[var(--accent-blue)] text-[var(--bg-base)] text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {notifications.length > 0 && (
            <>
              <button
                className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors"
                onClick={() => markAllReadForWorkspace(activeWorkspaceId)}
              >
                {t('notification.markAllRead')}
              </button>
              <button
                className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--accent-red)] transition-colors"
                onClick={clearNotifications}
              >
                {t('notification.clear')}
              </button>
            </>
          )}
          <button
            className="text-[var(--text-subtle)] hover:text-[var(--text-main)] text-sm transition-colors"
            onClick={toggleNotificationPanel}
          >
            ✕
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
            {t('notification.empty')}
          </div>
        ) : (
          sorted.map((notif) => (
            <div
              key={notif.id}
              className={`px-4 py-3 border-b border-[rgba(var(--bg-surface-rgb),0.5)] cursor-pointer hover:bg-[rgba(var(--bg-surface-rgb),0.3)] transition-colors ${
                notif.read ? 'opacity-60' : ''
              }`}
              onClick={() => handleNotifClick(notif)}
            >
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">{typeIcon(notif.type)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-medium truncate ${notif.read ? 'text-[var(--text-subtle)]' : 'text-[var(--text-main)]'}`}>
                      {notif.title}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 ml-2">
                      {formatTime(notif.timestamp)}
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--text-sub2)] mt-0.5 truncate">{notif.body}</p>
                </div>
                {!notif.read && (
                  <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-blue)] mt-1.5 flex-shrink-0" />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-[var(--bg-surface)] text-[10px] text-[var(--text-muted)]">
        {t('notification.toggle')}
      </div>
    </div>
  );
}

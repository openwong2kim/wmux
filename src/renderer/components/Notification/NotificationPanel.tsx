import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { timeAgo } from '../../utils/timeAgo';
import { tokenAttrs } from '../../themes';
import type { Notification, NotificationType } from '../../../shared/types';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';

// ─── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Sort notifications by timestamp DESC (newest first). Pure for tests.
 */
export function sortNotificationsDesc(notifications: Notification[]): Notification[] {
  return [...notifications].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Map a NotificationType to a screen-reader friendly noun.
 * Kept as literal English; no i18n keys exist yet for these (DESIGN D5 + scope hygiene).
 */
export function notifTypeName(type: NotificationType): string {
  switch (type) {
    case 'agent': return 'agent';
    case 'error': return 'error';
    case 'warning': return 'warning';
    default: return 'info';
  }
}

/**
 * Build the screen-reader announce string for a notification row.
 * Shape: "{typeName}, {title}, {timeAgo}, {read|unread}"
 */
export function buildNotifAriaLabel(notif: Notification, now: number = Date.now()): string {
  const typeName = notifTypeName(notif.type);
  const rel = timeAgo(notif.timestamp, now);
  const state = notif.read ? 'read' : 'unread';
  return `${typeName}, ${notif.title}, ${rel}, ${state}`;
}

// ─── Scroll-position memory (cmux parity) ─────────────────────────────────────
//
// The panel unmounts entirely when hidden (`return null`), so its list scroll
// offset is lost on close. Per-session, in-memory only (module-level — a store
// slice would broadcast every scroll tick to all subscribers for no benefit):
// remember the offset at close and restore it on reopen, UNLESS new
// notifications arrived while the panel was closed — then snap to top so the
// newest entries are visible (the list is newest-first).
export interface PanelScrollMemory {
  /** Last observed scrollTop of the list container. */
  scrollTop: number;
  /** id of the newest notification the panel last saw while open. */
  newestId: string | null;
}

/** Exported for tests; reset between test cases. */
export const panelScrollMemory: PanelScrollMemory = { scrollTop: 0, newestId: null };

/**
 * Pure resolver: restore the saved offset only if the newest notification is
 * still the one the panel saw before closing; otherwise snap to top.
 */
export function resolveRestoredScrollTop(
  memory: PanelScrollMemory,
  currentNewestId: string | null,
): number {
  return memory.newestId === currentNewestId ? memory.scrollTop : 0;
}

/**
 * Emoji icon for a notification type. NOT updated as part of T10 (DESIGN D9
 * scope hygiene); kept here so the view function stays pure and renderable.
 */
function typeIcon(type: string): string {
  switch (type) {
    case 'agent': return '🤖';
    case 'error': return '❌';
    case 'warning': return '⚠️';
    default: return 'ℹ️';
  }
}

// ─── Pure view (exported for tests) ───────────────────────────────────────────

export interface NotificationPanelViewProps {
  notifications: Notification[];     // pre-sorted (DESC) by caller
  unreadCount: number;
  dialogLabel: string;               // t('notification.title') equivalent
  emptyLabel: string;                // t('notification.empty')
  toggleHintLabel: string;           // t('notification.toggle')
  markAllReadLabel: string;          // t('notification.markAllRead')
  markWorkspaceReadLabel: string;    // t('notification.markWorkspaceRead')
  closeLabel: string;                // t('notification.close')
  clearLabel: string;                // t('notification.clear')
  onNotifClick: (notif: Notification) => void;
  onNotifKeyDown: (e: React.KeyboardEvent, notif: Notification) => void;
  onClose: () => void;
  onMarkAllRead: () => void;         // global
  onMarkWorkspaceRead: () => void;   // active workspace only
  onClear: () => void;
  firstUnreadRef?: React.Ref<HTMLDivElement>;
  markAllReadBtnRef?: React.Ref<HTMLButtonElement>;
  listRef?: React.Ref<HTMLDivElement>;
  onListScroll?: React.UIEventHandler<HTMLDivElement>;
}

/**
 * Stateless presentation. Receives all data + handlers via props.
 * Safe to renderToStaticMarkup without any store wiring.
 */
export function NotificationPanelView(props: NotificationPanelViewProps): ReactElement {
  const {
    notifications, unreadCount, dialogLabel, emptyLabel, toggleHintLabel,
    markAllReadLabel, markWorkspaceReadLabel, clearLabel, closeLabel,
    onNotifClick, onNotifKeyDown, onClose,
    onMarkAllRead, onMarkWorkspaceRead, onClear,
    firstUnreadRef, markAllReadBtnRef, listRef, onListScroll,
  } = props;

  const firstUnreadIdx = notifications.findIndex((n) => !n.read);

  return (
    <div
      role="dialog"
      aria-label={dialogLabel}
      className="fixed right-0 top-0 h-full w-80 bg-[var(--bg-mantle)] border-l border-[var(--bg-surface)] z-50 flex flex-col shadow-2xl notification-panel-enter"
      {...tokenAttrs('bgMantle', 'bg')}
      {...tokenAttrs('bgSurface', 'border')}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--bg-surface)]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[var(--text-main)]" {...tokenAttrs('textMain', 'text')}>{dialogLabel}</span>
          {unreadCount > 0 && (
            <span className="bg-[var(--accent)] text-[var(--bg-base)] text-[10px] font-bold px-1.5 py-0.5 rounded-full" {...tokenAttrs('accent', 'accent')} {...tokenAttrs('bgBase', 'bg')}>
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {notifications.length > 0 && (
            <>
              {/* Global mark-all-read (T2). Placed FIRST per plan. */}
              <button
                ref={markAllReadBtnRef}
                className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors"
                onClick={onMarkAllRead}
                aria-label={markAllReadLabel}
              >
                {markAllReadLabel}
              </button>
              {/* Per-workspace mark-all-read (legacy behavior). */}
              <button
                className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors"
                onClick={onMarkWorkspaceRead}
                aria-label={markWorkspaceReadLabel}
              >
                {markWorkspaceReadLabel}
              </button>
              <button
                className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--accent-red)] transition-colors"
                onClick={onClear}
                {...tokenAttrs('danger', 'accent')}
              >
                {clearLabel}
              </button>
            </>
          )}
          <button
            className="text-[var(--text-subtle)] hover:text-[var(--text-main)] text-sm transition-colors"
            onClick={onClose}
            aria-label={closeLabel}
          >
            ✕
          </button>
        </div>
      </div>

      {/* List */}
      <div ref={listRef} onScroll={onListScroll} data-notification-list className="flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm" {...tokenAttrs('textMuted', 'text')}>
            {emptyLabel}
          </div>
        ) : (
          notifications.map((notif, idx) => (
            <div
              key={notif.id}
              ref={idx === firstUnreadIdx ? firstUnreadRef : undefined}
              role="button"
              tabIndex={0}
              aria-label={buildNotifAriaLabel(notif)}
              className={`px-4 py-3 border-b border-[rgba(var(--bg-surface-rgb),0.5)] cursor-pointer hover:bg-[rgba(var(--bg-surface-rgb),0.3)] transition-colors ${
                notif.read ? 'opacity-60' : ''
              }`}
              onClick={() => onNotifClick(notif)}
              onKeyDown={(e) => onNotifKeyDown(e, notif)}
            >
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">{typeIcon(notif.type)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-medium truncate ${notif.read ? 'text-[var(--text-subtle)]' : 'text-[var(--text-main)]'}`}>
                      {notif.title}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 ml-2">
                      {timeAgo(notif.timestamp)}
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--text-sub2)] mt-0.5 truncate" {...tokenAttrs('textMain', 'text')} data-derived="textSub2">{notif.body}</p>
                </div>
                {!notif.read && (
                  <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] mt-1.5 flex-shrink-0" />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-[var(--bg-surface)] text-[10px] text-[var(--text-muted)]">
        {toggleHintLabel}
      </div>
    </div>
  );
}

// ─── Container (store-wired) ──────────────────────────────────────────────────

export default function NotificationPanel() {
  const t = useT();
  const notifications = useStore((s) => s.notifications);
  const notificationPanelVisible = useStore((s) => s.notificationPanelVisible);
  const toggleNotificationPanel = useStore((s) => s.toggleNotificationPanel);
  const markRead = useStore((s) => s.markRead);
  const markAllReadForWorkspace = useStore((s) => s.markAllReadForWorkspace);
  const clearNotifications = useStore((s) => s.clearNotifications);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);

  const firstUnreadRef = useRef<HTMLDivElement>(null);
  const markAllReadBtnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Track the notification id the firstUnreadRef captured at render time so
  // the rAF focus pass can detect a race (new notification arrived between
  // render and rAF firing) and degrade to the mark-all button instead of
  // focusing the now-stale row. See useEffect below.
  const firstUnreadIdAtRenderRef = useRef<string | null>(null);

  const sorted = useMemo(() => sortNotificationsDesc(notifications), [notifications]);
  // Capture at render time which notification the firstUnreadRef will point
  // at; consumed by the focus rAF below to detect the race window.
  firstUnreadIdAtRenderRef.current = sorted.find((n) => !n.read)?.id ?? null;
  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  // ─── Esc to close ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!notificationPanelVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleNotificationPanel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [notificationPanelVisible, toggleNotificationPanel]);

  // ─── Initial focus: first unread, else markAllRead button (D5) ─────────────
  // Defer with requestAnimationFrame so the enter animation has flipped the
  // panel into the visible DOM tree before we move focus.
  //
  // Race fix (FIX #4): a new notification arriving between render and rAF
  // firing would shift `firstUnreadRef` to a no-longer-newest row. We
  // re-derive first unread from live store state at rAF time and only
  // accept the cached ref if its captured id still matches. Otherwise we
  // fall back to the mark-all button so the user lands somewhere stable
  // instead of on a row that quietly got demoted to second-newest.
  useEffect(() => {
    if (!notificationPanelVisible) return;
    const raf = requestAnimationFrame(() => {
      const liveFirstUnreadId =
        useStore.getState().notifications
          .filter((n) => !n.read)
          .sort((a, b) => b.timestamp - a.timestamp)[0]?.id ?? null;
      const capturedId = firstUnreadIdAtRenderRef.current;
      if (firstUnreadRef.current && capturedId !== null && capturedId === liveFirstUnreadId) {
        firstUnreadRef.current.focus();
      } else if (markAllReadBtnRef.current) {
        markAllReadBtnRef.current.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [notificationPanelVisible]);

  // ─── Scroll-position restore (cmux parity) ─────────────────────────────────
  // On open: restore the offset saved at close, unless new notifications
  // arrived while closed — then snap to top (list is newest-first). The
  // decision is computed synchronously at effect time (BEFORE the memory-sync
  // effect below overwrites `newestId`), and applied in a rAF registered
  // AFTER the focus effect above so the scrollTop write lands after any
  // implicit scroll caused by `.focus()`.
  useEffect(() => {
    if (!notificationPanelVisible) return;
    const liveNewestId =
      sortNotificationsDesc(useStore.getState().notifications)[0]?.id ?? null;
    const target = resolveRestoredScrollTop(panelScrollMemory, liveNewestId);
    // Keep memory coherent with what we actually applied, so a
    // snap-to-top open followed by a scroll-less close doesn't
    // resurrect the pre-snap offset on the next open.
    panelScrollMemory.scrollTop = target;
    const raf = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = target;
    });
    return () => cancelAnimationFrame(raf);
  }, [notificationPanelVisible]);

  // While open, keep the "newest notification the panel has seen" marker in
  // sync so the reopen comparison above only fires for arrivals-while-CLOSED.
  useEffect(() => {
    if (!notificationPanelVisible) return;
    panelScrollMemory.newestId = sorted[0]?.id ?? null;
  }, [notificationPanelVisible, sorted]);

  if (!notificationPanelVisible) return null;

  const handleListScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    panelScrollMemory.scrollTop = e.currentTarget.scrollTop;
  };

  const handleNotifClick = (notif: Notification) => {
    // Full click-jump: workspace + pane + surface (+ zoom coherence), the
    // same path the OS toast click takes. ptyId is the strongest signal;
    // surfaceId survives PTY reconnects (panel entries can be old);
    // workspaceId remains the app-level fallback — focusNotificationTarget
    // handles the whole cascade, so no separate setActiveWorkspace call.
    //
    // Codex review catch: do NOT pre-mark read here. focusNotificationTarget
    // marks-read-and-clears-ring together, but only for notifications it
    // still SEES as unread at that moment — if this click's own notif.id was
    // the surface's only unread entry and we'd already marked it read above,
    // the helper would find nothing unread, `markedAny` stays false, and the
    // pane keeps a stale flash/glow ring despite the user having just
    // visited it. Let the helper observe the real pre-click state instead.
    focusNotificationTarget(() => useStore.getState(), {
      ptyId: notif.ptyId ?? null,
      surfaceId: notif.surfaceId ?? null,
      workspaceId: notif.workspaceId,
    });
    // Guaranteed fallback: a pure workspace-level record (no ptyId/
    // surfaceId) or a surface that's fully gone (pane closed, not just a
    // reconnected PTY) never reaches focusNotificationTarget's internal
    // mark-read loop — that loop only runs inside its ptyId/surfaceId match
    // branches. Re-check post-jump so the click always marks read; this is
    // a no-op when the jump above already marked it (the common case).
    if (!useStore.getState().notifications.find((n) => n.id === notif.id)?.read) {
      markRead(notif.id);
    }
  };

  const handleNotifKey = (e: React.KeyboardEvent, notif: Notification) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleNotifClick(notif);
    }
  };

  const handleGlobalMarkAllRead = () => {
    // T2 is merged — call the slice action directly. The action also clears
    // paneNotificationRing as part of the global "seen everything" semantics
    // (see notificationSlice.markAllRead).
    useStore.getState().markAllRead();
  };

  return (
    <NotificationPanelView
      notifications={sorted}
      unreadCount={unreadCount}
      dialogLabel={t('notification.title')}
      emptyLabel={t('notification.empty')}
      toggleHintLabel={t('notification.toggle')}
      markAllReadLabel={t('notification.markAllRead')}
      markWorkspaceReadLabel={t('notification.markWorkspaceRead')}
      closeLabel={t('notification.close')}
      clearLabel={t('notification.clear')}
      onNotifClick={handleNotifClick}
      onNotifKeyDown={handleNotifKey}
      onClose={toggleNotificationPanel}
      onMarkAllRead={handleGlobalMarkAllRead}
      onMarkWorkspaceRead={() => markAllReadForWorkspace(activeWorkspaceId)}
      onClear={clearNotifications}
      firstUnreadRef={firstUnreadRef}
      markAllReadBtnRef={markAllReadBtnRef}
      listRef={listRef}
      onListScroll={handleListScroll}
    />
  );
}

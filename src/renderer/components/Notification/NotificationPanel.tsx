import { useEffect, useId, useLayoutEffect, useMemo, useRef, type ReactElement } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useShortcutLabel } from '../../utils/shortcutLabel';
import { timeAgo } from '../../utils/timeAgo';
import { tokenAttrs } from '../../themes';
import type { AgentStatus, Notification, NotificationType, Workspace } from '../../../shared/types';
import type { SecurityNotice } from '../../../shared/securityNotice';
import { findWorkspaceSurfaceByPtyId } from '../../utils/paneTraversal';
import { describeNotificationSource, focusNotificationTarget, osToastBody } from '../../hooks/useNotificationListener';
import { AGENT_IDENTITIES } from '../../../shared/agentIdentity';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import { IconBell, IconRobot, IconWarning, IconX } from '../icons';
import { TITLEBAR_HEIGHT } from '../Titlebar/Titlebar';
import { NOTIFICATION_TOGGLE_ATTR } from '../StatusBar/StatusBar';

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
 * Shape: "{typeName}, {title}, {timeAgo}, {read|unread}" — or, when the row
 * is drawn from `display`, "{typeName}, {title}, {body}, {timeAgo}, …" so the
 * spoken name says what the row shows.
 */
export function buildNotifAriaLabel(notif: Notification, now: number = Date.now(), display?: NotifDisplay): string {
  const typeName = notifTypeName(notif.type);
  const rel = timeAgo(notif.timestamp, now);
  const state = notif.read ? 'read' : 'unread';
  const said = display ? `${display.title}, ${display.body}` : notif.title;
  return `${typeName}, ${said}, ${rel}, ${state}`;
}

// ─── What a row says ─────────────────────────────────────────────────────────

/** A row as drawn: a headline and one line under it. */
export interface NotifDisplay {
  title: string;
  body: string;
}

/** The store slices a row's wording reads. */
export interface NotifDisplayState {
  workspaces: Workspace[];
  surfaceAgent: Record<string, { name: string; status: AgentStatus } | undefined>;
  surfaceAgentStatus: Record<string, AgentStatus | undefined>;
  surfacePendingQuestion: Record<string, string | undefined>;
}

const KNOWN_AGENT_NAMES = new Set(AGENT_IDENTITIES.map((a) => a.display.toLowerCase()));

/** The agent a hook title names ("Claude Code: Awaiting input" → "Claude
 *  Code"), when it is a known agent. */
function agentFromTitle(title: string): string | undefined {
  const head = title.split(': ')[0]?.trim();
  return head && head !== title && KNOWN_AGENT_NAMES.has(head.toLowerCase()) ? head : undefined;
}

/**
 * What a panel row says, from data the store already has. A needs-you row
 * (an agent in a local pane waiting on an approval, or whose turn ended on a
 * question it still waits on) names where
 * it waits — workspace · agent — and what it asks: the agent's question while
 * it still waits (on its newest row only), a plain sentence when no question
 * text was captured, another when it no longer waits. It never repeats the
 * state word main put in the title and body ("Awaiting input" twice). Any
 * other row keeps its title; a body that only repeats the title gives way to
 * where the notification came from, as the OS toast does.
 */
export function describeNotification(
  notif: Notification,
  state: NotifDisplayState,
  t: (key: string, vars?: Record<string, string | number>) => string,
  latestForPty: boolean,
): NotifDisplay {
  const ws = state.workspaces.find((w) => w.id === notif.workspaceId);
  const ptyId = notif.ptyId;
  const question = latestForPty && ptyId ? state.surfacePendingQuestion[ptyId]?.trim() : undefined;
  // A turn that ended on a question still waiting is needs you too.
  const needsYou = !!ptyId && (notif.category === 'approval' || (notif.category === 'agent-turn' && !!question));
  if (needsYou && ptyId) {
    // The agent the notification itself names: the pane may run another
    // agent by now. The pane's live agent only when the title names none.
    const agent = agentFromTitle(notif.title) || state.surfaceAgent[ptyId]?.name;
    const title = [ws?.name?.trim(), agent].filter(Boolean).join(' · ') || notif.title;
    const waiting = latestForPty && (!!question
      || state.surfaceAgent[ptyId]?.status === 'awaiting_input'
      || state.surfaceAgentStatus[ptyId] === 'awaiting_input');
    const body = question ? t('notification.needsYou.question', { question })
      : waiting ? t('notification.needsYou.noQuestion')
      : t('notification.needsYou.over');
    return { title, body };
  }
  const source = describeNotificationSource(ws, notif.surfaceId);
  const body = source && osToastBody(notif.title, notif.body, source) === source ? source : notif.body;
  return { title: notif.title, body };
}

/**
 * Whether a pointer press at `target` should dismiss the open panel: anywhere
 * outside the panel except the toggle that opened it.
 */
export function isOutsidePanelPress(target: EventTarget | null, panel: Element | null): boolean {
  if (!panel || !(target instanceof Element)) return false;
  if (panel.contains(target)) return false;
  return !target.closest(`[${NOTIFICATION_TOGGLE_ATTR}]`);
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
 * Monochrome status mark for a notification type (DESIGN.md: no emoji glyphs
 * in chrome; status marks are icons). Only error and warning take a hue, on
 * the icon alone.
 */
function TypeIcon({ type }: { type: string }): ReactElement {
  switch (type) {
    case 'agent':
      return <span className="text-[var(--text-sub)]"><IconRobot size={13} /></span>;
    case 'error':
      return <span className="text-[var(--accent-red)]"><IconWarning size={13} /></span>;
    case 'warning':
      return <span className="text-[var(--accent-yellow)]"><IconWarning size={13} /></span>;
    default:
      return <span className="text-[var(--text-sub)]"><IconBell size={13} /></span>;
  }
}

// ─── Pinned security notices ─────────────────────────────────────────────────

/** A pending security notice as the panel pins it. */
export interface PinnedSecurityNotice {
  notice: SecurityNotice;
  /** "workspace › tab" of its pane while the pane is still open (empty when
   *  neither has a name), else null (and no Go to pane). */
  location: string | null;
}

/** Where each pending notice's pane is now, oldest notice first. */
export function pinSecurityNotices(notices: readonly SecurityNotice[], workspaces: readonly Workspace[]): PinnedSecurityNotice[] {
  return notices.map((notice) => {
    if (notice.ptyId) {
      for (const ws of workspaces) {
        const found = findWorkspaceSurfaceByPtyId(ws, notice.ptyId);
        if (found) return { notice, location: describeNotificationSource(ws, found.surfaceId) };
      }
    }
    return { notice, location: null };
  });
}

interface SecurityNoticesSectionProps {
  items: readonly PinnedSecurityNotice[];
  headingLabel: string;
  goToPaneLabel: string;
  ackLabel: string;
  onGoToPane: (notice: SecurityNotice) => void;
  onAcknowledge: (notice: SecurityNotice) => void;
}

/**
 * Notices a paired phone's risky agent start raised, pinned above the list
 * until acknowledged. Warning icon in the caution yellow (a warning, not the
 * needs-you orange); the read and clear actions never reach them.
 */
function SecurityNoticesSection(props: SecurityNoticesSectionProps): ReactElement {
  const { items, headingLabel, goToPaneLabel, ackLabel, onGoToPane, onAcknowledge } = props;
  // Every notice has the same two buttons; each names its notice's title as
  // its description so a screen reader can tell them apart.
  const titleIdBase = useId();
  return (
    <section
      aria-label={headingLabel}
      data-security-notices
      className="max-h-[50%] shrink-0 overflow-y-auto"
      style={{ borderBottom: '1px solid var(--surface-hairline)' }}
    >
      <div className="ui-note px-4 pt-2.5">{headingLabel}</div>
      {items.map(({ notice, location }) => {
        const titleId = `${titleIdBase}-${notice.id}`;
        return (
        <div key={notice.id} data-security-notice={notice.id} className="flex items-start gap-2.5 px-4 py-3">
          <span className="mt-[3px] shrink-0 text-[var(--accent-yellow)]" aria-hidden="true" {...tokenAttrs('warning', 'accent')}>
            <IconWarning size={13} />
          </span>
          <div className="min-w-0 flex-1">
            <div id={titleId} className="text-[13px] font-medium leading-5 text-[var(--text-main)]">{notice.title}</div>
            <p className="m-0 mt-0.5 text-[11px] leading-4 text-[var(--text-sub2)]" data-derived="textSub2">{notice.body}</p>
            {location && <p className="m-0 mt-0.5 truncate text-[11px] leading-4 text-[var(--text-sub)]" title={location}>{location}</p>}
            <div className="-ml-2.5 mt-1.5 flex items-center gap-1">
              {location !== null && (
                <Button variant="secondary" size="sm" aria-describedby={titleId} onClick={() => onGoToPane(notice)}>
                  {goToPaneLabel}
                </Button>
              )}
              <Button variant="ghost" size="sm" aria-describedby={titleId} onClick={() => onAcknowledge(notice)}>
                {ackLabel}
              </Button>
            </div>
          </div>
        </div>
        );
      })}
    </section>
  );
}

/** The first button of the pinned notice `id` (the first notice when null). */
function firstPinnedButton(panel: HTMLElement | null, id: string | null): HTMLButtonElement | null {
  const notices = [...(panel?.querySelectorAll<HTMLElement>('[data-security-notice]') ?? [])];
  const notice = id === null ? notices[0] : notices.find((el) => el.dataset.securityNotice === id);
  return notice?.querySelector('button') ?? null;
}

// ─── Pure view (exported for tests) ───────────────────────────────────────────

export interface NotificationPanelViewProps {
  notifications: Notification[];     // pre-sorted (DESC) by caller
  /** How each row reads (describeNotification), by id; a row without an
   *  entry shows its raw title and body. */
  displayById?: Readonly<Record<string, NotifDisplay>>;
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
  /** Pending security notices, pinned above the list; none = no section. */
  securityNotices?: readonly PinnedSecurityNotice[];
  securityHeadingLabel?: string;     // t('notification.security.heading')
  securityGoToPaneLabel?: string;    // t('notification.security.goToPane')
  securityAckLabel?: string;         // t('notification.security.ack')
  onSecurityGoToPane?: (notice: SecurityNotice) => void;
  onSecurityAcknowledge?: (notice: SecurityNotice) => void;
  firstUnreadRef?: React.Ref<HTMLDivElement>;
  markAllReadBtnRef?: React.Ref<HTMLButtonElement>;
  listRef?: React.Ref<HTMLDivElement>;
  onListScroll?: React.UIEventHandler<HTMLDivElement>;
  panelRef?: React.Ref<HTMLDivElement>;
}

/**
 * Stateless presentation. Receives all data + handlers via props.
 * Safe to renderToStaticMarkup without any store wiring.
 */
export function NotificationPanelView(props: NotificationPanelViewProps): ReactElement {
  const {
    notifications, displayById, unreadCount, dialogLabel, emptyLabel, toggleHintLabel,
    markAllReadLabel, markWorkspaceReadLabel, clearLabel, closeLabel,
    onNotifClick, onNotifKeyDown, onClose,
    onMarkAllRead, onMarkWorkspaceRead, onClear,
    securityNotices, securityHeadingLabel = '', securityGoToPaneLabel = '', securityAckLabel = '',
    onSecurityGoToPane, onSecurityAcknowledge,
    firstUnreadRef, markAllReadBtnRef, listRef, onListScroll, panelRef,
  } = props;

  const firstUnreadIdx = notifications.findIndex((n) => !n.read);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={dialogLabel}
      // A drawer, not a floating card: the quiet surface rules (hairline, one
      // soft shadow, Inter, flat controls) without the 14px card radius.
      className="ui-surface fixed right-0 bottom-0 w-80 bg-[var(--bg-mantle)] z-50 flex flex-col font-sans notification-panel-enter"
      style={{
        // Hang under the titlebar (#1747). On Windows the top-right
        // TITLEBAR_HEIGHT strip belongs to the native caption buttons
        // (titleBarOverlay), drawn by the OS above any z-index, so a drawer
        // starting at top: 0 put its close button under them.
        top: TITLEBAR_HEIGHT,
        borderLeft: '1px solid var(--surface-hairline)',
        boxShadow: 'var(--surface-shadow)',
      }}
      {...tokenAttrs('bgMantle', 'bg')}
    >
      {/* Header */}
      <div className="flex flex-col gap-2 px-4 pb-2.5 pt-3" style={{ borderBottom: '1px solid var(--surface-hairline)' }}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold leading-5 text-[var(--text-main)]" {...tokenAttrs('textMain', 'text')}>{dialogLabel}</span>
            {unreadCount > 0 && <Badge>{unreadCount}</Badge>}
          </div>
          <Button variant="icon" className="h-7 w-7 shrink-0" onClick={onClose} aria-label={closeLabel}>
            <IconX size={12} />
          </Button>
        </div>
        {notifications.length > 0 && (
          <div className="-ml-2.5 flex flex-wrap items-center gap-1">
            {/* Global mark-all-read (T2). Placed FIRST per plan. */}
            <Button
              ref={markAllReadBtnRef}
              variant="ghost"
              size="sm"
              onClick={onMarkAllRead}
              aria-label={markAllReadLabel}
            >
              {markAllReadLabel}
            </Button>
            {/* Per-workspace mark-all-read (legacy behavior). */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onMarkWorkspaceRead}
              aria-label={markWorkspaceReadLabel}
            >
              {markWorkspaceReadLabel}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hover:text-[var(--accent-red)]"
              onClick={onClear}
              {...tokenAttrs('danger', 'accent')}
            >
              {clearLabel}
            </Button>
          </div>
        )}
      </div>

      {securityNotices && securityNotices.length > 0 && (
        <SecurityNoticesSection
          items={securityNotices}
          headingLabel={securityHeadingLabel}
          goToPaneLabel={securityGoToPaneLabel}
          ackLabel={securityAckLabel}
          onGoToPane={(notice) => onSecurityGoToPane?.(notice)}
          onAcknowledge={(notice) => onSecurityAcknowledge?.(notice)}
        />
      )}

      {/* List */}
      <div ref={listRef} onScroll={onListScroll} data-notification-list className="flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          // A pinned notice above is not "no notifications".
          securityNotices && securityNotices.length > 0 ? null : <div className="flex items-center justify-center h-full text-[13px] text-[var(--text-sub)]" {...tokenAttrs('textSub', 'text')}>
            {emptyLabel}
          </div>
        ) : (
          notifications.map((notif, idx) => {
            const display = displayById?.[notif.id];
            return (
            <div
              key={notif.id}
              ref={idx === firstUnreadIdx ? firstUnreadRef : undefined}
              role="button"
              tabIndex={0}
              aria-label={buildNotifAriaLabel(notif, Date.now(), display)}
              data-notification-row
              data-category={notif.category}
              // The focused row (the panel focuses the first unread one) wears
              // the neutral selection, never the OS focus colour (ui.css).
              className={`wmux-notification-row px-4 py-3 cursor-pointer hover:bg-[var(--surface-fill)] transition-colors ${
                notif.read ? 'opacity-60' : ''
              }`}
              style={{ borderBottom: '1px solid var(--surface-hairline)' }}
              onClick={() => onNotifClick(notif)}
              onKeyDown={(e) => onNotifKeyDown(e, notif)}
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-[3px] shrink-0" aria-hidden="true"><TypeIcon type={notif.type} /></span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={`text-[13px] leading-5 font-medium truncate ${notif.read ? 'text-[var(--text-sub)]' : 'text-[var(--text-main)]'}`}>
                      {display?.title ?? notif.title}
                    </span>
                    <span className="text-[11px] text-[var(--text-sub)] flex-shrink-0 ml-2">
                      {timeAgo(notif.timestamp)}
                    </span>
                  </div>
                  <p className="m-0 mt-0.5 text-[11px] leading-4 text-[var(--text-sub2)] truncate" {...tokenAttrs('textMain', 'text')} data-derived="textSub2" title={display?.body}>{display?.body ?? notif.body}</p>
                </div>
                {!notif.read && (
                  <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] mt-2 flex-shrink-0" {...tokenAttrs('accent', 'accent')} />
                )}
              </div>
            </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      {toggleHintLabel && (
        <div className="ui-note px-4 py-2.5" style={{ borderTop: '1px solid var(--surface-hairline)' }}>
          {toggleHintLabel}
        </div>
      )}
    </div>
  );
}

// ─── Container (store-wired) ──────────────────────────────────────────────────

const NONE: Workspace[] = [];
const EMPTY: Record<string, never> = {};

export default function NotificationPanel() {
  const t = useT();
  const toggleKey = useShortcutLabel('toggleNotifications');
  const notifications = useStore((s) => s.notifications);
  const notificationPanelVisible = useStore((s) => s.notificationPanelVisible);
  const toggleNotificationPanel = useStore((s) => s.toggleNotificationPanel);
  const markRead = useStore((s) => s.markRead);
  const markAllReadForWorkspace = useStore((s) => s.markAllReadForWorkspace);
  const clearNotifications = useStore((s) => s.clearNotifications);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const securityNotices = useStore((s) => s.securityNotices);

  const firstUnreadRef = useRef<HTMLDivElement>(null);
  const markAllReadBtnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Track the notification id the firstUnreadRef captured at render time so
  // the rAF focus pass can detect a race (new notification arrived between
  // render and rAF firing) and degrade to the mark-all button instead of
  // focusing the now-stale row. See useEffect below.
  const firstUnreadIdAtRenderRef = useRef<string | null>(null);

  const sorted = useMemo(() => sortNotificationsDesc(notifications), [notifications]);
  // Read only while the panel is open: a closed panel must not re-render on
  // every agent status change.
  const workspaces = useStore((s) => (s.notificationPanelVisible ? s.workspaces : NONE));
  const surfaceAgent = useStore((s) => (s.notificationPanelVisible ? s.surfaceAgent : EMPTY));
  const surfaceAgentStatus = useStore((s) => (s.notificationPanelVisible ? s.surfaceAgentStatus : EMPTY));
  const surfacePendingQuestion = useStore((s) => (s.notificationPanelVisible ? s.surfacePendingQuestion : EMPTY));
  const displayById = useMemo(() => {
    const out: Record<string, NotifDisplay> = {};
    if (!notificationPanelVisible) return out;
    const seenPty = new Set<string>();
    const state = { workspaces, surfaceAgent, surfaceAgentStatus, surfacePendingQuestion };
    for (const n of sorted) {
      // Newest first: a pane's newest agent row is the one its live question
      // belongs to.
      const latest = (n.category === 'approval' || n.category === 'agent-turn') && !!n.ptyId && !seenPty.has(n.ptyId);
      if (latest && n.ptyId) seenPty.add(n.ptyId);
      out[n.id] = describeNotification(n, state, t, latest);
    }
    return out;
  }, [notificationPanelVisible, sorted, workspaces, surfaceAgent, surfaceAgentStatus, surfacePendingQuestion, t]);
  const pinnedSecurityNotices = useMemo(
    () => pinSecurityNotices(securityNotices, workspaces),
    [securityNotices, workspaces],
  );
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

  // ─── Outside click to close ────────────────────────────────────────────────
  // Deferred one tick (the PresetPicker / create-channel pattern) so the
  // press that opened the panel cannot also close it. Capture phase: xterm
  // stops propagation of some presses (Shift/Option+click in a
  // mouse-tracking terminal), which a bubbling listener would never see.
  //
  // A press inside a browser pane's <webview> lands in the guest page and
  // never reaches this document; the window blurs and the <webview> becomes
  // the active element instead, so that is treated as an outside press too.
  // (A press on the titlebar's drag region reaches neither — known gap.)
  useEffect(() => {
    if (!notificationPanelVisible) return;
    const close = () => useStore.getState().setNotificationPanelVisible(false);
    const onDown = (e: MouseEvent) => {
      if (isOutsidePanelPress(e.target, panelRef.current)) close();
    };
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      // activeElement settles after the blur event; read it a tick later.
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        if (document.activeElement?.tagName === 'WEBVIEW') close();
      }, 0);
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      window.addEventListener('blur', onBlur);
    }, 0);
    return () => {
      clearTimeout(timer);
      clearTimeout(blurTimer);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [notificationPanelVisible]);

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
      } else {
        // No ordinary notifications: the first pinned security notice.
        firstPinnedButton(panelRef.current, null)?.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [notificationPanelVisible]);

  // ─── Focus after acknowledging a pinned notice ─────────────────────────────
  // Its buttons leave the DOM with it; focus goes to the notice that took its
  // place, else Mark all read (acknowledging adds a read row, so it is there),
  // never to <body>.
  const focusAfterAckRef = useRef<{ nextId: string | null } | null>(null);
  useLayoutEffect(() => {
    const pending = focusAfterAckRef.current;
    if (!pending) return;
    focusAfterAckRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (firstPinnedButton(panelRef.current, pending.nextId) ?? markAllReadBtnRef.current)?.focus();
  }, [securityNotices]);

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

  // Acknowledging is the store (unpin; a read row joins the list) and main
  // (forget it, so a reload or another window does not pin it again).
  const handleSecurityAcknowledge = (notice: SecurityNotice) => {
    const idx = securityNotices.findIndex((n) => n.id === notice.id);
    const rest = securityNotices.filter((n) => n.id !== notice.id);
    focusAfterAckRef.current = { nextId: rest[Math.min(idx, rest.length - 1)]?.id ?? null };
    useStore.getState().acknowledgeSecurityNotice(notice.id);
    void window.electronAPI?.notification?.acknowledgeSecurityNotice?.(notice.id)?.catch(() => undefined);
  };

  const handleSecurityGoToPane = (notice: SecurityNotice) => {
    focusNotificationTarget(() => useStore.getState(), { ptyId: notice.ptyId });
    handleSecurityAcknowledge(notice);
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
      displayById={displayById}
      unreadCount={unreadCount}
      dialogLabel={t('notification.title')}
      emptyLabel={t('notification.empty')}
      toggleHintLabel={toggleKey ? t('notification.toggle', { key: toggleKey }) : ''}
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
      securityNotices={pinnedSecurityNotices}
      securityHeadingLabel={t('notification.security.heading')}
      securityGoToPaneLabel={t('notification.security.goToPane')}
      securityAckLabel={t('notification.security.ack')}
      onSecurityGoToPane={handleSecurityGoToPane}
      onSecurityAcknowledge={handleSecurityAcknowledge}
      firstUnreadRef={firstUnreadRef}
      markAllReadBtnRef={markAllReadBtnRef}
      listRef={listRef}
      onListScroll={handleListScroll}
      panelRef={panelRef}
    />
  );
}

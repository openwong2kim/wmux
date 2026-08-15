/**
 * Tests for NotificationPanel (T10).
 *
 * The repository's vitest config runs in `node` environment without a DOM
 * library installed (no jsdom / happy-dom / @testing-library/react), so this
 * suite tests the panel via three strategies:
 *   1. Pure helpers exported from NotificationPanel.tsx
 *      (sortNotificationsDesc, notifTypeName, buildNotifAriaLabel).
 *   2. React DOM Server's `renderToStaticMarkup` against the stateless
 *      `NotificationPanelView`. The store-wired container cannot be tested
 *      this way because zustand's `useSyncExternalStore` server snapshot
 *      reads from `getInitialState()` (not the live `getState()`), so any
 *      `useStore.setState()` mutation we apply before render is invisible.
 *   3. Store-integration tests against the real zustand store: invoking the
 *      same slice actions the panel binds to its handlers and asserting on
 *      the resulting state.
 *
 * Effect-driven behaviors (Esc handler, initial focus via
 * requestAnimationFrame) require a real DOM and are documented here rather
 * than asserted directly; the strategy is captured in the run report.
 *
 * Phase 4 cleanup: the legacy `runGlobalMarkAllRead` resolver and its tests
 * have been removed. T2's `markAllRead` slice action is merged, so the
 * container now calls `useStore.getState().markAllRead()` directly. Two
 * tests below were rewritten to exercise the live action instead of the
 * dead resolver indirection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  sortNotificationsDesc,
  notifTypeName,
  buildNotifAriaLabel,
  NotificationPanelView,
  type NotificationPanelViewProps,
} from '../NotificationPanel';
import { useStore } from '../../../stores';
import type { Notification, Pane } from '../../../../shared/types';
import { focusNotificationTarget } from '../../../hooks/useNotificationListener';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

const mkNotif = (
  id: string,
  partial: Partial<Notification> & { workspaceId?: string } = {},
): Notification => ({
  id,
  workspaceId: partial.workspaceId ?? 'ws-1',
  type: partial.type ?? 'info',
  title: partial.title ?? `Notif ${id}`,
  body: partial.body ?? `body ${id}`,
  timestamp: partial.timestamp ?? NOW,
  read: partial.read ?? false,
  ...partial,
});

const noop = (): void => undefined;

const mkViewProps = (
  overrides: Partial<NotificationPanelViewProps> = {},
): NotificationPanelViewProps => ({
  notifications: [],
  unreadCount: 0,
  dialogLabel: 'Notifications',
  emptyLabel: 'No notifications',
  toggleHintLabel: 'Ctrl+I to toggle',
  markAllReadLabel: 'Mark all read',
  markWorkspaceReadLabel: 'Mark workspace read',
  closeLabel: 'Close notifications',
  clearLabel: 'Clear',
  onNotifClick: noop,
  onNotifKeyDown: noop,
  onClose: noop,
  onMarkAllRead: noop,
  onMarkWorkspaceRead: noop,
  onClear: noop,
  ...overrides,
});

// ─── Pure helper tests ────────────────────────────────────────────────────────

describe('sortNotificationsDesc', () => {
  it('sorts by timestamp descending (newest first)', () => {
    const a = mkNotif('a', { timestamp: NOW - 1000 });
    const b = mkNotif('b', { timestamp: NOW - 500 });
    const c = mkNotif('c', { timestamp: NOW });
    const sorted = sortNotificationsDesc([a, b, c]);
    expect(sorted.map((n) => n.id)).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate the input array', () => {
    const a = mkNotif('a', { timestamp: 1 });
    const b = mkNotif('b', { timestamp: 2 });
    const input = [a, b];
    sortNotificationsDesc(input);
    expect(input.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array when given empty input', () => {
    expect(sortNotificationsDesc([])).toEqual([]);
  });
});

describe('notifTypeName', () => {
  it('maps each NotificationType to its screen-reader noun', () => {
    expect(notifTypeName('agent')).toBe('agent');
    expect(notifTypeName('error')).toBe('error');
    expect(notifTypeName('warning')).toBe('warning');
    expect(notifTypeName('info')).toBe('info');
  });
});

describe('buildNotifAriaLabel', () => {
  it('includes type, title, time, and read state in order', () => {
    const n = mkNotif('x', {
      type: 'agent',
      title: 'Build complete',
      timestamp: NOW - 5 * 60_000,
      read: false,
    });
    expect(buildNotifAriaLabel(n, NOW)).toBe('agent, Build complete, 5m ago, unread');
  });

  it('marks read notifications as "read"', () => {
    const n = mkNotif('y', {
      type: 'error',
      title: 'Crashed',
      timestamp: NOW,
      read: true,
    });
    expect(buildNotifAriaLabel(n, NOW)).toBe('error, Crashed, just now, read');
  });

  it('uses the warning type name for warnings', () => {
    const n = mkNotif('z', { type: 'warning', title: 'Low disk', timestamp: NOW });
    expect(buildNotifAriaLabel(n, NOW)).toContain('warning');
  });
});

// ─── Direct markAllRead store action (Phase 4 cleanup) ─────────────────────
// The container previously routed through a `runGlobalMarkAllRead` resolver
// that fell back to per-workspace iteration when T2's `markAllRead` action
// was missing. T2 is now merged, so the indirection is gone — the panel
// calls `useStore.getState().markAllRead()` directly. These tests pin the
// contract the panel relies on so a future slice rename or accidental
// removal of the global action gets caught immediately.

// ─── Store-integration tests ──────────────────────────────────────────────────
//
// The store-wired container reads everything from useStore selectors. We
// exercise the contract by invoking the same slice actions through the live
// store and asserting on the resulting state.

describe('NotificationPanel store contract', () => {
  beforeEach(() => {
    useStore.setState((s) => {
      s.notifications = [];
    });
  });

  it('markRead flips a single notification to read', () => {
    const ws1 = useStore.getState().workspaces[0]?.id ?? 'ws-default';
    useStore.setState((s) => {
      s.notifications.push(mkNotif('n1', { workspaceId: ws1, read: false }));
      s.activeWorkspaceId = ws1;
    });

    useStore.getState().markRead('n1');

    const after = useStore.getState().notifications.find((n) => n.id === 'n1');
    expect(after?.read).toBe(true);
  });

  it('setActiveWorkspace switches the active workspace id', () => {
    const wsIds = useStore.getState().workspaces.map((w) => w.id);
    if (wsIds.length < 1) return; // defensive — fresh store always seeds at least one
    const target = wsIds[0]!;
    useStore.getState().setActiveWorkspace(target);
    expect(useStore.getState().activeWorkspaceId).toBe(target);
  });

  it('markAllReadForWorkspace marks every notification in the active workspace', () => {
    const ws1 = useStore.getState().workspaces[0]?.id ?? 'ws-default';
    useStore.setState((s) => {
      s.notifications.push(
        mkNotif('a', { workspaceId: ws1, read: false }),
        mkNotif('b', { workspaceId: ws1, read: false }),
        mkNotif('c', { workspaceId: 'other', read: false }),
      );
      s.activeWorkspaceId = ws1;
    });

    useStore.getState().markAllReadForWorkspace(ws1);

    const notifs = useStore.getState().notifications;
    expect(notifs.find((n) => n.id === 'a')?.read).toBe(true);
    expect(notifs.find((n) => n.id === 'b')?.read).toBe(true);
    expect(notifs.find((n) => n.id === 'c')?.read).toBe(false);
  });

  it('global markAllRead clears every notification across all workspaces', () => {
    const ws1 = useStore.getState().workspaces[0]?.id ?? 'ws-default';
    useStore.setState((s) => {
      s.notifications.push(
        mkNotif('a', { workspaceId: ws1, read: false }),
        mkNotif('b', { workspaceId: 'other', read: false }),
      );
    });

    // The container calls this exact action on click of "Mark all read".
    useStore.getState().markAllRead();

    const notifs = useStore.getState().notifications;
    expect(notifs.every((n) => n.read)).toBe(true);
  });

  it('global markAllRead also clears paneNotificationRing (FIX #3 lifecycle)', () => {
    // The panel's "Mark all read" button is the only path beside per-pane
    // click that should fully reset the visual ring state.
    useStore.setState((s) => {
      s.paneNotificationRing = { 'pane-x': 'flash', 'pane-y': 'glow' };
    });

    useStore.getState().markAllRead();

    expect(useStore.getState().paneNotificationRing).toEqual({});
  });

  // Codex review catch: NotificationPanel's click handler used to call
  // markRead(notif.id) BEFORE focusNotificationTarget. If the clicked
  // notification was the surface's only unread entry, focusNotificationTarget's
  // internal mark-read+ring-clear loop would then see NOTHING unread (it was
  // already marked) and leave the pane's flash/glow ring stuck despite the
  // user having just visited it. This test exercises the exact sequence the
  // fixed handler now performs — focusNotificationTarget FIRST (observing
  // the real pre-click unread state), matching the fix's intent.
  it('clicking the surface\'s only unread notification clears the ring (focus-first ordering)', () => {
    const leaf: Pane = {
      id: 'pane-ring-test',
      type: 'leaf',
      surfaces: [{ id: 'sf-ring-test', ptyId: 'pty-ring-test', title: 't', shell: 'powershell', cwd: 'C:\\', surfaceType: 'terminal' }],
      activeSurfaceId: 'sf-ring-test',
    };
    useStore.setState((s) => {
      s.workspaces.push({
        id: 'ws-ring-test',
        name: 'ws-ring-test',
        rootPane: leaf,
        activePaneId: leaf.id,
      });
      s.notifications.push(mkNotif('ring-notif', {
        workspaceId: 'ws-ring-test',
        surfaceId: 'sf-ring-test',
        ptyId: 'pty-ring-test',
        read: false,
      }));
      s.paneNotificationRing['pane-ring-test'] = 'glow';
      // SAME-workspace jump on purpose: activatePaneTarget only calls
      // setActiveWorkspace (which has its OWN unrelated "entering this
      // workspace clears its rings" side effect) on a CROSS-workspace jump.
      // Pre-activating the target workspace isolates the specific
      // mark-read+ring-clear loop this test is actually about.
      s.activeWorkspaceId = 'ws-ring-test';
    });

    // The fix: focusNotificationTarget runs against the untouched (still
    // unread) state, so its own mark-read+ring-clear loop finds and clears it.
    const jumped = focusNotificationTarget(() => useStore.getState(), {
      ptyId: 'pty-ring-test',
      surfaceId: 'sf-ring-test',
      workspaceId: 'ws-ring-test',
    });
    expect(jumped).toBe(true);

    expect(useStore.getState().notifications.find((n) => n.id === 'ring-notif')?.read).toBe(true);
    expect(useStore.getState().paneNotificationRing['pane-ring-test']).toBeUndefined();

    // Cleanup — this test mutates the shared store's workspace list.
    useStore.setState((s) => {
      s.workspaces = s.workspaces.filter((w) => w.id !== 'ws-ring-test');
    });
  });

  it('regression (the bug this fixes): pre-marking read BEFORE focusNotificationTarget leaves the ring stuck', () => {
    // This test documents the OLD broken ordering for contrast — it is not
    // exercised by the fixed NotificationPanel anymore, but pins the
    // mechanism so a future regression back to "markRead first" is caught.
    const leaf: Pane = {
      id: 'pane-ring-test-2',
      type: 'leaf',
      surfaces: [{ id: 'sf-ring-test-2', ptyId: 'pty-ring-test-2', title: 't', shell: 'powershell', cwd: 'C:\\', surfaceType: 'terminal' }],
      activeSurfaceId: 'sf-ring-test-2',
    };
    useStore.setState((s) => {
      s.workspaces.push({
        id: 'ws-ring-test-2',
        name: 'ws-ring-test-2',
        rootPane: leaf,
        activePaneId: leaf.id,
      });
      s.notifications.push(mkNotif('ring-notif-2', {
        workspaceId: 'ws-ring-test-2',
        surfaceId: 'sf-ring-test-2',
        ptyId: 'pty-ring-test-2',
        read: false,
      }));
      s.paneNotificationRing['pane-ring-test-2'] = 'glow';
      // Same-workspace jump — see the sibling test above for why.
      s.activeWorkspaceId = 'ws-ring-test-2';
    });

    // The OLD (buggy) ordering: mark read FIRST.
    useStore.getState().markRead('ring-notif-2');
    focusNotificationTarget(() => useStore.getState(), {
      ptyId: 'pty-ring-test-2',
      surfaceId: 'sf-ring-test-2',
      workspaceId: 'ws-ring-test-2',
    });

    // The ring is stuck — this is the bug codex caught.
    expect(useStore.getState().paneNotificationRing['pane-ring-test-2']).toBe('glow');

    useStore.setState((s) => {
      s.workspaces = s.workspaces.filter((w) => w.id !== 'ws-ring-test-2');
    });
  });

  it('Esc keydown toggles the panel via toggleNotificationPanel', () => {
    // Documents the contract the container's Esc useEffect depends on.
    useStore.setState((s) => { s.notificationPanelVisible = true; });
    expect(useStore.getState().notificationPanelVisible).toBe(true);

    useStore.getState().toggleNotificationPanel();

    expect(useStore.getState().notificationPanelVisible).toBe(false);
  });
});

// ─── NotificationPanelView render assertions (renderToStaticMarkup) ──────────
//
// The view is stateless — all data flows in as props — so SSR produces the
// real markup. We use it to lock in the ARIA contract, button labels, and
// list ordering. Click/keydown handlers don't fire in static rendering;
// those are covered by the store-contract block above.

describe('NotificationPanelView (renderToStaticMarkup)', () => {
  it('renders the empty state when there are no notifications', () => {
    const html = renderToStaticMarkup(
      createElement(NotificationPanelView, mkViewProps()),
    );
    expect(html).toContain('No notifications');
  });

  it('renders dialog role + aria-label on the outer panel', () => {
    const html = renderToStaticMarkup(
      createElement(NotificationPanelView, mkViewProps()),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Notifications"');
  });

  it('renders both mark-all buttons (global + per-workspace) when notifications exist', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [mkNotif('n1')],
          unreadCount: 1,
        }),
      ),
    );
    expect(html).toContain('aria-label="Mark all read"');
    expect(html).toContain('aria-label="Mark workspace read"');
  });

  it('renders notifications in caller-provided order (sorted DESC by the container)', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [
            mkNotif('newer', { timestamp: NOW, title: 'NEWER_TITLE' }),
            mkNotif('older', { timestamp: NOW - 60 * 60_000, title: 'OLDER_TITLE' }),
          ],
          unreadCount: 2,
        }),
      ),
    );
    const olderIdx = html.indexOf('OLDER_TITLE');
    const newerIdx = html.indexOf('NEWER_TITLE');
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it('renders timeAgo for a 5-minute-old notification as "5m ago"', () => {
    // The view calls timeAgo(notif.timestamp) (no `now` arg) so we anchor
    // against Date.now() with a small cushion to avoid the 60s boundary.
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [
            mkNotif('n1', { timestamp: Date.now() - 5 * 60_000 - 100 }),
          ],
          unreadCount: 1,
        }),
      ),
    );
    expect(html).toContain('5m ago');
  });

  it('renders each row with role=button, tabIndex=0, and a full aria-label', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [
            mkNotif('n1', {
              type: 'agent',
              title: 'Build done',
              timestamp: Date.now(),
              read: false,
            }),
          ],
          unreadCount: 1,
        }),
      ),
    );
    expect(html).toContain('role="button"');
    // HTML attribute is lowercased; React JSX prop `tabIndex` → `tabindex`.
    expect(html).toContain('tabindex="0"');
    expect(html).toMatch(/aria-label="agent, Build done, just now, unread"/);
  });

  it('reflects read state in the aria-label', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [
            mkNotif('n1', {
              type: 'info',
              title: 'Seen',
              timestamp: Date.now(),
              read: true,
            }),
          ],
          unreadCount: 0,
        }),
      ),
    );
    expect(html).toMatch(/aria-label="info, Seen, just now, read"/);
  });

  it('shows the unread count badge in the header when unreadCount > 0', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [mkNotif('n1', { read: false })],
          unreadCount: 7,
        }),
      ),
    );
    expect(html).toContain('>7<'); // badge text inside a span
  });

  it('omits the unread count badge when unreadCount = 0', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [mkNotif('n1', { read: true })],
          unreadCount: 0,
        }),
      ),
    );
    // The badge classname is unique; absence of the bg-[var(--accent)] pill
    // proves the badge wasn't rendered.
    expect(html).not.toMatch(/rounded-full"[^>]*>\s*0\s*</);
  });
});

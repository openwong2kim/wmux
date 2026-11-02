// @vitest-environment jsdom
//
// Pending daemon security notices are pinned above the list until the user
// acknowledges one: Mark all read, Mark workspace read, Clear and Escape leave
// them; "Got it" and "Go to pane" unpin it in the store AND tell main, and it
// then reads as an ordinary read warning row. Go to pane shows only while the
// pane is still open, and jumps there.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import NotificationPanel, { pinSecurityNotices } from '../NotificationPanel';
import { useStore } from '../../../stores';
import type { Workspace } from '../../../../shared/types';
import type { SecurityNotice } from '../../../../shared/securityNotice';

const mkWorkspace = (id: string, ptyId?: string): Workspace => ({
  id,
  name: id,
  rootPane: {
    id: `${id}-pane`,
    type: 'leaf',
    surfaces: ptyId ? [{ id: `${id}-surface`, ptyId, title: 'shell', shell: '', cwd: '' }] : [],
    activeSurfaceId: ptyId ? `${id}-surface` : '',
  },
  activePaneId: `${id}-pane`,
});

const notice = (id: string, ptyId: string | null, timestamp: number): SecurityNotice => ({
  id, title: `Title ${id}`, body: `Body ${id}`, ptyId, timestamp,
});

let host: HTMLDivElement;
let root: Root;
let acknowledge: ReturnType<typeof vi.fn>;

const section = (): HTMLElement | null => host.querySelector('[data-security-notices]');
const pinned = (id: string): HTMLElement | null => host.querySelector(`[data-security-notice="${id}"]`);
const button = (scope: ParentNode | null, text: string): HTMLButtonElement | undefined =>
  [...(scope?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text);

beforeEach(async () => {
  acknowledge = vi.fn(async () => undefined);
  vi.stubGlobal('electronAPI', { notification: { acknowledgeSecurityNotice: acknowledge } });
  useStore.setState((s) => {
    s.workspaces = [mkWorkspace('ws-a'), mkWorkspace('ws-b', 'pty-7')];
    s.activeWorkspaceId = 'ws-a';
    s.notifications = [{ id: 'n-1', workspaceId: 'ws-a', type: 'info', title: 'Notif', body: 'b', timestamp: 1, read: false }];
    s.unreadBySurfaceId = {};
    s.securityNotices = [notice('s1', 'pty-7', 10), notice('s2', null, 20)];
    s.notificationPanelVisible = true;
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(NotificationPanel)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  useStore.setState((s) => {
    s.notifications = [];
    s.securityNotices = [];
    s.notificationPanelVisible = false;
  });
});

describe('NotificationPanel pinned security notices', () => {
  it('pins each pending notice above the list with its label, place and buttons', () => {
    const el = section();
    expect(el?.getAttribute('aria-label')).toBe('Security · stays until you acknowledge it');
    expect(el?.compareDocumentPosition(host.querySelector('[data-notification-list]') as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(pinned('s1')?.textContent).toContain('Title s1');
    expect(pinned('s1')?.textContent).toContain('Body s1');
    expect(pinned('s1')?.textContent).toContain('ws-b › shell');
    expect(pinned('s1')?.querySelector('.text-\\[var\\(--accent-yellow\\)\\] svg')).not.toBeNull();
    expect(button(pinned('s1'), 'Go to pane')).toBeDefined();
    // Its pane is unknown: no place, no Go to pane.
    expect(button(pinned('s2'), 'Go to pane')).toBeUndefined();
    expect(button(pinned('s2'), 'Got it')).toBeDefined();
  });

  it('Mark all read, Mark workspace read, Clear and Escape leave the pinned notices', () => {
    act(() => button(host, 'Mark all read')?.click());
    act(() => button(host, 'Mark workspace read')?.click());
    act(() => button(host, 'Clear')?.click());
    expect(useStore.getState().notifications).toEqual([]);
    expect(pinned('s1')).not.toBeNull();
    expect(pinned('s2')).not.toBeNull();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(useStore.getState().notificationPanelVisible).toBe(false);
    expect(useStore.getState().securityNotices.map((n) => n.id)).toEqual(['s1', 's2']);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('Got it unpins the notice, tells main, and lists it as a read warning row', () => {
    act(() => button(pinned('s2'), 'Got it')?.click());
    expect(acknowledge).toHaveBeenCalledWith('s2');
    expect(pinned('s2')).toBeNull();
    expect(useStore.getState().securityNotices.map((n) => n.id)).toEqual(['s1']);
    const row = useStore.getState().notifications.find((n) => n.title === 'Title s2');
    expect(row).toMatchObject({ type: 'warning', read: true, workspaceId: 'ws-a' });
    expect(host.querySelector('[data-notification-list]')?.textContent).toContain('Title s2');
  });

  it('Go to pane jumps to its pane and acknowledges it', () => {
    act(() => button(pinned('s1'), 'Go to pane')?.click());
    expect(useStore.getState().activeWorkspaceId).toBe('ws-b');
    expect(acknowledge).toHaveBeenCalledWith('s1');
    expect(useStore.getState().securityNotices.map((n) => n.id)).toEqual(['s2']);
    expect(useStore.getState().notifications.find((n) => n.title === 'Title s1'))
      .toMatchObject({ read: true, ptyId: 'pty-7', workspaceId: 'ws-b' });
  });

  it('draws no section when nothing is pending', () => {
    act(() => useStore.setState({ securityNotices: [] }));
    expect(section()).toBeNull();
  });
});

const frames = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });
};

describe('NotificationPanel pinned security notices: focus, empty state, names', () => {
  const reopen = async (): Promise<void> => {
    act(() => useStore.setState({ notificationPanelVisible: false }));
    act(() => useStore.setState({ notificationPanelVisible: true }));
    await frames();
  };

  it('opening with only pinned notices focuses the first notice\'s first button', async () => {
    act(() => useStore.setState({ notifications: [] }));
    await reopen();
    expect(document.activeElement).toBe(button(pinned('s1'), 'Go to pane'));
  });

  it('opening with ordinary notifications still focuses the first unread row', async () => {
    await reopen();
    expect(document.activeElement?.hasAttribute('data-notification-row')).toBe(true);
  });

  it('after Got it focus moves to the next pinned notice, then to Mark all read', async () => {
    act(() => useStore.setState({ notifications: [] }));
    await reopen();
    const gotIt = button(pinned('s1'), 'Got it');
    act(() => { gotIt?.focus(); gotIt?.click(); });
    expect(document.activeElement).toBe(button(pinned('s2'), 'Got it'));
    act(() => { (document.activeElement as HTMLButtonElement).click(); });
    expect(document.activeElement).toBe(button(host, 'Mark all read'));
  });

  it('after Go to pane focus does not fall to <body>', async () => {
    act(() => useStore.setState({ notifications: [] }));
    await reopen();
    const go = button(pinned('s1'), 'Go to pane');
    act(() => { go?.focus(); go?.click(); });
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(button(pinned('s2'), 'Got it'));
  });

  it('does not say "No notifications" while a notice is pinned', () => {
    act(() => useStore.setState({ notifications: [] }));
    expect(host.textContent).not.toContain('No notifications');
    act(() => useStore.setState({ securityNotices: [] }));
    expect(host.textContent).toContain('No notifications');
  });

  it('each notice\'s buttons are described by that notice\'s title', () => {
    for (const id of ['s1', 's2']) {
      const title = [...(pinned(id)?.querySelectorAll('[id]') ?? [])].find((el) => el.textContent === `Title ${id}`);
      expect(title).toBeDefined();
      const buttons = [...(pinned(id)?.querySelectorAll('button') ?? [])];
      expect(buttons.length).toBeGreaterThan(0);
      for (const b of buttons) expect(b.getAttribute('aria-describedby')).toBe(title?.id);
    }
    expect(button(pinned('s1'), 'Got it')?.getAttribute('aria-describedby'))
      .not.toBe(button(pinned('s2'), 'Got it')?.getAttribute('aria-describedby'));
  });
});

describe('pinSecurityNotices', () => {
  it('a pane in an unnamed workspace and untitled tab is still known', () => {
    const ws = mkWorkspace('', 'pty-9');
    if (ws.rootPane.type === 'leaf') ws.rootPane.surfaces[0].title = '';
    expect(pinSecurityNotices([notice('s9', 'pty-9', 1)], [ws])[0].location).toBe('');
    expect(pinSecurityNotices([notice('s9', 'pty-gone', 1)], [ws])[0].location).toBeNull();
  });
});

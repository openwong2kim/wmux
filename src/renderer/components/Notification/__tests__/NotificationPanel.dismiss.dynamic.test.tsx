// @vitest-environment jsdom
//
// #1747 — the notification drawer must be closable with the mouse on Windows.
//
// The Windows window uses `titleBarOverlay` (createWindow.ts): the OS draws
// the minimize / maximize / close buttons over the top-right TITLEBAR_HEIGHT
// strip, above any web z-index. A drawer starting at top: 0 put its close
// button under them. jsdom has no layout, so "reachable" is asserted as
// geometry: the drawer (and so its header and close button) starts at or
// below the overlay strip's bottom edge.
//
// Also covered: a press outside the drawer closes it (even when an outer
// handler stops propagation, as xterm does), focus moving into a browser
// pane's <webview> closes it, a press inside or on the real bell does not
// (the bell's click toggles it closed), and Esc still closes it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import NotificationPanel, { isOutsidePanelPress } from '../NotificationPanel';
import { NotificationBellBadgeView } from '../../StatusBar/StatusBar';
import { TITLEBAR_HEIGHT } from '../../Titlebar/Titlebar';
import { useStore } from '../../../stores';
import type { Notification } from '../../../../shared/types';

const mkNotif = (id: string): Notification => ({
  id,
  workspaceId: 'ws-1',
  type: 'info',
  title: `Notif ${id}`,
  body: `body ${id}`,
  timestamp: 1_700_000_000_000,
  read: false,
});

type PlatformWindow = { electronAPI?: { platform: NodeJS.Platform } };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const panel = (): HTMLElement | null => container?.querySelector('[role="dialog"]') ?? null;
const visible = (): boolean => useStore.getState().notificationPanelVisible;

const openPanel = async (): Promise<void> => {
  act(() => {
    useStore.setState((s) => {
      s.notificationPanelVisible = true;
    });
  });
  // The outside-click listener is attached one tick after open.
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const press = (target: Element): void => {
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
};

// The bell mirrors StatusBar's wiring: the real view, toggling the store.
function PanelWithBell() {
  return createElement('div', null,
    createElement(NotificationBellBadgeView, {
      unreadCount: 1,
      onActivate: () => useStore.getState().toggleNotificationPanel(),
    }),
    createElement(NotificationPanel));
}

const mount = (platform: NodeJS.Platform): void => {
  (window as unknown as PlatformWindow).electronAPI = { platform };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r = createRoot(host);
  container = host;
  root = r;
  act(() => r.render(createElement(PanelWithBell)));
};

const tick = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

beforeEach(() => {
  useStore.setState((s) => {
    s.notifications = [mkNotif('n-1')];
    s.notificationPanelVisible = false;
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = '';
  delete (window as unknown as PlatformWindow).electronAPI;
  useStore.setState((s) => {
    s.notifications = [];
    s.notificationPanelVisible = false;
  });
});

describe('NotificationPanel vs the Windows titleBarOverlay (#1747)', () => {
  it('the overlay strip is TITLEBAR_HEIGHT tall (main and renderer agree)', () => {
    const src = readFileSync(resolve(__dirname, '../../../../main/window/createWindow.ts'), 'utf8');
    const m = /titleBarOverlay:\s*\{[^}]*height:\s*(\d+)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(TITLEBAR_HEIGHT);
  });

  it.each(['win32', 'darwin'] as const)('on %s the drawer starts under the titlebar', async (platform) => {
    mount(platform);
    await openPanel();
    const el = panel();
    expect(el).not.toBeNull();
    expect(el?.style.top).toBe(`${TITLEBAR_HEIGHT}px`);
    expect(el?.className).toContain('bottom-0');
    expect(el?.className).not.toMatch(/\btop-0\b|\bh-full\b/);
  });

  it('on win32 the close button sits below the overlay strip and closes the drawer', async () => {
    mount('win32');
    await openPanel();
    const el = panel();
    const close = el?.querySelector<HTMLButtonElement>('button[aria-label]');
    expect(close).toBeTruthy();
    // The header is the drawer's first child; the close button lives in it,
    // so its top edge is >= the drawer's top, which clears the 40px strip.
    expect(el?.firstElementChild?.contains(close ?? null)).toBe(true);
    expect(parseInt(el?.style.top ?? '0', 10)).toBeGreaterThanOrEqual(TITLEBAR_HEIGHT);
    act(() => close?.click());
    expect(visible()).toBe(false);
  });
});

describe('NotificationPanel dismissal', () => {
  it('a press outside the drawer closes it', async () => {
    mount('win32');
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    await openPanel();
    press(outside);
    expect(visible()).toBe(false);
  });

  it('a press inside the drawer keeps it open', async () => {
    mount('win32');
    await openPanel();
    const row = panel()?.querySelector('[role="button"]');
    expect(row).toBeTruthy();
    press(row as Element);
    expect(visible()).toBe(true);
  });

  it('a press on the real bell does not close it first; its click toggles it closed', async () => {
    mount('win32');
    await openPanel();
    const bell = container?.querySelector<HTMLButtonElement>('[data-testid="statusbar-notification-bell"]');
    expect(bell).toBeTruthy();
    press(bell as Element);
    expect(visible()).toBe(true);
    act(() => bell?.click());
    expect(visible()).toBe(false);
    await tick();
    expect(visible()).toBe(false);
  });

  it('closes on an outside press even when an outer handler stops propagation', async () => {
    mount('win32');
    const outer = document.createElement('div');
    const inner = document.createElement('span');
    outer.appendChild(inner);
    // xterm's SelectionService does this for Shift/Option+click.
    outer.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(outer);
    await openPanel();
    press(inner);
    expect(visible()).toBe(false);
  });

  it('closes when focus moves into a browser pane <webview>', async () => {
    mount('win32');
    const webview = document.createElement('webview');
    webview.tabIndex = 0;
    document.body.appendChild(webview);
    await openPanel();
    act(() => {
      webview.focus();
      window.dispatchEvent(new Event('blur'));
    });
    await tick();
    expect(visible()).toBe(false);
  });

  it('stays open when the whole window loses focus (switching apps)', async () => {
    mount('win32');
    await openPanel();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await tick();
    expect(visible()).toBe(true);
  });

  it('the press that opened it does not close it', () => {
    mount('win32');
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    act(() => {
      useStore.setState((s) => {
        s.notificationPanelVisible = true;
      });
    });
    // Same tick as the open: the listener is not attached yet.
    press(outside);
    expect(visible()).toBe(true);
  });

  it('Esc still closes it', async () => {
    mount('win32');
    await openPanel();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(visible()).toBe(false);
  });

  it('isOutsidePanelPress ignores a missing panel or a non-element target', () => {
    const el = document.createElement('div');
    expect(isOutsidePanelPress(document.body, null)).toBe(false);
    expect(isOutsidePanelPress(null, el)).toBe(false);
    expect(isOutsidePanelPress(document.body, el)).toBe(true);
  });
});

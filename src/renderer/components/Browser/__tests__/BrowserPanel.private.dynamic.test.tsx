// @vitest-environment jsdom
//
// Private browser tabs: the <webview> of a private tab must not mount while a
// wipe of the private session is still in flight (the last private tab just
// closed), or the wipe takes the new tab's cookies with it. And in a narrow
// pane the "Private" badge folds to its padlock so the address keeps room.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BrowserPanel from '../BrowserPanel';
import BrowserToolbar, { privateBadgeCompact } from '../BrowserToolbar';
import { useStore } from '../../../stores';
import { PRIVATE_BROWSER_PARTITION } from '../../../../shared/privateBrowser';
import { beginPrivateSessionClear, isPrivateSessionReady } from '../../../utils/privateSessionGate';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(element: React.ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(element); });
}

function panel(partition: string): React.ReactElement {
  return React.createElement(BrowserPanel, {
    surfaceId: 'surf-p',
    workspaceId: 'ws-test',
    initialUrl: 'https://example.com',
    partition,
    isActive: true,
    onClose: noop,
  });
}

const noop = vi.fn();
const webview = () => document.querySelector('webview[data-surface-id="surf-p"]');

beforeEach(() => {
  act(() => { useStore.setState({ locale: 'en' }); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('private BrowserPanel waits for a pending session wipe', () => {
  it('mounts the webview only after the in-flight clear resolves', async () => {
    let finish!: () => void;
    beginPrivateSessionClear(() => new Promise<void>((resolve) => { finish = resolve; }));
    expect(isPrivateSessionReady()).toBe(false);

    render(panel(PRIVATE_BROWSER_PARTITION));
    expect(webview()).toBeNull();

    await act(async () => {
      finish();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(isPrivateSessionReady()).toBe(true);
    expect(webview()).not.toBeNull();
    expect(webview()?.getAttribute('partition')).toBe(PRIVATE_BROWSER_PARTITION);
  });

  it('a normal tab never waits for the private wipe', async () => {
    let finish!: () => void;
    beginPrivateSessionClear(() => new Promise<void>((resolve) => { finish = resolve; }));

    render(panel('persist:wmux-default'));
    expect(webview()).not.toBeNull();

    await act(async () => { finish(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  });

  it('a private tab with no clear pending mounts at once', () => {
    render(panel(PRIVATE_BROWSER_PARTITION));
    expect(webview()).not.toBeNull();
  });
});

describe('private badge in a narrow toolbar', () => {
  function toolbarAt(width: number): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect);
    render(React.createElement(BrowserToolbar, {
      currentUrl: 'https://example.com/',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: true,
      isPrivate: true,
      inspecting: false,
      onNavigate: noop,
      onBack: noop,
      onForward: noop,
      onRefresh: noop,
      onToggleInspect: noop,
      onOpenDevTools: noop,
      onClose: noop,
    }));
  }
  const badge = () => document.querySelector<HTMLElement>('[data-private-browser-badge]');

  it('folds to the padlock in a ~370px pane, keeping its accessible name', () => {
    toolbarAt(370);
    expect(badge()?.dataset.privateBrowserBadge).toBe('compact');
    expect(badge()?.getAttribute('aria-label')).toBe('Private tab');
    expect(badge()?.textContent).toBe('');
  });

  it('shows the word at a comfortable width', () => {
    toolbarAt(800);
    expect(badge()?.dataset.privateBrowserBadge).toBe('full');
    expect(badge()?.textContent).toBe('Private');
  });

  it('keeps the address field a minimum width and clipped', () => {
    toolbarAt(370);
    const form = document.querySelector('form');
    expect(form?.className).toContain('min-w-[64px]');
    expect(form?.className).toContain('overflow-hidden');
  });

  it('treats unmeasured or hidden (0) widths as not narrow', () => {
    expect(privateBadgeCompact(null)).toBe(false);
    expect(privateBadgeCompact(0)).toBe(false);
    expect(privateBadgeCompact(519)).toBe(true);
    expect(privateBadgeCompact(520)).toBe(false);
  });
});

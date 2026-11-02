// @vitest-environment jsdom
//
// The workspace row's context menu stays inside the window: opened near the
// bottom it moves up to fit, and when rows fill in after it opened (the
// account rows load late) it moves up again.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceItem from '../WorkspaceItem';
import { keepSubmenuInWindow } from '../../../utils/keepSubmenuInWindow';
import { useStore } from '../../../stores';
import type { Pane, Surface, Workspace } from '../../../../shared/types';

vi.mock('../../../utils/keepSubmenuInWindow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/keepSubmenuInWindow')>();
  return { ...actual, keepSubmenuInWindow: vi.fn(actual.keepSubmenuInWindow) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const surface: Surface = { id: 's1', ptyId: 'pty-1', title: '', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal' };
const ws: Workspace = {
  id: 'ws-1',
  name: 'app',
  activePaneId: 'p1',
  rootPane: { id: 'p1', type: 'leaf', surfaces: [surface], activeSurfaceId: 's1' } as Pane,
} as Workspace;

const noop = () => undefined;

// jsdom lays nothing out: give the menu (the only `fixed` element) a size, and
// keep the ResizeObserver callbacks so a test can report a resize.
let menuHeight = 300;
const observers: Array<{ cb: ResizeObserverCallback; targets: Element[] }> = [];
const savedRO = globalThis.ResizeObserver;
const savedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
const savedWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;

const menu = () => container.querySelector<HTMLElement>('div.fixed');

function openMenuAt(clientX: number, clientY: number): void {
  const row = container.querySelector('[role="treeitem"]')!;
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
  });
}

beforeEach(async () => {
  menuHeight = 300;
  observers.length = 0;
  globalThis.ResizeObserver = class {
    private entry: { cb: ResizeObserverCallback; targets: Element[] };
    constructor(cb: ResizeObserverCallback) { this.entry = { cb, targets: [] }; observers.push(this.entry); }
    observe(el: Element) { this.entry.targets.push(el); }
    unobserve() { /* inert */ }
    disconnect() { this.entry.targets = []; }
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('fixed') ? menuHeight : 0; },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('fixed') ? 200 : 0; },
  });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });

  useStore.setState({ ...useStore.getInitialState(), locale: 'en', workspaces: [ws], activeWorkspaceId: 'ws-other' });
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
  await act(async () => {
    root.render(createElement(WorkspaceItem, {
      workspaceId: 'ws-1', isActive: false, isMultiview: false, index: 0,
      onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop,
      onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
    }));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.ResizeObserver = savedRO;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', savedHeight);
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', savedWidth);
});

describe('workspace row menu fits the window', () => {
  it('stays at the pointer when it fits', () => {
    openMenuAt(50, 100);
    expect(menu()!.style.top).toBe('100px');
    expect(menu()!.style.left).toBe('50px');
  });

  it('moves up and left when opened near the bottom-right corner', () => {
    openMenuAt(900, 700);
    // 800 - 300 - 4, 1000 - 200 - 4
    expect(menu()!.style.top).toBe('496px');
    expect(menu()!.style.left).toBe('796px');
  });

  it('refits when rows fill in after the menu opened', () => {
    openMenuAt(50, 400);
    expect(menu()!.style.top).toBe('400px');

    menuHeight = 500;
    const el = menu()!;
    const watching = observers.filter((o) => o.targets.includes(el));
    expect(watching.length).toBeGreaterThan(0);
    act(() => { for (const o of watching) o.cb([], {} as ResizeObserver); });
    // 800 - 500 - 4
    expect(el.style.top).toBe('296px');
  });

  it('stops watching once the menu closes', () => {
    openMenuAt(50, 400);
    const el = menu()!;
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(menu()).toBeNull();
    expect(observers.some((o) => o.targets.includes(el))).toBe(false);
  });

  it('fits the snooze submenu once, not again on every re-render', () => {
    openMenuAt(50, 100);
    act(() => { container.querySelector<HTMLButtonElement>('[data-workspace-action="snooze"]')!.click(); });
    const submenu = container.querySelector('[data-snooze-preset]')!.closest('[role="menu"]');
    const fits = () => vi.mocked(keepSubmenuInWindow).mock.calls.filter(([el]) => el === submenu).length;
    expect(fits()).toBe(1);

    // A re-run would read the side to open on from its own flipped position
    // and undo the flip.
    act(() => { useStore.setState({ workspaces: [{ ...ws, name: 'renamed' }] }); });
    expect(container.textContent).toContain('renamed');
    expect(fits()).toBe(1);
  });
});

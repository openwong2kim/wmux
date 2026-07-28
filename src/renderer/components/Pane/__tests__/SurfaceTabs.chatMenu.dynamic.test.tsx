// @vitest-environment jsdom
//
// Chat View toggle on the surface-tab context menu.
//
// Right-click is already the app's menu gesture (the terminal body has carried
// one for a long time), so the per-surface view mode rides that same menu
// component instead of a second one. What matters here:
//   • right-clicking a tab — or the pane label — opens the menu and flips
//     `Surface.chatMode`, including for a pane that does NOT hold focus, which
//     the keyboard chord can never address;
//   • a pane whose agent publishes no transcript at all (Codex/Gemini) gets no
//     row and no menu — a permanently dead control must not hold a seat;
//   • the transient "not yet" DOES get a row, greyed, carrying the projector's
//     own reason string.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import { findLeaf } from '../../../../shared/paneUtils';
import type { Surface, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const PTY = 'pty-chatmenu-1';
const SURFACE_ID = 'sf-chatmenu-1';

function activeWs(): Workspace {
  const s = useStore.getState();
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
}

function terminalSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    id: SURFACE_ID,
    ptyId: PTY,
    title: 'Terminal',
    shell: '',
    cwd: '/repo',
    surfaceType: 'terminal',
    ...overrides,
  };
}

function seedSurface(overrides: Partial<Surface> = {}): void {
  useStore.setState((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
    const leaf = findLeaf(ws.rootPane, ws.rootPane.id);
    if (!leaf) return;
    leaf.surfaces.length = 0;
    leaf.surfaces.push(terminalSurface(overrides));
    leaf.activeSurfaceId = SURFACE_ID;
  });
}

function storedSurface(): Surface | undefined {
  const ws = activeWs();
  return findLeaf(ws.rootPane, ws.rootPane.id)?.surfaces.find((s) => s.id === SURFACE_ID);
}

/** `paneActive` is false on purpose: an unfocused pane must still be togglable. */
function mount(surfaces: Surface[]): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces,
        activeSurfaceId: surfaces[0]?.id ?? '',
        workspace: ws,
        paneId: ws.rootPane.id,
        paneActive: false,
        onSelect: () => undefined,
        onClose: () => undefined,
        onSplitHorizontal: () => undefined,
        onSplitVertical: () => undefined,
        onAddBrowser: () => undefined,
      }),
    );
  });
}

function rightClick(selector: string): void {
  const el = container.querySelector(selector);
  expect(el, `${selector} should be present`).not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 12 }));
  });
}

function menu(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-context-menu]');
}

function items(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-context-menu] button'));
}

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  useStore.setState((s) => {
    s.workspaces = s.workspaces.filter((w) => w.id === s.activeWorkspaceId);
    s.chatStatus = {};
  });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('SurfaceTabs — Chat View on the tab context menu', () => {
  it('right-clicking a tab flips an unfocused pane into Chat', () => {
    useStore.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    seedSurface();
    mount([terminalSurface()]);

    rightClick('[data-pane-tab]');
    // One row, and it teaches the chord the keyboard binds (OS-dependent).
    expect(items()).toHaveLength(1);
    expect(items()[0].textContent).toMatch(/^Show as chat(⇧⌘J|Ctrl\+Shift\+J)$/);

    act(() => { items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(storedSurface()?.chatMode).toBe(true);
    expect(menu()).toBeNull();
  });

  it('offers the way back once the surface renders as Chat', () => {
    useStore.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    seedSurface({ chatMode: true });
    mount([terminalSurface({ chatMode: true })]);

    rightClick('[data-pane-tab]');
    expect(items()[0].textContent).toContain('Show as terminal');

    act(() => { items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(storedSurface()?.chatMode).toBeUndefined();
  });

  it('the pane label opens the same menu for the active surface', () => {
    useStore.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    seedSurface();
    mount([terminalSurface()]);

    rightClick('[data-pane-label]');
    act(() => { items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(storedSurface()?.chatMode).toBe(true);
  });

  it('opens no menu at all for an agent that publishes no transcript', () => {
    useStore.getState().setChatStatus(PTY, { available: false, reason: 'not-claude' });
    seedSurface();
    mount([terminalSurface()]);

    rightClick('[data-pane-tab]');
    expect(menu()).toBeNull();
  });

  it('greys the row, with the projector reason, before the first turn lands', () => {
    useStore.getState().setChatStatus(PTY, { available: false, reason: 'no-transcript-path' });
    seedSurface();
    mount([terminalSurface()]);

    rightClick('[data-pane-tab]');
    const item = items()[0];
    expect(item.disabled).toBe(true);
    expect(item.getAttribute('title')).toBe(
      "Chat View opens after this agent's first turn completes.",
    );

    act(() => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(storedSurface()?.chatMode).toBeUndefined();
  });

  it('opens no menu on a surface with nothing behind it', () => {
    useStore.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    mount([{ id: 'sf-browser', ptyId: '', title: 'Browser', shell: '', cwd: '', surfaceType: 'browser' }]);

    rightClick('[data-pane-tab]');
    expect(menu()).toBeNull();
  });

  it('Escape dismisses the menu', () => {
    useStore.getState().setChatStatus(PTY, { available: true, reason: 'ok' });
    seedSurface();
    mount([terminalSurface()]);

    rightClick('[data-pane-tab]');
    expect(menu()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
  });
});

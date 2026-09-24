// @vitest-environment jsdom
//
// #1455 — Settings → Shortcuts moves and switches off built-in shortcuts.
//
// Mounts the REAL tab against the REAL store and drives it with real clicks and
// keydowns, so what is under test is the override the keyboard gates will
// read: the row's key badge opens the recorder, the next chord becomes the
// action's binding, and a chord that would leave something unreachable is
// refused on the row instead of written.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TabShortcuts } from '../SettingsPanel';
import { useStore } from '../../../stores';
import { useKeyboard } from '../../../hooks/useKeyboard';
import { createWorkspace } from '../../../../shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const PREV = 'Previous workspace';

/** The row's key badge — the button that records a new combo. */
function badge(description: string): HTMLButtonElement {
  const el = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .find((b) => b.getAttribute('aria-label')?.startsWith(`${description} (`));
  if (!el) throw new Error(`no key badge for ${description}`);
  return el;
}

function toggle(description: string): HTMLButtonElement {
  const el = [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
    .find((b) => b.getAttribute('aria-label')?.startsWith(`${description} (`));
  if (!el) throw new Error(`no toggle for ${description}`);
  return el;
}

function click(el: HTMLElement): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

function press(init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

const overrides = () => useStore.getState().shortcutOverrides;

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: () => undefined },
    pty: { dispose: () => undefined, create: () => undefined, write: () => undefined },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => useStore.setState({ shortcutOverrides: {} }));
  act(() => root.render(createElement(Harness)));
});

/** The tab, with the app's global shortcut hook live — as in the real window. */
function Harness() {
  useKeyboard();
  return createElement(TabShortcuts);
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Settings → Shortcuts (#1455)', () => {
  it('lists every configurable built-in with its current key', () => {
    expect(badge(PREV).textContent).toBe('Alt+ArrowUp');
    expect(badge('Next workspace').textContent).toBe('Alt+ArrowDown');
    expect(badge('Switch to workspace 3').textContent).toBe('Ctrl+3');
  });

  it('moves a shortcut to the next chord pressed', () => {
    click(badge(PREV));
    press({ key: 'Alt' });                       // modifiers alone are not a combo
    expect(overrides()).toEqual({});
    press({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
    expect(overrides()).toEqual({ prevWorkspace: 'Ctrl+Alt+K' });
    expect(badge(PREV).textContent).toBe('Ctrl+Alt+K');
  });

  it('refuses a chord another action holds, and says which', () => {
    click(badge(PREV));
    press({ key: 't', code: 'KeyT', ctrlKey: true });
    expect(overrides()).toEqual({});
    expect(container.textContent).toContain('Already used by “New terminal in this pane”');
  });

  it('refuses a chord with no Ctrl / Alt, which would eat typing', () => {
    click(badge(PREV));
    press({ key: 'k', code: 'KeyK' });
    expect(overrides()).toEqual({});
    expect(container.textContent).toContain('Hold Ctrl, ⌘ or Alt');
  });

  it('a chord that is already a shortcut reaches the recorder instead of running', () => {
    // useKeyboard listens on the same capture phase and registered first;
    // without standing down it would switch workspace and swallow the key.
    const workspaces = ['a', 'b'].map((n) => createWorkspace(n));
    act(() => useStore.setState({ workspaces, activeWorkspaceId: workspaces[0].id }));
    click(badge(PREV));
    press({ key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    expect(useStore.getState().activeWorkspaceId).toBe(workspaces[0].id);
    expect(container.textContent).toContain('Already used by “Next workspace”');
    // Recorder closed: the shortcut works again.
    expect(useStore.getState().keyCaptureActive).toBe(false);
    press({ key: 'ArrowDown', code: 'ArrowDown', altKey: true });
    expect(useStore.getState().activeWorkspaceId).toBe(workspaces[1].id);
  });

  it('recording under an IME: the follow-up keydown does not run the new binding', () => {
    // Hangul composition: one Ctrl+Alt+K press is `Process` then `k`. The
    // recorder takes the first and closes; the second must not then fire
    // the shortcut it was just bound to.
    const workspaces = ['a', 'b'].map((n) => createWorkspace(n));
    act(() => useStore.setState({ workspaces, activeWorkspaceId: workspaces[1].id }));
    click(badge(PREV));
    press({ key: 'Process', code: 'KeyK', ctrlKey: true, altKey: true });
    expect(overrides()).toEqual({ prevWorkspace: 'Ctrl+Alt+K' });
    press({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
    expect(useStore.getState().activeWorkspaceId).toBe(workspaces[1].id);
  });

  it('Escape cancels the recorder without a change', () => {
    click(badge(PREV));
    press({ key: 'Escape', code: 'Escape' });
    press({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
    expect(overrides()).toEqual({});
  });

  it('switches a shortcut off and back on', () => {
    click(toggle(PREV));
    expect(overrides()).toEqual({ prevWorkspace: null });
    expect(toggle(PREV).getAttribute('aria-checked')).toBe('false');
    click(toggle(PREV));
    expect(overrides()).toEqual({});
  });

  it('Reset puts a moved shortcut back on its default', () => {
    act(() => useStore.getState().setShortcutOverride('prevWorkspace', 'Ctrl+Alt+K'));
    const reset = container.querySelector<HTMLButtonElement>(`button[aria-label="Reset: ${PREV}"]`);
    expect(reset).not.toBeNull();
    click(reset as HTMLButtonElement);
    expect(overrides()).toEqual({});
  });

  it('will not reset onto a default another action has taken meanwhile', () => {
    act(() => useStore.getState().setShortcutOverride('prevWorkspace', null));
    act(() => useStore.getState().setShortcutOverride('nextWorkspace', 'Alt+ArrowUp'));
    click(toggle(PREV));
    expect(overrides()).toEqual({ prevWorkspace: null, nextWorkspace: 'Alt+ArrowUp' });
    expect(container.textContent).toContain('Already used by “Next workspace”');
  });
});

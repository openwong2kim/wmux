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
import { buildDefaultCustomKeybindings, createWorkspace } from '../../../../shared/types';

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
    // #1885 — Windows has no ⌘ key, so the hint does not name it.
    expect(container.textContent).toContain('Hold Ctrl or Alt (or use an F-key)');
    expect(container.textContent).not.toContain('⌘');
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

describe('Settings → Shortcuts search', () => {
  const search = () => container.querySelector<HTMLInputElement>('[data-testid="shortcut-search"]')!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search(), value);
    search().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const shown = () => [...container.querySelectorAll('button[aria-label]')]
    .map((b) => b.getAttribute('aria-label') ?? '')
    .filter((label) => / \(/.test(label));

  it('filters by the action name', () => {
    type('previous work');
    expect(shown().every((l) => l.toLowerCase().includes('previous work'))).toBe(true);
    expect(shown().length).toBeGreaterThan(0);
  });

  it('filters by the key combo, ignoring case, spaces and "+"', () => {
    type('alt arrowup');
    expect(shown().some((l) => l.startsWith(`${PREV} (`))).toBe(true);
    expect(shown().some((l) => l.startsWith('Next workspace ('))).toBe(false);
  });

  it('finds macOS symbol combos by modifier name', () => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI.platform = 'darwin';
    act(() => root.render(createElement(Harness)));
    expect(badge(PREV).textContent).toBe('⌥+ArrowUp');
    type('option arrowup');
    expect(shown().some((l) => l.startsWith(`${PREV} (`))).toBe(true);
    expect(shown().some((l) => l.startsWith('Next workspace ('))).toBe(false);
  });

  it('says so when nothing matches, and shows every row again when cleared', () => {
    const all = shown().length;
    type('zzzz-no-such-shortcut');
    expect(shown()).toEqual([]);
    expect(container.textContent).toContain('No shortcuts match');
    type('');
    expect(shown().length).toBe(all);
  });
});

// #1885 — built-ins run before custom keybindings. Taking a custom
// keybinding's key (or putting one on a built-in's key) leaves the custom one
// dead, so Settings asks first: Use anyway saves, Cancel keeps the old key.
describe('Settings → Shortcuts: keys custom keybindings use (#1885)', () => {
  const dialog = () => container.querySelector<HTMLElement>('[data-testid="key-conflict-confirm"]');
  const cancel = () => container.querySelector<HTMLButtonElement>('[data-key-conflict-cancel]') as HTMLButtonElement;
  const useAnyway = () => container.querySelector<HTMLButtonElement>('[data-key-conflict-confirm]') as HTMLButtonElement;
  const customKeys = () => useStore.getState().customKeybindings.map((kb) => kb.key);
  const customBadge = (key: string) => {
    const el = [...container.querySelectorAll<HTMLButtonElement>('button.settings-kbd')]
      .find((b) => b.textContent === key);
    if (!el) throw new Error(`no custom keybinding badge ${key}`);
    return el;
  };

  beforeEach(() => {
    act(() => useStore.setState({
      customKeybindings: buildDefaultCustomKeybindings('win32').map((kb) => ({ ...kb })),
    }));
  });

  it('warns before a built-in takes the default F7 keybinding, and Cancel keeps the old key', () => {
    click(badge(PREV));
    press({ key: 'F7', code: 'F7' });
    expect(overrides()).toEqual({});
    expect(dialog()?.textContent).toContain('F7 is already used by “Claude (skip permissions)”');
    expect(dialog()?.textContent).toContain('stops working');
    // The safe answer holds the focus, so Enter does not take the key.
    expect(document.activeElement).toBe(cancel());
    click(cancel());
    expect(dialog()).toBeNull();
    expect(overrides()).toEqual({});
    expect(badge(PREV).textContent).toBe('Alt+ArrowUp');
  });

  it('Use anyway moves the built-in onto F7, as before', () => {
    click(badge(PREV));
    press({ key: 'F7', code: 'F7' });
    click(useAnyway());
    expect(dialog()).toBeNull();
    expect(overrides()).toEqual({ prevWorkspace: 'F7' });
    expect(badge(PREV).textContent).toBe('F7');
  });

  it('Escape answers Cancel', () => {
    click(badge(PREV));
    press({ key: 'F7', code: 'F7' });
    act(() => {
      (document.activeElement ?? window).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(dialog()).toBeNull();
    expect(overrides()).toEqual({});
  });

  it('a key no custom keybinding uses saves with no question', () => {
    click(badge(PREV));
    press({ key: 'F8', code: 'F8' });
    expect(dialog()).toBeNull();
    expect(overrides()).toEqual({ prevWorkspace: 'F8' });
  });

  it('warns that a custom keybinding on a built-in key will not fire', () => {
    click(customBadge('F7'));
    press({ key: 't', code: 'KeyT', ctrlKey: true });
    expect(dialog()?.textContent).toContain('Ctrl+T is already used by “New terminal in this pane”');
    expect(dialog()?.textContent).toContain('will not fire');
    click(cancel());
    expect(customKeys()).toEqual(['F7']);

    click(customBadge('F7'));
    press({ key: 't', code: 'KeyT', ctrlKey: true });
    click(useAnyway());
    expect(customKeys()).toEqual(['Ctrl+T']);
  });

  it('a custom keybinding on a free key saves with no question', () => {
    click(customBadge('F7'));
    press({ key: 'F9', code: 'F9' });
    expect(dialog()).toBeNull();
    expect(customKeys()).toEqual(['F9']);
  });
});

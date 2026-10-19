// @vitest-environment jsdom
//
// #1455 — Alt+Up / Alt+Down cycle workspaces, and Settings → Shortcuts can
// switch either one off, or move it, so a TUI in the pane (Codex, Crush, …)
// gets the key. Drives the real hook and store with real KeyboardEvents: a
// released combo must neither switch workspace nor preventDefault / stop the
// event, or xterm never sees it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspace } from '../../../shared/types';
import type { ShortcutOverrides } from '../../../shared/keymap';
import { useStore } from '../../stores';
import { useKeyboard } from '../useKeyboard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  function Harness(): null {
    useKeyboard();
    return null;
  }

  act(() => {
    root.render(React.createElement(Harness));
  });
}

/** Dispatch a keydown and report whether it reached a later listener. */
function press(init: KeyboardEventInit): { event: KeyboardEvent; reachedTarget: boolean } {
  let reachedTarget = false;
  const later = (): void => { reachedTarget = true; };
  // Bubble-phase window listener: runs after useKeyboard's capture handler,
  // so it only fires when that handler did not stopImmediatePropagation.
  window.addEventListener('keydown', later);
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  window.removeEventListener('keydown', later);
  return { event, reachedTarget };
}

function seedWorkspaces(overrides: ShortcutOverrides): string[] {
  const workspaces = ['one', 'two', 'three'].map((name) => createWorkspace(name));
  act(() => {
    useStore.setState((state) => {
      state.workspaces = workspaces;
      state.activeWorkspaceId = workspaces[1].id;
      state.shortcutOverrides = overrides;
      state.setPrefixMode(false);
    });
  });
  return workspaces.map((ws) => ws.id);
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: vi.fn() },
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
});

afterEach(() => {
  if (root) {
    act(() => root.unmount());
  }
  container?.remove();
});

describe('#1455 Alt+Arrow workspace cycling toggle', () => {
  it('enabled (default): Alt+Up/Down switch workspace and swallow the key', () => {
    const ids = seedWorkspaces({});
    mount();

    const up = press({ altKey: true, key: 'ArrowUp', code: 'ArrowUp' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[0]);
    expect(up.event.defaultPrevented).toBe(true);
    expect(up.reachedTarget).toBe(false);

    press({ altKey: true, key: 'ArrowDown', code: 'ArrowDown' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[1]);
  });

  it('disabled: the key is left alone for the terminal', () => {
    const ids = seedWorkspaces({ prevWorkspace: null, nextWorkspace: null });
    mount();

    for (const key of ['ArrowUp', 'ArrowDown']) {
      const { event, reachedTarget } = press({ altKey: true, key, code: key });
      expect(useStore.getState().activeWorkspaceId).toBe(ids[1]);
      expect(event.defaultPrevented).toBe(false);
      expect(reachedTarget).toBe(true);
    }
  });

  it('each direction is its own toggle', () => {
    const ids = seedWorkspaces({ prevWorkspace: null });
    mount();

    press({ altKey: true, key: 'ArrowUp', code: 'ArrowUp' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[1]);

    press({ altKey: true, key: 'ArrowDown', code: 'ArrowDown' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[2]);
  });

  it('Meta+Alt+Arrow is not Alt+Arrow — it never switched off a released row', () => {
    const ids = seedWorkspaces({ prevWorkspace: null });
    mount();

    press({ altKey: true, metaKey: true, key: 'ArrowUp', code: 'ArrowUp' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[1]);
  });

  it('moved: the new combo switches workspace and the old one goes to the pane', () => {
    const ids = seedWorkspaces({ prevWorkspace: 'Ctrl+Alt+K' });
    mount();

    const old = press({ altKey: true, key: 'ArrowUp', code: 'ArrowUp' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[1]);
    expect(old.event.defaultPrevented).toBe(false);

    const moved = press({ ctrlKey: true, altKey: true, key: 'k', code: 'KeyK' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[0]);
    expect(moved.event.defaultPrevented).toBe(true);
  });
});

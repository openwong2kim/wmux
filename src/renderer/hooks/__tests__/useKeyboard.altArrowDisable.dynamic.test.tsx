// @vitest-environment jsdom
//
// #1455 — Alt+Up / Alt+Down cycle workspaces, and Settings → Shortcuts can
// switch either one off so a TUI in the pane (Codex, Crush, …) gets the key.
// Drives the real hook and store with real KeyboardEvents: a disabled row
// must neither switch workspace nor preventDefault / stop the event, or
// xterm never sees it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspace } from '../../../shared/types';
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

function seedWorkspaces(disabled: string[]): string[] {
  const workspaces = ['one', 'two', 'three'].map((name) => createWorkspace(name));
  act(() => {
    useStore.setState((state) => {
      state.workspaces = workspaces;
      state.activeWorkspaceId = workspaces[1].id;
      state.disabledShortcuts = disabled;
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
    const ids = seedWorkspaces([]);
    mount();

    const up = press({ altKey: true, key: 'ArrowUp', code: 'ArrowUp' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[0]);
    expect(up.event.defaultPrevented).toBe(true);
    expect(up.reachedTarget).toBe(false);

    press({ altKey: true, key: 'ArrowDown', code: 'ArrowDown' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[1]);
  });

  it('disabled: the key is left alone for the terminal', () => {
    const ids = seedWorkspaces(['Alt+ArrowUp', 'Alt+ArrowDown']);
    mount();

    for (const key of ['ArrowUp', 'ArrowDown']) {
      const { event, reachedTarget } = press({ altKey: true, key, code: key });
      expect(useStore.getState().activeWorkspaceId).toBe(ids[1]);
      expect(event.defaultPrevented).toBe(false);
      expect(reachedTarget).toBe(true);
    }
  });

  it('each direction is its own toggle', () => {
    const ids = seedWorkspaces(['Alt+ArrowUp']);
    mount();

    press({ altKey: true, key: 'ArrowUp', code: 'ArrowUp' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[1]);

    press({ altKey: true, key: 'ArrowDown', code: 'ArrowDown' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[2]);
  });

  it('disabled row does not fire as Meta+Alt+Arrow either', () => {
    const ids = seedWorkspaces(['Alt+ArrowUp']);
    mount();

    press({ altKey: true, metaKey: true, key: 'ArrowUp', code: 'ArrowUp' });
    expect(useStore.getState().activeWorkspaceId).toBe(ids[1]);
  });
});

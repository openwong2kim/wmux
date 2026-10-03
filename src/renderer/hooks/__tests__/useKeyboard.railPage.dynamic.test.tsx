// @vitest-environment jsdom
//
// Another rail page covers the panes (mounted, inert). Shortcuts that act on a
// pane, its PTY or the layout must not run there, and the tmux prefix must not
// arm or survive a page switch — a key typed on Fleet must never reach a
// terminal the user cannot see.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useKeyboard, WORKSPACES_ONLY_ACTIONS } from '../useKeyboard';
import { useStore } from '../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function press(init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: vi.fn() },
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
  act(() => {
    useStore.getState().setTerminalFontSize(14);
    useStore.getState().setPrefixMode(false);
    useStore.getState().setAppRoute('workspaces');
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useKeyboard();
    return null;
  }
  act(() => root.render(React.createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.getState().setAppRoute('workspaces'));
});

describe('shortcuts on a rail page', () => {
  it('pane and PTY shortcuts do nothing while Fleet covers the panes', () => {
    expect(WORKSPACES_ONLY_ACTIONS.has('closeSurface')).toBe(true);
    expect(WORKSPACES_ONLY_ACTIONS.has('splitHorizontal')).toBe(true);
    act(() => useStore.getState().setAppRoute('fleet'));
    press({ ctrlKey: true, key: '=', code: 'Equal' });
    expect(useStore.getState().terminalFontSize).toBe(14);
    act(() => useStore.getState().setAppRoute('workspaces'));
    press({ ctrlKey: true, key: '=', code: 'Equal' });
    expect(useStore.getState().terminalFontSize).toBe(15);
  });

  it('the prefix does not arm on a page, and a page switch ends an armed one', () => {
    act(() => useStore.getState().setAppRoute('settings'));
    press({ ctrlKey: true, key: 'b', code: 'KeyB' });
    expect(useStore.getState().prefixMode).toBe(false);

    act(() => useStore.getState().setAppRoute('workspaces'));
    press({ ctrlKey: true, key: 'b', code: 'KeyB' });
    expect(useStore.getState().prefixMode).toBe(true);
    act(() => useStore.getState().setAppRoute('fleet'));
    expect(useStore.getState().prefixMode).toBe(false);
  });
});

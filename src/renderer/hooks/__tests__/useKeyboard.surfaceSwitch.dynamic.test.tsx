// @vitest-environment jsdom
//
// Regression coverage for #1422. On Windows, holding Shift changes
// KeyboardEvent.key from '[' / ']' to '{' / '}', while KeyboardEvent.code
// remains BracketLeft / BracketRight. These tests exercise the real hook and
// store through real KeyboardEvents so the documented shortcuts stay usable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspace, type PaneLeaf, type Surface } from '../../../shared/types';
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

function press(init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    }));
  });
}

function seedWorkspace(): void {
  const ws = createWorkspace('Surface shortcuts');
  const pane = ws.rootPane as PaneLeaf;
  const surfaces: Surface[] = ['one', 'two', 'three'].map((id) => ({
    id,
    ptyId: `pty-${id}`,
    title: id,
    shell: 'pwsh',
    cwd: 'C:\\',
    surfaceType: 'terminal',
  }));
  pane.surfaces = surfaces;
  pane.activeSurfaceId = surfaces[0].id;

  act(() => {
    useStore.setState((state) => {
      state.workspaces = [ws];
      state.activeWorkspaceId = ws.id;
      state.setPrefixMode(false);
    });
  });
}

function activeSurfaceId(): string {
  const ws = useStore.getState().workspaces.find(
    (workspace) => workspace.id === useStore.getState().activeWorkspaceId,
  );
  if (!ws || ws.rootPane.type !== 'leaf') throw new Error('expected active leaf root');
  return ws.rootPane.activeSurfaceId;
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

describe('#1422 surface switching with shifted bracket keys', () => {
  it('Ctrl+Shift+] advances when Windows reports key="}"', () => {
    seedWorkspace();
    mount();

    press({ ctrlKey: true, shiftKey: true, key: '}', code: 'BracketRight' });

    expect(activeSurfaceId()).toBe('two');
  });

  it('Ctrl+Shift+[ moves backward when Windows reports key="{"', () => {
    seedWorkspace();
    mount();

    press({ ctrlKey: true, shiftKey: true, key: '{', code: 'BracketLeft' });

    expect(activeSurfaceId()).toBe('three');
  });
});

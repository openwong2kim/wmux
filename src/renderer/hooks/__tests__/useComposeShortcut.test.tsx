// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useComposeShortcut } from '../useComposeShortcut';
import { useStore } from '../../stores';
import type { SessionData, Workspace } from '../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  useComposeShortcut();
  return null;
}

function seedWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf-a',
      type: 'leaf',
      activeSurfaceId: 'sa1',
      surfaces: [
        { id: 'sa1', ptyId: 'pty-1', title: 'claude', shell: 'bash', cwd: '/x', surfaceType: 'terminal' },
      ],
    },
    activePaneId: 'leaf-a',
  } as unknown as Workspace;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const data: SessionData = {
    workspaces: [seedWorkspace()],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
  act(() => {
    useStore.getState().loadSession(data);
    useStore.setState({ toolbarPopover: null, composeContext: null, composeTarget: 'pane' });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(createElement(Harness)); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function pressG(): void {
  act(() => {
    const ev = new KeyboardEvent('keydown', {
      key: 'g',
      ctrlKey: true,
      bubbles: true,
    });
    document.body.dispatchEvent(ev);
  });
}

describe('useComposeShortcut', () => {
  it('Ctrl+G opens compose against the focused terminal', () => {
    pressG();
    expect(useStore.getState().toolbarPopover).toBe('rich');
    expect(useStore.getState().composeContext).toEqual({ paneId: 'leaf-a', ptyId: 'pty-1' });
    expect(useStore.getState().composeTarget).toBe('pane');
  });

  it('a second Ctrl+G closes compose', () => {
    pressG();
    pressG();
    expect(useStore.getState().toolbarPopover).toBeNull();
    expect(useStore.getState().composeContext).toBeNull();
  });
});

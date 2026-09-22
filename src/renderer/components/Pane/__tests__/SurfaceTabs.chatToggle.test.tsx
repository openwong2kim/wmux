// @vitest-environment jsdom
//
// The Chat view is opt-in while experimental (PR #1440). Off means the
// Terminal / Chat switch is not offered at all; on restores it, and a
// surface that was left in Chat comes back as Chat rather than being reset.
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import type { Surface, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function activeWs(): Workspace {
  return useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

function mount(surfaces: Surface[]): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  act(() => {
    root.render(React.createElement(SurfaceTabs, {
      surfaces, activeSurfaceId: surfaces[0]!.id, workspace: ws, paneId: ws.rootPane.id, paneActive: true,
      onSelect: () => undefined, onClose: () => undefined, onSplitHorizontal: () => undefined,
      onSplitVertical: () => undefined, onAddTerminal: () => undefined, onAddBrowser: () => undefined,
    }));
  });
}

const terminal = (viewMode?: 'terminal' | 'chat'): Surface =>
  ({ id: 's1', ptyId: 'pty-s1', title: 'shell', shell: 'bash', cwd: '/tmp', ...(viewMode ? { viewMode } : {}) });

describe('SurfaceTabs — Chat view is opt-in', () => {
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useStore.getState().setChatViewEnabled(false);
  });

  it('is off by default and offers no switch', () => {
    expect(useStore.getState().chatViewEnabled).toBe(false);
    mount([terminal()]);
    expect(container.querySelector('.wmux-chat-toggle')).toBeNull();
  });

  it('offers the switch once enabled, and keeps a surface that was in Chat', () => {
    act(() => useStore.getState().setChatViewEnabled(true));
    mount([terminal('chat')]);
    const pressed = [...container.querySelectorAll('[data-surface-view]')]
      .map((b) => `${(b as HTMLElement).dataset.surfaceView}:${b.getAttribute('aria-pressed')}`);
    expect(pressed).toEqual(['terminal:false', 'chat:true']);
  });

  it('withdraws the switch again when disabled, without touching the stored view', () => {
    act(() => useStore.getState().setChatViewEnabled(true));
    mount([terminal('chat')]);
    act(() => useStore.getState().setChatViewEnabled(false));
    expect(container.querySelector('.wmux-chat-toggle')).toBeNull();
  });
});

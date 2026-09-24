// @vitest-environment jsdom
//
// #1509 — a background tab's status dot follows the same per-surface attention
// the Fleet row reads. The unread entry (`surfaceAgentStatus`) is deleted once
// the tab has been looked at; an open dialog is not answered by looking at it,
// so the tab keeps its red dot until its own agent reports something else. A
// viewed finished turn stays cleared.
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import type { AgentStatus, Surface, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function activeWs(): Workspace {
  const ws = useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId);
  if (!ws) throw new Error('no active workspace');
  return ws;
}

const bg: Surface = { id: 'surf-bg', ptyId: 'pty-bg-1509', title: 'BG', shell: 'bash', cwd: 'D:/repo' };
const fg: Surface = { id: 'surf-fg', ptyId: 'pty-fg-1509', title: 'FG', shell: 'bash', cwd: 'D:/repo' };

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces: [bg, fg],
        activeSurfaceId: 'surf-fg',
        workspace: ws,
        paneId: ws.rootPane.id,
        paneActive: true,
        onSelect: () => undefined,
        onClose: () => undefined,
        onSplitHorizontal: () => undefined,
        onSplitVertical: () => undefined,
        onAddTerminal: () => undefined,
        onAddBrowser: () => undefined,
      }),
    );
  });
}

function dots(): number {
  return container.querySelectorAll('.tab-status-blink').length;
}

function setLifecycle(status: AgentStatus): void {
  act(() => {
    useStore.getState().setSurfaceAgent('pty-bg-1509', 'Claude Code', status);
    // The tab was already looked at: its unread entry is gone.
    useStore.getState().setSurfaceAgentStatus('pty-bg-1509', null);
  });
}

describe('SurfaceTabs — background tab status dot (#1509)', () => {
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    act(() => useStore.getState().clearSurfaceAgent('pty-bg-1509'));
  });

  it('keeps the dot for a viewed tab whose dialog is still open', () => {
    setLifecycle('awaiting_input');
    mount();
    expect(dots()).toBe(1);
  });

  it('drops it once that tab answers', () => {
    setLifecycle('awaiting_input');
    mount();
    setLifecycle('running');
    expect(dots()).toBe(0);
  });

  it('does not re-raise a viewed finished turn', () => {
    setLifecycle('complete');
    mount();
    expect(dots()).toBe(0);
  });
});

// @vitest-environment jsdom
//
// A workspace color tag (shared/workspaceColors.ts) is purely visual and must
// never gate on anything else the tab already shows. This pins: an untagged
// workspace's tab renders with no underline, a tagged one's tab renders with
// an underline in exactly that color, and the underline follows the store —
// changing the tag re-renders the same mounted tab without a remount.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import { WORKSPACE_COLOR_HEX } from '../../../../shared/workspaceColors';
import type { Surface, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function activeWs(): Workspace {
  return useStore
    .getState()
    .workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

function mount(surfaces: Surface[], activeSurfaceId: string): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces,
        activeSurfaceId,
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

function tabLabel(title: string): HTMLElement {
  const spans = Array.from(container.querySelectorAll('span'));
  const el = spans.find((s) => s.textContent === title);
  if (!el) throw new Error(`no tab label "${title}" in:\n${container.innerHTML}`);
  return el;
}

describe('SurfaceTabs — workspace color tag underline', () => {
  const surface: Surface = {
    id: 'surf-1',
    ptyId: 'pty-1',
    title: 'WMUX',
    shell: 'bash',
    cwd: 'D:/repo',
  };

  beforeEach(() => {
    useStore.getState().setWorkspaceColor(activeWs().id, undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useStore.getState().setWorkspaceColor(activeWs().id, undefined);
  });

  it('renders no underline when the workspace carries no color tag', () => {
    mount([surface], 'surf-1');
    expect(tabLabel('WMUX').style.boxShadow).toBe('');
  });

  it('renders an inset underline in the workspace tag color', () => {
    useStore.getState().setWorkspaceColor(activeWs().id, 'cyan');
    mount([surface], 'surf-1');
    const label = tabLabel('WMUX');
    expect(label.style.boxShadow).toContain('inset');
    expect(label.style.boxShadow).toContain(WORKSPACE_COLOR_HEX.cyan);
  });

  it('re-renders the underline when the workspace prop carries a new color', () => {
    // SurfaceTabs reads workspace.color from its prop, not a live store
    // subscription — the reactive path is the parent (Pane.tsx/WorkspaceSlot)
    // re-passing a fresh workspace object. This pins that the underline is
    // NOT frozen at the color read at first mount, by re-rendering with an
    // updated workspace the way that parent chain would.
    useStore.getState().setWorkspaceColor(activeWs().id, 'rose');
    mount([surface], 'surf-1');
    expect(tabLabel('WMUX').style.boxShadow).toContain(WORKSPACE_COLOR_HEX.rose);

    act(() => {
      useStore.getState().setWorkspaceColor(activeWs().id, 'indigo');
    });
    act(() => {
      root.render(
        React.createElement(SurfaceTabs, {
          surfaces: [surface],
          activeSurfaceId: 'surf-1',
          workspace: activeWs(),
          paneId: activeWs().rootPane.id,
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
    expect(tabLabel('WMUX').style.boxShadow).toContain(WORKSPACE_COLOR_HEX.indigo);
  });
});

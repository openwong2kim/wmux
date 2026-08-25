// @vitest-environment jsdom
//
// A workspace color tag (shared/workspaceColors.ts) is purely visual and must
// never gate on anything else the tab already shows. It renders as ONE dot at
// the strip's start — never a per-tab underline: the 2px bottom underline is
// DESIGN.md's steel-exclusive focus grammar, so a tag underline on an
// unfocused pane would read as focus. This pins: an untagged workspace's
// header renders no dot, a tagged one renders a dot in exactly that color
// (and no label underline), and the dot follows the workspace prop —
// changing the tag re-renders the same mounted strip without a remount.
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

function tagDot(): HTMLElement | null {
  return container.querySelector('[data-pane-tag-dot]');
}

/** jsdom normalizes an inline `background: #hex` to `rgb(r, g, b)`. */
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe('SurfaceTabs — workspace color tag dot', () => {
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

  it('renders no dot when the workspace carries no color tag', () => {
    mount([surface], 'surf-1');
    expect(tagDot()).toBeNull();
    expect(tabLabel('WMUX').style.boxShadow).toBe('');
  });

  it('renders one dot in the workspace tag color, and no label underline', () => {
    useStore.getState().setWorkspaceColor(activeWs().id, 'cyan');
    mount([surface], 'surf-1');
    const el = tagDot();
    expect(el).not.toBeNull();
    expect(el!.style.background).toBe(hexToRgb(WORKSPACE_COLOR_HEX.cyan));
    // The label must NOT carry the tag as an underline — that shape/position
    // is the steel focused-pane cue (DESIGN.md), and a cyan one would read
    // as focus on an unfocused pane.
    expect(tabLabel('WMUX').style.boxShadow).toBe('');
  });

  it('re-renders the dot when the workspace prop carries a new color', () => {
    // SurfaceTabs reads workspace.color from its prop, not a live store
    // subscription — the reactive path is the parent (Pane.tsx/WorkspaceSlot)
    // re-passing a fresh workspace object. This pins that the dot is
    // NOT frozen at the color read at first mount, by re-rendering with an
    // updated workspace the way that parent chain would.
    useStore.getState().setWorkspaceColor(activeWs().id, 'rose');
    mount([surface], 'surf-1');
    expect(tagDot()!.style.background).toBe(hexToRgb(WORKSPACE_COLOR_HEX.rose));

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
    expect(tagDot()!.style.background).toBe(hexToRgb(WORKSPACE_COLOR_HEX.indigo));
  });
});

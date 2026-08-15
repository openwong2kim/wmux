// @vitest-environment jsdom
//
// Dynamic verification for the pane-header action cluster and the new-terminal
// tab action (split right / split down / new browser / zoom).
// Mounts the REAL SurfaceTabs against the REAL zustand store, wiring the
// action callbacks to the same store actions Pane.tsx wires them to, then
// clicks each button and asserts the store effect:
//
//   • Split right → splitPane(_, 'horizontal') → root becomes a horizontal
//     branch (side-by-side columns), leaf count 1 → 2.
//   • Split down  → splitPane(_, 'vertical')   → root becomes a vertical branch
//     (stacked rows).
//   • New browser → addBrowserSurface           → a browser surface tab is added
//     to this pane.
//   • Zoom        → togglePaneZoom → zoomedPaneId toggles this pane on/off.
//   • The Settings toggle (paneActionsVisible=false) hides the whole cluster.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import { getLeafPanes } from '../../../../shared/paneUtils';
import type { Pane, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function activeWs(): Workspace {
  return useStore
    .getState()
    .workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

function rootLeafId(): string {
  return activeWs().rootPane.id;
}

function branchDirection(pane: Pane): string | undefined {
  return pane.type === 'branch' ? pane.direction : undefined;
}

function mount(paneId: string): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces: [],
        activeSurfaceId: '',
        workspace: ws,
        paneId,
        paneActive: true,
        onSelect: () => undefined,
        onClose: () => undefined,
        onSplitHorizontal: () => useStore.getState().splitPane(paneId, 'horizontal', ws.id),
        onSplitVertical: () => useStore.getState().splitPane(paneId, 'vertical', ws.id),
        onAddTerminal: () => useStore.getState().addSurface(paneId, 'test-pty', 'Terminal', 'D:/repo', ws.id),
        onAddBrowser: () => useStore.getState().addBrowserSurface(paneId, undefined, undefined, ws.id),
      }),
    );
  });
}

function click(action: string): void {
  const btn = container.querySelector<HTMLButtonElement>(`[data-pane-action="${action}"]`);
  expect(btn, `button [data-pane-action="${action}"] should be present`).not.toBeNull();
  act(() => {
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  state.setPaneActionsVisible(true);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('SurfaceTabs pane action cluster', () => {
  it('renders the terminal add button after the final tab and action buttons after it', () => {
    mount(rootLeafId());
    const actions = Array.from(
      container.querySelectorAll('[data-pane-action]'),
    ).map((el) => el.getAttribute('data-pane-action'));
    expect(actions).toEqual([
      'new-terminal',
      'split-right',
      'split-down',
      'new-browser',
      'zoom',
    ]);
    expect(container.querySelector('[data-pane-action="new-terminal"]')).not.toBeNull();
    expect(container.querySelector('[data-pane-action="new-terminal"]')?.getAttribute('aria-label')).toBe('New terminal');
  });

  it('Add terminal invokes the callback without selecting a tab', () => {
    const paneId = rootLeafId();
    let addTerminalCalls = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const ws = activeWs();
    act(() => {
      root.render(
        React.createElement(SurfaceTabs, {
          surfaces: [],
          activeSurfaceId: '',
          workspace: ws,
          paneId,
          paneActive: true,
          onSelect: () => { throw new Error('onSelect should not run'); },
          onClose: () => undefined,
          onSplitHorizontal: () => undefined,
          onSplitVertical: () => undefined,
          onAddTerminal: () => { addTerminalCalls += 1; },
          onAddBrowser: () => undefined,
        }),
      );
    });

    click('new-terminal');

    expect(addTerminalCalls).toBe(1);
  });

  it('Add terminal creates a terminal surface in this pane', () => {
    const paneId = rootLeafId();
    mount(paneId);

    click('new-terminal');

    const leaf = getLeafPanes(activeWs().rootPane).find((l) => l.id === paneId)!;
    const terminals = leaf.surfaces.filter((s) => s.ptyId === 'test-pty');
    expect(terminals).toHaveLength(1);
    expect(leaf.activeSurfaceId).toBe(terminals[0].id);
  });

  it('Split right splits the pane horizontally (side-by-side columns)', () => {
    const paneId = rootLeafId();
    mount(paneId);
    expect(getLeafPanes(activeWs().rootPane)).toHaveLength(1);

    click('split-right');

    expect(getLeafPanes(activeWs().rootPane)).toHaveLength(2);
    expect(branchDirection(activeWs().rootPane)).toBe('horizontal');
  });

  it('Split down splits the pane vertically (stacked rows)', () => {
    const paneId = rootLeafId();
    mount(paneId);

    click('split-down');

    expect(getLeafPanes(activeWs().rootPane)).toHaveLength(2);
    expect(branchDirection(activeWs().rootPane)).toBe('vertical');
  });

  it('New browser adds a browser surface tab to this pane', () => {
    const paneId = rootLeafId();
    mount(paneId);

    click('new-browser');

    const leaf = getLeafPanes(activeWs().rootPane).find((l) => l.id === paneId)!;
    const browsers = leaf.surfaces.filter((s) => s.surfaceType === 'browser');
    expect(browsers).toHaveLength(1);
    expect(leaf.activeSurfaceId).toBe(browsers[0].id);
  });

  it('Zoom toggles this pane in zoomedPaneId (maximize ⇄ restore)', () => {
    const paneId = rootLeafId();
    mount(paneId);
    expect(useStore.getState().zoomedPaneId).toBeNull();

    click('zoom');
    expect(useStore.getState().zoomedPaneId).toBe(paneId);

    click('zoom');
    expect(useStore.getState().zoomedPaneId).toBeNull();
  });

  it('hides the cluster when the Settings toggle is off', () => {
    act(() => {
      useStore.getState().setPaneActionsVisible(false);
    });
    mount(rootLeafId());

    expect(container.querySelector('[data-pane-actions]')).toBeNull();
    expect(container.querySelectorAll('[data-pane-action]')).toHaveLength(1);
    expect(container.querySelector('[data-pane-action="new-terminal"]')).not.toBeNull();
  });
});

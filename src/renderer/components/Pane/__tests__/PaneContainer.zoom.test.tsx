// @vitest-environment jsdom
//
// Dynamic verification for issue #182 — prefix-mode Toggle Zoom.
//
// Mounts the REAL PaneContainer (real react-resizable-panels Group/Panel/
// Separator) against the REAL zustand store, with only the leaf Pane
// component mocked out (it would otherwise pull in xterm.js/electronAPI).
// Asserts the rendering contract the fix relies on:
//
//   • zoom on  → every Panel NOT on the path to the zoomed leaf carries
//     data-wmux-zoom-hidden (globals.css turns that into display:none
//     !important), separators get .wmux-zoom-hidden, and the on-path
//     panels stay visible.
//   • zoom off → no hidden markers anywhere; the saved layout is intact
//     because zoom never touches Panel layout state.
//   • a zoom belonging to a different workspace's pane leaves this tree
//     untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Leaf Pane mock: PaneContainer only needs SOMETHING to render at leaves.
vi.mock('../Pane', () => ({
  default: ({ pane }: { pane: { id: string } }) =>
    React.createElement('div', { 'data-testid': `leaf-${pane.id}` }),
}));

import PaneContainer from '../PaneContainer';
import { useStore } from '../../../stores';
import { getLeafPanes } from '../../../../shared/paneUtils';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// react-resizable-panels observes group elements; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe(): void {
    /* layout reflow is irrelevant under jsdom */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

let container: HTMLDivElement;
let root: Root;

function mountActiveWorkspace(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = useStore
    .getState()
    .workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
  act(() => {
    root.render(
      React.createElement(PaneContainer, {
        pane: ws.rootPane,
        workspace: ws,
        isWorkspaceVisible: true,
      }),
    );
  });
}

function rerender(): void {
  const ws = useStore
    .getState()
    .workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
  act(() => {
    root.render(
      React.createElement(PaneContainer, {
        pane: ws.rootPane,
        workspace: ws,
        isWorkspaceVisible: true,
      }),
    );
  });
}

const hiddenPanels = (): Element[] =>
  Array.from(container.querySelectorAll('[data-panel][data-wmux-zoom-hidden]'));
const hiddenSeparators = (): Element[] =>
  Array.from(container.querySelectorAll('.wmux-zoom-hidden'));

beforeEach(() => {
  // Reset to a single fresh workspace, then build a 3-leaf tree:
  // root(horizontal)[ A, branch(vertical)[ B, C ] ] via real splitPane.
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  useStore.setState({ zoomedPaneId: null });

  const ws = () =>
    useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
  const rootId = ws().rootPane.id;
  useStore.getState().splitPane(rootId, 'horizontal');
  // split the new active (right) pane vertically → 3 leaves
  useStore.getState().splitPane(ws().activePaneId, 'vertical');
  // splitPane clears zoom (tmux behavior) — start each test un-zoomed.
  expect(useStore.getState().zoomedPaneId).toBeNull();

  mountActiveWorkspace();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function leafIds(): string[] {
  const ws = useStore
    .getState()
    .workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
  return getLeafPanes(ws.rootPane).map((l) => l.id);
}

describe('PaneContainer zoom rendering (#182)', () => {
  it('renders all 3 leaves with no hidden markers before zoom', () => {
    expect(leafIds()).toHaveLength(3);
    for (const id of leafIds()) {
      expect(container.querySelector(`[data-testid="leaf-${id}"]`)).not.toBeNull();
    }
    expect(hiddenPanels()).toHaveLength(0);
    expect(hiddenSeparators()).toHaveLength(0);
  });

  it('zooming a nested leaf hides every off-path panel and all separators, keeps panes mounted', () => {
    const [a, b, c] = leafIds();
    act(() => {
      useStore.getState().togglePaneZoom(c);
    });
    rerender();

    // Off-path: leaf A's panel (outer branch) and leaf B's panel (inner branch).
    const hidden = hiddenPanels();
    expect(hidden).toHaveLength(2);
    const hiddenLeafIds = hidden.map((el) =>
      el.querySelector('[data-testid^="leaf-"]')?.getAttribute('data-testid'),
    );
    expect(hiddenLeafIds).toContain(`leaf-${a}`);
    expect(hiddenLeafIds).toContain(`leaf-${b}`);

    // Both branches are on the zoom path → both separators hidden.
    expect(hiddenSeparators()).toHaveLength(2);

    // The zoomed leaf's panel chain carries no hidden marker.
    const zoomedLeaf = container.querySelector(`[data-testid="leaf-${c}"]`)!;
    expect(zoomedLeaf).not.toBeNull();
    expect(zoomedLeaf.closest('[data-wmux-zoom-hidden]')).toBeNull();

    // Hide-don't-unmount: all three leaves are still in the DOM.
    for (const id of [a, b, c]) {
      expect(container.querySelector(`[data-testid="leaf-${id}"]`)).not.toBeNull();
    }
  });

  it('toggling again removes every hidden marker (un-zoom restores the tree)', () => {
    const [, , c] = leafIds();
    act(() => {
      useStore.getState().togglePaneZoom(c);
    });
    rerender();
    expect(hiddenPanels().length).toBeGreaterThan(0);

    act(() => {
      useStore.getState().togglePaneZoom(c);
    });
    rerender();
    expect(hiddenPanels()).toHaveLength(0);
    expect(hiddenSeparators()).toHaveLength(0);
  });

  it("a zoomed pane from another workspace leaves this tree untouched", () => {
    act(() => {
      useStore.getState().togglePaneZoom('pane-of-some-other-workspace');
    });
    rerender();
    expect(hiddenPanels()).toHaveLength(0);
    expect(hiddenSeparators()).toHaveLength(0);
  });
});

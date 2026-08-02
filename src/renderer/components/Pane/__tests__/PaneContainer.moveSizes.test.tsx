// @vitest-environment jsdom
//
// Issue #645 — PaneContainer's rendering contract for a pane move.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. Under jsdom the panels-library never
// applies a layout: with no real measurement (ResizeObserver is a stub, every
// element is 0x0) `setLayout` is a no-op and every Panel keeps flex-grow: 50
// no matter what sizes the store holds. Two of the three things the move work
// changed are therefore NOT verifiable here, by construction:
//
//   • that a stale debounced size write is dropped — arming the debounce needs
//     a real separator drag; the library does not fire onLayoutChanged on
//     mount or on a programmatic setLayout.
//   • that the layout is re-pushed after a swap (the child-id dependency) —
//     the push itself is invisible in jsdom.
//
// Both belong to the Phase 0 harness, which runs against a real window. What
// jsdom CAN prove is that the render tree follows the store: after a swap the
// panes exchange DOM slots and both stay mounted. That is the regression guard
// for "a swap dropped a pane" or "a swap rendered the same pane twice".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../Pane', () => ({
  default: ({ pane }: { pane: { id: string } }) =>
    React.createElement('div', { 'data-testid': `leaf-${pane.id}` }),
}));

import PaneContainer from '../PaneContainer';
import { useStore } from '../../../stores';
import { getLeafPanes } from '../../../../shared/paneUtils';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void { /* layout reflow is irrelevant under jsdom */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

let container: HTMLDivElement;
let root: Root;

const ws = () =>
  useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;

function render(): void {
  const w = ws();
  act(() => {
    root.render(
      React.createElement(PaneContainer, {
        pane: w.rootPane,
        workspace: w,
        isWorkspaceVisible: true,
      }),
    );
  });
}

/** Leaf ids in the order they appear in the DOM. */
function renderedLeafOrder(): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="leaf-"]')).map((el) =>
    el.getAttribute('data-testid')!.slice('leaf-'.length),
  );
}

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  useStore.setState({ zoomedPaneId: null });

  // Three leaves: root(h)[ A, inner(v)[ B, C ] ]
  useStore.getState().splitPane(ws().rootPane.id, 'horizontal');
  useStore.getState().splitPane(ws().activePaneId, 'vertical');

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('PaneContainer — rendering a moved layout (#645)', () => {
  it('swapping two panes exchanges their DOM slots and keeps both mounted', () => {
    const [a, b, c] = renderedLeafOrder();
    expect([a, b, c]).toHaveLength(3);

    act(() => { useStore.getState().swapPanes(ws().id, a, c); });
    render();

    expect(renderedLeafOrder()).toEqual([c, b, a]);
  });

  it('moving a pane re-renders the new tree with every leaf still mounted', () => {
    const before = renderedLeafOrder();
    const [a, , c] = before;

    act(() => { useStore.getState().movePane(ws().id, c, a, 'left'); });
    render();

    const after = renderedLeafOrder();
    expect(new Set(after)).toEqual(new Set(before)); // same panes, no drops, no dupes
    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(c); // edge='left' put the moved pane ahead of its target
  });

  it('unmounting a branch with a resize pending does not throw', () => {
    // The debounce cannot be armed from jsdom (see the header), so this only
    // pins the cleanup path itself: unmount must not leave a timer that blows
    // up when it fires.
    vi.useFakeTimers();
    act(() => { root.unmount(); });
    root = createRoot(container); // keep afterEach's unmount valid
    expect(() => { act(() => { vi.advanceTimersByTime(500); }); }).not.toThrow();
    vi.useRealTimers();
  });
});

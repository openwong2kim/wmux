// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../Pane', () => ({
  default: ({ pane }: { pane: { id: string } }) =>
    React.createElement('div', { 'data-testid': `leaf-${pane.id}` }),
}));

import PaneContainer, { separatorEqualizePair } from '../PaneContainer';
import { useStore } from '../../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void { /* layout reflow is irrelevant under jsdom */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

// #1233 — double-click a pane separator to even out the two panes it
// separates. Pure arithmetic: the two-pane case is the issue's 50/50; a
// three-plus group only touches the flanking pair.

describe('separatorEqualizePair', () => {
  it('equalizes two panes to 50/50', () => {
    expect(separatorEqualizePair([80, 20], 1)).toEqual([50, 50]);
    expect(separatorEqualizePair([12.5, 87.5], 1)).toEqual([50, 50]);
  });

  it('splits only the flanking pair, leaving other panes untouched', () => {
    // Separator between pane 0 and pane 1: their 70 combined splits evenly,
    // pane 2 keeps its 30.
    expect(separatorEqualizePair([60, 10, 30], 1)).toEqual([35, 35, 30]);
    // Separator between pane 1 and pane 2.
    expect(separatorEqualizePair([60, 10, 30], 2)).toEqual([60, 20, 20]);
  });

  it('already-even pairs stay even (idempotent)', () => {
    expect(separatorEqualizePair([50, 50], 1)).toEqual([50, 50]);
  });

  it('out-of-range indices are a no-op', () => {
    expect(separatorEqualizePair([80, 20], 0)).toEqual([80, 20]);
    expect(separatorEqualizePair([80, 20], 2)).toEqual([80, 20]);
    expect(separatorEqualizePair([80, 20], -1)).toEqual([80, 20]);
  });

  it('does not mutate the input', () => {
    const sizes = [80, 20];
    separatorEqualizePair(sizes, 1);
    expect(sizes).toEqual([80, 20]);
  });
});

// Wiring: the separator's double-click reaches the store through
// updatePaneSizes (the path a drag persists through), and only for the branch
// it belongs to. jsdom cannot show the visual resize (see
// PaneContainer.moveSizes.test.tsx), so the store write is the contract here.
describe('PaneContainer — double-clicking a separator (#1233)', () => {
  let container: HTMLDivElement;
  let root: Root;

  const ws = () =>
    useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;

  function render(): void {
    const w = ws();
    act(() => {
      root.render(
        React.createElement(PaneContainer, { pane: w.rootPane, workspace: w, isWorkspaceVisible: true }),
      );
    });
  }

  beforeEach(() => {
    const state = useStore.getState();
    for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
    state.addWorkspace();
    useStore.setState({ zoomedPaneId: null });
    // root(h)[ A, inner(v)[ B, C ] ]
    useStore.getState().splitPane(ws().rootPane.id, 'horizontal');
    useStore.getState().splitPane(ws().activePaneId, 'vertical');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  it('evens out the pair around the outer divider and leaves the nested split alone', () => {
    const outer = ws().rootPane;
    if (outer.type !== 'branch') throw new Error('expected a branch root');
    const inner = outer.children[1];
    if (inner.type !== 'branch') throw new Error('expected a nested branch');
    act(() => {
      useStore.getState().updatePaneSizes(outer.id, [80, 20]);
      useStore.getState().updatePaneSizes(inner.id, [70, 30]);
    });
    render();

    // Document order: the outer divider precedes the nested group's divider.
    const [outerSeparator] = container.querySelectorAll('[role="separator"]');
    act(() => {
      outerSeparator.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const after = ws().rootPane;
    if (after.type !== 'branch') throw new Error('expected a branch root');
    expect(after.sizes).toEqual([50, 50]);
    const innerAfter = after.children[1];
    if (innerAfter.type !== 'branch') throw new Error('expected a nested branch');
    expect(innerAfter.sizes).toEqual([70, 30]);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelProps } from 'react-resizable-panels';

vi.mock('../Pane', () => ({
  default: ({ pane }: { pane: { id: string } }) =>
    React.createElement('div', { 'data-testid': `leaf-${pane.id}` }),
}));

// Records the props PaneContainer hands the library's Panel, then renders the
// REAL Panel, so the Group still registers real panels and the library's own
// document-level listeners are live for every event dispatched below.
const panelProps = vi.hoisted(() => [] as PanelProps[]);
vi.mock('react-resizable-panels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-resizable-panels')>();
  return {
    ...actual,
    Panel: (props: PanelProps) => {
      panelProps.push(props);
      return React.createElement(actual.Panel, props);
    },
  };
});

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

// The real gesture. The library grabs a divider anywhere in a 16px band around
// its 1px line, so a real double-click lands on the NEIGHBOURING panel far more
// often than on the separator element — an onDoubleClick on the element never
// fired live, and the library's own dblclick reset (first panel of the pair back
// to its defaultSize) won instead. These events target the panel, carry real
// coordinates, and pass through the library's document-capture listener.
describe('PaneContainer — double-clicking a divider (#1233)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const rects = new Map<Element, DOMRect>();

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

  function leafEl(id: string): Element {
    return container.querySelector(`[data-testid="leaf-${id}"]`)!;
  }

  function dblclickAt(target: Element, x: number, y: number): MouseEvent {
    const e = new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y });
    act(() => { target.dispatchEvent(e); });
    return e;
  }

  /** root(h)[ A, inner(v)[ B, C ] ] at 80/20 and 70/30, laid out in a
   *  1000x500 box: the outer divider at x=800, the nested one at y=350. */
  function mountUneven(): { a: string; b: string; outerId: string; innerId: string } {
    const outer = ws().rootPane;
    if (outer.type !== 'branch') throw new Error('expected a branch root');
    const [left, inner] = outer.children;
    if (left.type !== 'leaf' || inner.type !== 'branch') throw new Error('expected root(h)[A, inner(v)[B, C]]');
    const b = inner.children[0].id;
    act(() => {
      useStore.getState().updatePaneSizes(outer.id, [80, 20]);
      useStore.getState().updatePaneSizes(inner.id, [70, 30]);
    });
    render();
    // Document order: the outer divider precedes the nested group's divider.
    const [outerSeparator, innerSeparator] = container.querySelectorAll('[role="separator"]');
    rects.set(outerSeparator, new DOMRect(800, 0, 1, 500));
    rects.set(innerSeparator, new DOMRect(801, 350, 199, 1));
    return { a: left.id, b, outerId: outer.id, innerId: inner.id };
  }

  function sizesOf(branchId: string): number[] | undefined {
    const find = (p: ReturnType<typeof ws>['rootPane']): number[] | undefined => {
      if (p.type !== 'branch') return undefined;
      if (p.id === branchId) return p.sizes;
      for (const c of p.children) {
        const hit = find(c);
        if (hit) return hit;
      }
      return undefined;
    };
    return find(ws().rootPane);
  }

  beforeEach(() => {
    const state = useStore.getState();
    for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
    state.addWorkspace();
    useStore.setState({ zoomedPaneId: null });
    useStore.getState().splitPane(ws().rootPane.id, 'horizontal');
    useStore.getState().splitPane(ws().activePaneId, 'vertical');

    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return rects.get(this) ?? new DOMRect(0, 0, 0, 0);
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    rects.clear();
    vi.restoreAllMocks();
  });

  it('evens out the outer pair for a double-click that lands on the neighbouring panel', () => {
    const { a, outerId, innerId } = mountUneven();

    // What the library's dblclick handler sees: it sits on document in the
    // capture phase and returns immediately when defaultPrevented is set.
    let preventedBeforeLibrary: boolean | null = null;
    const probe = (e: Event) => { preventedBeforeLibrary = e.defaultPrevented; };
    document.addEventListener('dblclick', probe, true);
    // 4.5px right of the line: inside the band, on panel A, not on the separator.
    const e = dblclickAt(leafEl(a), 805, 100);
    document.removeEventListener('dblclick', probe, true);

    expect(sizesOf(outerId)).toEqual([50, 50]);
    expect(sizesOf(innerId)).toEqual([70, 30]);
    expect(e.defaultPrevented).toBe(true);
    // The library's reset never runs, so it cannot race this write.
    expect(preventedBeforeLibrary).toBe(true);
  });

  it('evens out only the nested pair for a double-click on the nested divider', () => {
    const { b, outerId, innerId } = mountUneven();

    dblclickAt(leafEl(b), 900, 352);

    expect(sizesOf(innerId)).toEqual([50, 50]);
    expect(sizesOf(outerId)).toEqual([80, 20]);
  });

  it('leaves a double-click away from every divider alone (word selection in a pane)', () => {
    const { a, outerId, innerId } = mountUneven();

    const e = dblclickAt(leafEl(a), 400, 100);

    expect(sizesOf(outerId)).toEqual([80, 20]);
    expect(sizesOf(innerId)).toEqual([70, 30]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('hands the library percentages, never bare numbers (v4 reads a number as pixels)', () => {
    const { a } = mountUneven();

    const last = [...panelProps].reverse().find((p) => p.id === a);
    expect(last?.defaultSize).toBe('80%');
  });
});

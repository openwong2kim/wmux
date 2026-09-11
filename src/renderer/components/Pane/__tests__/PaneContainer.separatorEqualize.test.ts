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

import PaneContainer, { separatorEqualizePair, separatorIndexAt } from '../PaneContainer';
import { useStore } from '../../../stores';
import type { Pane, Workspace } from '../../../../shared/types';

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

describe('separatorIndexAt', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** A bare group element: three panels and two dividers at the given x. */
  function groupWithDividersAt(xs: number[]): Element {
    const rects = new Map<Element, DOMRect>();
    const group = document.createElement('div');
    xs.forEach((x) => {
      group.appendChild(document.createElement('div'));
      const sep = document.createElement('div');
      sep.setAttribute('role', 'separator');
      rects.set(sep, new DOMRect(x, 0, 1, 500));
      group.appendChild(sep);
    });
    group.appendChild(document.createElement('div'));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return rects.get(this) ?? new DOMRect(0, 0, 0, 0);
    });
    return group;
  }

  it('picks the NEAREST divider when two bands overlap (panes near their floor)', () => {
    const group = groupWithDividersAt([500, 510]);
    // 6.5px from the first line, 3.5px from the second: both inside the 16px band.
    expect(separatorIndexAt(group, 507, 100, 16)).toBe(2);
    expect(separatorIndexAt(group, 503, 100, 16)).toBe(1);
  });

  it('never matches a display:none (0x0) divider', () => {
    const group = document.createElement('div');
    const sep = document.createElement('div');
    sep.setAttribute('role', 'separator');
    group.append(document.createElement('div'), sep, document.createElement('div'));
    // Default jsdom rects are 0x0 at the origin.
    expect(separatorIndexAt(group, 0, 0, 16)).toBe(-1);
  });
});

// The real gesture. The library grabs a divider anywhere in a 16px band around
// its 1px line. A double-click OFF the line lands on the neighbouring panel; one
// exactly ON the line has its pointerdown on the divider and its pointerup on a
// panel, so the browser dispatches it to their common ancestor, BODY. Neither
// ever reaches an onDoubleClick on the divider element. These events carry real
// coordinates and pass through the library's document-capture listener.
describe('PaneContainer — double-clicking a divider (#1233)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const rects = new Map<Element, DOMRect>();

  const ws = () =>
    useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;

  function render(w: Workspace = ws()): void {
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
   *  1000x500 box: the outer divider at x=800, the nested group to its right
   *  with its divider at y=350. */
  function mountUneven(w: Workspace = ws()): { a: string; b: string; outerId: string; innerId: string } {
    const outer = w.rootPane;
    if (outer.type !== 'branch') throw new Error('expected a branch root');
    const [left, inner] = outer.children;
    if (left.type !== 'leaf' || inner.type !== 'branch') throw new Error('expected root(h)[A, inner(v)[B, C]]');
    act(() => {
      useStore.getState().updatePaneSizes(outer.id, [80, 20], w.id);
      useStore.getState().updatePaneSizes(inner.id, [70, 30], w.id);
    });
    render(useStore.getState().workspaces.find((x) => x.id === w.id)!);
    // Document order: the outer group/divider precede the nested ones.
    const [outerGroup, innerGroup] = container.querySelectorAll('[data-group]');
    const [outerSeparator, innerSeparator] = container.querySelectorAll('[role="separator"]');
    rects.set(outerGroup, new DOMRect(0, 0, 1000, 500));
    rects.set(innerGroup, new DOMRect(801, 0, 199, 500));
    rects.set(outerSeparator, new DOMRect(800, 0, 1, 500));
    rects.set(innerSeparator, new DOMRect(801, 350, 199, 1));
    return { a: left.id, b: inner.children[0].id, outerId: outer.id, innerId: inner.id };
  }

  function sizesOf(branchId: string, wsId: string = ws().id): number[] | undefined {
    const find = (p: Pane): number[] | undefined => {
      if (p.type !== 'branch') return undefined;
      if (p.id === branchId) return p.sizes;
      for (const c of p.children) {
        const hit = find(c);
        if (hit) return hit;
      }
      return undefined;
    };
    return find(useStore.getState().workspaces.find((w) => w.id === wsId)!.rootPane);
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
    vi.unstubAllGlobals();
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

  it('evens out the pair for a double-click exactly ON the line, dispatched to BODY', () => {
    const { outerId, innerId } = mountUneven();

    const e = dblclickAt(document.body, 800.5, 100);

    expect(sizesOf(outerId)).toEqual([50, 50]);
    expect(sizesOf(innerId)).toEqual([70, 30]);
    expect(e.defaultPrevented).toBe(true);
  });

  it('evens out only the nested pair for a double-click on the nested line', () => {
    const { b, outerId, innerId } = mountUneven();

    dblclickAt(leafEl(b), 900, 352);
    expect(sizesOf(innerId)).toEqual([50, 50]);
    expect(sizesOf(outerId)).toEqual([80, 20]);

    // And exactly on its centre line, dispatched to BODY.
    act(() => { useStore.getState().updatePaneSizes(innerId, [70, 30]); });
    render();
    dblclickAt(document.body, 900, 350.5);
    expect(sizesOf(innerId)).toEqual([50, 50]);
    expect(sizesOf(outerId)).toEqual([80, 20]);
  });

  it('evens out ONE pair at a T-junction: the innermost group handles it', () => {
    const { outerId, innerId } = mountUneven();

    // 2.5px from the outer line AND on the nested line.
    dblclickAt(document.body, 803, 350.5);

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

  it('ignores a double-click on a popover portalled over the band', () => {
    const { outerId } = mountUneven();
    const popover = document.createElement('div');
    document.body.appendChild(popover);

    dblclickAt(popover, 805, 100);
    popover.remove();

    // Not evened out. (The library's own handler may still claim the event —
    // its hit test accepts an unstacked target — but its reset now puts the
    // panel back at its saved percentage, a no-op.)
    expect(sizesOf(outerId)).toEqual([80, 20]);
  });

  it('uses the library\'s 37px band on a coarse pointer, 16px otherwise', () => {
    const { a, outerId } = mountUneven();

    // 14.5px from the line: outside the fine band's 8px reach...
    dblclickAt(leafEl(a), 815, 100);
    expect(sizesOf(outerId)).toEqual([80, 20]);

    // ...inside the coarse band's 18.5px.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('coarse') }));
    dblclickAt(leafEl(a), 815, 100);
    expect(sizesOf(outerId)).toEqual([50, 50]);
  });

  it('writes to the tile\'s own workspace when it is not the active one (multiview)', () => {
    const tile = ws();
    useStore.getState().addWorkspace();
    if (useStore.getState().activeWorkspaceId === tile.id) {
      throw new Error('expected addWorkspace to activate the new workspace');
    }
    const { a, outerId } = mountUneven(tile);

    dblclickAt(leafEl(a), 805, 100);

    expect(sizesOf(outerId, tile.id)).toEqual([50, 50]);
  });

  it('hands the library percentages, never bare numbers (v4 reads a number as pixels)', () => {
    const { a } = mountUneven();

    const last = [...panelProps].reverse().find((p) => p.id === a);
    expect(last?.defaultSize).toBe('80%');
  });
});

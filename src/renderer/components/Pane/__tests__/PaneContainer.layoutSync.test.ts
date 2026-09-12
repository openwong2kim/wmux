// @vitest-environment jsdom
//
// Store ↔ library layout sync when a Group's CHILD SET changes — split, close,
// snap, a different template count — against the REAL react-resizable-panels.
//
// Plain jsdom measures every element as 0, and the library then defers its
// layout entirely: it reports nothing and applies nothing, so none of this is
// observable (the other PaneContainer suites say as much). Panel offsetWidth /
// offsetHeight are stubbed here so the library sees a real group, registers
// real layouts, keeps its per-panel-set cache and renders real flexGrow values.
//
// What the library does that this guards against, measured: it registers a
// changed panel set a commit AFTER PaneContainer's sync effect runs. A
// setLayout issued before that lands on the previous registration — it throws
// on a child-count change and otherwise leaves the library holding a layout
// keyed by ids that are gone. And on re-registration it revives its cached
// layout for that panel-id set over whatever the store now says.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../Pane', () => ({
  default: ({ pane }: { pane: { id: string } }) =>
    React.createElement('div', { 'data-testid': `leaf-${pane.id}` }),
}));

import PaneContainer from '../PaneContainer';
import { useStore } from '../../../stores';
import { createLeafPane, generateId, type Pane, type PaneBranch, type PaneLeaf } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void { /* no reflow in these tests */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute('data-panel') ? 250 : 0; },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute('data-panel') ? 500 : 0; },
  });
});

afterAll(() => {
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
});

let container: HTMLDivElement;
let root: Root;

const ws = () =>
  useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;

/** Replace the workspace's root pane, as a snap / split / close would. */
function setRoot(next: Pane): void {
  useStore.setState((s) => {
    const w = s.workspaces.find((x) => x.id === s.activeWorkspaceId)!;
    w.rootPane = next;
  });
}

function branch(children: Pane[], sizes: number[], id: string = generateId('pane')): PaneBranch {
  return { id, type: 'branch', direction: 'horizontal', children, sizes };
}

/** Render the current tree and let the library's follow-up commit and any
 *  queued re-apply settle. */
async function renderSettled(): Promise<void> {
  const w = ws();
  await act(async () => {
    root.render(React.createElement(PaneContainer, { pane: w.rootPane, workspace: w, isWorkspaceVisible: true }));
  });
  await act(async () => { await Promise.resolve(); });
}

/** The flexGrow the library actually rendered for each panel id. */
function rendered(ids: string[]): number[] {
  return ids.map((id) => {
    const el = container.querySelector<HTMLElement>(`[data-panel][id="${id}"]`);
    return el ? Number(el.style.flexGrow) : NaN;
  });
}

function rootSizes(): number[] | undefined {
  const r = ws().rootPane;
  return r.type === 'branch' ? r.sizes : undefined;
}

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  useStore.setState({ zoomedPaneId: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('PaneContainer — layout sync across child-set changes', () => {
  it('split then close on the same group: the returning pane renders at its stored size', async () => {
    const a = createLeafPane(undefined, 1);
    const b = createLeafPane(undefined, 2);
    const rootId = generateId('pane');
    setRoot(branch([a, b], [70, 30], rootId));
    await renderSettled();
    expect(rendered([a.id, b.id])).toEqual([70, 30]);

    // Split B: it moves into a new branch Bp; the root keeps its sizes.
    const c = createLeafPane(undefined, 3);
    const bp: PaneBranch = { id: generateId('pane'), type: 'branch', direction: 'vertical', children: [b, c], sizes: [50, 50] };
    setRoot(branch([a, bp], [70, 30], rootId));
    await renderSettled();
    expect(rendered([a.id, bp.id])).toEqual([70, 30]);

    // Close the new pane: Bp collapses back to B.
    setRoot(branch([a, b], [70, 30], rootId));
    await renderSettled();
    // Not a sliver at flexGrow 1 next to A's 70.
    expect(rendered([a.id, b.id])).toEqual([70, 30]);

    // And the library is keyed by the right ids again: a later store change
    // reaches the screen.
    act(() => { useStore.getState().updatePaneSizes(rootId, [40, 60]); });
    await renderSettled();
    expect(rendered([a.id, b.id])).toEqual([40, 60]);
  });

  it('drag, split, then snap back onto the same pair: the screen converges to the store', async () => {
    const a = createLeafPane(undefined, 1);
    const b = createLeafPane(undefined, 2);
    const rootId = generateId('pane');
    // The end state of a drag to 17/83: the store holds it and the library has
    // cached it for the {A, B} panel set.
    setRoot(branch([a, b], [17, 83], rootId));
    await renderSettled();
    expect(rendered([a.id, b.id])).toEqual([17, 83]);

    const c = createLeafPane(undefined, 3);
    const bp: PaneBranch = { id: generateId('pane'), type: 'branch', direction: 'vertical', children: [b, c], sizes: [50, 50] };
    setRoot(branch([a, bp], [17, 83], rootId));
    await renderSettled();

    // Snap to 2 Columns: a NEW root branch over the same two leaves.
    setRoot(branch([a, b], [50, 50]));
    await renderSettled();
    expect(rendered([a.id, b.id])).toEqual([50, 50]);

    // And the cached 17/83 is not written back into the store afterwards.
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    expect(rootSizes()).toEqual([50, 50]);
    expect(rendered([a.id, b.id])).toEqual([50, 50]);
  });

  it('a child-count change (3 → 2 → 3) neither throws nor strands a pane', async () => {
    const [a, b, c] = [1, 2, 3].map((n) => createLeafPane(undefined, n)) as [PaneLeaf, PaneLeaf, PaneLeaf];
    const rootId = generateId('pane');
    setRoot(branch([a, b, c], [20, 30, 50], rootId));
    await renderSettled();
    expect(rendered([a.id, b.id, c.id])).toEqual([20, 30, 50]);

    setRoot(branch([a, b], [50, 50], rootId));
    await renderSettled();
    expect(rendered([a.id, b.id])).toEqual([50, 50]);

    setRoot(branch([a, b, c], [30, 30, 40], rootId));
    await renderSettled();
    expect(rendered([a.id, b.id, c.id])).toEqual([30, 30, 40]);
  });
});

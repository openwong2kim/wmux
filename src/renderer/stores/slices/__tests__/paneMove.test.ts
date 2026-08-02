import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspace, type Workspace, type Pane } from '../../../../shared/types';
import { findPane, findParent, getLeafPanes } from '../../../../shared/paneUtils';

// Issue #645 — movePane / swapPanes / moveActivePaneDirection.
//
// The model rules these tests pin down (each one is a rule from the plan):
//   • ordinals and auto-names never change — a moved pane keeps its identity
//   • insert always builds a FRESH binary [50,50] branch, like splitPane
//   • detach collapses the source's old parent, including when it was the root
//   • swap trades nodes, never sizes — geometry belongs to the slot
//   • every guard is a real no-op: no mutation, no focus change, no save
//   • zoom clears, because a move re-flows the layout underneath it

const saveSessionNow = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/sessionSaveBridge', () => ({ saveSessionNow }));

const publishPaneFocused = vi.hoisted(() => vi.fn());
vi.mock('../../../events/publisher', () => ({
  publishPaneCreated: vi.fn(),
  publishPaneClosed: vi.fn(),
  publishPaneFocused,
}));

type TestState = PaneSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pushToast: ReturnType<typeof vi.fn>;
  zoomedPaneId: string | null;
};

function createTestStore() {
  const ws = createWorkspace('Test');
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      pushToast: vi.fn(),
      zoomedPaneId: null,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
    }))
  );
}

type Store = ReturnType<typeof createTestStore>;

function activeWs(store: Store): Workspace {
  const s = store.getState();
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
}

/** Leaf ids in DFS order — the same order the UI lays them out. */
function leafIds(store: Store, ws?: Workspace): string[] {
  return getLeafPanes((ws ?? activeWs(store)).rootPane).map((l) => l.id);
}

/**
 * Build `A | B` (horizontal), then split B again to get a nested tree:
 *
 *   root(h) ── A
 *           └─ inner(h) ── B
 *                       └─ C
 */
function threePaneTree(store: Store): { a: string; b: string; c: string } {
  const a = activeWs(store).rootPane.id;
  const b = store.getState().splitPane(a, 'horizontal') as string;
  const c = store.getState().splitPane(b, 'horizontal') as string;
  return { a, b, c };
}

describe('movePane (#645)', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    saveSessionNow.mockClear();
    publishPaneFocused.mockClear();
  });

  describe('insert geometry', () => {
    it.each([
      ['left', 'horizontal', true],
      ['right', 'horizontal', false],
      ['top', 'vertical', true],
      ['bottom', 'vertical', false],
    ] as const)(
      'edge=%s builds a %s branch with the source %s',
      (edge, direction, sourceFirst) => {
        const { a, b, c } = threePaneTree(store);
        const ws = activeWs(store);

        expect(store.getState().movePane(ws.id, c, a, edge)).toBe(true);

        const parent = findParent(activeWs(store).rootPane, c)!;
        expect(parent.direction).toBe(direction);
        expect(parent.sizes).toEqual([50, 50]);
        expect(parent.children.map((ch) => ch.id)).toEqual(
          sourceFirst ? [c, a] : [a, c],
        );
        // b is untouched by a move of c next to a
        expect(findPane(activeWs(store).rootPane, b)).not.toBeNull();
      },
    );

    it('always wraps in a fresh binary branch, never flattens into an n-ary one', () => {
      const { a, b, c } = threePaneTree(store);
      const ws = activeWs(store);

      // c moves next to b, whose parent is ALREADY a horizontal branch. A
      // flattening implementation would produce one branch with 2+ children
      // reusing the parent; we deliberately wrap instead, so the tree a move
      // produces is indistinguishable from the tree a split produces.
      store.getState().movePane(ws.id, c, b, 'right');

      const parent = findParent(activeWs(store).rootPane, c)!;
      expect(parent.children).toHaveLength(2);
      expect(parent.children.map((ch) => ch.id).sort()).toEqual([b, c].sort());
      expect(leafIds(store).sort()).toEqual([a, b, c].sort());
    });

    it('installs the new branch as the root when the target has no parent', () => {
      // Two leaves: detaching the source collapses the root branch down to the
      // bare target leaf, so the insert has no parent to splice into and must
      // put its new branch at ws.rootPane.
      const a = activeWs(store).rootPane.id;
      const b = store.getState().splitPane(a, 'horizontal') as string;
      const ws = activeWs(store);
      const oldRootId = activeWs(store).rootPane.id;

      store.getState().movePane(ws.id, b, a, 'right');

      const root = activeWs(store).rootPane;
      expect(root.type).toBe('branch');
      expect(root.id).not.toBe(oldRootId); // a brand new branch node, not the collapsed one
      if (root.type === 'branch') {
        expect(root.children.map((c) => c.id)).toEqual([a, b]);
        expect(root.sizes).toEqual([50, 50]);
      }
    });
  });

  describe('detach side', () => {
    it("collapses the source's former parent", () => {
      const { a, b, c } = threePaneTree(store);
      const ws = activeWs(store);
      // Before: root(h)[ A, inner(h)[ B, C ] ]
      store.getState().movePane(ws.id, c, a, 'left');

      // inner had two children; losing C collapses it, so B is now a direct
      // child of the root — no empty or single-child branch is left behind.
      const root = activeWs(store).rootPane;
      expect(root.type).toBe('branch');
      if (root.type === 'branch') {
        const ids = root.children.map((ch) => ch.id);
        expect(ids).toContain(b);
        expect(ids).toHaveLength(2);
      }
      expect(leafIds(store).sort()).toEqual([a, b, c].sort());
    });

    it('handles source and target being siblings', () => {
      // The tricky ordering case: detaching the source collapses the very
      // branch that also holds the target, so the target node the insert uses
      // must be re-resolved after the detach.
      const a = activeWs(store).rootPane.id;
      const b = store.getState().splitPane(a, 'horizontal') as string;
      const ws = activeWs(store);

      expect(store.getState().movePane(ws.id, b, a, 'bottom')).toBe(true);

      const root = activeWs(store).rootPane;
      expect(root.type).toBe('branch');
      if (root.type === 'branch') {
        expect(root.direction).toBe('vertical');
        // edge='bottom' → the source lands second (below the target)
        expect(root.children.map((c) => c.id)).toEqual([a, b]);
      }
      expect(leafIds(store)).toHaveLength(2);
    });
  });

  describe('identity and persistence', () => {
    it('never reassigns ordinals or bumps the workspace counter', () => {
      const { a, c } = threePaneTree(store);
      const before = new Map(
        getLeafPanes(activeWs(store).rootPane).map((l) => [l.id, l.ordinal]),
      );
      const nextOrdinalBefore = activeWs(store).nextPaneOrdinal;

      store.getState().movePane(activeWs(store).id, c, a, 'right');

      for (const leaf of getLeafPanes(activeWs(store).rootPane)) {
        expect(leaf.ordinal).toBe(before.get(leaf.id));
      }
      expect(activeWs(store).nextPaneOrdinal).toBe(nextOrdinalBefore);
    });

    it('flushes the session immediately', () => {
      const { a, c } = threePaneTree(store);
      store.getState().movePane(activeWs(store).id, c, a, 'right');
      expect(saveSessionNow).toHaveBeenCalledTimes(1);
    });

    it('clears the zoom, because the layout re-flows underneath it', () => {
      const { a, c } = threePaneTree(store);
      store.setState((s) => { s.zoomedPaneId = a; });

      store.getState().movePane(activeWs(store).id, c, a, 'right');

      expect(store.getState().zoomedPaneId).toBeNull();
    });
  });

  describe('focus', () => {
    it('leaves the active pane alone by default', () => {
      const { a, b, c } = threePaneTree(store);
      const ws = activeWs(store);
      store.getState().setActivePane(b);
      publishPaneFocused.mockClear();

      store.getState().movePane(ws.id, c, a, 'right');

      expect(activeWs(store).activePaneId).toBe(b);
      expect(publishPaneFocused).not.toHaveBeenCalled();
    });

    it('focuses the source and emits pane.focused when asked', () => {
      const { a, b, c } = threePaneTree(store);
      const ws = activeWs(store);
      store.getState().setActivePane(b);
      publishPaneFocused.mockClear();

      store.getState().movePane(ws.id, c, a, 'right', { focusSource: true });

      expect(activeWs(store).activePaneId).toBe(c);
      expect(publishPaneFocused).toHaveBeenCalledWith(ws.id, c, b);
    });

    it('does not emit when the source was already active', () => {
      const { a, c } = threePaneTree(store);
      const ws = activeWs(store);
      store.getState().setActivePane(c);
      publishPaneFocused.mockClear();

      store.getState().movePane(ws.id, c, a, 'right', { focusSource: true });

      expect(publishPaneFocused).not.toHaveBeenCalled();
    });

    it('does not touch the visible workspace when moving in a background one', () => {
      threePaneTree(store);
      const visibleId = activeWs(store).id;
      const visibleActive = activeWs(store).activePaneId;
      const visibleTree = JSON.stringify(activeWs(store).rootPane);

      const bg = createWorkspace('Background');
      store.setState((s) => { s.workspaces.push(bg); });
      const bgFirst = bg.rootPane.id;
      const bgSecond = store.getState().splitPane(bgFirst, 'horizontal', bg.id) as string;

      store.getState().movePane(bg.id, bgSecond, bgFirst, 'bottom', { focusSource: true });

      // The background workspace really moved…
      const bgAfter = store.getState().workspaces.find((w) => w.id === bg.id)!;
      expect(bgAfter.rootPane.type).toBe('branch');
      expect(bgAfter.activePaneId).toBe(bgSecond);
      // …and the workspace on screen is byte-for-byte untouched.
      expect(activeWs(store).id).toBe(visibleId);
      expect(activeWs(store).activePaneId).toBe(visibleActive);
      expect(JSON.stringify(activeWs(store).rootPane)).toBe(visibleTree);
    });
  });

  describe('no-op guards', () => {
    /** Snapshot enough state to prove "nothing happened". */
    function snapshot(store: Store) {
      return {
        tree: JSON.stringify(activeWs(store).rootPane),
        active: activeWs(store).activePaneId,
        saves: saveSessionNow.mock.calls.length,
      };
    }

    it.each([
      [
        'source === target',
        (s: Store, ids: { a: string; c: string }) =>
          s.getState().movePane(activeWs(s).id, ids.c, ids.c, 'right'),
      ],
      [
        'unknown workspace',
        (s: Store, ids: { a: string; c: string }) =>
          s.getState().movePane('ws-does-not-exist', ids.c, ids.a, 'right'),
      ],
      [
        'unknown source',
        (s: Store, ids: { a: string; c: string }) =>
          s.getState().movePane(activeWs(s).id, 'pane-nope', ids.a, 'right'),
      ],
      [
        'unknown target',
        (s: Store, ids: { a: string; c: string }) =>
          s.getState().movePane(activeWs(s).id, ids.c, 'pane-nope', 'right'),
      ],
      [
        'branch id as source',
        (s: Store, ids: { a: string; c: string }) =>
          s.getState().movePane(activeWs(s).id, activeWs(s).rootPane.id, ids.a, 'right'),
      ],
      [
        'branch id as target',
        (s: Store, ids: { a: string; c: string }) =>
          s.getState().movePane(activeWs(s).id, ids.c, activeWs(s).rootPane.id, 'right'),
      ],
    ])('%s → false, no mutation, no save', (_label, act) => {
      const { a, c } = threePaneTree(store);
      saveSessionNow.mockClear();
      const before = snapshot(store);

      expect(act(store, { a, c })).toBe(false);

      expect(snapshot(store)).toEqual(before);
    });

    it('refuses to move the only pane in a workspace', () => {
      const only = activeWs(store).rootPane.id;
      const ws = activeWs(store);
      expect(store.getState().movePane(ws.id, only, only, 'right')).toBe(false);
      expect(saveSessionNow).not.toHaveBeenCalled();
    });
  });
});

describe('swapPanes (#645)', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    saveSessionNow.mockClear();
  });

  it('trades two leaves without touching the tree shape', () => {
    const { a, b, c } = threePaneTree(store);
    const shapeBefore = describeShape(activeWs(store).rootPane);

    expect(store.getState().swapPanes(activeWs(store).id, a, c)).toBe(true);

    expect(describeShape(activeWs(store).rootPane)).toEqual(shapeBefore);
    // a and c changed places in DFS order; b did not move
    expect(leafIds(store)).toEqual([c, b, a]);
  });

  it('leaves sizes with the SLOT, not with the pane', () => {
    const { a, c } = threePaneTree(store);
    store.setState((s) => {
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
      if (ws.rootPane.type === 'branch') ws.rootPane.sizes = [70, 30];
    });

    store.getState().swapPanes(activeWs(store).id, a, c);

    const root = activeWs(store).rootPane;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      // A pane swapped into the 70% slot becomes 70% wide. That is what a swap
      // looks like on screen; carrying sizes along would be a "move" instead.
      expect(root.sizes).toEqual([70, 30]);
      expect(root.children[0].id).toBe(c);
    }
  });

  it('keeps ordinals with their panes', () => {
    const { a, c } = threePaneTree(store);
    const ordinalOf = (id: string) =>
      getLeafPanes(activeWs(store).rootPane).find((l) => l.id === id)!.ordinal;
    const aOrdinal = ordinalOf(a);
    const cOrdinal = ordinalOf(c);

    store.getState().swapPanes(activeWs(store).id, a, c);

    expect(ordinalOf(a)).toBe(aOrdinal);
    expect(ordinalOf(c)).toBe(cOrdinal);
  });

  it('flushes the session', () => {
    const { a, c } = threePaneTree(store);
    store.getState().swapPanes(activeWs(store).id, a, c);
    expect(saveSessionNow).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['same pane', (s: Store, ids: { a: string; c: string }) => s.getState().swapPanes(activeWs(s).id, ids.a, ids.a)],
    ['unknown workspace', (s: Store, ids: { a: string; c: string }) => s.getState().swapPanes('nope', ids.a, ids.c)],
    ['unknown pane', (s: Store, ids: { a: string; c: string }) => s.getState().swapPanes(activeWs(s).id, ids.a, 'nope')],
    ['branch id', (s: Store, ids: { a: string; c: string }) => s.getState().swapPanes(activeWs(s).id, ids.a, activeWs(s).rootPane.id)],
  ])('%s → false, no mutation', (_label, act) => {
    const { a, c } = threePaneTree(store);
    saveSessionNow.mockClear();
    const before = JSON.stringify(activeWs(store).rootPane);

    expect(act(store, { a, c })).toBe(false);

    expect(JSON.stringify(activeWs(store).rootPane)).toBe(before);
    expect(saveSessionNow).not.toHaveBeenCalled();
  });
});

describe('moveActivePaneDirection (#645)', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    saveSessionNow.mockClear();
  });

  it('walks the pane across the layout instead of oscillating', () => {
    // A | B | C with the active pane A. Moving right twice should end with A
    // on the far right, not bouncing between the first two slots.
    const { a } = threePaneTree(store);
    store.getState().setActivePane(a);

    expect(store.getState().moveActivePaneDirection('right')).toBe(true);
    const afterFirst = leafIds(store);
    expect(afterFirst[afterFirst.length - 1]).not.toBe(a); // moved, not yet last

    store.getState().moveActivePaneDirection('right');
    const afterSecond = leafIds(store);
    expect(afterSecond[afterSecond.length - 1]).toBe(a);
    expect(afterSecond).toHaveLength(3);
  });

  it('keeps focus on the pane the user is moving', () => {
    const { a } = threePaneTree(store);
    store.getState().setActivePane(a);

    store.getState().moveActivePaneDirection('right');

    expect(activeWs(store).activePaneId).toBe(a);
  });

  it('returns false when there is no neighbour that way', () => {
    const { a } = threePaneTree(store);
    store.getState().setActivePane(a);
    const before = JSON.stringify(activeWs(store).rootPane);

    // The tree is purely horizontal, so there is nothing above A.
    expect(store.getState().moveActivePaneDirection('up')).toBe(false);
    expect(JSON.stringify(activeWs(store).rootPane)).toBe(before);
    expect(saveSessionNow).not.toHaveBeenCalled();
  });

  it('returns false in a single-pane workspace', () => {
    expect(store.getState().moveActivePaneDirection('left')).toBe(false);
    expect(saveSessionNow).not.toHaveBeenCalled();
  });
});

/** Structural fingerprint: shape and direction only, ignoring which leaf sits where. */
function describeShape(pane: Pane): unknown {
  if (pane.type === 'leaf') return 'leaf';
  return { direction: pane.direction, children: pane.children.map(describeShape) };
}

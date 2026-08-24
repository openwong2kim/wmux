import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice, MAX_PANES_PER_WORKSPACE } from '../paneSlice';
import { createWorkspace, createLeafPane, type Workspace, type Surface } from '../../../../shared/types';
import { findPane, getLeafPanes } from '../../../../shared/paneUtils';
import { setDaemonModeActive, resetDaemonModeForTests } from '../../../daemon/daemonMode';

// Stash is the NON-DESTRUCTIVE counterpart to closePane, so most of these tests
// are about what must NOT happen. The identity maps (surfaceAgent,
// surfaceActivity, paneLabel, paneRole) are the difference between "the pane
// moved" and "the agent died" — closePane clears them, stash must not touch a
// single one.

type TestState = PaneSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pushToast: ReturnType<typeof vi.fn>;
  zoomedPaneId: string | null;
};

function surface(id: string, ptyId: string, surfaceType?: Surface['surfaceType']): Surface {
  return { id, ptyId, title: '', shell: '', cwd: '', ...(surfaceType ? { surfaceType } : {}) };
}

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

function ws(store: ReturnType<typeof createTestStore>): Workspace {
  const state = store.getState();
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId)!;
}

/** The active workspace ON THE DRAFT — getState() hands back a frozen snapshot,
 *  so a fixture that mutates through it dies on immer's read-only proxy. */
function draftWs(s: TestState): Workspace {
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
}

/** Give every visible leaf a terminal surface, as the AppLayout funnel does a
 *  tick after a split. A pane with no surfaces has no session to keep running,
 *  so stash refuses it — fixtures have to be as real as that guard. */
function seedSurfaces(store: ReturnType<typeof createTestStore>): void {
  store.setState((s) => {
    for (const leaf of getLeafPanes(draftWs(s).rootPane)) {
      if (leaf.surfaces.length === 0) {
        leaf.surfaces = [surface(`sf-${leaf.id}`, `pty-${leaf.id}`)];
        leaf.activeSurfaceId = `sf-${leaf.id}`;
      }
    }
  });
}

/** Split the root once and return [firstLeafId, secondLeafId]. */
function splitOnce(store: ReturnType<typeof createTestStore>): [string, string] {
  const rootId = ws(store).rootPane.id;
  store.getState().splitPane(rootId, 'horizontal');
  seedSurfaces(store);
  const leaves = getLeafPanes(ws(store).rootPane);
  return [leaves[0].id, leaves[1].id];
}

describe('paneSlice — stash', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    setDaemonModeActive(true);
  });

  afterEach(() => {
    resetDaemonModeForTests();
  });

  describe('stashPane', () => {
    it('moves the leaf out of rootPane and into stashedPanes', () => {
      const [a, b] = splitOnce(store);

      expect(store.getState().stashPane(b)).toBe(true);

      const after = ws(store);
      expect(getLeafPanes(after.rootPane).map((l) => l.id)).toEqual([a]);
      expect(after.stashedPanes).toHaveLength(1);
      expect(after.stashedPanes![0].pane.id).toBe(b);
      expect(after.stashedPanes![0].stashedAt).toBeGreaterThan(0);
    });

    it('leaves every identity map untouched — the whole difference from closePane', () => {
      const [, b] = splitOnce(store);
      store.setState((s) => {
        const leaf = findPane(draftWs(s).rootPane, b);
        if (leaf && leaf.type === 'leaf') leaf.surfaces = [surface('sf-b', 'pty-b')];
        s.surfaceAgent['pty-b'] = { name: 'Claude Code', status: 'running', slug: 'claude' };
        s.surfaceActivity['pty-b'] = 'Reading paneSlice.ts';
        s.surfaceAgentStatus['pty-b'] = 'awaiting_input';
        s.surfacePendingQuestion['pty-b'] = 'Apply this patch?';
        s.paneLabel[b] = 'Backend';
        s.paneRole[b] = 'reviewer';
      });

      store.getState().stashPane(b);

      const s = store.getState();
      expect(s.surfaceAgent['pty-b']).toBeDefined();
      expect(s.surfaceActivity['pty-b']).toBe('Reading paneSlice.ts');
      expect(s.surfaceAgentStatus['pty-b']).toBe('awaiting_input');
      expect(s.surfacePendingQuestion['pty-b']).toBe('Apply this patch?');
      expect(s.paneLabel[b]).toBe('Backend');
      expect(s.paneRole[b]).toBe('reviewer');
      // …and the surface keeps its pty: the session is still running.
      expect(ws(store).stashedPanes![0].pane.surfaces[0].ptyId).toBe('pty-b');
    });

    it('refuses the last visible leaf', () => {
      const rootId = ws(store).rootPane.id;

      expect(store.getState().stashPane(rootId)).toBe(false);

      expect(ws(store).stashedPanes).toBeUndefined();
      expect(store.getState().pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn' }),
      );
    });

    it('refuses without a daemon connection — nothing would hold the session', () => {
      const [, b] = splitOnce(store);
      resetDaemonModeForTests();

      expect(store.getState().stashPane(b)).toBe(false);
      expect(ws(store).stashedPanes).toBeUndefined();
      expect(getLeafPanes(ws(store).rootPane)).toHaveLength(2);
    });

    it.each(['editor', 'diff', 'git', 'review'] as const)(
      'refuses a pane holding a %s surface — the ring cannot replay unsaved state',
      (surfaceType) => {
        const [, b] = splitOnce(store);
        store.setState((s) => {
          const leaf = findPane(draftWs(s).rootPane, b);
          if (leaf && leaf.type === 'leaf') {
            leaf.surfaces = [surface('sf-t', 'pty-t'), surface('sf-x', '', surfaceType)];
          }
        });

        expect(store.getState().stashPane(b)).toBe(false);
        expect(ws(store).stashedPanes).toBeUndefined();
      },
    );

    it('allows a browser surface — cold-park already unmounts webviews and restores them', () => {
      const [, b] = splitOnce(store);
      store.setState((s) => {
        const leaf = findPane(draftWs(s).rootPane, b);
        if (leaf && leaf.type === 'leaf') leaf.surfaces = [surface('sf-w', '', 'browser')];
      });

      expect(store.getState().stashPane(b)).toBe(true);
    });

    it('records the former neighbour, direction, order and a two-element sizes', () => {
      const rootId = ws(store).rootPane.id;
      store.getState().splitPane(rootId, 'vertical');
      seedSurfaces(store);
      const [a, b] = getLeafPanes(ws(store).rootPane).map((l) => l.id);
      store.setState((s) => {
        const root = draftWs(s).rootPane;
        if (root.type === 'branch') root.sizes = [30, 70];
      });

      store.getState().stashPane(a);

      const origin = ws(store).stashedPanes![0].origin!;
      expect(origin.anchorPaneId).toBe(b);
      expect(origin.direction).toBe('vertical');
      expect(origin.sourceFirst).toBe(true);
      // [stashed, anchor] — exactly two, in child order.
      expect(origin.sizes).toEqual([30, 70]);
    });

    it('anchors on the first leaf when the sibling is a branch (topology is lost)', () => {
      // root ── [ A , (B | C) ]
      const rootId = ws(store).rootPane.id;
      store.getState().splitPane(rootId, 'horizontal');
      const [a, b] = getLeafPanes(ws(store).rootPane).map((l) => l.id);
      store.getState().splitPane(b, 'vertical');
      seedSurfaces(store);
      const afterSplit = getLeafPanes(ws(store).rootPane).map((l) => l.id);
      const firstOfBranch = afterSplit[1];

      store.getState().stashPane(a);

      expect(ws(store).stashedPanes![0].origin!.anchorPaneId).toBe(firstOfBranch);
    });

    it('clears the zoom when the zoomed pane is the one being stashed', () => {
      const [, b] = splitOnce(store);
      store.setState((s) => { s.zoomedPaneId = b; });

      store.getState().stashPane(b);

      expect(store.getState().zoomedPaneId).toBeNull();
    });

    it('moves the active selection off the stashed pane', () => {
      const [a, b] = splitOnce(store);
      store.setState((s) => { draftWs(s).activePaneId = b; });

      store.getState().stashPane(b);

      expect(ws(store).activePaneId).toBe(a);
    });

    it('signals the sidebar so a collapsed roster does not read the stash as a delete', () => {
      const [, b] = splitOnce(store);

      store.getState().stashPane(b);

      expect(store.getState().stashPulse).toMatchObject({ workspaceId: ws(store).id, paneId: b });
      store.getState().clearStashPulse();
      expect(store.getState().stashPulse).toBeNull();
    });

    it('offers undo on a plain-value snapshot, not a revoked immer draft', () => {
      const [, b] = splitOnce(store);

      store.getState().stashPane(b);

      const toast = store.getState().pushToast.mock.calls.at(-1)![0];
      expect(toast.action).toBeDefined();
      // 10s, not the default 5 — the action IS the point of this toast.
      expect(toast.durationMs).toBe(10_000);
      // The captured ids must still work after the producer has closed.
      toast.action.onClick();
      expect(ws(store).stashedPanes).toBeUndefined();
      expect(getLeafPanes(ws(store).rootPane).map((l) => l.id)).toContain(b);
    });
  });

  describe('unstashPane', () => {
    it('re-attaches beside the recorded neighbour with its direction and sizes', () => {
      const rootId = ws(store).rootPane.id;
      store.getState().splitPane(rootId, 'vertical');
      seedSurfaces(store);
      const [a, b] = getLeafPanes(ws(store).rootPane).map((l) => l.id);
      store.setState((s) => {
        const root = draftWs(s).rootPane;
        if (root.type === 'branch') root.sizes = [30, 70];
      });
      store.getState().stashPane(a);

      expect(store.getState().unstashPane(a)).toBe(true);

      const root = ws(store).rootPane;
      expect(root.type).toBe('branch');
      if (root.type === 'branch') {
        expect(root.direction).toBe('vertical');
        expect(root.children.map((c) => c.id)).toEqual([a, b]);
        expect(root.sizes).toEqual([30, 70]);
      }
      expect(ws(store).stashedPanes).toBeUndefined();
      expect(ws(store).activePaneId).toBe(a);
    });

    it('falls back to the active pane when the recorded neighbour is gone', () => {
      // A | B | C, stash A (anchored on B), then close B.
      const rootId = ws(store).rootPane.id;
      store.getState().splitPane(rootId, 'horizontal');
      const [a, b] = getLeafPanes(ws(store).rootPane).map((l) => l.id);
      store.getState().splitPane(b, 'horizontal');
      seedSurfaces(store);
      const c = getLeafPanes(ws(store).rootPane).map((l) => l.id).find((id) => id !== a && id !== b)!;
      store.getState().stashPane(a);
      store.getState().closePane(b);
      store.setState((s) => { draftWs(s).activePaneId = c; });

      expect(store.getState().unstashPane(a)).toBe(true);

      const leaves = getLeafPanes(ws(store).rootPane).map((l) => l.id);
      expect(leaves).toContain(a);
      expect(leaves).toContain(c);
      // The fallback branch is built fresh, so it uses the default split.
      const parent = findPane(ws(store).rootPane, a);
      expect(parent).not.toBeNull();
    });

    it('is a silent success when the pane is already back (undo/roster race)', () => {
      const [, b] = splitOnce(store);
      store.getState().stashPane(b);
      store.getState().unstashPane(b);

      // Second call — the toast's undo firing after the roster already restored it.
      expect(store.getState().unstashPane(b)).toBe(true);
      expect(getLeafPanes(ws(store).rootPane).filter((l) => l.id === b)).toHaveLength(1);
    });

    it('returns false for an id that is neither stashed nor in the layout', () => {
      expect(store.getState().unstashPane('pane-nope')).toBe(false);
    });

    it('keeps the entry in the stash when re-attachment cannot land', () => {
      // Every anchor candidate is gone: the workspace itself has vanished, so
      // there is no tree to attach to. The pane must NOT be dropped — losing it
      // from both the tree and the stash is the one outcome this ordering exists
      // to prevent.
      const [, b] = splitOnce(store);
      store.getState().stashPane(b);
      const stashedBefore = ws(store).stashedPanes!.length;

      expect(store.getState().unstashPane(b, 'ws-does-not-exist')).toBe(false);
      expect(ws(store).stashedPanes).toHaveLength(stashedBefore);
    });

    it('survives a stash → unstash → stash round trip (no draft leak)', () => {
      const [, b] = splitOnce(store);

      store.getState().stashPane(b);
      store.getState().unstashPane(b);
      store.getState().stashPane(b);

      expect(ws(store).stashedPanes).toHaveLength(1);
      expect(ws(store).stashedPanes![0].pane.id).toBe(b);
      // The leaf survived two immer producers with its identity intact.
      expect(ws(store).stashedPanes![0].pane.type).toBe('leaf');
    });
  });

  describe('closePane on a stashed pane', () => {
    it('removes the entry AND performs the full destructive cleanup', () => {
      const [, b] = splitOnce(store);
      store.setState((s) => {
        const leaf = findPane(draftWs(s).rootPane, b);
        if (leaf && leaf.type === 'leaf') leaf.surfaces = [surface('sf-b', 'pty-b')];
        s.surfaceAgent['pty-b'] = { name: 'Claude Code', status: 'running', slug: 'claude' };
        s.surfaceActivity['pty-b'] = 'working';
        s.paneLabel[b] = 'Backend';
      });
      store.getState().stashPane(b);

      store.getState().closePane(b);

      expect(ws(store).stashedPanes).toBeUndefined();
      const s = store.getState();
      expect(s.surfaceAgent['pty-b']).toBeUndefined();
      expect(s.surfaceActivity['pty-b']).toBeUndefined();
      expect(s.paneLabel[b]).toBeUndefined();
    });
  });

  describe('the pane cap counts stashed panes', () => {
    it('blocks a split once visible + stashed reaches the limit', () => {
      // Fill to the cap, then stash half of them. The workspace still OWNS
      // MAX panes, so it is still at the cap.
      const rootId = ws(store).rootPane.id;
      let target = rootId;
      for (let i = 1; i < MAX_PANES_PER_WORKSPACE; i += 1) {
        const created = store.getState().splitPane(target, 'horizontal');
        target = created as string;
      }
      expect(getLeafPanes(ws(store).rootPane)).toHaveLength(MAX_PANES_PER_WORKSPACE);
      seedSurfaces(store);

      const stashTargets = getLeafPanes(ws(store).rootPane).slice(0, 5).map((l) => l.id);
      for (const id of stashTargets) store.getState().stashPane(id);
      expect(getLeafPanes(ws(store).rootPane)).toHaveLength(MAX_PANES_PER_WORKSPACE - 5);
      expect(ws(store).stashedPanes).toHaveLength(5);

      store.getState().pushToast.mockClear();
      const created = store.getState().splitPane(getLeafPanes(ws(store).rootPane)[0].id, 'horizontal');

      expect(created).toBe(false);
      // …and the message names the stash, or it points at panes the user can
      // count on screen while the ones eating the budget are invisible.
      const toast = store.getState().pushToast.mock.calls.at(-1)![0];
      expect(toast.message).toContain('5');
    });

    it('keeps the ordinal high-water above every stashed pane', () => {
      const [, b] = splitOnce(store);
      const stashedOrdinal = (findPane(ws(store).rootPane, b) as { ordinal?: number }).ordinal!;
      store.getState().stashPane(b);
      // Drop the counter, as a pre-P2 session would: the fallback must still
      // see the stashed pane, or the next split reissues its number and two
      // panes answer to the same A2A address.
      store.setState((s) => { delete draftWs(s).nextPaneOrdinal; });

      const created = store.getState().splitPane(getLeafPanes(ws(store).rootPane)[0].id, 'horizontal');

      const newLeaf = findPane(ws(store).rootPane, created as string) as { ordinal?: number };
      expect(newLeaf.ordinal).toBeGreaterThan(stashedOrdinal);
    });
  });

  describe('stashedPanes lifecycle', () => {
    it('is absent until something is stashed and absent again once emptied', () => {
      const [, b] = splitOnce(store);
      expect(ws(store).stashedPanes).toBeUndefined();

      store.getState().stashPane(b);
      expect(ws(store).stashedPanes).toHaveLength(1);

      store.getState().unstashPane(b);
      // Not `[]`: absence keeps meaning "nothing stashed", and a workspace that
      // has never stashed anything stays byte-identical on disk.
      expect(ws(store).stashedPanes).toBeUndefined();
    });

    it('createWorkspace does not seed the field', () => {
      expect(createWorkspace('Fresh').stashedPanes).toBeUndefined();
      expect(createLeafPane()).toMatchObject({ type: 'leaf' });
    });
  });
});

// ─── Review follow-ups ──────────────────────────────────────────────────────

describe('paneSlice — stash, review follow-ups', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    setDaemonModeActive(true);
  });

  afterEach(() => {
    resetDaemonModeForTests();
  });

  it('refuses to stash a pane with no surfaces', () => {
    const [, b] = splitOnce(store);
    store.setState((s) => {
      const leaf = findPane(draftWs(s).rootPane, b);
      if (leaf && leaf.type === 'leaf') leaf.surfaces = [];
    });

    expect(store.getState().stashPane(b)).toBe(false);
    // Not stashed and not lost — still right where it was.
    expect(ws(store).stashedPanes).toBeUndefined();
    expect(getLeafPanes(ws(store).rootPane).map((l) => l.id)).toContain(b);
  });

  it('only clears a zoom that belongs to THIS workspace on unstash', () => {
    const [, b] = splitOnce(store);
    store.getState().stashPane(b);
    // A pane the user left zoomed in a DIFFERENT workspace. zoomedPaneId is one
    // global slot, so an unguarded clear would silently un-zoom it.
    store.setState((s) => { s.zoomedPaneId = 'pane-in-another-workspace'; });

    store.getState().unstashPane(b);

    expect(store.getState().zoomedPaneId).toBe('pane-in-another-workspace');
  });

  it('clears a zoom on a pane of this workspace when unstashing beside it', () => {
    const [a, b] = splitOnce(store);
    store.getState().stashPane(b);
    store.setState((s) => { s.zoomedPaneId = a; });

    store.getState().unstashPane(b);

    // The re-attach re-flows the layout, so a pane hidden behind the zoom would
    // reappear somewhere unexpected — same rule split and move follow.
    expect(store.getState().zoomedPaneId).toBeNull();
  });
});

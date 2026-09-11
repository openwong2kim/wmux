import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createUISlice, type UISlice } from '../uiSlice';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspace, type Workspace, type Surface } from '../../../../shared/types';
import { getLeafPanes } from '../../../../shared/paneUtils';
import { setDaemonModeActive, resetDaemonModeForTests } from '../../../daemon/daemonMode';

// #1237 — snapToLayoutTemplate is the non-destructive twin of
// applyLayoutTemplate: running panes keep their identities and move into the
// template's slots, surplus panes go to the stash (or are refused when they
// cannot be stashed), and any deficit is filled with fresh empty leaves.

type TestState = UISlice & PaneSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pushToast: ReturnType<typeof vi.fn>;
  zoomedPaneId: string | null;
};

function terminalSurface(id: string): Surface {
  return { id, ptyId: `pty-${id}`, title: '', shell: '', cwd: '', surfaceType: 'terminal' };
}

function editorSurface(id: string): Surface {
  return { id, ptyId: `pty-${id}`, title: '', shell: '', cwd: '', surfaceType: 'editor' };
}

function createTestStore() {
  const ws = createWorkspace('Test');
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      pushToast: vi.fn(),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createUISlice(...args),
      // @ts-expect-error — same: slice factories type set/get against StoreState
      ...createPaneSlice(...args),
    })),
  );
}

function ws(store: ReturnType<typeof createTestStore>): Workspace {
  const state = store.getState();
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId)!;
}

function draftWs(s: TestState): Workspace {
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId)!;
}

function seedSurfaces(store: ReturnType<typeof createTestStore>): void {
  store.setState((s) => {
    for (const leaf of getLeafPanes(draftWs(s).rootPane)) {
      if (leaf.surfaces.length === 0) {
        leaf.surfaces = [terminalSurface(`sf-${leaf.id}`)];
        leaf.activeSurfaceId = leaf.surfaces[0].id;
      }
    }
  });
}

describe('uiSlice — snapToLayoutTemplate', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    setDaemonModeActive(true);
  });

  afterEach(() => {
    resetDaemonModeForTests();
  });

  it('reuses the running panes — identities, surfaces and ordinals survive', () => {
    // Two live panes snapped into the 2x2 grid: same ids, same surfaces, two
    // fresh leaves fill the deficit.
    store.getState().splitPane(ws(store).rootPane.id, 'horizontal');
    seedSurfaces(store);
    const before = getLeafPanes(ws(store).rootPane);
    expect(before).toHaveLength(2);
    // splitPane focuses the new leaf; pin the first one so the focus
    // assertion below is unambiguous.
    store.setState((s) => { draftWs(s).activePaneId = before[0].id; });

    store.getState().snapToLayoutTemplate('builtin-grid');

    const after = getLeafPanes(ws(store).rootPane);
    expect(after).toHaveLength(4);
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).toBe(before[1].id);
    expect(after[0].surfaces).toEqual(before[0].surfaces);
    expect(after[1].surfaces).toEqual(before[1].surfaces);
    // Tree shape + sizes come from the template.
    const root = ws(store).rootPane;
    expect(root.type).toBe('branch');
    if (root.type === 'branch') {
      expect(root.direction).toBe('vertical');
      expect(root.sizes).toEqual([50, 50]);
    }
    // Deficit leaves continue past the ordinal high-water (2 panes → next is 3).
    expect(after[2].ordinal).toBe(3);
    expect(after[3].ordinal).toBe(4);
    expect(ws(store).nextPaneOrdinal).toBe(5);
    // The active pane stayed on screen, so focus follows it.
    expect(ws(store).activePaneId).toBe(before[0].id);
  });

  it('stashes surplus panes instead of killing them', () => {
    setDaemonModeActive(true);
    // 2x2 grid → 4 panes, then snap into 2 Columns: 2 fit, 2 are stashed.
    store.getState().applyLayoutTemplate('builtin-grid');
    seedSurfaces(store);
    const before = getLeafPanes(ws(store).rootPane);
    expect(before).toHaveLength(4);

    store.getState().snapToLayoutTemplate('builtin-2col');

    const w = ws(store);
    const visible = getLeafPanes(w.rootPane);
    expect(visible).toHaveLength(2);
    // Tree-order reuse: the first two panes in reading order stay.
    expect(visible[0].id).toBe(before[0].id);
    expect(visible[1].id).toBe(before[1].id);
    expect(w.stashedPanes).toHaveLength(2);
    expect(w.stashedPanes!.map((e) => e.pane.id)).toEqual([before[2].id, before[3].id]);
    // The sessions are intact, not respawned.
    expect(w.stashedPanes![0].pane.surfaces).toEqual(before[2].surfaces);
    // No origin anchor — the old topology is gone; unstash falls back to the
    // active pane, which is the honest promise.
    expect(w.stashedPanes![0].origin).toBeUndefined();
    // A toast explains where the surplus went.
    const toast = store.getState().pushToast.mock.calls.at(-1)?.[0];
    expect(toast?.level).toBe('info');
  });

  it('discards surplus EMPTY panes — nothing to keep alive', () => {
    setDaemonModeActive(false);
    // 3 Columns with the last pane left EMPTY (a split that never got its
    // surface). Snap to 2 Columns: 2 live panes fill the slots, the empty one
    // is surplus — discarded, not stashed, and no daemon is needed for that.
    store.getState().applyLayoutTemplate('builtin-3col');
    seedSurfaces(store);
    // Empty the last pane's surfaces.
    store.setState((s) => {
      const leaves = getLeafPanes(draftWs(s).rootPane);
      leaves[2].surfaces = [];
      leaves[2].activeSurfaceId = '';
    });
    const emptiedId = getLeafPanes(ws(store).rootPane)[2].id;

    // No daemon on purpose: if the empty pane had to be stashed, this would
    // refuse. Discarding it needs nothing.
    setDaemonModeActive(false);
    store.getState().snapToLayoutTemplate('builtin-2col');

    const w = ws(store);
    const visible = getLeafPanes(w.rootPane);
    expect(visible).toHaveLength(2);
    expect(w.stashedPanes ?? []).toHaveLength(0);
    expect(visible.map((p) => p.id)).not.toContain(emptiedId);
    expect(store.getState().pushToast).not.toHaveBeenCalled();
  });

  it('refuses — no daemon and a surplus pane holds a live session', () => {
    setDaemonModeActive(false);
    store.getState().applyLayoutTemplate('builtin-grid');
    seedSurfaces(store);
    const treeBefore = JSON.stringify(ws(store).rootPane);

    store.getState().snapToLayoutTemplate('builtin-2col');

    // Tree untouched, nothing stashed, refusal toast.
    expect(JSON.stringify(ws(store).rootPane)).toBe(treeBefore);
    expect(ws(store).stashedPanes).toBeUndefined();
    const toast = store.getState().pushToast.mock.calls.at(-1)?.[0];
    expect(toast?.level).toBe('warn');
    expect(String(toast?.message)).toContain('daemon');
  });

  it('refuses — surplus pane holds an unstashable tab (editor)', () => {
    setDaemonModeActive(true);
    store.getState().applyLayoutTemplate('builtin-grid');
    seedSurfaces(store);
    const editorId = 'sf-editor';
    store.setState((s) => {
      const leaves = getLeafPanes(draftWs(s).rootPane);
      leaves[3].surfaces = [editorSurface(editorId)];
      leaves[3].activeSurfaceId = editorId;
    });
    const treeBefore = JSON.stringify(ws(store).rootPane);

    store.getState().snapToLayoutTemplate('builtin-2col');

    expect(JSON.stringify(ws(store).rootPane)).toBe(treeBefore);
    expect(ws(store).stashedPanes).toBeUndefined();
    const toast = store.getState().pushToast.mock.calls.at(-1)?.[0];
    expect(toast?.level).toBe('warn');
    expect(String(toast?.message)).toContain('editor');
  });

  it('blocks at the pane cap when the deficit would overflow the workspace', () => {
    // 2 visible + 17 stashed = 19 owned; snapping to the 4-slot grid would
    // add 2 leaves → 21 > 20. Refused with the cap toast, tree untouched.
    store.getState().splitPane(ws(store).rootPane.id, 'horizontal');
    seedSurfaces(store);
    const treeBefore = JSON.stringify(ws(store).rootPane);
    store.setState((s) => {
      const w = draftWs(s);
      w.stashedPanes = Array.from({ length: 17 }, (_, i) => ({
        pane: { id: `stashed-${i}`, type: 'leaf' as const, surfaces: [terminalSurface(`sf-st${i}`)], activeSurfaceId: `sf-st${i}`, ordinal: 10 + i },
        stashedAt: 1,
      }));
    });

    store.getState().snapToLayoutTemplate('builtin-grid');

    expect(JSON.stringify(ws(store).rootPane)).toBe(treeBefore);
    const toast = store.getState().pushToast.mock.calls.at(-1)?.[0];
    expect(toast?.level).toBe('warn');
    expect(String(toast?.message)).toContain('20');
  });

  it('moves focus off a stashed active pane and clears zoom', () => {
    setDaemonModeActive(true);
    store.getState().applyLayoutTemplate('builtin-grid');
    seedSurfaces(store);
    const leaves = getLeafPanes(ws(store).rootPane);
    store.setState((s) => {
      draftWs(s).activePaneId = leaves[2].id;
      s.zoomedPaneId = leaves[2].id;
    });

    store.getState().snapToLayoutTemplate('builtin-2col');

    const w = ws(store);
    expect(getLeafPanes(w.rootPane).map((p) => p.id)).not.toContain(leaves[2].id);
    expect(w.activePaneId).toBe(leaves[0].id);
    expect(store.getState().zoomedPaneId).toBeNull();
  });

  it('keeps the ordinal counter monotonic — a closed pane\'s number is never recycled', () => {
    // Two live panes (ordinals 1, 2) whose counter already sits at 9: panes
    // 3–8 were split off and closed. Deficit leaves continue from 9, not 3.
    store.getState().splitPane(ws(store).rootPane.id, 'horizontal');
    seedSurfaces(store);
    store.setState((s) => { draftWs(s).nextPaneOrdinal = 9; });

    store.getState().snapToLayoutTemplate('builtin-grid');

    const after = getLeafPanes(ws(store).rootPane);
    expect(after.slice(2).map((p) => p.ordinal)).toEqual([9, 10]);
    expect(ws(store).nextPaneOrdinal).toBe(11);
  });

  it('a snap that creates no pane leaves the ordinal counter where it was', () => {
    store.getState().splitPane(ws(store).rootPane.id, 'horizontal');
    seedSurfaces(store);
    store.setState((s) => { draftWs(s).nextPaneOrdinal = 9; });

    store.getState().snapToLayoutTemplate('builtin-2row');

    expect(ws(store).nextPaneOrdinal).toBe(9);
  });

  it('leaves a zoom pinned in ANOTHER workspace alone', () => {
    store.getState().splitPane(ws(store).rootPane.id, 'horizontal');
    seedSurfaces(store);
    const other = createWorkspace('Other');
    store.setState((s) => {
      s.workspaces.push(other);
      s.zoomedPaneId = other.rootPane.id;
    });

    store.getState().snapToLayoutTemplate('builtin-2row');

    expect(store.getState().zoomedPaneId).toBe(other.rootPane.id);
  });

  it('names a refused pane by the label its header shows', () => {
    setDaemonModeActive(true);
    store.getState().applyLayoutTemplate('builtin-grid');
    seedSurfaces(store);
    store.setState((s) => {
      const leaves = getLeafPanes(draftWs(s).rootPane);
      leaves[3].surfaces = [editorSurface('sf-editor')];
      leaves[3].activeSurfaceId = 'sf-editor';
      s.paneLabel[leaves[3].id] = 'notes';
    });

    store.getState().snapToLayoutTemplate('builtin-2col');

    const toast = store.getState().pushToast.mock.calls.at(-1)?.[0];
    expect(String(toast?.message)).toContain('notes');
  });
});

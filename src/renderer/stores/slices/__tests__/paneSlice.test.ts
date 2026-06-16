import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice, MAX_PANES_PER_WORKSPACE } from '../paneSlice';
import { createWorkspace, type Workspace, type Surface } from '../../../../shared/types';
import { findPane, getLeafPanes } from '../../../../shared/paneUtils';

// Minimal store that satisfies PaneSlice dependencies. Includes a `pushToast`
// stub because splitPane calls it via get() when the leaf cap is hit.
type TestState = PaneSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pushToast: ReturnType<typeof vi.fn>;
  // uiSlice field that splitPane/closePane mutate for zoom coherence (#182).
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

function getActiveWorkspace(store: ReturnType<typeof createTestStore>): Workspace {
  const state = store.getState();
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId)!;
}

describe('PaneSlice', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  describe('splitPane', () => {
    it('creates a branch with 2 children from a leaf', () => {
      const ws = getActiveWorkspace(store);
      const rootId = ws.rootPane.id;

      store.getState().splitPane(rootId, 'horizontal');

      const wsAfter = getActiveWorkspace(store);
      expect(wsAfter.rootPane.type).toBe('branch');
      if (wsAfter.rootPane.type === 'branch') {
        expect(wsAfter.rootPane.children).toHaveLength(2);
        expect(wsAfter.rootPane.children[0].type).toBe('leaf');
        expect(wsAfter.rootPane.children[1].type).toBe('leaf');
      }
    });

    it('with horizontal creates a horizontal branch', () => {
      const ws = getActiveWorkspace(store);
      store.getState().splitPane(ws.rootPane.id, 'horizontal');

      const wsAfter = getActiveWorkspace(store);
      if (wsAfter.rootPane.type === 'branch') {
        expect(wsAfter.rootPane.direction).toBe('horizontal');
      }
    });

    it('with vertical creates a vertical branch', () => {
      const ws = getActiveWorkspace(store);
      store.getState().splitPane(ws.rootPane.id, 'vertical');

      const wsAfter = getActiveWorkspace(store);
      if (wsAfter.rootPane.type === 'branch') {
        expect(wsAfter.rootPane.direction).toBe('vertical');
      }
    });

    // Regression: AppLayout's auto-PTY effect uses the joined empty-leaf id list as
    // its dep signature so split-induced empty leaves trigger PTY creation. If split
    // ever stops producing an empty leaf as the new active pane (or that leaf already
    // carries surfaces), the effect would silently miss it and the new pane would
    // stay as the "빈 창" placeholder forever. Lock both invariants here.
    it('split produces a new empty leaf and makes it active', () => {
      const ws = getActiveWorkspace(store);
      const rootId = ws.rootPane.id;
      store.getState().splitPane(rootId, 'horizontal');

      const wsAfter = getActiveWorkspace(store);
      const emptyLeafIds: string[] = [];
      const walk = (p: typeof wsAfter.rootPane): void => {
        if (p.type === 'leaf') {
          if (p.surfaces.length === 0) emptyLeafIds.push(p.id);
        } else {
          p.children.forEach(walk);
        }
      };
      walk(wsAfter.rootPane);

      expect(emptyLeafIds.length).toBeGreaterThanOrEqual(1);
      expect(emptyLeafIds).toContain(wsAfter.activePaneId);
    });

    // Issue #173: splitting a pane whose active surface has an OSC 7-tracked
    // cwd records a transient seed for the new pane; the AppLayout funnel
    // consumes it as the new PTY's starting directory.
    describe('splitCwdSeed (#173)', () => {
      function seedSurface(cwd: string, surfaceType?: 'terminal' | 'browser' | 'editor') {
        store.setState((s) => {
          const root = s.workspaces[0].rootPane;
          if (root.type !== 'leaf') throw new Error('expected leaf root');
          root.surfaces.push({ id: 's1', ptyId: 'pty-1', title: 't', shell: 'pwsh', cwd, ...(surfaceType ? { surfaceType } : {}) });
          root.activeSurfaceId = 's1';
        });
      }

      it('captures the active surface cwd for the new pane', () => {
        const rootId = getActiveWorkspace(store).rootPane.id;
        seedSurface('D:\\proj');
        store.getState().splitPane(rootId, 'horizontal');

        const wsAfter = getActiveWorkspace(store);
        expect(store.getState().splitCwdSeed[wsAfter.activePaneId]).toBe('D:\\proj');
      });

      it('records no seed when the active surface has no cwd yet', () => {
        const rootId = getActiveWorkspace(store).rootPane.id;
        seedSurface('');
        store.getState().splitPane(rootId, 'horizontal');
        expect(Object.keys(store.getState().splitCwdSeed)).toHaveLength(0);
      });

      it('records no seed for a browser surface', () => {
        const rootId = getActiveWorkspace(store).rootPane.id;
        seedSurface('D:\\proj', 'browser');
        store.getState().splitPane(rootId, 'horizontal');
        expect(Object.keys(store.getState().splitCwdSeed)).toHaveLength(0);
      });

      it('clearSplitCwdSeed consumes the entry', () => {
        const rootId = getActiveWorkspace(store).rootPane.id;
        seedSurface('D:\\proj');
        store.getState().splitPane(rootId, 'horizontal');
        const newPaneId = getActiveWorkspace(store).activePaneId;
        store.getState().clearSplitCwdSeed(newPaneId);
        expect(store.getState().splitCwdSeed[newPaneId]).toBeUndefined();
      });

      it('closePane drops a dangling seed', () => {
        const rootId = getActiveWorkspace(store).rootPane.id;
        seedSurface('D:\\proj');
        store.getState().splitPane(rootId, 'horizontal');
        const newPaneId = getActiveWorkspace(store).activePaneId;
        expect(store.getState().splitCwdSeed[newPaneId]).toBe('D:\\proj');
        store.getState().closePane(newPaneId);
        expect(store.getState().splitCwdSeed[newPaneId]).toBeUndefined();
      });
    });

    // 4-way directional split (Ctrl+Shift+Arrow): position drives which slot
    // the new pane lands in. Right/Down → 'after', Left/Up → 'before'.
    it('position "after" (default) puts the new pane second (right/below)', () => {
      const ws = getActiveWorkspace(store);
      const rootId = ws.rootPane.id;
      store.getState().splitPane(rootId, 'horizontal'); // default position 'after'
      const wsAfter = getActiveWorkspace(store);
      expect(wsAfter.rootPane.type).toBe('branch');
      if (wsAfter.rootPane.type === 'branch') {
        // original stays in slot 0, new (active) pane lands in slot 1
        expect(wsAfter.rootPane.children[0].id).toBe(rootId);
        expect(wsAfter.rootPane.children[1].id).toBe(wsAfter.activePaneId);
      }
    });

    it('position "before" puts the new pane first (left/above)', () => {
      const ws = getActiveWorkspace(store);
      const rootId = ws.rootPane.id;
      store.getState().splitPane(rootId, 'vertical', undefined, 'before');
      const wsAfter = getActiveWorkspace(store);
      expect(wsAfter.rootPane.type).toBe('branch');
      if (wsAfter.rootPane.type === 'branch') {
        // new (active) pane lands in slot 0, original moves to slot 1
        expect(wsAfter.rootPane.children[0].id).toBe(wsAfter.activePaneId);
        expect(wsAfter.rootPane.children[1].id).toBe(rootId);
      }
    });
  });

  describe('splitPane — background workspace targeting (#236)', () => {
    // ws1 stays active; ws2 is split DIRECTLY via the workspaceId arg without
    // ever being activated — exactly what the pane.split RPC does for an
    // external multi-agent caller whose workspace isn't the one on screen.
    function twoWorkspaces() {
      const ws1 = getActiveWorkspace(store);
      const ws2 = createWorkspace('Background');
      store.setState((s) => { s.workspaces.push(ws2); });
      return { ws1, ws2 };
    }

    it('splits the explicit background workspace while another ws stays active', () => {
      const { ws1, ws2 } = twoWorkspaces();
      const ok = store.getState().splitPane(ws2.rootPane.id, 'horizontal', ws2.id);
      expect(ok).toBe(true);

      const ws2After = store.getState().workspaces.find((w) => w.id === ws2.id)!;
      expect(ws2After.rootPane.type).toBe('branch'); // ws2 got the split
      const ws1After = store.getState().workspaces.find((w) => w.id === ws1.id)!;
      expect(ws1After.rootPane.type).toBe('leaf');    // ws1 untouched
      expect(store.getState().activeWorkspaceId).toBe(ws1.id); // global focus didn't move
    });

    it('does NOT change the active ws activePaneId when splitting a background ws', () => {
      const { ws1, ws2 } = twoWorkspaces();
      const activeBefore = ws1.activePaneId;
      store.getState().splitPane(ws2.rootPane.id, 'horizontal', ws2.id);
      const ws1After = store.getState().workspaces.find((w) => w.id === ws1.id)!;
      expect(ws1After.activePaneId).toBe(activeBefore);
    });

    it('leaves the background ws own activePaneId untouched (focus-scoping); new empty leaf is locatable', () => {
      const { ws2 } = twoWorkspaces();
      const ws2ActiveBefore = ws2.activePaneId;
      store.getState().splitPane(ws2.rootPane.id, 'horizontal', ws2.id);
      const ws2After = store.getState().workspaces.find((w) => w.id === ws2.id)!;
      // The RPC handler locates the fresh empty leaf structurally, so the slice
      // does not need to (and must not) move the background ws's selection.
      expect(ws2After.activePaneId).toBe(ws2ActiveBefore);
      const emptyLeaves = getLeafPanes(ws2After.rootPane).filter((l) => l.surfaces.length === 0);
      expect(emptyLeaves.length).toBeGreaterThanOrEqual(1);
    });

    it('still records the splitCwdSeed for a background split (the PTY funnel / eager-spawn needs it)', () => {
      const { ws2 } = twoWorkspaces();
      store.setState((s) => {
        const w = s.workspaces.find((x) => x.id === ws2.id)!;
        if (w.rootPane.type !== 'leaf') throw new Error('expected leaf');
        w.rootPane.surfaces.push({ id: 's-bg', ptyId: 'pty-bg', title: 't', shell: 'pwsh', cwd: 'D:\\bg' });
        w.rootPane.activeSurfaceId = 's-bg';
      });
      store.getState().splitPane(ws2.rootPane.id, 'horizontal', ws2.id);
      const ws2After = store.getState().workspaces.find((w) => w.id === ws2.id)!;
      const newLeaf = getLeafPanes(ws2After.rootPane).find((l) => l.surfaces.length === 0)!;
      expect(store.getState().splitCwdSeed[newLeaf.id]).toBe('D:\\bg');
    });

    it('no-workspaceId split still targets the active ws (human-path regression guard)', () => {
      const { ws1, ws2 } = twoWorkspaces();
      store.getState().splitPane(ws1.activePaneId, 'horizontal'); // omit workspaceId
      const ws1After = store.getState().workspaces.find((w) => w.id === ws1.id)!;
      const ws2After = store.getState().workspaces.find((w) => w.id === ws2.id)!;
      expect(ws1After.rootPane.type).toBe('branch'); // active ws split
      expect(ws2After.rootPane.type).toBe('leaf');    // background untouched
    });
  });

  describe('closePane', () => {
    it('closes a pane in a non-active workspace via the workspaceId parameter', () => {
      const ws1 = getActiveWorkspace(store);
      const ws2 = createWorkspace('Other');
      store.setState((s) => { s.workspaces.push(ws2); });

      // Build a 2-pane tree inside ws2 (splitPane operates on the active
      // workspace), then return focus to ws1 so ws2 is a background workspace.
      store.setState((s) => { s.activeWorkspaceId = ws2.id; });
      store.getState().splitPane(ws2.rootPane.id, 'horizontal');
      store.setState((s) => { s.activeWorkspaceId = ws1.id; });

      const ws2Split = store.getState().workspaces.find((w) => w.id === ws2.id)!;
      expect(ws2Split.rootPane.type).toBe('branch');
      if (ws2Split.rootPane.type !== 'branch') return;
      const childId = ws2Split.rootPane.children[0].id;

      store.getState().closePane(childId, ws2.id);

      const ws2After = store.getState().workspaces.find((w) => w.id === ws2.id)!;
      expect(ws2After.rootPane.type).toBe('leaf');
      // The active workspace must be untouched.
      expect(store.getState().activeWorkspaceId).toBe(ws1.id);
      expect(getActiveWorkspace(store).rootPane.type).toBe('leaf');
    });

    it('without workspaceId, a non-active workspace pane is a no-op (the asymmetry guard)', () => {
      const ws1 = getActiveWorkspace(store);
      const ws2 = createWorkspace('Other');
      store.setState((s) => { s.workspaces.push(ws2); });
      store.setState((s) => { s.activeWorkspaceId = ws2.id; });
      store.getState().splitPane(ws2.rootPane.id, 'horizontal');
      store.setState((s) => { s.activeWorkspaceId = ws1.id; });

      const ws2Split = store.getState().workspaces.find((w) => w.id === ws2.id)!;
      if (ws2Split.rootPane.type !== 'branch') throw new Error('expected branch');

      store.getState().closePane(ws2Split.rootPane.children[0].id);

      const ws2After = store.getState().workspaces.find((w) => w.id === ws2.id)!;
      expect(ws2After.rootPane.type).toBe('branch');
    });

    it('removes a leaf and collapses the parent branch', () => {
      const ws = getActiveWorkspace(store);
      const originalLeafId = ws.rootPane.id;

      // Split to create 2 panes
      store.getState().splitPane(originalLeafId, 'horizontal');
      const wsAfterSplit = getActiveWorkspace(store);
      expect(wsAfterSplit.rootPane.type).toBe('branch');

      // Close the first child (original leaf copy)
      if (wsAfterSplit.rootPane.type === 'branch') {
        const firstChildId = wsAfterSplit.rootPane.children[0].id;
        store.getState().closePane(firstChildId);

        const wsAfterClose = getActiveWorkspace(store);
        // Parent branch should have been collapsed, leaving the remaining leaf as root
        expect(wsAfterClose.rootPane.type).toBe('leaf');
      }
    });

    it('on root pane does nothing (cannot close root)', () => {
      const ws = getActiveWorkspace(store);
      const rootId = ws.rootPane.id;

      store.getState().closePane(rootId);

      const wsAfter = getActiveWorkspace(store);
      expect(wsAfter.rootPane.id).toBe(rootId);
      expect(wsAfter.rootPane.type).toBe('leaf');
    });
  });

  describe('focusPaneDirection', () => {
    it('does nothing with only 1 pane', () => {
      const ws = getActiveWorkspace(store);
      const activeId = ws.activePaneId;

      store.getState().focusPaneDirection('right');

      const wsAfter = getActiveWorkspace(store);
      expect(wsAfter.activePaneId).toBe(activeId);
    });

    it('moves to adjacent sibling in aligned direction', () => {
      const ws = getActiveWorkspace(store);
      store.getState().splitPane(ws.rootPane.id, 'horizontal');

      const wsAfterSplit = getActiveWorkspace(store);
      const leaves = getLeafPanes(wsAfterSplit.rootPane);
      expect(leaves).toHaveLength(2);

      // After split, active pane should be the new (second) pane
      const activeBeforeMove = wsAfterSplit.activePaneId;
      expect(activeBeforeMove).toBe(leaves[1].id);

      // Move left should go to the first pane
      store.getState().focusPaneDirection('left');
      const wsAfterMove = getActiveWorkspace(store);
      expect(wsAfterMove.activePaneId).toBe(leaves[0].id);
    });

    it('stays at current pane when no neighbor in direction (no wrap)', () => {
      const ws = getActiveWorkspace(store);
      store.getState().splitPane(ws.rootPane.id, 'vertical');

      const wsAfterSplit = getActiveWorkspace(store);
      const leaves = getLeafPanes(wsAfterSplit.rootPane);

      // Active is leaves[1] (last pane). Move down should stay (no wrap-around)
      store.getState().focusPaneDirection('down');
      const wsAfterMove = getActiveWorkspace(store);
      expect(wsAfterMove.activePaneId).toBe(leaves[1].id);
    });
  });

  describe('cyclePane', () => {
    it('does nothing with only 1 pane', () => {
      const ws = getActiveWorkspace(store);
      const activeId = ws.activePaneId;

      store.getState().cyclePane('next');
      expect(getActiveWorkspace(store).activePaneId).toBe(activeId);

      store.getState().cyclePane('prev');
      expect(getActiveWorkspace(store).activePaneId).toBe(activeId);
    });

    it('next moves to the next leaf in tree order', () => {
      const ws = getActiveWorkspace(store);
      const rootId = ws.rootPane.id;

      // Split twice → 3 leaves total. Tree shape after each split:
      //   Step 1 (split rootId horizontally):  [originalCopy, A]    active = A
      //   Step 2 (split A horizontally):       [originalCopy, [A, B]]  active = B
      store.getState().splitPane(rootId, 'horizontal');
      const wsAfterFirst = getActiveWorkspace(store);
      store.getState().splitPane(wsAfterFirst.activePaneId, 'horizontal');

      const wsAfter = getActiveWorkspace(store);
      const leaves = getLeafPanes(wsAfter.rootPane);
      expect(leaves).toHaveLength(3);

      // Active is the last leaf (B). next → wrap to leaves[0].
      expect(wsAfter.activePaneId).toBe(leaves[2].id);
      store.getState().cyclePane('next');
      expect(getActiveWorkspace(store).activePaneId).toBe(leaves[0].id);

      // next again → leaves[1], then leaves[2].
      store.getState().cyclePane('next');
      expect(getActiveWorkspace(store).activePaneId).toBe(leaves[1].id);
      store.getState().cyclePane('next');
      expect(getActiveWorkspace(store).activePaneId).toBe(leaves[2].id);
    });

    it('prev cycles backwards and wraps from first to last', () => {
      const ws = getActiveWorkspace(store);
      const rootId = ws.rootPane.id;

      store.getState().splitPane(rootId, 'horizontal');
      const wsAfterFirst = getActiveWorkspace(store);
      store.getState().splitPane(wsAfterFirst.activePaneId, 'vertical');

      const wsAfter = getActiveWorkspace(store);
      const leaves = getLeafPanes(wsAfter.rootPane);
      expect(leaves).toHaveLength(3);

      // Snap to leaves[0] then go prev → wraps to leaves[leaves.length - 1].
      store.getState().setActivePane(leaves[0].id);
      store.getState().cyclePane('prev');
      expect(getActiveWorkspace(store).activePaneId).toBe(leaves[leaves.length - 1].id);

      // prev again walks toward the front.
      store.getState().cyclePane('prev');
      expect(getActiveWorkspace(store).activePaneId).toBe(leaves[leaves.length - 2].id);
    });
  });

  describe('splitPane — leaf cap', () => {
    // Workspace starts with 1 leaf; each split adds exactly 1 leaf, so
    // (MAX_PANES_PER_WORKSPACE - 1) splits brings us right to the cap.
    it('allows splits up to MAX_PANES_PER_WORKSPACE leaves', () => {
      for (let i = 0; i < MAX_PANES_PER_WORKSPACE - 1; i++) {
        const ws = getActiveWorkspace(store);
        const ok = store.getState().splitPane(ws.activePaneId, 'horizontal');
        expect(ok).toBe(true);
      }
      const wsAfter = getActiveWorkspace(store);
      expect(getLeafPanes(wsAfter.rootPane)).toHaveLength(MAX_PANES_PER_WORKSPACE);
      expect(store.getState().pushToast).not.toHaveBeenCalled();
    });

    it('returns false, no-ops the tree, and toasts once at the cap', () => {
      for (let i = 0; i < MAX_PANES_PER_WORKSPACE - 1; i++) {
        const ws = getActiveWorkspace(store);
        store.getState().splitPane(ws.activePaneId, 'horizontal');
      }
      const wsAtCap = getActiveWorkspace(store);
      const leavesAtCap = getLeafPanes(wsAtCap.rootPane).map((l) => l.id);

      const ok = store.getState().splitPane(wsAtCap.activePaneId, 'horizontal');
      expect(ok).toBe(false);

      const wsAfter = getActiveWorkspace(store);
      const leavesAfter = getLeafPanes(wsAfter.rootPane).map((l) => l.id);
      expect(leavesAfter).toEqual(leavesAtCap); // tree unchanged
      expect(store.getState().pushToast).toHaveBeenCalledTimes(1);
      const arg = store.getState().pushToast.mock.calls[0][0] as { level: string; message: string };
      expect(arg.level).toBe('warn');
      expect(arg.message).toContain(String(MAX_PANES_PER_WORKSPACE));
    });
  });

  describe('setSurfaceAgentStatus (B8: completed-terminal blink)', () => {
    it('stores attention statuses (complete / waiting / awaiting_input)', () => {
      store.getState().setSurfaceAgentStatus('pty-1', 'complete');
      store.getState().setSurfaceAgentStatus('pty-2', 'waiting');
      store.getState().setSurfaceAgentStatus('pty-3', 'awaiting_input');
      const map = store.getState().surfaceAgentStatus;
      expect(map['pty-1']).toBe('complete');
      expect(map['pty-2']).toBe('waiting');
      expect(map['pty-3']).toBe('awaiting_input');
    });

    it('clears the entry on running / idle / error (non-attention statuses)', () => {
      store.getState().setSurfaceAgentStatus('pty-1', 'complete');
      store.getState().setSurfaceAgentStatus('pty-1', 'running');
      expect(store.getState().surfaceAgentStatus['pty-1']).toBeUndefined();

      store.getState().setSurfaceAgentStatus('pty-2', 'awaiting_input');
      store.getState().setSurfaceAgentStatus('pty-2', 'idle');
      expect(store.getState().surfaceAgentStatus['pty-2']).toBeUndefined();

      store.getState().setSurfaceAgentStatus('pty-3', 'complete');
      store.getState().setSurfaceAgentStatus('pty-3', 'error');
      expect(store.getState().surfaceAgentStatus['pty-3']).toBeUndefined();
    });

    it('clears the entry on null (pane focused / seen)', () => {
      store.getState().setSurfaceAgentStatus('pty-1', 'complete');
      store.getState().setSurfaceAgentStatus('pty-1', null);
      expect(store.getState().surfaceAgentStatus['pty-1']).toBeUndefined();
    });

    it('ignores an empty ptyId', () => {
      store.getState().setSurfaceAgentStatus('', 'complete');
      expect(store.getState().surfaceAgentStatus['']).toBeUndefined();
    });

    it('overwrites an existing attention status with a newer attention status', () => {
      store.getState().setSurfaceAgentStatus('pty-1', 'waiting');
      store.getState().setSurfaceAgentStatus('pty-1', 'complete');
      expect(store.getState().surfaceAgentStatus['pty-1']).toBe('complete');
    });
  });

  // Issue #182: split/close must keep the zoom state coherent. zoomedPaneId
  // lives in uiSlice; the pane mutations below clear it via the shared
  // StoreState, so the test store injects it with setState.
  describe('pane zoom coherence (issue #182)', () => {
    it('splitPane un-zooms when the zoomed pane is in the target workspace', () => {
      const ws = getActiveWorkspace(store);
      const rootId = ws.rootPane.id;
      store.setState({ zoomedPaneId: rootId });

      store.getState().splitPane(rootId, 'horizontal');

      expect(store.getState().zoomedPaneId).toBeNull();
    });

    it('splitPane keeps a zoom that belongs to a different workspace', () => {
      const ws = getActiveWorkspace(store);
      store.setState({ zoomedPaneId: 'pane-elsewhere' });

      store.getState().splitPane(ws.rootPane.id, 'horizontal');

      expect(store.getState().zoomedPaneId).toBe('pane-elsewhere');
    });

    it('closePane clears the zoom when closing the zoomed pane', () => {
      const ws = getActiveWorkspace(store);
      store.getState().splitPane(ws.rootPane.id, 'horizontal');
      const leaves = getLeafPanes(getActiveWorkspace(store).rootPane);
      const target = leaves[1].id;
      store.setState({ zoomedPaneId: target });

      store.getState().closePane(target);

      expect(store.getState().zoomedPaneId).toBeNull();
    });

    it('closePane keeps the zoom when closing a different pane', () => {
      const ws = getActiveWorkspace(store);
      store.getState().splitPane(ws.rootPane.id, 'horizontal');
      const leaves = getLeafPanes(getActiveWorkspace(store).rootPane);
      store.setState({ zoomedPaneId: leaves[0].id });

      store.getState().closePane(leaves[1].id);

      expect(store.getState().zoomedPaneId).toBe(leaves[0].id);
    });
  });

  // Part A — per-surface agent identity map.
  describe('surfaceAgent', () => {
    it('stores name + status keyed by ptyId', () => {
      store.getState().setSurfaceAgent('pty-1', 'Claude Code', 'waiting');
      expect(store.getState().surfaceAgent['pty-1']).toEqual({ name: 'Claude Code', status: 'waiting' });
    });

    it('keeps the known name when a later update carries an empty name (running broadcast)', () => {
      store.getState().setSurfaceAgent('pty-1', 'Codex CLI', 'running');
      store.getState().setSurfaceAgent('pty-1', '', 'running'); // ActivityMonitor running, name not yet gated
      expect(store.getState().surfaceAgent['pty-1']).toEqual({ name: 'Codex CLI', status: 'running' });
    });

    it('updates only the status when a status-only update arrives for a known agent', () => {
      store.getState().setSurfaceAgent('pty-1', 'Claude Code', 'running');
      store.getState().setSurfaceAgent('pty-1', undefined, 'complete');
      expect(store.getState().surfaceAgent['pty-1']).toEqual({ name: 'Claude Code', status: 'complete' });
    });

    it('does nothing when no name is known yet (no entry created)', () => {
      store.getState().setSurfaceAgent('pty-x', '', 'running');
      store.getState().setSurfaceAgent('pty-x', undefined, 'waiting');
      expect(store.getState().surfaceAgent['pty-x']).toBeUndefined();
    });

    it('clearSurfaceAgent removes the entry', () => {
      store.getState().setSurfaceAgent('pty-1', 'Claude Code', 'running');
      store.getState().clearSurfaceAgent('pty-1');
      expect(store.getState().surfaceAgent['pty-1']).toBeUndefined();
    });

    it('closePane auto-clears surfaceAgent for every surface under the closed subtree (leak-prevention)', () => {
      const ws = getActiveWorkspace(store);
      const rootLeafId = getLeafPanes(ws.rootPane)[0].id;
      store.getState().splitPane(rootLeafId, 'horizontal');
      const closing = getLeafPanes(getActiveWorkspace(store).rootPane)[1];
      // Give the closing pane a terminal surface with a known ptyId (a freshly
      // split leaf is empty until AppLayout funnels a PTY in the real app).
      store.setState((s) => {
        const leaf = getLeafPanes(s.workspaces[0].rootPane).find((l) => l.id === closing.id);
        if (leaf) leaf.surfaces.push({ id: 'surf-ct', ptyId: 'pty-closetest', title: 'x', shell: '', cwd: '', surfaceType: 'terminal' } as Surface);
      });
      store.getState().setSurfaceAgent('pty-closetest', 'Claude Code', 'running');
      expect(store.getState().surfaceAgent['pty-closetest']).toBeTruthy();
      store.getState().closePane(closing.id);
      expect(store.getState().surfaceAgent['pty-closetest']).toBeUndefined();
    });
  });
});

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Pane, PaneLeaf, PaneBranch, Workspace, AgentStatus } from '../../../shared/types';
import {
  createLeafPane,
  generateId,
} from '../../../shared/types';
import {
  publishPaneCreated,
  publishPaneClosed,
  publishPaneFocused,
} from '../../events/publisher';
import { t } from '../../i18n';

// Per-workspace leaf cap. xterm.js + node-pty memory scales linearly with
// pane count, and the project memory budget targets ~200 MB for 10 panes
// (TODOS.md "Pane split max depth/count guard"). 20 leaves keeps a runaway
// shortcut spam (Ctrl+D held, scripted splits, etc.) from exhausting RAM
// while still being far more than any sane manual layout needs.
export const MAX_PANES_PER_WORKSPACE = 20;

// M0-d: paneSlice is a read-only mirror for PaneLeaf.metadata. The
// authoritative writer is MetadataStore in the main process (M0-a + M0-b).
// `setPaneMetadata` / `getPaneMetadata` / `clearPaneMetadata` are intentionally
// *not* exposed here so no renderer code path can bypass the store. The
// `PaneLeaf.metadata` field remains on the shared type so UI components can
// read it directly (and so SessionManager hydration can populate it).
export interface PaneSlice {
  /**
   * Split a leaf pane into a new horizontal/vertical branch.
   * Returns `true` on success, `false` if the workspace is at
   * MAX_PANES_PER_WORKSPACE (callers chaining `addBrowserSurface`,
   * RPC handlers, etc. must abort on `false` so they don't mutate
   * the still-active original pane).
   */
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical', workspaceId?: string, position?: 'before' | 'after') => boolean;
  /** Close a leaf pane. `workspaceId` lets RPC/CLI callers target a
   * non-active workspace (defaults to the active one — existing callers are
   * unchanged). */
  closePane: (paneId: string, workspaceId?: string) => void;
  setActivePane: (paneId: string) => void;
  focusPaneDirection: (direction: 'up' | 'down' | 'left' | 'right') => void;
  cyclePane: (direction: 'next' | 'prev') => void;
  updatePaneSizes: (branchId: string, sizes: number[]) => void;
  resizeActivePane: (direction: 'left' | 'right' | 'up' | 'down', amount: number) => void;
  equalizePaneSizes: () => void;
  // Sparse map of per-pane visual notification rings. Missing entry = no ring.
  // T11 will consume this for the flash→glow CSS treatment around each pane.
  paneNotificationRing: Record<string, 'flash' | 'glow'>;
  setPaneNotificationRing: (paneId: string, ring: 'flash' | 'glow' | null) => void;
  // B8: per-surface agent lifecycle status keyed by ptyId. Only the
  // "needs attention" statuses (complete / waiting / awaiting_input) are
  // retained; running / idle / error / null all clear the entry. Drives the
  // "completed terminal" blink on inactive panes (Pane.tsx) and the per-tab
  // status dot (SurfaceTabs). Populated from METADATA_UPDATE in
  // useNotificationListener; cleared when the owning pane is focused or the
  // agent resumes / the PTY exits (PTYBridge broadcasts running/idle).
  surfaceAgentStatus: Record<string, AgentStatus>;
  setSurfaceAgentStatus: (ptyId: string, status: AgentStatus | null) => void;
  // X1: per-surface listening ports keyed by ptyId. Main emits ports per PTY
  // (PID-tree scoped); the workspace-level sidebar value is the UNION over
  // the workspace's surfaces, computed at write time in
  // useNotificationListener. Without this map, multi-pane workspaces
  // last-writer-win on metadata.listeningPorts and the sidebar flickers
  // (pane A's [8123] erased by pane B's [] on every poll tick). Transient —
  // never persisted (buildSessionData allowlist excludes it).
  surfacePorts: Record<string, number[]>;
  setSurfacePorts: (ptyId: string, ports: number[] | null) => void;
  // Issue #173: transient map of pane id → cwd inherited from the pane that
  // was split. Written by splitPane, consumed (and cleared) by the AppLayout
  // empty-leaf PTY funnel. Deliberately NOT persisted — buildSessionData's
  // allowlist never includes it, so a saved session can't replay stale seeds.
  splitCwdSeed: Record<string, string>;
  clearSplitCwdSeed: (paneId: string) => void;
}

// The agent statuses that mean "this terminal wants the user's attention"
// (the work finished or is paused waiting for input). Anything else clears.
const ATTENTION_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'complete',
  'waiting',
  'awaiting_input',
]);

function findPane(root: Pane, id: string): Pane | null {
  if (root.id === id) return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findPane(child, id);
      if (found) return found;
    }
  }
  return null;
}

function findParent(root: Pane, id: string): PaneBranch | null {
  if (root.type === 'branch') {
    for (const child of root.children) {
      if (child.id === id) return root;
      const found = findParent(child, id);
      if (found) return found;
    }
  }
  return null;
}

function collectLeafIds(pane: Pane): string[] {
  if (pane.type === 'leaf') return [pane.id];
  return pane.children.flatMap(collectLeafIds);
}

function getLeafPanes(root: Pane): PaneLeaf[] {
  if (root.type === 'leaf') return [root];
  return root.children.flatMap(getLeafPanes);
}

export const createPaneSlice: StateCreator<StoreState, [['zustand/immer', never]], [], PaneSlice> = (set, get) => ({
  paneNotificationRing: {},

  setPaneNotificationRing: (paneId, ring) => set((state: StoreState) => {
    if (ring === null) {
      delete state.paneNotificationRing[paneId];
      return;
    }
    state.paneNotificationRing[paneId] = ring;
  }),

  surfaceAgentStatus: {},

  setSurfaceAgentStatus: (ptyId, status) => set((state: StoreState) => {
    if (!ptyId) return;
    // Store only attention-worthy statuses; everything else (running, idle,
    // error, null) clears the entry so the blink stops as soon as the agent
    // resumes, goes idle, or the PTY exits.
    if (status && ATTENTION_STATUSES.has(status)) {
      state.surfaceAgentStatus[ptyId] = status;
    } else {
      delete state.surfaceAgentStatus[ptyId];
    }
  }),

  surfacePorts: {},

  setSurfacePorts: (ptyId, ports) => set((state: StoreState) => {
    if (!ptyId) return;
    if (ports && ports.length > 0) {
      state.surfacePorts[ptyId] = ports;
    } else {
      delete state.surfacePorts[ptyId];
    }
  }),

  splitCwdSeed: {},

  clearSplitCwdSeed: (paneId) => set((state: StoreState) => {
    delete state.splitCwdSeed[paneId];
  }),

  splitPane: (paneId, direction, workspaceId, position = 'after') => {
    let event: { wsId: string; newPaneId: string; branchId: string; previousActiveId: string } | null = null;
    let blockedAtCap = false;
    let created = false;
    set((state: StoreState) => {
      const targetWsId = workspaceId || state.activeWorkspaceId;
      const ws = state.workspaces.find((w: Workspace) => w.id === targetWsId);
      if (!ws) return;

      const targetPane = findPane(ws.rootPane, paneId);
      if (!targetPane || targetPane.type !== 'leaf') return;

      // Cap leaf growth — every callsite (Ctrl+D, prefix-mode split, palette,
      // browser-pane shortcut, sample-task wizard) funnels through here, so a
      // single guard is enough.
      if (collectLeafIds(ws.rootPane).length >= MAX_PANES_PER_WORKSPACE) {
        blockedAtCap = true;
        return;
      }
      created = true;

      // Issue #173: capture the splitting pane's live cwd (OSC 7-tracked on
      // its active surface) so the new pane's PTY can start there. Browser /
      // editor surfaces have no shell cwd to inherit; surfaces that never
      // emitted OSC 7 have cwd '' — both fall through to the startup-directory
      // chain in the AppLayout funnel.
      const srcSurface = targetPane.surfaces.find((s) => s.id === targetPane.activeSurfaceId);
      const inheritedCwd =
        srcSurface && (srcSurface.surfaceType ?? 'terminal') === 'terminal' && srcSurface.cwd
          ? srcSurface.cwd
          : undefined;

      const newPane = createLeafPane();
      // `position` drives 4-way directional split from Ctrl+Shift+Arrow:
      // 'before' puts the new pane left/up of the target, 'after' (default)
      // right/down. Left/Up → before, Right/Down → after.
      const branch: PaneBranch = {
        id: generateId('pane'),
        type: 'branch',
        direction,
        children: position === 'before' ? [newPane, { ...targetPane }] : [{ ...targetPane }, newPane],
        sizes: [50, 50],
      };

      // Replace target with branch
      const parent = findParent(ws.rootPane, paneId);
      if (parent) {
        const idx = parent.children.findIndex((c) => c.id === paneId);
        if (idx !== -1) {
          parent.children[idx] = branch;
        }
      } else {
        // Target is the root
        ws.rootPane = branch;
      }

      const previousActiveId = ws.activePaneId;
      ws.activePaneId = newPane.id;

      // Issue #182: splitting while a pane in this workspace is zoomed must
      // un-zoom (tmux behavior) — otherwise the freshly created sibling would
      // be born hidden behind the zoom and look like the split did nothing.
      if (state.zoomedPaneId !== null && findPane(ws.rootPane, state.zoomedPaneId)) {
        state.zoomedPaneId = null;
      }

      if (inheritedCwd) state.splitCwdSeed[newPane.id] = inheritedCwd;

      event = {
        wsId: targetWsId,
        newPaneId: newPane.id,
        branchId: branch.id,
        previousActiveId,
      };
    });
    if (event) {
      const e = event as { wsId: string; newPaneId: string; branchId: string; previousActiveId: string };
      publishPaneCreated(e.wsId, e.newPaneId, e.branchId);
      if (e.previousActiveId !== e.newPaneId) {
        publishPaneFocused(e.wsId, e.newPaneId, e.previousActiveId);
      }
    }
    if (blockedAtCap) {
      // Toast emitted outside the immer producer so the slice doesn't recurse
      // into another set() while the producer is still running.
      get().pushToast({
        message: t('pane.maxLeavesReached', { count: MAX_PANES_PER_WORKSPACE }),
        level: 'warn',
      });
    }
    return created;
  },

  closePane: (paneId, workspaceId) => {
    let event: { wsId: string; closedPaneId: string; previousActiveId: string; newActiveId: string | null } | null = null;
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === (workspaceId || state.activeWorkspaceId));
      if (!ws) return;

      const parent = findParent(ws.rootPane, paneId);
      if (!parent) {
        // Can't close root pane, but can clear its surfaces
        return;
      }

      const idx = parent.children.findIndex((c) => c.id === paneId);
      if (idx === -1) return;

      const previousActiveId = ws.activePaneId;
      parent.children.splice(idx, 1);

      if (parent.children.length === 1) {
        // Collapse: replace parent with the remaining child
        const remaining = parent.children[0];
        const grandParent = findParent(ws.rootPane, parent.id);
        if (grandParent) {
          const parentIdx = grandParent.children.findIndex((c) => c.id === parent.id);
          if (parentIdx !== -1) {
            grandParent.children[parentIdx] = remaining;
          }
        } else {
          // Parent was root
          ws.rootPane = remaining;
        }
      }

      // Update active pane
      const leaves = getLeafPanes(ws.rootPane);
      if (leaves.length > 0 && !leaves.some((l) => l.id === ws.activePaneId)) {
        ws.activePaneId = leaves[0].id;
      }

      // CEO A7: drop ring state for the deleted pane so a re-used paneId (or stale
      // selector) can't render a phantom ring on a pane that no longer exists.
      delete state.paneNotificationRing[paneId];
      // A pane closed before its PTY spawned would leave a dangling cwd seed.
      delete state.splitCwdSeed[paneId];
      // Issue #182: closing the zoomed pane ends the zoom; a stale id would
      // make the next toggle on another pane read as an un-zoom.
      if (state.zoomedPaneId === paneId) {
        state.zoomedPaneId = null;
      }

      event = {
        wsId: ws.id,
        closedPaneId: paneId,
        previousActiveId,
        newActiveId: ws.activePaneId !== previousActiveId ? ws.activePaneId : null,
      };
    });
    if (event) {
      const e = event as { wsId: string; closedPaneId: string; previousActiveId: string; newActiveId: string | null };
      publishPaneClosed(e.wsId, e.closedPaneId);
      if (e.newActiveId) {
        publishPaneFocused(e.wsId, e.newActiveId, e.previousActiveId);
      }
    }
  },

  setActivePane: (paneId) => {
    let event: { wsId: string; paneId: string; previousActiveId: string } | null = null;
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
      if (!ws) return;
      if (!findPane(ws.rootPane, paneId)) return;
      if (ws.activePaneId === paneId) return; // No-op when already active.
      event = { wsId: ws.id, paneId, previousActiveId: ws.activePaneId };
      ws.activePaneId = paneId;
    });
    if (event) {
      const e = event as { wsId: string; paneId: string; previousActiveId: string };
      publishPaneFocused(e.wsId, e.paneId, e.previousActiveId);
    }
  },

  updatePaneSizes: (branchId, sizes) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const branch = findPane(ws.rootPane, branchId);
    if (branch && branch.type === 'branch') {
      branch.sizes = sizes;
    }
  }),

  resizeActivePane: (direction, amount) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const parent = findParent(ws.rootPane, ws.activePaneId);
    if (!parent || parent.type !== 'branch') return;

    const idx = parent.children.findIndex((c) => {
      if (c.type === 'leaf') return c.id === ws.activePaneId;
      return collectLeafIds(c).includes(ws.activePaneId);
    });
    if (idx < 0) return;

    const isHorizontal = parent.direction === 'horizontal';
    const isGrow =
      (isHorizontal && direction === 'right') ||
      (!isHorizontal && direction === 'down');
    const isShrink =
      (isHorizontal && direction === 'left') ||
      (!isHorizontal && direction === 'up');

    if (!isGrow && !isShrink) return;

    const sizes = parent.sizes
      ? [...parent.sizes]
      : parent.children.map(() => 100 / parent.children.length);

    const neighborIdx = isGrow ? idx + 1 : idx - 1;
    if (neighborIdx < 0 || neighborIdx >= sizes.length) return;

    const delta = isGrow ? amount : -amount;
    const newSize = Math.max(10, sizes[idx] + delta);
    const newNeighborSize = Math.max(10, sizes[neighborIdx] - delta);

    sizes[idx] = newSize;
    sizes[neighborIdx] = newNeighborSize;
    parent.sizes = sizes;
  }),

  equalizePaneSizes: () => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const parent = findParent(ws.rootPane, ws.activePaneId);
    if (!parent || parent.type !== 'branch') return;
    const equal = 100 / parent.children.length;
    parent.sizes = parent.children.map(() => equal);
  }),

  focusPaneDirection: (direction) => {
    let event: { wsId: string; paneId: string; previousActiveId: string } | null = null;
    set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;

    const leaves = getLeafPanes(ws.rootPane);
    if (leaves.length <= 1) return;

    // Helper: get first leaf in a subtree (leftmost/topmost)
    const firstLeaf = (pane: Pane): PaneLeaf => {
      if (pane.type === 'leaf') return pane;
      return firstLeaf(pane.children[0]);
    };

    // Helper: get last leaf in a subtree (rightmost/bottommost)
    const lastLeaf = (pane: Pane): PaneLeaf => {
      if (pane.type === 'leaf') return pane;
      return lastLeaf(pane.children[pane.children.length - 1]);
    };

    // Tree-based spatial navigation
    const navigate = (paneId: string, dir: 'up' | 'down' | 'left' | 'right'): string | null => {
      const parent = findParent(ws.rootPane, paneId);
      if (!parent) return null; // at root

      const idx = parent.children.findIndex(c => c.id === paneId);
      const isAligned =
        (parent.direction === 'horizontal' && (dir === 'left' || dir === 'right')) ||
        (parent.direction === 'vertical' && (dir === 'up' || dir === 'down'));

      if (isAligned) {
        const delta = (dir === 'right' || dir === 'down') ? 1 : -1;
        const nextIdx = idx + delta;
        if (nextIdx >= 0 && nextIdx < parent.children.length) {
          // Move to adjacent sibling — descend to nearest leaf
          const sibling = parent.children[nextIdx];
          const leaf = delta > 0 ? firstLeaf(sibling) : lastLeaf(sibling);
          return leaf.id;
        }
      }

      // Direction not aligned or no sibling in that direction — go up
      return navigate(parent.id, dir);
    };

    const targetId = navigate(ws.activePaneId, direction);
    if (targetId && targetId !== ws.activePaneId) {
      event = { wsId: ws.id, paneId: targetId, previousActiveId: ws.activePaneId };
      ws.activePaneId = targetId;
    }
    });
    if (event) {
      const e = event as { wsId: string; paneId: string; previousActiveId: string };
      publishPaneFocused(e.wsId, e.paneId, e.previousActiveId);
    }
  },

  // Tab-style cycle through every leaf pane in the active workspace, wrapping
  // around at the ends. Tree traversal order matches getLeafPanes (depth-first,
  // left-to-right / top-to-bottom) so the cycle order mirrors what the user
  // sees on screen. Bare-Tab would conflict with shell completion, so this is
  // wired to Ctrl+Tab / Ctrl+Shift+Tab in useKeyboard.
  cyclePane: (direction) => {
    let event: { wsId: string; paneId: string; previousActiveId: string } | null = null;
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
      if (!ws) return;

      const leaves = getLeafPanes(ws.rootPane);
      if (leaves.length <= 1) return;

      const currentIdx = leaves.findIndex((l) => l.id === ws.activePaneId);
      // Defensive: if active pane somehow isn't a leaf in the tree, jump to
      // the first/last leaf instead of throwing.
      const fallbackIdx = direction === 'next' ? 0 : leaves.length - 1;
      const baseIdx = currentIdx === -1 ? fallbackIdx : currentIdx;
      const delta = direction === 'next' ? 1 : -1;
      const nextIdx = (baseIdx + delta + leaves.length) % leaves.length;
      const targetId = leaves[nextIdx].id;
      if (targetId === ws.activePaneId) return;

      event = { wsId: ws.id, paneId: targetId, previousActiveId: ws.activePaneId };
      ws.activePaneId = targetId;
    });
    if (event) {
      const e = event as { wsId: string; paneId: string; previousActiveId: string };
      publishPaneFocused(e.wsId, e.paneId, e.previousActiveId);
    }
  },
});

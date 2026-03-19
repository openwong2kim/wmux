import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Pane, PaneLeaf, PaneBranch, Workspace } from '../../../shared/types';
import { createLeafPane, generateId } from '../../../shared/types';

export interface PaneSlice {
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  focusPaneDirection: (direction: 'up' | 'down' | 'left' | 'right') => void;
}

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
  splitPane: (paneId, direction) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;

    const targetPane = findPane(ws.rootPane, paneId);
    if (!targetPane || targetPane.type !== 'leaf') return;

    const newPane = createLeafPane();
    const branch: PaneBranch = {
      id: generateId('pane'),
      type: 'branch',
      direction,
      children: [{ ...targetPane }, newPane],
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

    ws.activePaneId = newPane.id;
  }),

  closePane: (paneId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;

    const parent = findParent(ws.rootPane, paneId);
    if (!parent) {
      // Can't close root pane, but can clear its surfaces
      return;
    }

    const idx = parent.children.findIndex((c) => c.id === paneId);
    if (idx === -1) return;

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
  }),

  setActivePane: (paneId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    if (findPane(ws.rootPane, paneId)) {
      ws.activePaneId = paneId;
    }
  }),

  focusPaneDirection: (_direction) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;

    const leaves = getLeafPanes(ws.rootPane);
    if (leaves.length <= 1) return;

    const currentIdx = leaves.findIndex((l) => l.id === ws.activePaneId);
    if (currentIdx === -1) return;

    // Simple round-robin navigation for now
    let nextIdx: number;
    if (_direction === 'right' || _direction === 'down') {
      nextIdx = (currentIdx + 1) % leaves.length;
    } else {
      nextIdx = (currentIdx - 1 + leaves.length) % leaves.length;
    }
    ws.activePaneId = leaves[nextIdx].id;
  }),
});

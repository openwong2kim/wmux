import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createUISlice, type UISlice } from '../uiSlice';
import {
  createWorkspace,
  createLeafPane,
  assignPaneOrdinals,
  generateId,
  type Workspace,
  type Pane,
} from '../../../../shared/types';
import { getLeafPanes } from '../../../../shared/paneUtils';

// #1011 — Active → Archived → Permanently Deleted. Archiving snapshots the
// configuration (name, color, profile, pane arrangement) and delegates the
// teardown to removeWorkspace; restoring rebuilds with FRESH ids so a restored
// workspace can never collide with a live auto-name or A2A address.

type TestState = WorkspaceSlice & UISlice & { multiviewIds: string[] };

function createTestStore(initialWorkspaces: Workspace[], activeId: string) {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — same
      ...createUISlice(...args),
      workspaces: initialWorkspaces,
      activeWorkspaceId: activeId,
      multiviewIds: [],
    })),
  );
}

/** A two-pane workspace with a color and a profile, as a real one would look. */
function makeWorkspace(name: string, ordinal: number): Workspace {
  const a = createLeafPane();
  const b = createLeafPane();
  const root: Pane = { id: generateId('pane'), type: 'branch', direction: 'horizontal', children: [a, b], sizes: [70, 30] };
  const ws = createWorkspace(name, ordinal);
  ws.rootPane = root;
  ws.nextPaneOrdinal = assignPaneOrdinals(root, 1);
  ws.activePaneId = a.id;
  ws.color = 'rose';
  ws.profile = { env: { PROJECT: name } };
  return ws;
}

describe('workspace archive (#1011)', () => {
  let store: ReturnType<typeof createTestStore>;
  let wsA: Workspace;
  let wsB: Workspace;

  beforeEach(() => {
    wsA = makeWorkspace('Alpha', 1);
    wsB = makeWorkspace('Beta', 2);
    store = createTestStore([wsA, wsB], wsA.id);
  });

  it('archive snapshots the config and removes the workspace', () => {
    store.getState().archiveWorkspace(wsA.id);
    const state = store.getState();
    expect(state.workspaces.map((w) => w.name)).toEqual(['Beta']);
    expect(state.archivedWorkspaces).toHaveLength(1);
    const snap = state.archivedWorkspaces[0];
    expect(snap.name).toBe('Alpha');
    expect(snap.color).toBe('rose');
    expect(snap.profile?.env?.PROJECT).toBe('Alpha');
    expect(snap.tree.type).toBe('branch');
    expect(state.activeWorkspaceId).toBe(wsB.id); // promotion like Close
  });

  it('never archives the last workspace', () => {
    store.getState().removeWorkspace(wsB.id);
    store.getState().archiveWorkspace(wsA.id);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().archivedWorkspaces).toHaveLength(0);
  });

  it('restore brings the config back as a LIVE workspace with fresh ids', () => {
    store.getState().archiveWorkspace(wsA.id);
    const archivedId = store.getState().archivedWorkspaces[0].id;
    store.getState().restoreArchivedWorkspace(archivedId);

    const state = store.getState();
    expect(state.archivedWorkspaces).toHaveLength(0);
    const restored = state.workspaces.find((w) => w.name === 'Alpha');
    expect(restored).toBeDefined();
    expect(restored!.id).not.toBe(wsA.id); // fresh identity
    expect(restored!.color).toBe('rose');
    expect(restored!.profile?.env?.PROJECT).toBe('Alpha');
    expect(getLeafPanes(restored!.rootPane)).toHaveLength(2);
    // Fresh pane ids: none of the original tree's leaves survive.
    const oldIds = new Set(getLeafPanes(wsA.rootPane).map((l) => l.id));
    for (const leaf of getLeafPanes(restored!.rootPane)) {
      expect(oldIds.has(leaf.id)).toBe(false);
    }
    // A fresh ordinal — the restored workspace cannot reuse a live w<N>.
    expect(restored!.wsOrdinal).not.toBe(wsB.wsOrdinal);
    expect(state.activeWorkspaceId).toBe(restored!.id);
  });

  it('delete permanently drops the snapshot', () => {
    store.getState().archiveWorkspace(wsA.id);
    const archivedId = store.getState().archivedWorkspaces[0].id;
    store.getState().deleteArchivedWorkspace(archivedId);
    expect(store.getState().archivedWorkspaces).toHaveLength(0);
    expect(store.getState().workspaces.map((w) => w.name)).toEqual(['Beta']);
  });

  it('unknown ids are safe no-ops', () => {
    store.getState().archiveWorkspace('nope');
    store.getState().restoreArchivedWorkspace('nope');
    store.getState().deleteArchivedWorkspace('nope');
    expect(store.getState().workspaces).toHaveLength(2);
    expect(store.getState().archivedWorkspaces).toHaveLength(0);
  });
});

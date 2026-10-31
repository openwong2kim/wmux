import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createUISlice, type UISlice } from '../uiSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import { multiviewGroupsForSave } from '../../../utils/multiviewGroups';

// Multiview groups: several saved grids, one on screen. The grid on screen is
// `multiviewIds`; activating a member of another group swaps that group in.

type TestState = WorkspaceSlice & UISlice;

function createTestStore(workspaces: Workspace[], activeId: string) {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — same
      ...createUISlice(...args),
      workspaces,
      activeWorkspaceId: activeId,
    })),
  );
}

describe('multiview groups', () => {
  let ws: Record<'A' | 'B' | 'C' | 'D' | 'E', Workspace>;
  let store: ReturnType<typeof createTestStore>;
  const ids = (...names: Array<keyof typeof ws>) => names.map((n) => ws[n].id);

  beforeEach(() => {
    ws = { A: createWorkspace('A'), B: createWorkspace('B'), C: createWorkspace('C'), D: createWorkspace('D'), E: createWorkspace('E') };
    store = createTestStore(Object.values(ws), ws.A.id);
    // Group 1: A + B.
    store.getState().toggleMultiviewWorkspace(ws.B.id);
  });

  /** Ctrl+click from C starts group 2: C + D. */
  function startSecondGroup() {
    store.getState().setActiveWorkspace(ws.C.id);
    store.getState().toggleMultiviewWorkspace(ws.D.id);
  }

  it('a Ctrl+click from outside every group starts a new group and saves the one on screen', () => {
    startSecondGroup();
    expect(store.getState().multiviewIds).toEqual(ids('C', 'D'));
    expect(store.getState().multiviewSavedGroups).toEqual([ids('A', 'B')]);
  });

  it('activating a member of a saved group puts that group on screen', () => {
    startSecondGroup();
    store.getState().setActiveWorkspace(ws.B.id);
    expect(store.getState().multiviewIds).toEqual(ids('A', 'B'));
    expect(store.getState().multiviewSavedGroups).toEqual([ids('C', 'D')]);
  });

  it('activating a workspace in no group keeps the groups as they are', () => {
    startSecondGroup();
    store.getState().setActiveWorkspace(ws.E.id);
    expect(store.getState().multiviewIds).toEqual(ids('C', 'D'));
    expect(store.getState().multiviewSavedGroups).toEqual([ids('A', 'B')]);
  });

  it('a workspace joining a group leaves its old one, which dissolves at one member', () => {
    startSecondGroup();
    store.getState().toggleMultiviewWorkspace(ws.B.id);
    expect(store.getState().multiviewIds).toEqual(ids('C', 'D', 'B'));
    expect(store.getState().multiviewSavedGroups).toEqual([]);
  });

  it('clearMultiview disbands only the group on screen', () => {
    startSecondGroup();
    store.getState().clearMultiview();
    expect(store.getState().multiviewIds).toEqual([]);
    expect(store.getState().multiviewSavedGroups).toEqual([ids('A', 'B')]);
  });

  it('un-parks every member of a group put on screen', () => {
    startSecondGroup();
    store.setState((s) => { s.parkedWorkspaceIds[ws.A.id] = true; s.lastVisibleAt[ws.A.id] = 1; });
    store.getState().setActiveWorkspace(ws.B.id);
    expect(store.getState().parkedWorkspaceIds[ws.A.id]).toBeUndefined();
    expect(store.getState().lastVisibleAt[ws.A.id]).toBeUndefined();
  });

  it('closing a workspace prunes it from a saved group, dissolving it at one member', () => {
    startSecondGroup();
    store.getState().removeWorkspace(ws.A.id);
    expect(store.getState().multiviewSavedGroups).toEqual([]);
    expect(store.getState().multiviewIds).toEqual(ids('C', 'D'));
  });

  it('a session round-trip restores every group with the active one on screen', () => {
    startSecondGroup();
    // Through JSON, as session.json is: the store's own objects are frozen.
    const saved = JSON.parse(JSON.stringify({
      workspaces: store.getState().workspaces,
      activeWorkspaceId: ws.A.id,
      sidebarVisible: true,
      multiviewGroups: multiviewGroupsForSave(store.getState()),
    }));
    const reopened = createTestStore([createWorkspace('X')], 'x');
    reopened.getState().loadSession(saved);
    expect(reopened.getState().multiviewIds).toEqual(ids('A', 'B'));
    expect(reopened.getState().multiviewSavedGroups).toEqual([ids('C', 'D')]);
  });
});

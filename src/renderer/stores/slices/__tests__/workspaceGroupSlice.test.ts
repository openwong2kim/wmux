// #3069 — sidebar workspace groups: create, rename, delete, collapse, move,
// and the save/load round trip. Grouping is display-only, so none of these
// may change the stored workspace order or close anything.
import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createUISlice, type UISlice } from '../uiSlice';
import { createWorkspaceGroupSlice, type WorkspaceGroupSlice } from '../workspaceGroupSlice';
import { createWorkspace, type SessionData, type Workspace } from '../../../../shared/types';

type TestState = WorkspaceSlice & UISlice & WorkspaceGroupSlice & { multiviewIds: string[] };

function createTestStore(initialWorkspaces: Workspace[], activeId: string) {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — same
      ...createUISlice(...args),
      // @ts-expect-error — same
      ...createWorkspaceGroupSlice(...args),
      workspaces: initialWorkspaces,
      activeWorkspaceId: activeId,
      multiviewIds: [],
    })),
  );
}

describe('workspace groups', () => {
  let store: ReturnType<typeof createTestStore>;
  let a: Workspace;
  let b: Workspace;
  let c: Workspace;
  const order = () => store.getState().workspaces.map((w) => w.id);
  const groupOf = (id: string) => store.getState().workspaces.find((w) => w.id === id)?.groupId;

  beforeEach(() => {
    a = createWorkspace('A', 1);
    b = createWorkspace('B', 2);
    c = createWorkspace('C', 3);
    store = createTestStore([a, b, c], a.id);
  });

  it('creates a group and files the workspace under it, without moving it', () => {
    const before = order();
    const id = store.getState().createWorkspaceGroup('  Client A ', b.id);
    expect(id).toBeTruthy();
    expect(store.getState().workspaceGroups).toEqual([{ id, name: 'Client A' }]);
    expect(groupOf(b.id)).toBe(id);
    expect(order()).toEqual(before);
  });

  it('refuses an empty name', () => {
    expect(store.getState().createWorkspaceGroup('   ', a.id)).toBeNull();
    expect(store.getState().workspaceGroups).toEqual([]);
    expect(groupOf(a.id)).toBeUndefined();
  });

  it('renames, but keeps the old name for an empty one', () => {
    const id = store.getState().createWorkspaceGroup('Old')!;
    store.getState().renameWorkspaceGroup(id, 'New');
    expect(store.getState().workspaceGroups[0].name).toBe('New');
    store.getState().renameWorkspaceGroup(id, '  ');
    expect(store.getState().workspaceGroups[0].name).toBe('New');
  });

  it('moves a workspace between groups and back to the top level', () => {
    const g1 = store.getState().createWorkspaceGroup('One')!;
    const g2 = store.getState().createWorkspaceGroup('Two')!;
    store.getState().moveWorkspaceToGroup(a.id, g1);
    expect(groupOf(a.id)).toBe(g1);
    store.getState().moveWorkspaceToGroup(a.id, g2);
    expect(groupOf(a.id)).toBe(g2);
    store.getState().moveWorkspaceToGroup(a.id, undefined);
    expect(groupOf(a.id)).toBeUndefined();
  });

  it('ignores a move to a group that does not exist, or of an unknown workspace', () => {
    store.getState().moveWorkspaceToGroup(a.id, 'grp-nope');
    expect(groupOf(a.id)).toBeUndefined();
    const g = store.getState().createWorkspaceGroup('One')!;
    store.getState().moveWorkspaceToGroup('ws-nope', g);
    expect(store.getState().workspaces.every((w) => w.groupId === undefined)).toBe(true);
  });

  it('expands a folded group when a workspace is moved into it', () => {
    const g = store.getState().createWorkspaceGroup('One')!;
    store.getState().setWorkspaceGroupCollapsed(g, true);
    expect(store.getState().workspaceGroups[0].collapsed).toBe(true);
    store.getState().moveWorkspaceToGroup(c.id, g);
    expect(store.getState().workspaceGroups[0].collapsed).toBeUndefined();
  });

  it('deleting a group returns its workspaces to the top level, all still open', () => {
    const g1 = store.getState().createWorkspaceGroup('One', a.id)!;
    const g2 = store.getState().createWorkspaceGroup('Two', b.id)!;
    store.getState().moveWorkspaceToGroup(c.id, g1);
    store.getState().setWorkspaceGroupRenaming(g1);
    const before = order();
    store.getState().deleteWorkspaceGroup(g1);
    expect(store.getState().workspaceGroups.map((g) => g.id)).toEqual([g2]);
    expect(groupOf(a.id)).toBeUndefined();
    expect(groupOf(c.id)).toBeUndefined();
    expect(groupOf(b.id)).toBe(g2);
    expect(order()).toEqual(before);
    expect(store.getState().workspaceGroupRenamingId).toBeNull();
  });

  it('a duplicate is listed under the same group as its source', () => {
    const g = store.getState().createWorkspaceGroup('One', b.id)!;
    store.getState().duplicateWorkspace(b.id);
    const copy = store.getState().workspaces.find((w) => w.id !== a.id && w.id !== b.id && w.id !== c.id);
    expect(copy?.groupId).toBe(g);
  });

  it('round-trips through a saved session, dropping memberships of unknown groups', () => {
    const g1 = store.getState().createWorkspaceGroup('Client A', a.id)!;
    store.getState().createWorkspaceGroup('Infra', b.id);
    store.getState().setWorkspaceGroupCollapsed(g1, true);
    const saved = JSON.parse(JSON.stringify({
      workspaces: store.getState().workspaces.map((w) => (w.id === c.id ? { ...w, groupId: 'grp-gone' } : w)),
      activeWorkspaceId: store.getState().activeWorkspaceId,
      sidebarVisible: true,
      // A hand-edited stray entry is dropped, the rest kept in order.
      workspaceGroups: [...store.getState().workspaceGroups, { id: 7, name: 'bad' }],
    })) as SessionData;

    const restored = createTestStore([], '');
    restored.getState().loadSession(saved);
    const st = restored.getState();
    expect(st.workspaceGroups).toEqual(store.getState().workspaceGroups);
    expect(st.workspaceGroups[0].collapsed).toBe(true);
    const restoredGroupOf = (id: string) => st.workspaces.find((w) => w.id === id)?.groupId;
    expect(restoredGroupOf(a.id)).toBe(g1);
    expect(restoredGroupOf(b.id)).toBe(st.workspaceGroups[1].id);
    expect(restoredGroupOf(c.id)).toBeUndefined();
    expect(st.workspaceGroupRenamingId).toBeNull();
  });

  it('loads a session saved before groups existed as having none', () => {
    const restored = createTestStore([], '');
    restored.getState().loadSession({ workspaces: [a, b], activeWorkspaceId: a.id, sidebarVisible: true } as SessionData);
    expect(restored.getState().workspaceGroups).toEqual([]);
    expect(restored.getState().workspaces.every((w) => w.groupId === undefined)).toBe(true);
  });
});

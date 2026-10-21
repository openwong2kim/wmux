// Workspace bookmarks: a per-workspace mark the sidebar filter narrows to.
// Toggling never moves a row (that is the pin's job), a removed workspace
// keeps no bookmark, and bookmarks survive a save/load round trip.
import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createUISlice, type UISlice } from '../uiSlice';
import { createWorkspace, type SessionData, type Workspace } from '../../../../shared/types';
import { readSourceText } from '../../../../test-utils/sourceText';

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

describe('workspace bookmarks', () => {
  let store: ReturnType<typeof createTestStore>;
  let a: Workspace;
  let b: Workspace;
  let c: Workspace;
  const order = () => store.getState().workspaces.map((w) => w.id);

  beforeEach(() => {
    a = createWorkspace('A', 1);
    b = createWorkspace('B', 2);
    c = createWorkspace('C', 3);
    store = createTestStore([a, b, c], a.id);
  });

  it('toggles on and off without moving the row', () => {
    const before = order();
    store.getState().toggleSidebarBookmark(c.id);
    store.getState().toggleSidebarBookmark(a.id);
    expect(store.getState().sidebarBookmarkedIds).toEqual([c.id, a.id]);
    expect(order()).toEqual(before);
    store.getState().toggleSidebarBookmark(c.id);
    expect(store.getState().sidebarBookmarkedIds).toEqual([a.id]);
    expect(order()).toEqual(before);
    // Bookmarking is not pinning.
    expect(store.getState().sidebarPinnedIds).toEqual([]);
  });

  it('refuses an unknown id', () => {
    store.getState().toggleSidebarBookmark('nope');
    expect(store.getState().sidebarBookmarkedIds).toEqual([]);
  });

  it('drops the bookmark of a removed workspace', () => {
    store.getState().toggleSidebarBookmark(b.id);
    store.getState().removeWorkspace(b.id);
    expect(store.getState().sidebarBookmarkedIds).toEqual([]);
  });

  it('round-trips through a saved session, keeping only live, unique ids', () => {
    store.getState().toggleSidebarBookmark(c.id);
    store.getState().toggleSidebarBookmark(a.id);
    const json = JSON.stringify({
      workspaces: store.getState().workspaces,
      activeWorkspaceId: store.getState().activeWorkspaceId,
      sidebarVisible: true,
      sidebarBookmarkedIds: [...store.getState().sidebarBookmarkedIds, 'gone', 7, c.id],
    });
    const saved = JSON.parse(json) as SessionData;
    const restored = createTestStore([], '');
    restored.getState().loadSession(saved);
    expect(restored.getState().sidebarBookmarkedIds).toEqual([c.id, a.id]);
    expect(restored.getState().workspaces.map((w) => w.id)).toEqual([a.id, b.id, c.id]);
    // A session without the field (or with a torn one) loads with none.
    const bare = createTestStore([], '');
    bare.getState().loadSession({ ...(JSON.parse(json) as SessionData), sidebarBookmarkedIds: 'x' as unknown as string[] });
    expect(bare.getState().sidebarBookmarkedIds).toEqual([]);
  });

  it('is written by the session save', () => {
    const source = readSourceText(path.resolve(__dirname, '../../../components/Layout/AppLayout.tsx'));
    const start = source.indexOf('function buildSessionData');
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, start + 8000)).toContain('sidebarBookmarkedIds: state.sidebarBookmarkedIds');
  });
});

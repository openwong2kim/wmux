import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createRemoteWorkspacesSlice, mergePaneSets, type RemoteWorkspacesSlice, type AttachedRemoteWorkspace } from '../remoteWorkspacesSlice';
import { createWorkspace, type SessionData } from '../../../../shared/types';

// Minimal store: workspaceSlice + remoteWorkspacesSlice only. Mirrors the
// workspaceSlice.coldPark.test.ts / loadSession.test.ts convention of NOT
// pulling in the full StoreState — channelsSlice's fire-and-forget daemon
// calls touch `window`, which isn't defined under the node test environment,
// and loadSession only needs the fields this test actually reads/writes.
type TestState = WorkspaceSlice & RemoteWorkspacesSlice & {
  multiviewIds: string[];
  sidebarVisible: boolean;
};

function createTestStore() {
  return create<TestState>()(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    immer((...args: any) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createRemoteWorkspacesSlice(...args),
      multiviewIds: [],
      sidebarVisible: true,
    }))
  );
}

function makeRemote(overrides: Partial<AttachedRemoteWorkspace> = {}): AttachedRemoteWorkspace {
  return {
    key: 'host-1:ws-1',
    hostId: 'host-1',
    hostLabel: 'office-mac',
    workspaceId: 'ws-1',
    name: 'Remote WS',
    panes: [],
    ...overrides,
  };
}

describe('remoteWorkspacesSlice', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('attach dedups by key and sets activeRemoteKey', () => {
    const remote = makeRemote();
    store.getState().attachRemoteWorkspace(remote);
    expect(store.getState().remoteWorkspaces).toHaveLength(1);
    expect(store.getState().activeRemoteKey).toBe(remote.key);

    // Re-attach with the same key refreshes the snapshot in place, no dupe.
    const refreshed = makeRemote({ name: 'Renamed', panes: [{ sessionId: 's1' }] });
    store.getState().attachRemoteWorkspace(refreshed);
    expect(store.getState().remoteWorkspaces).toHaveLength(1);
    expect(store.getState().remoteWorkspaces[0].name).toBe('Renamed');
    expect(store.getState().activeRemoteKey).toBe(remote.key);
  });

  it('attaching never mutates workspaces[]', () => {
    const before = store.getState().workspaces;
    store.getState().attachRemoteWorkspace(makeRemote());
    expect(store.getState().workspaces).toBe(before);
    expect(store.getState().workspaces).toHaveLength(1);
  });

  it('detach clears selection only when detaching the active one', () => {
    const a = makeRemote({ key: 'host-1:ws-a', workspaceId: 'ws-a' });
    const b = makeRemote({ key: 'host-1:ws-b', workspaceId: 'ws-b' });
    store.getState().attachRemoteWorkspace(a);
    store.getState().attachRemoteWorkspace(b);
    expect(store.getState().activeRemoteKey).toBe(b.key);

    // Detaching the non-active one leaves selection untouched.
    store.getState().detachRemoteWorkspace(a.key);
    expect(store.getState().remoteWorkspaces).toHaveLength(1);
    expect(store.getState().activeRemoteKey).toBe(b.key);

    // Detaching the active one clears selection.
    store.getState().detachRemoteWorkspace(b.key);
    expect(store.getState().remoteWorkspaces).toHaveLength(0);
    expect(store.getState().activeRemoteKey).toBeNull();
  });

  it('setActiveRemoteKey(null) clears selection without touching entries', () => {
    const remote = makeRemote();
    store.getState().attachRemoteWorkspace(remote);
    store.getState().setActiveRemoteKey(null);
    expect(store.getState().activeRemoteKey).toBeNull();
    expect(store.getState().remoteWorkspaces).toHaveLength(1);
  });

  describe('every activeWorkspaceId assignment path clears activeRemoteKey', () => {
    beforeEach(() => {
      store.getState().attachRemoteWorkspace(makeRemote());
      expect(store.getState().activeRemoteKey).not.toBeNull();
    });

    it('addWorkspace', () => {
      store.getState().addWorkspace('Local A');
      expect(store.getState().activeRemoteKey).toBeNull();
    });

    it('addWorkspaceWithPreset', () => {
      store.getState().addWorkspaceWithPreset('single', 'Local B');
      expect(store.getState().activeRemoteKey).toBeNull();
    });

    it('duplicateWorkspace', () => {
      const id = store.getState().workspaces[0].id;
      store.getState().duplicateWorkspace(id);
      expect(store.getState().activeRemoteKey).toBeNull();
    });

    it('removeWorkspace fallback (removing the active local workspace)', () => {
      store.getState().addWorkspace('Local C');
      const ids = store.getState().workspaces.map((w) => w.id);
      const toRemove = ids[0];
      // Reselect it, then re-attach a remote so removal exercises its OWN
      // clear (not the earlier setActiveWorkspace/addWorkspace clears).
      store.getState().setActiveWorkspace(toRemove);
      store.getState().attachRemoteWorkspace(makeRemote({ key: 'host-1:ws-2', workspaceId: 'ws-2' }));
      expect(store.getState().activeRemoteKey).not.toBeNull();

      store.getState().removeWorkspace(toRemove);
      expect(store.getState().activeRemoteKey).toBeNull();
    });

    it('setActiveWorkspace', () => {
      const id = store.getState().workspaces[0].id;
      store.getState().setActiveWorkspace(id);
      expect(store.getState().activeRemoteKey).toBeNull();
    });

    it('loadSession', () => {
      const ws = createWorkspace('Restored', 1);
      const data = {
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        sidebarVisible: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as SessionData;
      store.getState().loadSession(data);
      expect(store.getState().activeRemoteKey).toBeNull();
    });
  });
});

describe('mergePaneSets', () => {
  const p = (sessionId: string, shell?: string) => ({ sessionId, shell });

  it('drops panes that are gone from the remote', () => {
    expect(mergePaneSets([p('a'), p('b'), p('c')], [p('a'), p('c')]))
      .toEqual([p('a'), p('c')]);
  });

  it('appends newly opened panes at the end', () => {
    expect(mergePaneSets([p('a'), p('b')], [p('a'), p('b'), p('c')]))
      .toEqual([p('a'), p('b'), p('c')]);
  });

  it('keeps existing order when the remote reorders (grid must not shuffle)', () => {
    expect(mergePaneSets([p('a'), p('b'), p('c')], [p('c'), p('b'), p('a')]))
      .toEqual([p('a'), p('b'), p('c')]);
  });

  it('places a new pane after the survivors even when the remote lists it first', () => {
    expect(mergePaneSets([p('a'), p('b')], [p('new'), p('b')]))
      .toEqual([p('b'), p('new')]);
  });

  it('takes fresh field values for panes that survive', () => {
    expect(mergePaneSets([p('a', 'bash')], [p('a', 'zsh')])).toEqual([p('a', 'zsh')]);
  });
});

describe('remoteWorkspacesSlice — live pane membership', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    store.getState().attachRemoteWorkspace(makeRemote({ panes: [{ sessionId: 'a' }, { sessionId: 'b' }] }));
  });

  it('setRemoteWorkspacePanes applies a removal and an addition in one update', () => {
    store.getState().setRemoteWorkspacePanes('host-1:ws-1', [{ sessionId: 'b' }, { sessionId: 'c' }]);
    expect(store.getState().remoteWorkspaces[0].panes.map((p) => p.sessionId)).toEqual(['b', 'c']);
  });

  it('setRemoteWorkspacePanes does not churn the array when nothing changed', () => {
    const before = store.getState().remoteWorkspaces[0].panes;
    store.getState().setRemoteWorkspacePanes('host-1:ws-1', [{ sessionId: 'a' }, { sessionId: 'b' }]);
    expect(store.getState().remoteWorkspaces[0].panes).toBe(before);
  });

  it('setRemoteWorkspacePanes ignores an unknown key', () => {
    store.getState().setRemoteWorkspacePanes('host-1:gone', [{ sessionId: 'z' }]);
    expect(store.getState().remoteWorkspaces).toHaveLength(1);
    expect(store.getState().remoteWorkspaces[0].panes).toHaveLength(2);
  });

  it('a successful pane update clears the stale flag', () => {
    store.getState().setRemoteWorkspaceStale('host-1:ws-1', true);
    expect(store.getState().remoteWorkspaces[0].stale).toBe(true);
    store.getState().setRemoteWorkspacePanes('host-1:ws-1', [{ sessionId: 'a' }, { sessionId: 'b' }]);
    expect(store.getState().remoteWorkspaces[0].stale).toBe(false);
  });

  it('setRemoteWorkspaceStale never drops the entry', () => {
    store.getState().setRemoteWorkspaceStale('host-1:ws-1', true);
    expect(store.getState().remoteWorkspaces).toHaveLength(1);
    expect(store.getState().activeRemoteKey).toBe('host-1:ws-1');
  });
});

describe('remoteWorkspacesSlice — restore', () => {
  it('restore adds the entry WITHOUT stealing the selection', () => {
    const store = createTestStore();
    store.getState().restoreRemoteWorkspace(makeRemote({ stale: true }));
    expect(store.getState().remoteWorkspaces).toHaveLength(1);
    expect(store.getState().remoteWorkspaces[0].stale).toBe(true);
    expect(store.getState().activeRemoteKey).toBeNull();
  });

  it('restore dedups by key, like attach', () => {
    const store = createTestStore();
    store.getState().restoreRemoteWorkspace(makeRemote());
    store.getState().restoreRemoteWorkspace(makeRemote({ name: 'Renamed' }));
    expect(store.getState().remoteWorkspaces).toHaveLength(1);
    expect(store.getState().remoteWorkspaces[0].name).toBe('Renamed');
  });
});

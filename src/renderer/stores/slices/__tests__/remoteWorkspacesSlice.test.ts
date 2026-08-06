import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createRemoteWorkspacesSlice, type RemoteWorkspacesSlice, type AttachedRemoteWorkspace } from '../remoteWorkspacesSlice';
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

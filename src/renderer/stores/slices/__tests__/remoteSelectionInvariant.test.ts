import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createUISlice, type UISlice } from '../uiSlice';
import { createOrphanSessionsSlice, type OrphanSessionsSlice } from '../orphanSessionsSlice';
import {
  createRemoteWorkspacesSlice,
  isRemoteMirrorVisible,
  type RemoteWorkspacesSlice,
  type AttachedRemoteWorkspace,
} from '../remoteWorkspacesSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';

// #1086 Bug 1 — "returning to a local workspace after visiting a remote one
// takes two clicks". `activeWorkspaceId` (workspaceSlice) and `activeRemoteKey`
// (remoteWorkspacesSlice) are independent fields and WorkspaceCenter checks the
// remote one FIRST, so ANY action that makes the local viewport the thing the
// user wants to see must drop the remote selection in the same mutation.
// These tests pin the paths where that was left to a hand-written convention.

vi.mock('../../../i18n', () => ({
  setLocale: vi.fn(),
  t: (k: string) => k,
}));
vi.mock('../../../themes', () => ({
  applyCustomCssVars: vi.fn(),
  clearCustomCssVars: vi.fn(),
  DEFAULT_CUSTOM_THEME: {},
}));
vi.mock('../../../utils/sessionSaveBridge', () => ({ saveSessionNow: vi.fn() }));
vi.mock('../../../events/publisher', () => ({
  publishPaneCreated: vi.fn(),
  publishPaneFocused: vi.fn(),
  publishPaneStashed: vi.fn(),
}));

Object.defineProperty(globalThis, 'document', {
  value: { documentElement: { setAttribute: vi.fn() } },
  writable: true,
});
Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: {
      pty: { list: vi.fn(async () => []), dispose: vi.fn(async () => undefined) },
      settings: {
        setToastEnabled: vi.fn(),
        setAutoUpdateEnabled: vi.fn(),
        setMutedNotificationCategories: vi.fn(),
      },
    },
  },
  writable: true,
});

type TestState = WorkspaceSlice & PaneSlice & UISlice & OrphanSessionsSlice & RemoteWorkspacesSlice & {
  pushToast: ReturnType<typeof vi.fn>;
  paneGate: 'pending' | 'ready';
};

function createTestStore() {
  return create<TestState>()(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    immer((...args: any) => ({
      pushToast: vi.fn(),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — same
      ...createPaneSlice(...args),
      // @ts-expect-error — same
      ...createUISlice(...args),
      // @ts-expect-error — same
      ...createOrphanSessionsSlice(...args),
      // @ts-expect-error — same
      ...createRemoteWorkspacesSlice(...args),
      // Last: startup restore settled (uiSlice seeds 'pending'), which is the
      // gate computeOrphans checks.
      paneGate: 'ready' as const,
    })),
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

describe('#1086 — a local selection always drops the remote mirror', () => {
  let store: ReturnType<typeof createTestStore>;
  let wsA: Workspace;
  let wsB: Workspace;

  beforeEach(() => {
    store = createTestStore();
    wsA = createWorkspace('CTO', 1);
    wsB = createWorkspace('Other', 2);
    store.setState((s) => {
      s.workspaces = [wsA, wsB];
      s.activeWorkspaceId = wsA.id;
      s.remoteWorkspaces = [makeRemote()];
      s.activeRemoteKey = 'host-1:ws-1';
    });
  });

  // The reporter's exact click: the local workspace they want back is STILL
  // activeWorkspaceId (only activeRemoteKey moved when they opened the mirror),
  // so re-selecting it must not be treated as a no-op anywhere on the path.
  it('re-selecting the ALREADY-ACTIVE workspace clears the remote selection', () => {
    store.getState().setActiveWorkspace(wsA.id);
    expect(store.getState().activeWorkspaceId).toBe(wsA.id);
    expect(store.getState().activeRemoteKey).toBeNull();
    expect(isRemoteMirrorVisible(store.getState())).toBe(false);
  });

  it('selecting a DIFFERENT local workspace clears it too', () => {
    store.getState().setActiveWorkspace(wsB.id);
    expect(store.getState().activeRemoteKey).toBeNull();
  });

  // Adopting an orphan session assigns activeWorkspaceId directly (it does not
  // route through setActiveWorkspace), so before the single activation helper
  // it left the mirror on screen and the adopt click read as a no-op.
  it('adopting an orphan session into the active workspace clears it', () => {
    store.getState().setDaemonSessionInventory([
      { id: 'pty-orphan-1', shell: '/bin/zsh', state: 'detached', workspaceId: wsA.id, cwd: '/repo' },
    ]);
    const paneId = store.getState().adoptOrphanSession('pty-orphan-1');
    expect(paneId).not.toBeNull();
    expect(store.getState().activeWorkspaceId).toBe(wsA.id);
    expect(store.getState().activeRemoteKey).toBeNull();
  });

  // Ctrl+click multiview never assigns activeWorkspaceId — the grid IS the
  // local viewport, so it needs the same clear or the mirror keeps covering it
  // and the Ctrl+click looks like it did nothing.
  it('Ctrl+click into the multiview grid clears it', () => {
    store.getState().toggleMultiviewWorkspace(wsB.id);
    expect(store.getState().multiviewIds).toContain(wsB.id);
    expect(store.getState().activeRemoteKey).toBeNull();
  });
});

// The render gate WorkspaceCenter reads. Kept as one predicate so local-vs-
// remote has a single reading, including the dangling-key case the raw flag
// cannot express.
describe('#1086 — isRemoteMirrorVisible (WorkspaceCenter gate)', () => {
  it('is true only while a selected key has a live entry behind it', () => {
    const attached = [makeRemote()];
    expect(isRemoteMirrorVisible({ remoteWorkspaces: attached, activeRemoteKey: 'host-1:ws-1' })).toBe(true);
    expect(isRemoteMirrorVisible({ remoteWorkspaces: attached, activeRemoteKey: null })).toBe(false);
    // Dangling key (entry gone): show the local tree, never a blank centre.
    expect(isRemoteMirrorVisible({ remoteWorkspaces: [], activeRemoteKey: 'host-1:ws-1' })).toBe(false);
  });

  it('flips to local on the first selection of an already-active workspace', () => {
    const store = createTestStore();
    const ws = createWorkspace('CTO', 1);
    store.setState((s) => {
      s.workspaces = [ws];
      s.activeWorkspaceId = ws.id;
      s.remoteWorkspaces = [makeRemote()];
      s.activeRemoteKey = 'host-1:ws-1';
    });
    expect(isRemoteMirrorVisible(store.getState())).toBe(true);
    store.getState().setActiveWorkspace(ws.id);
    expect(isRemoteMirrorVisible(store.getState())).toBe(false);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createNotificationSlice, type NotificationSlice } from '../notificationSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';

// P2-1 regression: setActiveWorkspace auto-marks a workspace's notifications
// read, but before the fix it mutated `n.read` WITHOUT decrementing the O(S)
// unreadBySurfaceId index → ghost unread badges. This composes the workspace +
// notification slices and asserts the index tracks the array.
type TestState = WorkspaceSlice & NotificationSlice & { multiviewIds: string[] };

function createTestStore(workspaces: Workspace[], activeId: string) {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal composed store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — same
      ...createNotificationSlice(...args),
      workspaces,
      activeWorkspaceId: activeId,
      multiviewIds: [],
    }))
  );
}

describe('setActiveWorkspace ↔ unreadBySurfaceId index', () => {
  let wsA: Workspace;
  let wsB: Workspace;

  beforeEach(() => {
    wsA = createWorkspace('A');
    wsB = createWorkspace('B');
  });

  it('clears the per-surface unread counts of the activated workspace', () => {
    const store = createTestStore([wsA, wsB], wsA.id);
    // Two unread notifications on B's surfaces while A is active.
    store.getState().addNotification({ workspaceId: wsB.id, surfaceId: 'surf-b1', category: 'agent', message: 'x' } as never);
    store.getState().addNotification({ workspaceId: wsB.id, surfaceId: 'surf-b2', category: 'agent', message: 'y' } as never);
    expect(store.getState().unreadBySurfaceId['surf-b1']).toBe(1);
    expect(store.getState().unreadBySurfaceId['surf-b2']).toBe(1);

    // Activating B auto-marks them read — the index must zero out, not drift.
    store.getState().setActiveWorkspace(wsB.id);
    expect(store.getState().unreadBySurfaceId['surf-b1']).toBeUndefined();
    expect(store.getState().unreadBySurfaceId['surf-b2']).toBeUndefined();
    expect(store.getState().notifications.every((n) => n.read)).toBe(true);
  });

  it('leaves another workspace\'s unread counts intact', () => {
    const store = createTestStore([wsA, wsB], wsA.id);
    store.getState().addNotification({ workspaceId: wsA.id, surfaceId: 'surf-a1', category: 'agent', message: 'x' } as never);
    store.getState().addNotification({ workspaceId: wsB.id, surfaceId: 'surf-b1', category: 'agent', message: 'y' } as never);
    // Activate B — only B's surface clears; A's stays unread.
    store.getState().setActiveWorkspace(wsB.id);
    expect(store.getState().unreadBySurfaceId['surf-b1']).toBeUndefined();
    expect(store.getState().unreadBySurfaceId['surf-a1']).toBe(1);
  });
});

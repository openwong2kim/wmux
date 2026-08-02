import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createSurface, type Workspace } from '../../../../shared/types';
import type { DeadPaneRecovery } from '../../../../shared/ptyRecovery';

type TestState = WorkspaceSlice & {
  pendingDeadPaneRecoveryBySurfaceId: Record<string, DeadPaneRecovery>;
};

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — intentionally minimal cross-slice test store.
      ...createWorkspaceSlice(...args),
      pendingDeadPaneRecoveryBySurfaceId: {},
    })),
  );
}

describe('WorkspaceSlice.clearSurfacePtyIdByPty (#650)', () => {
  it('stages recovery metadata on the matched surface before clearing its ptyId', () => {
    const store = createTestStore();
    const surface = createSurface('pty-dead', 'pwsh', 'C:\\old');
    store.setState((state) => {
      const workspace = state.workspaces[0] as Workspace;
      if (workspace.rootPane.type !== 'leaf') throw new Error('expected leaf fixture');
      workspace.rootPane.surfaces.push(surface);
      workspace.rootPane.activeSurfaceId = surface.id;
    });
    const recovery = { spawnCwd: 'D:\\spawn', cwd: 'D:\\live' };

    store.getState().clearSurfacePtyIdByPty('pty-dead', recovery);

    expect(store.getState().workspaces[0].rootPane).toMatchObject({
      surfaces: [{ id: surface.id, ptyId: '' }],
    });
    expect(store.getState().pendingDeadPaneRecoveryBySurfaceId[surface.id]).toEqual(recovery);
  });

  it('does not stage metadata when the pty no longer belongs to a surface', () => {
    const store = createTestStore();
    store.getState().clearSurfacePtyIdByPty('pty-gone', { spawnCwd: 'D:\\spawn' });
    expect(store.getState().pendingDeadPaneRecoveryBySurfaceId).toEqual({});
  });
});

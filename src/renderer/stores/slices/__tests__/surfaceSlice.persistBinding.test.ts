/**
 * v2 RCA fix (reboot-reattach, axis A) — centralized binding persistence.
 *
 * addSurface / updateSurfacePtyId must flush session.json via the
 * sessionSaveBridge the moment a surface↔ptyId binding changes, but ONLY when
 * paneGate === 'ready' (startup-reconcile mutations are persisted once by the
 * success-path save; a mid-reconcile snapshot on disk is the half-reconciled
 * garbage class the periodic tick's gate guards against).
 *
 * Functional store test (hand-rolled minimal cross-slice state, same pattern
 * as workspaceSlice.loadSession.test.ts) so a refactor that drops the
 * persistBindingNow call fails HERE instead of silently killing axis A — the
 * exact tsc-invisible field-drop class from the U-PERM runtime drops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createSurfaceSlice, type SurfaceSlice } from '../surfaceSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import { registerSessionSaver } from '../../../utils/sessionSaveBridge';

type TestState = SurfaceSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  paneGate: 'pending' | 'ready';
};

function createTestStore() {
  const ws = createWorkspace('W1', 1);
  return create<TestState>()(
    immer((...a) => ({
      ...(createSurfaceSlice as unknown as (...args: unknown[]) => SurfaceSlice)(...a),
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      paneGate: 'pending' as const,
    })),
  );
}

describe('surfaceSlice — centralized immediate binding persistence', () => {
  const saver = vi.fn();
  beforeEach(() => {
    saver.mockClear();
    registerSessionSaver(saver);
  });
  afterEach(() => registerSessionSaver(null));

  it('addSurface persists immediately when paneGate is ready', () => {
    const store = createTestStore();
    store.setState((s) => { s.paneGate = 'ready'; });
    const paneId = store.getState().workspaces[0].rootPane.id;
    store.getState().addSurface(paneId, 'pty-new', 'pwsh', 'D:/x');
    expect(saver).toHaveBeenCalledTimes(1);
  });

  it('addSurface does NOT persist while paneGate is pending (startup reconcile)', () => {
    const store = createTestStore();
    const paneId = store.getState().workspaces[0].rootPane.id;
    store.getState().addSurface(paneId, 'pty-new', 'pwsh', 'D:/x');
    expect(saver).not.toHaveBeenCalled();
  });

  it('updateSurfacePtyId persists immediately when ready (self-create + rebind path)', () => {
    const store = createTestStore();
    const paneId = store.getState().workspaces[0].rootPane.id;
    store.getState().addSurface(paneId, 'pty-old', 'pwsh', 'D:/x');
    const pane = store.getState().workspaces[0].rootPane;
    const surfaceId = pane.type === 'leaf' ? pane.surfaces[0].id : '';
    store.setState((s) => { s.paneGate = 'ready'; });
    saver.mockClear();

    store.getState().updateSurfacePtyId(paneId, surfaceId, 'pty-fresh');
    expect(saver).toHaveBeenCalledTimes(1);
    // The store mutation must land BEFORE the save fires (saver reads getState()).
    const after = store.getState().workspaces[0].rootPane;
    expect(after.type === 'leaf' && after.surfaces[0].ptyId).toBe('pty-fresh');
  });

  it('updateSurfacePtyId stays silent while pending', () => {
    const store = createTestStore();
    const paneId = store.getState().workspaces[0].rootPane.id;
    store.getState().addSurface(paneId, 'pty-old', 'pwsh', 'D:/x');
    const pane = store.getState().workspaces[0].rootPane;
    const surfaceId = pane.type === 'leaf' ? pane.surfaces[0].id : '';
    saver.mockClear();

    store.getState().updateSurfacePtyId(paneId, surfaceId, '');
    expect(saver).not.toHaveBeenCalled();
  });
});

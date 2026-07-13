import { describe, it, expect, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import { getLeafPanes } from '../../../../shared/paneUtils';

type TestState = PaneSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pushToast: ReturnType<typeof vi.fn>;
  zoomedPaneId: string | null;
};

function createTestStore(ws: Workspace) {
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      pushToast: vi.fn(),
      zoomedPaneId: null,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
    })),
  );
}

describe('paneLabel mirror (P2)', () => {
  it('stores a trimmed label and clears on empty / whitespace / undefined', () => {
    const store = createTestStore(createWorkspace('W', 1));

    store.getState().setPaneLabel('p1', '  Backend  ');
    expect(store.getState().paneLabel.p1).toBe('Backend');

    store.getState().setPaneLabel('p1', '   '); // whitespace-only → clear
    expect(store.getState().paneLabel.p1).toBeUndefined();

    store.getState().setPaneLabel('p2', 'API');
    store.getState().setPaneLabel('p2', undefined); // relay clear (tombstone)
    expect(store.getState().paneLabel.p2).toBeUndefined();
  });

  it('drops a closed pane label from the mirror', () => {
    const ws = createWorkspace('W', 1);
    const store = createTestStore(ws);
    store.getState().splitPane(ws.rootPane.id, 'horizontal');
    const target = getLeafPanes(store.getState().workspaces[0].rootPane)[1];

    store.getState().setPaneLabel(target.id, 'Doomed');
    expect(store.getState().paneLabel[target.id]).toBe('Doomed');

    store.getState().closePane(target.id);
    expect(store.getState().paneLabel[target.id]).toBeUndefined();
  });
});

describe('paneRole mirror (orchestrator role)', () => {
  it('stores a trimmed role and clears on empty / whitespace / undefined', () => {
    const store = createTestStore(createWorkspace('W', 1));

    store.getState().setPaneRole('p1', '  Reviewer  ');
    expect(store.getState().paneRole.p1).toBe('Reviewer');

    store.getState().setPaneRole('p1', ''); // unassigned sentinel → clear
    expect(store.getState().paneRole.p1).toBeUndefined();

    store.getState().setPaneRole('p2', 'Builder');
    store.getState().setPaneRole('p2', undefined); // relay tombstone
    expect(store.getState().paneRole.p2).toBeUndefined();
  });

  it('drops a closed pane role from the mirror', () => {
    const ws = createWorkspace('W', 1);
    const store = createTestStore(ws);
    store.getState().splitPane(ws.rootPane.id, 'horizontal');
    const target = getLeafPanes(store.getState().workspaces[0].rootPane)[1];

    store.getState().setPaneRole(target.id, 'Tester');
    expect(store.getState().paneRole[target.id]).toBe('Tester');

    store.getState().closePane(target.id);
    expect(store.getState().paneRole[target.id]).toBeUndefined();
  });
});

describe('surfaceAgent slug retention (P2)', () => {
  it('stores the slug and retains it across a status-only update', () => {
    const store = createTestStore(createWorkspace('W', 1));

    store.getState().setSurfaceAgent('pty1', 'Claude Code', 'running', 'claude');
    expect(store.getState().surfaceAgent.pty1).toMatchObject({ name: 'Claude Code', slug: 'claude' });

    // A later status-only broadcast (no name, no slug) keeps both — the slug is
    // what the `(<agent>)` auto-name suffix renders from.
    store.getState().setSurfaceAgent('pty1', undefined, 'waiting', undefined);
    expect(store.getState().surfaceAgent.pty1).toMatchObject({
      name: 'Claude Code',
      status: 'waiting',
      slug: 'claude',
    });
  });
});

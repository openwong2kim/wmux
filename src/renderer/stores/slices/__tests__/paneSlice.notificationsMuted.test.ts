import { describe, it, expect, vi, afterEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspace, createLeafPane, type Workspace, type PaneLeaf } from '../../../../shared/types';
import { registerSessionSaver } from '../../../utils/sessionSaveBridge';

type TestState = PaneSlice & { workspaces: Workspace[]; activeWorkspaceId: string };

function createTestStore() {
  const ws = createWorkspace('Test');
  const stashed = createLeafPane();
  ws.stashedPanes = [{ pane: stashed, stashedAt: 0 }];
  return {
    stashedId: stashed.id,
    store: create<TestState>()(
      immer((...args) => ({
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        // @ts-expect-error — minimal test store doesn't match full StoreState
        ...createPaneSlice(...args),
      })),
    ),
  };
}

afterEach(() => registerSessionSaver(null));

describe('setPaneNotificationsMuted', () => {
  it('mutes a visible and a stashed pane, saves once per change, and unmute removes the key', () => {
    const save = vi.fn();
    registerSessionSaver(save);
    const { store, stashedId } = createTestStore();
    const ws = () => store.getState().workspaces[0];
    const visibleId = (ws().rootPane as PaneLeaf).id;

    store.getState().setPaneNotificationsMuted(visibleId, true);
    store.getState().setPaneNotificationsMuted(stashedId, true, ws().id);
    expect((ws().rootPane as PaneLeaf).notificationsMuted).toBe(true);
    expect(ws().stashedPanes![0].pane.notificationsMuted).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);

    // Same value again: no write, no save.
    store.getState().setPaneNotificationsMuted(visibleId, true);
    expect(save).toHaveBeenCalledTimes(2);

    store.getState().setPaneNotificationsMuted(visibleId, false);
    expect('notificationsMuted' in (ws().rootPane as PaneLeaf)).toBe(false);
    expect(save).toHaveBeenCalledTimes(3);
  });
});

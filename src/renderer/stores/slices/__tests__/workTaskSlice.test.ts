import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkTaskSlice, type WorkTaskSlice } from '../workTaskSlice';
import type { WorkTask } from '../../../../shared/workTask';

// WorkTaskSlice touches only its own state, not full StoreState — validate with minimal mock store
// (same convention as companySlice.test.ts).
function createTestStore() {
  return create<WorkTaskSlice>()(
    immer((...args) => ({
      // @ts-expect-error — minimal mock store does not match full StoreState.
      ...createWorkTaskSlice(...args),
    })),
  );
}

/** Mission fixture helper (fills required fields only — renderer is read-only consumer). */
function mission(over: Partial<WorkTask> & Pick<WorkTask, 'id' | 'title'>): WorkTask {
  const ref = { principalId: 'p', verifiedWorkspaceId: over.owner?.verifiedWorkspaceId ?? 'parent-a' };
  return {
    status: 'open',
    missionChannelId: `chan-${over.id}`,
    createdAt: 0,
    createdBy: ref,
    owner: ref,
    ...over,
  } as WorkTask;
}

describe('workTaskSlice', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('setMissions caches per parent and builds paneGroupId reverse index', () => {
    store.getState().setMissions('parent-a', [
      mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' }),
      mission({ id: 'wtask-2', title: 'B', paneGroupId: 'child-2' }),
    ]);
    expect(store.getState().missionsByWorkspace['parent-a']).toHaveLength(2);
    expect(store.getState().getMissionForPaneGroup('child-1')?.id).toBe('wtask-1');
    expect(store.getState().getMissionForPaneGroup('child-2')?.title).toBe('B');
  });

  it('tasks without materialized paneGroupId (fan-out in progress) are omitted from reverse index', () => {
    store.getState().setMissions('parent-a', [
      mission({ id: 'wtask-1', title: 'A' }), // no paneGroupId
    ]);
    expect(store.getState().missionsByWorkspace['parent-a']).toHaveLength(1);
    expect(store.getState().getMissionForPaneGroup('child-1')).toBeUndefined();
  });

  it('merges missions from multiple parents into one paneGroupId index', () => {
    store.getState().setMissions('parent-a', [mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' })]);
    store.getState().setMissions('parent-b', [mission({ id: 'wtask-9', title: 'Z', paneGroupId: 'child-9', owner: { principalId: 'p', verifiedWorkspaceId: 'parent-b' } })]);
    expect(store.getState().getMissionForPaneGroup('child-1')?.id).toBe('wtask-1');
    expect(store.getState().getMissionForPaneGroup('child-9')?.id).toBe('wtask-9');
  });

  it('setMissions re-invocation replaces only that parent list (other parents preserved)', () => {
    store.getState().setMissions('parent-a', [mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' })]);
    store.getState().setMissions('parent-b', [mission({ id: 'wtask-2', title: 'B', paneGroupId: 'child-2' })]);
    // Replace parent-a with empty list → child-1 index gone, parent-b preserved.
    store.getState().setMissions('parent-a', []);
    expect(store.getState().getMissionForPaneGroup('child-1')).toBeUndefined();
    expect(store.getState().getMissionForPaneGroup('child-2')?.id).toBe('wtask-2');
  });

  it('clearMissionsFor removes parent cache and its reverse index entries', () => {
    store.getState().setMissions('parent-a', [mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' })]);
    store.getState().clearMissionsFor('parent-a');
    expect(store.getState().missionsByWorkspace['parent-a']).toBeUndefined();
    expect(store.getState().getMissionForPaneGroup('child-1')).toBeUndefined();
  });

  describe('J3 §3 registerTaskPtys (onExhausted toast mapping)', () => {
    it('registers ptyId→task mapping and preserves worktreePath', () => {
      store.getState().registerTaskPtys([
        { ptyId: 'pty-1', taskId: 'wtask-1', title: 'A', worktreePath: '/wt/a' },
        { ptyId: 'pty-2', taskId: 'wtask-2', title: 'B' }, // no worktreePath (not materialized).
      ]);
      expect(store.getState().taskPtyRegistry['pty-1']).toEqual({ taskId: 'wtask-1', title: 'A', worktreePath: '/wt/a' });
      expect(store.getState().taskPtyRegistry['pty-2']).toEqual({ taskId: 'wtask-2', title: 'B' });
    });

    it('skips entries with empty ptyId', () => {
      store.getState().registerTaskPtys([{ ptyId: '', taskId: 'x', title: 'X' }]);
      expect(Object.keys(store.getState().taskPtyRegistry)).toHaveLength(0);
    });
  });

  describe('J3 §4 setPaneGroupDeparted (departure badge)', () => {
    it('sets departed cwd and clears with null', () => {
      store.getState().setPaneGroupDeparted('child-1', '/somewhere/else');
      expect(store.getState().departedPaneGroups['child-1']).toBe('/somewhere/else');
      store.getState().setPaneGroupDeparted('child-1', null);
      expect(store.getState().departedPaneGroups['child-1']).toBeUndefined();
    });

    it('ignores empty paneGroupId', () => {
      store.getState().setPaneGroupDeparted('', '/x');
      expect(Object.keys(store.getState().departedPaneGroups)).toHaveLength(0);
    });
  });

  describe('refreshMissions (via bridge)', () => {
    afterEach(() => {
      delete (globalThis as { window?: unknown }).window;
    });

    it('unwraps rpc.invoke envelope ({result:{ok,tasks}}) into setMissions', async () => {
      const listFn = vi.fn().mockResolvedValue({
        ok: true,
        result: { ok: true, tasks: [mission({ id: 'wtask-1', title: 'A', paneGroupId: 'child-1' })] },
      });
      (globalThis as { window?: unknown }).window = { __wmuxMissionRpc: { list: listFn } };

      await store.getState().refreshMissions('parent-a');

      expect(listFn).toHaveBeenCalledWith({ verifiedWorkspaceId: 'parent-a' });
      expect(store.getState().getMissionForPaneGroup('child-1')?.id).toBe('wtask-1');
    });

    it('bridge missing/rejected/non-array response is silent no-op (cache unchanged)', async () => {
      // No bridge installed.
      (globalThis as { window?: unknown }).window = {};
      await store.getState().refreshMissions('parent-a');
      expect(store.getState().missionsByWorkspace['parent-a']).toBeUndefined();

      // ok=false envelope.
      (globalThis as { window?: unknown }).window = {
        __wmuxMissionRpc: { list: vi.fn().mockResolvedValue({ ok: false }) },
      };
      await store.getState().refreshMissions('parent-a');
      expect(store.getState().missionsByWorkspace['parent-a']).toBeUndefined();
    });

    it('does not call bridge for empty verifiedWorkspaceId', async () => {
      const listFn = vi.fn();
      (globalThis as { window?: unknown }).window = { __wmuxMissionRpc: { list: listFn } };
      await store.getState().refreshMissions('');
      expect(listFn).not.toHaveBeenCalled();
    });
  });
});

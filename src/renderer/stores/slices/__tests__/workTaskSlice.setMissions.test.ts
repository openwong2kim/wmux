// setMissions used to write a fresh array on every 15 s poll tick, so
// `missionsByWorkspace` changed identity even when the daemon had returned the
// same tasks. Everything memoizing on it — the deck's channel map, the
// sidebar's summary — recomputed and re-rendered four times a minute for
// nothing. The early return is the fix; this pins it.

import { describe, expect, it } from 'vitest';
import { useStore } from '../../index';
import { sameMissionList } from '../workTaskSlice';
import type { WorkTask } from '../../../../shared/workTask';

const mission = (over: Partial<WorkTask> & Pick<WorkTask, 'id' | 'title'>): WorkTask => {
  const ref = { principalId: 'p', verifiedWorkspaceId: 'parent' };
  return {
    status: 'open',
    missionChannelId: `chan-${over.id}`,
    createdAt: 0,
    createdBy: ref,
    owner: ref,
    ...over,
  } as WorkTask;
};

describe('sameMissionList', () => {
  it('is true for the identical reference and for a content-equal copy', () => {
    const list = [mission({ id: 'a', title: 'A' })];
    expect(sameMissionList(list, list)).toBe(true);
    expect(sameMissionList(list, [mission({ id: 'a', title: 'A' })])).toBe(true);
  });

  it('is false with no previous list, or a different length', () => {
    expect(sameMissionList(undefined, [])).toBe(false);
    expect(sameMissionList([], [mission({ id: 'a', title: 'A' })])).toBe(false);
  });

  it('sees the transitions a reader actually renders', () => {
    const before = [mission({ id: 'a', title: 'A' })];
    expect(sameMissionList(before, [mission({ id: 'a', title: 'A', status: 'closed', closedAt: 1 })])).toBe(false);
    expect(sameMissionList(before, [mission({ id: 'a', title: 'renamed' })])).toBe(false);
    expect(sameMissionList(before, [mission({ id: 'a', title: 'A', paneGroupId: 'child' })])).toBe(false);
    expect(sameMissionList(before, [mission({ id: 'a', title: 'A', missionChannelId: 'other' })])).toBe(false);
    expect(sameMissionList(before, [mission({ id: 'b', title: 'A' })])).toBe(false);
  });
});

describe('setMissions', () => {
  it('keeps the cache identity when the poll returned the same tasks', () => {
    useStore.getState().setMissions('ws-a', [mission({ id: 'a', title: 'A' })]);
    const first = useStore.getState().missionsByWorkspace;
    const firstIndex = useStore.getState().missionByPaneGroup;

    // The next poll tick: same tasks, a brand-new array off the wire.
    useStore.getState().setMissions('ws-a', [mission({ id: 'a', title: 'A' })]);
    expect(useStore.getState().missionsByWorkspace).toBe(first);
    expect(useStore.getState().missionByPaneGroup).toBe(firstIndex);
  });

  it('still lands a real transition', () => {
    useStore.getState().setMissions('ws-a', [mission({ id: 'a', title: 'A' })]);
    const first = useStore.getState().missionsByWorkspace;
    useStore.getState().setMissions('ws-a', [
      mission({ id: 'a', title: 'A', status: 'closed', closedAt: 1 }),
    ]);
    expect(useStore.getState().missionsByWorkspace).not.toBe(first);
    expect(useStore.getState().missionsByWorkspace['ws-a'][0].status).toBe('closed');
  });

  it('rebuilds the paneGroup index when a task materializes its workspace', () => {
    useStore.getState().setMissions('ws-b', [mission({ id: 'b', title: 'B' })]);
    expect(useStore.getState().missionByPaneGroup['child-b']).toBeUndefined();
    useStore.getState().setMissions('ws-b', [
      mission({ id: 'b', title: 'B', paneGroupId: 'child-b' }),
    ]);
    expect(useStore.getState().missionByPaneGroup['child-b']?.id).toBe('b');
  });
});

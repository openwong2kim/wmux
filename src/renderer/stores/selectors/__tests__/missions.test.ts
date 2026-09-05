// The projections the sidebar summary and the deck's row affordances read.

import { describe, expect, it } from 'vitest';
import { ownerForTaskLedger, selectMissionChannelIds, summarizeMissions } from '../missions';
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

const alwaysLive = (): boolean => true;

describe('summarizeMissions', () => {
  it('is all zeroes with no tasks', () => {
    expect(summarizeMissions([])).toEqual({ open: 0, finished: 0 });
  });

  it('splits open from finished', () => {
    expect(
      summarizeMissions([
        mission({ id: 'a', title: 'A' }),
        mission({ id: 'b', title: 'B' }),
        mission({ id: 'c', title: 'C', status: 'closed', closedAt: 1 }),
      ]),
    ).toEqual({ open: 2, finished: 1 });
  });
});

describe('selectMissionChannelIds', () => {
  it('maps every task id to its mission channel across parents', () => {
    expect(
      selectMissionChannelIds({
        'parent-a': [mission({ id: 'a', title: 'A' })],
        'parent-b': [mission({ id: 'b', title: 'B' })],
      }),
    ).toEqual({ a: 'chan-a', b: 'chan-b' });
  });

  it('is empty for an empty cache', () => {
    expect(selectMissionChannelIds({})).toEqual({});
  });

  it('omits a task with no channel, so the row draws no link to nowhere', () => {
    expect(
      selectMissionChannelIds({ p: [mission({ id: 'a', title: 'A', missionChannelId: '' })] }),
    ).toEqual({});
  });
});

// The summary counts every workspace's tasks; the deck panel reads ONE
// workspace's ledger. Without this hop "Tasks · 3 open" could open an empty
// panel — the dead link this function exists to close.
describe('ownerForTaskLedger', () => {
  it('stays put when the active workspace already owns a matching task', () => {
    expect(
      ownerForTaskLedger(
        {
          'ws-a': [mission({ id: 'a', title: 'A', createdAt: 1 })],
          'ws-b': [mission({ id: 'b', title: 'B', createdAt: 9 })],
        },
        'ws-a',
        'open',
        alwaysLive,
      ),
    ).toBeNull();
  });

  it('hops to the owner of the most recent matching task otherwise', () => {
    expect(
      ownerForTaskLedger(
        {
          'ws-a': [mission({ id: 'a', title: 'A', createdAt: 1 })],
          'ws-b': [mission({ id: 'b', title: 'B', createdAt: 9 })],
        },
        'ws-elsewhere',
        'open',
        alwaysLive,
      ),
    ).toBe('ws-b');
  });

  it('ignores tasks in the other lifecycle state', () => {
    const cache = {
      'ws-a': [mission({ id: 'a', title: 'A', status: 'closed', closedAt: 1, createdAt: 9 })],
      'ws-b': [mission({ id: 'b', title: 'B', createdAt: 1 })],
    };
    expect(ownerForTaskLedger(cache, 'ws-x', 'open', alwaysLive)).toBe('ws-b');
    expect(ownerForTaskLedger(cache, 'ws-x', 'closed', alwaysLive)).toBe('ws-a');
  });

  it('ignores a task whose own workspace is gone', () => {
    const isLive = (task: WorkTask): boolean => task.paneGroupId !== 'dead';
    expect(
      ownerForTaskLedger(
        { 'ws-a': [mission({ id: 'a', title: 'A', paneGroupId: 'dead' })] },
        'ws-x',
        'open',
        isLive,
      ),
    ).toBeNull();
  });

  it('is null when nothing matches anywhere', () => {
    expect(ownerForTaskLedger({}, 'ws-a', 'open', alwaysLive)).toBeNull();
  });
});

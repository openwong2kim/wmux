// The two projections the sidebar summary and the deck's `#` jump read.

import { describe, expect, it } from 'vitest';
import { selectMissionChannelIds, summarizeMissions } from '../missions';
import type { AgentStatus } from '../../../../shared/types';
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

describe('summarizeMissions', () => {
  it('counts open tasks only', () => {
    expect(
      summarizeMissions(
        [
          mission({ id: 'a', title: 'A' }),
          mission({ id: 'b', title: 'B', status: 'closed', closedAt: 1 }),
        ],
        {},
      ),
    ).toEqual({ open: 1, needYou: 0 });
  });

  it('is all zeroes with no tasks', () => {
    expect(summarizeMissions([], {})).toEqual({ open: 0, needYou: 0 });
  });

  it('counts a task whose worker is blocked on a human as "need you"', () => {
    const tasks = [
      mission({ id: 'a', title: 'A', paneGroupId: 'ws-a' }),
      mission({ id: 'b', title: 'B', paneGroupId: 'ws-b' }),
      mission({ id: 'c', title: 'C', paneGroupId: 'ws-c' }),
    ];
    const statuses: Record<string, AgentStatus> = {
      'ws-a': 'awaiting_input',
      'ws-b': 'running',
      'ws-c': 'idle',
    };
    expect(summarizeMissions(tasks, statuses)).toEqual({ open: 3, needYou: 1 });
  });

  it('does not call an unmaterialized fan-out "need you" — there is nothing to answer yet', () => {
    expect(summarizeMissions([mission({ id: 'a', title: 'A' })], {})).toEqual({
      open: 1,
      needYou: 0,
    });
  });

  it('never counts a closed task, even with a pane still awaiting input', () => {
    expect(
      summarizeMissions(
        [mission({ id: 'a', title: 'A', status: 'closed', closedAt: 1, paneGroupId: 'ws-a' })],
        { 'ws-a': 'awaiting_input' },
      ),
    ).toEqual({ open: 0, needYou: 0 });
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
      selectMissionChannelIds({
        p: [mission({ id: 'a', title: 'A', missionChannelId: '' })],
      }),
    ).toEqual({});
  });
});

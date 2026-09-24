// #1481 review B7 — closed owners are re-asked only while one of their open
// tasks lacks a record, and only a bounded number of times.
import { describe, expect, it } from 'vitest';
import { closedOwnersNeedingRecords } from '../useMissionsPolling';

describe('closedOwnersNeedingRecords', () => {
  const base = {
    workspaces: [{ id: 'live-owner' }, { id: 't1' }, { id: 't2' }, { id: 't3' }],
    missionByPaneGroup: { t3: {} } as Record<string, unknown>,
    fanoutLineage: { t1: 'closed-a', t2: 'live-owner', t3: 'closed-b' },
    fanoutSpawnOwner: {},
  };

  it('names only closed owners of open tasks without a loaded record', () => {
    expect(closedOwnersNeedingRecords(base, new Map())).toEqual(['closed-a']);
  });

  it('stops asking once the retry budget is spent', () => {
    expect(closedOwnersNeedingRecords(base, new Map([['closed-a', 3]]), 3)).toEqual([]);
  });
});

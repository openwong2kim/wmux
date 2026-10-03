import { describe, it, expect } from 'vitest';
import { partitionWorkspaceSettle, workspaceSettleGroupOf, workspaceSettleGroupedIds } from '../workspaceSettleGroups';
import { ORPHAN_GROUP_KEY } from '../sidebarTree';
import type { WorkspaceSettleMap } from '../../../../shared/workspaceSettle';

const NOW = 1_000_000;
const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((r) => r.id);

function partition(states: WorkspaceSettleMap, opts: { pinned?: string[]; owners?: Record<string, string> } = {}) {
  return partitionWorkspaceSettle(rows('a', 'b', 'c', 'task1', 'task2', 'd'), {
    groupOf: (id) => workspaceSettleGroupOf(states[id], NOW),
    pinned: new Set(opts.pinned ?? []),
    nestedOwnerOf: (id) => opts.owners?.[id],
  });
}

describe('workspaceSettleGroupOf', () => {
  it('reads settled, a live snooze, and treats an expired snooze as none', () => {
    expect(workspaceSettleGroupOf(undefined, NOW)).toBeNull();
    expect(workspaceSettleGroupOf({ settled: { at: 1, reason: 'idle' } }, NOW)).toBe('settled');
    expect(workspaceSettleGroupOf({ snoozedUntil: NOW + 1 }, NOW)).toBe('snoozed');
    expect(workspaceSettleGroupOf({ snoozedUntil: NOW }, NOW)).toBeNull();
    expect(workspaceSettleGroupOf({ snoozedUntil: NOW - 60_000 }, NOW)).toBeNull();
  });
});

describe('partitionWorkspaceSettle', () => {
  it('moves a settled or snoozed owner together with its nested tasks, keeping order', () => {
    const out = partition(
      { b: { settled: { at: 1, reason: 'pr' } }, d: { snoozedUntil: NOW + 5 } },
      { owners: { task1: 'b', task2: 'a' } },
    );
    expect(ids(out.main)).toEqual(['a', 'c', 'task2']);
    expect(ids(out.settled)).toEqual(['b', 'task1']);
    expect(ids(out.snoozed)).toEqual(['d']);
  });

  it('keeps a nested task with its owner even when the task itself is settled', () => {
    const out = partition({ task1: { settled: { at: 1, reason: 'manual' } } }, { owners: { task1: 'a' } });
    expect(ids(out.main)).toContain('task1');
    expect(out.settled).toEqual([]);
  });

  it('never groups a pinned row, nor the tasks nested under it', () => {
    const out = partition(
      { a: { settled: { at: 1, reason: 'idle' } }, c: { snoozedUntil: NOW + 5 } },
      { pinned: ['a', 'c'], owners: { task1: 'a' } },
    );
    expect(ids(out.main)).toEqual(['a', 'b', 'c', 'task1', 'task2', 'd']);
    expect(out.settled).toEqual([]);
    expect(out.snoozed).toEqual([]);
  });

  it('counts an expired snooze as not snoozed', () => {
    const out = partition({ c: { snoozedUntil: NOW - 1 } });
    expect(ids(out.main)).toContain('c');
    expect(out.snoozed).toEqual([]);
  });

  it('leaves a task of a closed owner in the main list', () => {
    const out = partition({ task1: { settled: { at: 1, reason: 'idle' } } }, { owners: { task1: ORPHAN_GROUP_KEY } });
    expect(ids(out.main)).toContain('task1');
  });
});

describe('workspaceSettleGroupedIds', () => {
  it('lists grouped, unpinned ids for the rail', () => {
    const grouped = workspaceSettleGroupedIds({
      a: { settled: { at: 1, reason: 'idle' } },
      b: { snoozedUntil: NOW + 1 },
      c: { snoozedUntil: NOW - 1 },
      d: { settled: { at: 1, reason: 'manual' } },
    }, ['d'], NOW);
    expect([...grouped].sort()).toEqual(['a', 'b']);
  });
});

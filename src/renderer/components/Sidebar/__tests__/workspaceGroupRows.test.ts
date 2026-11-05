import { describe, it, expect } from 'vitest';
import { partitionWorkspaceGroups, workspaceDropMovesRow, workspaceListPart } from '../workspaceGroupRows';
import { ORPHAN_GROUP_KEY } from '../sidebarTree';
import type { WorkspaceGroup } from '../../../../shared/workspaceGroups';

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((r) => r.id);
const GROUPS: WorkspaceGroup[] = [{ id: 'g1', name: 'Client A' }, { id: 'g2', name: 'Infra' }, { id: 'g3', name: 'Empty' }];

function partition(groupOf: Record<string, string>, opts: { pinned?: string[]; owners?: Record<string, string> } = {}) {
  return partitionWorkspaceGroups(rows('a', 'b', 'c', 'task1', 'd', 'e'), {
    groups: GROUPS,
    groupOf: (id) => groupOf[id],
    pinned: new Set(opts.pinned ?? []),
    nestedOwnerOf: (id) => opts.owners?.[id],
  });
}

describe('partitionWorkspaceGroups', () => {
  it('files rows under their group in input order, the rest below', () => {
    const out = partition({ b: 'g2', d: 'g1', a: 'g1' });
    expect(out.groups.map((g) => [g.group.id, ids(g.rows)])).toEqual([
      ['g1', ['a', 'd']],
      ['g2', ['b']],
      ['g3', []],
    ]);
    expect(ids(out.rest)).toEqual(['c', 'task1', 'e']);
    expect(out.pinned).toEqual([]);
  });

  it('keeps a nested task with its owner', () => {
    const out = partition({ c: 'g2', task1: 'g1' }, { owners: { task1: 'c' } });
    expect(ids(out.groups[1].rows)).toEqual(['c', 'task1']);
    expect(ids(out.groups[0].rows)).toEqual([]);
  });

  it('leaves a task whose owner is gone at the top level', () => {
    const out = partition({ task1: 'g1' }, { owners: { task1: ORPHAN_GROUP_KEY } });
    expect(ids(out.rest)).toContain('task1');
  });

  it('lets a pin win over a group, taking its tasks along', () => {
    const out = partition({ a: 'g1', d: 'g1' }, { pinned: ['a'], owners: { task1: 'a' } });
    expect(ids(out.pinned)).toEqual(['a', 'task1']);
    expect(ids(out.groups[0].rows)).toEqual(['d']);
  });

  it('treats a group id that names no group as no group', () => {
    const out = partition({ a: 'gone' });
    expect(ids(out.rest)).toEqual(['a', 'b', 'c', 'task1', 'd', 'e']);
  });
});

describe('workspaceListPart', () => {
  const opts = { pinned: ['p'], groupOf: (id: string) => ({ a: 'g1', b: 'g1', c: 'g2', p: 'g1', x: 'gone' } as Record<string, string>)[id], groups: GROUPS };
  it('puts rows of one group together and apart from other parts', () => {
    expect(workspaceListPart('a', opts)).toBe(workspaceListPart('b', opts));
    expect(workspaceListPart('a', opts)).not.toBe(workspaceListPart('c', opts));
    // Pinned wins over the group; an unknown group is the rest.
    expect(workspaceListPart('p', opts)).toBe('pinned');
    expect(workspaceListPart('x', opts)).toBe(workspaceListPart('z', opts));
    expect(workspaceListPart('x', opts)).toBe('rest');
  });
});

describe('workspaceDropMovesRow', () => {
  it('offers drops inside a part and the pin rules, never into or out of a group', () => {
    expect(workspaceDropMovesRow('group:g1', 'group:g1')).toBe(true);
    expect(workspaceDropMovesRow('rest', 'rest')).toBe(true);
    // Dropping on a pinned row pins; a pinned row dropped in the rest unpins.
    expect(workspaceDropMovesRow('rest', 'pinned')).toBe(true);
    expect(workspaceDropMovesRow('group:g1', 'pinned')).toBe(true);
    expect(workspaceDropMovesRow('pinned', 'rest')).toBe(true);
    expect(workspaceDropMovesRow('group:g1', 'group:g2')).toBe(false);
    expect(workspaceDropMovesRow('group:g1', 'rest')).toBe(false);
    expect(workspaceDropMovesRow('rest', 'group:g1')).toBe(false);
    expect(workspaceDropMovesRow('pinned', 'group:g1')).toBe(false);
  });
});

// #3069 — the load boundary for sidebar groups: session.json is hand-editable,
// so whatever it holds is reduced to well-formed groups, never trusted.
import { describe, it, expect } from 'vitest';
import {
  normalizeWorkspaceGroupName,
  normalizeWorkspaceGroups,
  resolveWorkspaceGroupId,
  WORKSPACE_GROUP_NAME_MAX,
  WORKSPACE_GROUPS_MAX,
} from '../workspaceGroups';

describe('normalizeWorkspaceGroupName', () => {
  it('trims, folds whitespace to one line and caps the length', () => {
    expect(normalizeWorkspaceGroupName('  Client A  ')).toBe('Client A');
    expect(normalizeWorkspaceGroupName('Client\n\tA')).toBe('Client A');
    expect(normalizeWorkspaceGroupName('x'.repeat(WORKSPACE_GROUP_NAME_MAX + 10))).toHaveLength(WORKSPACE_GROUP_NAME_MAX);
  });

  it('refuses what leaves nothing usable', () => {
    expect(normalizeWorkspaceGroupName('')).toBeNull();
    expect(normalizeWorkspaceGroupName('   ')).toBeNull();
    expect(normalizeWorkspaceGroupName(undefined)).toBeNull();
    expect(normalizeWorkspaceGroupName(42)).toBeNull();
  });
});

describe('normalizeWorkspaceGroups', () => {
  it('keeps well-formed groups in order and drops the rest', () => {
    expect(normalizeWorkspaceGroups([
      { id: 'grp-a', name: 'Client A' },
      { id: 'grp-b', name: ' Infra ', collapsed: true },
      { id: 'grp-a', name: 'Duplicate id' },
      { id: '', name: 'No id' },
      { id: 'grp-c', name: '   ' },
      { id: 7, name: 'Number id' },
      null,
      'nope',
      { id: 'grp-d', name: 'Not folded', collapsed: 'yes' },
    ])).toEqual([
      { id: 'grp-a', name: 'Client A' },
      { id: 'grp-b', name: 'Infra', collapsed: true },
      { id: 'grp-d', name: 'Not folded' },
    ]);
  });

  it('reads anything that is not an array as no groups', () => {
    expect(normalizeWorkspaceGroups(undefined)).toEqual([]);
    expect(normalizeWorkspaceGroups({ id: 'grp-a', name: 'A' })).toEqual([]);
  });

  it('caps the number of groups', () => {
    const many = Array.from({ length: WORKSPACE_GROUPS_MAX + 5 }, (_, i) => ({ id: `grp-${i}`, name: `G${i}` }));
    expect(normalizeWorkspaceGroups(many)).toHaveLength(WORKSPACE_GROUPS_MAX);
  });
});

describe('resolveWorkspaceGroupId', () => {
  it('keeps only an id naming an existing group', () => {
    const ids = new Set(['grp-a']);
    expect(resolveWorkspaceGroupId('grp-a', ids)).toBe('grp-a');
    expect(resolveWorkspaceGroupId('grp-gone', ids)).toBeUndefined();
    expect(resolveWorkspaceGroupId(undefined, ids)).toBeUndefined();
    expect(resolveWorkspaceGroupId(5, ids)).toBeUndefined();
  });
});

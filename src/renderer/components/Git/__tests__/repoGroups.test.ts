import { describe, expect, it } from 'vitest';
import { groupWorkspacesByRepo, type ResolvedWorkspace } from '../repoGroups';

const w = (workspaceId: string, repoPath: string, mainPath: string, remoteKey: string | null = null): ResolvedWorkspace =>
  ({ workspaceId, repoPath, mainPath, remoteKey });
const live = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { name: `${id}-name`, pr: null }]));

describe('groupWorkspacesByRepo', () => {
  it('puts worktrees of one checkout together and the active repo first', () => {
    const groups = groupWorkspacesByRepo([
      w('a', '/code/alpha', '/code/alpha'),
      w('b', '/code/zeta', '/code/zeta'),
      w('c', '/code/zeta-wt/feat', '/code/zeta'),
    ], live('a', 'b', 'c'), 'c', 'linux');
    expect(groups.map((g) => g.name)).toEqual(['zeta', 'alpha']);
    expect(groups[0].active).toBe(true);
    expect(groups[0].checkouts).toHaveLength(1);
    expect(groups[0].checkouts[0].workspaces.map((x) => x.workspaceId)).toEqual(['b', 'c']);
    // The active pane's worktree gets the dot without changing the pinned checkout.
    expect(groups[0].checkouts[0].currentPath).toBe('/code/zeta-wt/feat');
    expect(groups[0].checkouts[0].mainPath).toBe('/code/zeta');
    expect(groups[1].checkouts[0].currentPath).toBeUndefined();
  });

  it('folds two clones of one remote into one group: one PR list, each clone its own checkout', () => {
    const groups = groupWorkspacesByRepo([
      w('a', '/code/wmux', '/code/wmux', 'github.com/o/wmux'),
      w('b', '/tmp/pr1745', '/tmp/pr1745', 'github.com/o/wmux'),
      w('c', '/code/other', '/code/other', 'github.com/o/other'),
    ], live('a', 'b', 'c'), 'b', 'linux');
    expect(groups.map((g) => g.name)).toEqual(['wmux', 'other']);
    expect(groups[0].checkouts.map((c) => c.label)).toEqual(['wmux', 'pr1745']);
    expect(groups[0].workspaceCount).toBe(2);
    // The PR list reads from the active workspace's checkout.
    expect(groups[0].prPath).toBe('/tmp/pr1745');
  });

  it('takes names from the live store and drops workspaces closed since resolution', () => {
    const groups = groupWorkspacesByRepo(
      [w('a', '/r', '/r'), w('gone', '/r', '/r')],
      { a: { name: 'Renamed', pr: { number: 3, state: 'open', checks: null, url: 'u' } } },
      null,
      'linux',
    );
    expect(groups[0].checkouts[0].workspaces).toEqual([
      { workspaceId: 'a', name: 'Renamed', pr: { number: 3, state: 'open', checks: null, url: 'u' }, repoPath: '/r' },
    ]);
  });
});

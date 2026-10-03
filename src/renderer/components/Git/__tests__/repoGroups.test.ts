import { describe, expect, it } from 'vitest';
import { groupWorkspacesByRepo, type ResolvedWorkspace } from '../repoGroups';

const w = (workspaceId: string, repoPath: string, mainPath: string): ResolvedWorkspace => ({ workspaceId, name: workspaceId, pr: null, repoPath, mainPath });

describe('groupWorkspacesByRepo', () => {
  it('groups worktrees of one repo together and puts the active repo first', () => {
    const groups = groupWorkspacesByRepo([
      w('a', '/code/alpha', '/code/alpha'),
      w('b', '/code/zeta', '/code/zeta'),
      w('c', '/code/zeta-wt/feat', '/code/zeta'),
    ], 'c', 'linux');
    expect(groups.map((g) => g.name)).toEqual(['zeta', 'alpha']);
    expect(groups[0].workspaces.map((x) => x.workspaceId)).toEqual(['b', 'c']);
    expect(groups[0].active).toBe(true);
    // The active repo opens on the active workspace's own worktree (its row gets the dot).
    expect(groups[0].cwd).toBe('/code/zeta-wt/feat');
    expect(groups[1].cwd).toBe('/code/alpha');
  });

  it('folds path spelling where the file system ignores case, and sorts the rest by name', () => {
    const groups = groupWorkspacesByRepo([
      w('a', 'C:\\Repo', 'C:\\Repo'),
      w('b', 'c:/repo/', 'c:/repo/'),
      w('c', 'C:\\Beta', 'C:\\Beta'),
    ], null, 'win32');
    expect(groups.map((g) => g.workspaces.length)).toEqual([1, 2]);
    expect(groups.every((g) => !g.active)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { buildWorktreeRows, normWorktreePath, type WorktreeRowUI } from '../worktreeRows';

const wt = (path: string, branch: string, extra: Partial<WorktreeRowUI> = {}): WorktreeRowUI => ({
  path, branch, headOid: '0000000', locked: null, prunable: null, ...extra,
} as WorktreeRowUI);

describe('normWorktreePath', () => {
  it('folds separators and trailing slashes, and case only where the file system ignores it', () => {
    expect(normWorktreePath('C:\\Repo\\wt\\', 'win32')).toBe('c:/repo/wt');
    expect(normWorktreePath('/Users/me/Repo/', 'darwin')).toBe('/users/me/repo');
    expect(normWorktreePath('/home/me/Repo/', 'linux')).toBe('/home/me/Repo');
  });
});

describe('buildWorktreeRows', () => {
  const worktrees = [
    wt('C:\\repo', 'main'),
    wt('C:\\repo-wt\\feat', 'feat'),
    wt('C:\\repo-wt\\idle', 'idle'),
    wt('C:\\repo-wt\\.integration', 'wmux/merge', { integration: true }),
  ];

  it('joins workspaces onto their worktree by path and marks main and current', () => {
    const rows = buildWorktreeRows({
      worktrees,
      mainPath: 'C:\\repo',
      currentPath: 'c:/repo-wt/feat/',
      workspaces: [
        { workspaceId: 'a', name: 'A', pr: null, repoPath: 'C:/repo-wt/feat' },
        { workspaceId: 'b', name: 'B', pr: { number: 7, state: 'open', checks: null, url: 'u' }, repoPath: 'C:\\repo-wt\\feat' },
      ],
      stats: {},
      platform: 'win32',
    });
    // The merge session's own worktree is hidden.
    expect(rows.map((r) => r.entry.branch)).toEqual(['main', 'feat', 'idle']);
    const feat = rows[1];
    expect(feat.isCurrent).toBe(true);
    expect(feat.isMain).toBe(false);
    expect(feat.workspaces.map((w) => w.name)).toEqual(['A', 'B']);
    expect(rows[0].isMain).toBe(true);
    expect(rows[2].workspaces).toEqual([]);
    expect(rows[2].stat).toBeNull();
  });

  it('puts worktrees with uncommitted changes first, keeping git order inside each group', () => {
    const rows = buildWorktreeRows({
      worktrees,
      mainPath: 'C:\\repo',
      currentPath: '',
      workspaces: [],
      stats: {
        'c:/repo-wt/idle': { files: 2, additions: 3, deletions: 1, error: null },
        'c:/repo': { files: 0, additions: 0, deletions: 0, error: null },
      },
      platform: 'win32',
    });
    expect(rows.map((r) => r.entry.branch)).toEqual(['idle', 'main', 'feat']);
    expect(rows[0].stat?.additions).toBe(3);
    expect(rows.some((r) => r.isCurrent)).toBe(false);
  });
});

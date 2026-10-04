import { describe, expect, it } from 'vitest';
import { buildWorktreeRows, groupWorktreeRows, normWorktreePath, worktreeContaining, STALE_WORKTREE_DAYS, type GitWorktreeRow, type WorktreeRowUI } from '../worktreeRows';

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

describe('worktreeContaining', () => {
  const wts = ['/code/repo', '/code/repo/.worktrees/feat', '/code/other'];
  it('finds the innermost worktree a path sits in', () => {
    expect(worktreeContaining('/code/repo/src/a', wts, 'linux')).toBe('/code/repo');
    expect(worktreeContaining('/code/repo/.worktrees/feat/src', wts, 'linux')).toBe('/code/repo/.worktrees/feat');
    expect(worktreeContaining('/code/repo', wts, 'linux')).toBe('/code/repo');
  });
  it('does not match a sibling that merely shares a prefix, or another repo', () => {
    expect(worktreeContaining('/code/repository', wts, 'linux')).toBeNull();
    expect(worktreeContaining('/elsewhere/repo', wts, 'linux')).toBeNull();
  });
});

describe('groupWorktreeRows', () => {
  const now = Date.UTC(2026, 9, 4);
  const day = 24 * 60 * 60 * 1000;
  const row = (path: string, over: Partial<WorktreeRowUI> = {}, extra: Partial<GitWorktreeRow> = {}): GitWorktreeRow => ({
    key: path,
    entry: { path, headOid: 'abc1234', branch: path, detached: false, bare: false, locked: null, prunable: null, ...over },
    isMain: false,
    isCurrent: false,
    workspaces: [],
    stat: null,
    ...extra,
  });

  it('in use = a workspace on it; cleanup = no workspace and detached, prunable or quiet; the rest idle', () => {
    const g = groupWorktreeRows([
      row('main', { lastCommitAt: now - 90 * day }, { isMain: true }),
      row('busy', { detached: true }, { workspaces: [{ workspaceId: 'w', name: 'w', pr: null }] }),
      row('fresh', { lastCommitAt: now - 2 * day }),
      row('quiet', { lastCommitAt: now - (STALE_WORKTREE_DAYS + 1) * day }),
      row('detached', { branch: null, detached: true }),
      row('prunable', { prunable: 'gone' }),
      row('merge', { detached: true, integration: true }),
      row('unknown'),
      row('locked', { detached: true, locked: 'on a USB disk' }),
      row('fresh-worktree', { lastCommitAt: now - 90 * day, worktreeAt: now - 1 * day }),
    ], now);
    const names = (rows: GitWorktreeRow[]) => rows.map((r) => r.entry.path);
    expect(names(g.inUse)).toEqual(['busy']);
    expect(names(g.cleanup)).toEqual(['quiet', 'detached', 'prunable']);
    // The main worktree and a merge session's worktree are never candidates.
    // A locked worktree, or a new worktree on an old branch, is not a candidate either.
    expect(names(g.idle)).toEqual(['main', 'fresh', 'merge', 'unknown', 'locked', 'fresh-worktree']);
  });
});

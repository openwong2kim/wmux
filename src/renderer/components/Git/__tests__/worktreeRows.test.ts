import { describe, expect, it } from 'vitest';
import {
  buildWorktreeRows, classifyWorktree, normWorktreePath, resolveWorktreeSnoozes, sectionWorktreeRows, snoozeUntil, worktreeContaining,
  worktreeSnoozeSig, STALE_WORKTREE_DAYS,
  type GitWorktreeRow, type WorktreeRowUI, type WorktreeSignals, type WorktreeSnooze,
} from '../worktreeRows';

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

describe('classifyWorktree — who acts next on a worktree', () => {
  const now = Date.UTC(2026, 9, 4);
  const day = 24 * 60 * 60 * 1000;
  const clean = { files: 0, additions: 0, deletions: 0, error: null };
  const dirty = { files: 2, additions: 5, deletions: 1, error: null };
  const row = (path: string, over: Partial<WorktreeRowUI> = {}, extra: Partial<GitWorktreeRow> = {}): GitWorktreeRow => ({
    key: path,
    entry: { path, headOid: 'abc1234', branch: path, detached: false, bare: false, locked: null, prunable: null, ...over },
    isMain: false,
    isCurrent: false,
    workspaces: [],
    stat: clean,
    ...extra,
  });
  const ws = (id: string, state: 'open' | 'draft' | 'merged' | 'closed' | null = null) => ({
    workspaceId: id, name: id, pr: state ? { number: 1, state, checks: null, url: 'u' } : null,
  });
  const sig = (over: Partial<WorktreeSignals> = {}): WorktreeSignals => ({
    now, openPrBranches: new Set(['open-pr']), prListComplete: true, busyWorkspaces: new Set(), ...over,
  });

  it('sorts rows into the five sections, first match wins', () => {
    const g = sectionWorktreeRows([
      row('main', { lastCommitAt: now - 90 * day }, { isMain: true }),
      row('busy', { detached: true }, { workspaces: [ws('w')], stat: dirty }),
      row('left-dirty', { lastCommitAt: now - 90 * day, detached: true }, { stat: dirty }),
      row('open-pr', { lastCommitAt: now - 90 * day }),
      row('no-pr', { lastCommitAt: now - 2 * day }),
      row('quiet', { lastCommitAt: now - (STALE_WORKTREE_DAYS + 1) * day }),
      row('detached', { branch: null, detached: true }),
      row('prunable', { prunable: 'gone' }, { stat: null }),
      row('unread', { lastCommitAt: now - 90 * day, detached: true }, { stat: null }),
      row('read-failed', { lastCommitAt: now - 90 * day }, { stat: { ...clean, error: 'git status failed' } }),
      row('merged', {}, { workspaces: [ws('m', 'merged')] }),
      row('locked', { branch: null, detached: true, locked: 'on a USB disk' }),
      row('merge', { branch: null, detached: true, integration: true }),
    ], sig());
    const names = (rows: GitWorktreeRow[]) => rows.map((r) => r.entry.path);
    expect(names(g.inUse)).toEqual(['busy']);
    // Uncommitted wins over the cleanup rules: a quiet, detached worktree
    // with changes is work left behind, not a candidate.
    expect(names(g.uncommitted)).toEqual(['left-dirty']);
    expect(names(g.noPr)).toEqual(['no-pr']);
    expect(names(g.cleanup)).toEqual(['quiet', 'detached', 'prunable', 'merged']);
    // The main worktree, a locked one, a merge session's and one with an
    // open PR (even quiet) are never candidates.
    // An unknown uncommitted state (not read yet, or the read failed) is
    // never taken as clean: neither a candidate nor No open PR.
    expect(names(g.idle)).toEqual(['main', 'open-pr', 'unread', 'read-failed', 'locked', 'merge']);
  });

  it('a merged PR is a cleanup candidate only with a clean tree and no agent working or asking there', () => {
    const merged = (extra: Partial<GitWorktreeRow>) => row('feat', {}, { workspaces: [ws('w', 'merged')], ...extra });
    expect(classifyWorktree(merged({}), sig())).toBe('cleanup');
    expect(classifyWorktree(merged({ stat: dirty }), sig())).toBe('inUse');
    // Stats not read yet (or failed): not provably clean, so still in use.
    expect(classifyWorktree(merged({ stat: null }), sig())).toBe('inUse');
    expect(classifyWorktree(merged({ stat: { ...clean, error: 'boom' } }), sig())).toBe('inUse');
    expect(classifyWorktree(merged({}), sig({ busyWorkspaces: new Set(['w']) }))).toBe('inUse');
    // An open or closed PR keeps a workspace's worktree in use.
    expect(classifyWorktree(row('feat', {}, { workspaces: [ws('w', 'open')] }), sig())).toBe('inUse');
    expect(classifyWorktree(row('feat', {}, { workspaces: [ws('w', 'closed')] }), sig())).toBe('inUse');
    // The main worktree and a locked one never are.
    expect(classifyWorktree(merged({ isMain: true }), sig())).toBe('inUse');
    expect(classifyWorktree(row('feat', { locked: '' }, { workspaces: [ws('w', 'merged')] }), sig())).toBe('inUse');
  });

  it('a PR list that may be cut off at its cap proves nothing about a missing branch', () => {
    // 'feat' has an open PR past the list's cap.
    expect(classifyWorktree(row('feat'), sig({ prListComplete: false }))).toBe('idle');
    // Quiet too: never a cleanup candidate on a capped list's silence.
    expect(classifyWorktree(row('feat', { lastCommitAt: now - 90 * day }), sig({ prListComplete: false }))).toBe('idle');
    // A branch the capped list does hold is still known to have one.
    expect(classifyWorktree(row('open-pr', { lastCommitAt: now - 90 * day }), sig({ prListComplete: false }))).toBe('idle');
  });

  it('No open PR needs the PR list: unknown keeps the row in No workspace', () => {
    expect(classifyWorktree(row('feat'), sig())).toBe('noPr');
    expect(classifyWorktree(row('feat'), sig({ openPrBranches: null }))).toBe('idle');
    expect(classifyWorktree(row('feat'), sig({ openPrBranches: new Set(['feat']) }))).toBe('idle');
    // Quiet with the PR list unknown: the PR state is unknown, so not a candidate.
    expect(classifyWorktree(row('feat', { lastCommitAt: now - 90 * day }), sig({ openPrBranches: null }))).toBe('idle');
    // Detached has no branch to hold a PR: still a candidate without a list.
    expect(classifyWorktree(row('feat', { branch: null, detached: true }), sig({ openPrBranches: null }))).toBe('cleanup');
    // A fresh worktree on an old branch is not quiet.
    expect(classifyWorktree(row('feat', { lastCommitAt: now - 90 * day, worktreeAt: now - day }), sig())).toBe('noPr');
  });
});

describe('worktree snooze', () => {
  const now = Date.UTC(2026, 9, 10, 12);
  const clean = { files: 0, additions: 0, deletions: 0, error: null };
  const row = (path: string, extra: Partial<GitWorktreeRow> = {}): GitWorktreeRow => ({
    key: path,
    entry: { path, headOid: 'abc1234', branch: path, detached: false, bare: false, locked: null, prunable: null },
    isMain: false, isCurrent: false, workspaces: [], stat: clean, ...extra,
  });
  const z = (r: GitWorktreeRow, section: 'noPr' | 'uncommitted' | 'cleanup', until: number | null, repo = '/repo'): WorktreeSnooze => ({
    until, sig: worktreeSnoozeSig(r, section), repo,
  });

  it('presets end an hour, a day or a week later; until-it-changes has no time', () => {
    expect(snoozeUntil('hour', now)).toBe(now + 3600_000);
    expect(snoozeUntil('day', now)).toBe(now + 86_400_000);
    expect(snoozeUntil('week', now)).toBe(now + 7 * 86_400_000);
    expect(snoozeUntil('change', now)).toBeNull();
  });

  it('a snooze holds while its time and its row state hold', () => {
    const a = row('/wt/a');
    const res = resolveWorktreeSnoozes({
      snoozes: { '/wt/a': z(a, 'noPr', now + 1000), '/wt/b': z(row('/wt/b'), 'noPr', null) },
      repo: '/repo',
      rows: [{ row: a, section: 'noPr' }, { row: row('/wt/b'), section: 'noPr' }],
      now,
      settled: true,
      prKnown: true,
    });
    expect([...res.snoozed].sort()).toEqual(['/wt/a', '/wt/b']);
    expect(res.ended).toEqual([]);
  });

  it('ends when its time passes, in any repo', () => {
    const a = row('/wt/a');
    const res = resolveWorktreeSnoozes({
      snoozes: { '/wt/a': z(a, 'noPr', now), '/other/x': z(row('/other/x'), 'cleanup', now - 1, '/other') },
      repo: '/repo', rows: [{ row: a, section: 'noPr' }], now, settled: false,
      prKnown: true,
    });
    expect(res.snoozed.size).toBe(0);
    expect(res.ended.sort()).toEqual(['/other/x', '/wt/a']);
  });

  it('ends when the row changes: another section, a new commit or more edits', () => {
    const a = row('/wt/a');
    const snoozes = { '/wt/a': z(a, 'noPr', null) };
    const run = (r: GitWorktreeRow, section: Parameters<typeof z>[1] | 'inUse') =>
      resolveWorktreeSnoozes({ snoozes, repo: '/repo', rows: [{ row: r, section }], now, settled: true, prKnown: true }).ended;
    expect(run(a, 'cleanup')).toEqual(['/wt/a']);
    expect(run(a, 'inUse')).toEqual(['/wt/a']);
    expect(run({ ...a, entry: { ...a.entry, headOid: 'def5678' } }, 'noPr')).toEqual(['/wt/a']);
    const d = row('/wt/a', { stat: { files: 1, additions: 1, deletions: 0, error: null } });
    const dirtySnooze = { '/wt/a': z(d, 'uncommitted', null) };
    const more = row('/wt/a', { stat: { files: 3, additions: 9, deletions: 0, error: null } });
    expect(resolveWorktreeSnoozes({ snoozes: dirtySnooze, repo: '/repo', rows: [{ row: more, section: 'uncommitted' }], now, settled: true, prKnown: true }).ended)
      .toEqual(['/wt/a']);
    expect(run(a, 'noPr')).toEqual([]);
  });

  it('with the PR list unknown, No open PR reading as No workspace is no change; a commit or a workspace still is', () => {
    const a = row('/wt/a');
    const snoozes = { '/wt/a': z(a, 'noPr', null) };
    const run = (r: GitWorktreeRow, section: 'idle' | 'inUse') =>
      resolveWorktreeSnoozes({ snoozes, repo: '/repo', rows: [{ row: r, section }], now, settled: true, prKnown: false }).ended;
    expect(run(a, 'idle')).toEqual([]);
    expect(run({ ...a, entry: { ...a.entry, headOid: 'def5678' } }, 'idle')).toEqual(['/wt/a']);
    expect(run(a, 'inUse')).toEqual(['/wt/a']);
  });

  it('a failed read of the uncommitted state keeps the snooze (unknown, not clean)', () => {
    const d = row('/wt/a', { stat: { files: 2, additions: 3, deletions: 0, error: null } });
    const snoozes = { '/wt/a': z(d, 'uncommitted', null) };
    const failed = row('/wt/a', { stat: { files: 0, additions: 0, deletions: 0, error: 'git status failed' } });
    const res = resolveWorktreeSnoozes({ snoozes, repo: '/repo', rows: [{ row: failed, section: 'idle' }], now, settled: true, prKnown: true });
    expect([...res.snoozed]).toEqual(['/wt/a']);
    expect(res.ended).toEqual([]);
    // A workspace opening on it still ends the snooze.
    const used = resolveWorktreeSnoozes({ snoozes, repo: '/repo', rows: [{ row: failed, section: 'inUse' }], now, settled: true, prKnown: true });
    expect(used.ended).toEqual(['/wt/a']);
  });

  it('while the row is still loading, only time ends it; another repo\'s snoozes are left alone', () => {
    const a = row('/wt/a');
    const res = resolveWorktreeSnoozes({
      snoozes: { '/wt/a': z(a, 'noPr', null), '/wt/gone': z(row('/wt/gone'), 'noPr', null), '/other/x': z(row('/other/x'), 'noPr', null, '/other') },
      repo: '/repo',
      // Stats not in yet: the row reads as idle for now.
      rows: [{ row: { ...a, stat: null }, section: 'idle' }],
      now,
      settled: false,
      prKnown: true,
    });
    expect([...res.snoozed]).toEqual(['/wt/a']);
    expect(res.ended).toEqual([]);
    // Once settled, a worktree that is gone from its repo's list ends; the other repo's stays.
    const settled = resolveWorktreeSnoozes({
      snoozes: { '/wt/gone': z(row('/wt/gone'), 'noPr', null), '/other/x': z(row('/other/x'), 'noPr', null, '/other') },
      repo: '/repo', rows: [], now, settled: true,
      prKnown: true,
    });
    expect(settled.ended).toEqual(['/wt/gone']);
  });
});

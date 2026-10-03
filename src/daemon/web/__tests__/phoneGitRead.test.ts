import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildGitEnv, createGitRunner, type GitRunner } from '../sessionDiff';
import { PhoneGitReads, parseBranchLine, parseWorktreeList } from '../phoneGitRead';
import { SessionGitError } from '../sessionGit';

const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let root: string;
let repo: string;
let linked: string;
let other: string;
let plain: string;
let git: GitRunner;
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: buildGitEnv(), encoding: 'utf8' }).trim();
const init = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  run(dir, 'init', '-q', '-b', 'main');
  run(dir, 'config', 'user.name', 'Phone Test');
  run(dir, 'config', 'user.email', 'phone@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  run(dir, 'add', 'a.txt');
  run(dir, 'commit', '-q', '-m', 'base');
};

// Windows runners spawn git slowly enough to blow the 5 s default.
describe('phone Git reads against real repositories', { timeout: 30_000 }, () => {
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-git-read-')));
    // Global config is the temp root, so a runner's ~/.gitconfig cannot leak in.
    process.env.HOME = root; process.env.USERPROFILE = root;
    repo = path.join(root, 'repo');
    init(repo);
    // A linked worktree INSIDE the main checkout, as wmux's own `.claude/worktrees/*`.
    linked = path.join(repo, 'nested', 'wt');
    run(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    fs.writeFileSync(path.join(linked, 'b.txt'), 'b');
    run(linked, 'add', 'b.txt');
    run(linked, 'commit', '-q', '-m', 'feature work');
    run(repo, 'config', 'branch.feature.remote', '.');
    run(repo, 'config', 'branch.feature.merge', 'refs/heads/main');
    other = path.join(root, 'other');
    init(other);
    plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    git = createGitRunner();
  });
  afterAll(() => {
    process.env.HOME = savedHome.HOME; process.env.USERPROFILE = savedHome.USERPROFILE;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('groups worktrees of one repository under the desktop repoHash, newest session first', async () => {
    const reads = new PhoneGitReads(git);
    const result = await reads.projects([
      { id: 'main-pane', spawnCwd: path.join(repo), lastActivity: '2026-09-01T00:00:00.000Z' },
      { id: 'wt-pane', spawnCwd: path.join(linked), lastActivity: '2026-09-03T00:00:00.000Z' },
      { id: 'other-pane', spawnCwd: other, lastActivity: '2026-09-02T00:00:00.000Z' },
      { id: 'plain-pane', spawnCwd: plain, lastActivity: '2026-09-04T00:00:00.000Z' },
    ]);
    // The desktop's derivation (resolveRepoInfo): realpathSync of git's own
    // toplevel, which on Windows spells the temp dir differently (8.3 names).
    const hash = (dir: string) => createHash('sha256').update(fs.realpathSync(run(dir, 'rev-parse', '--show-toplevel'))).digest('hex').slice(0, 12);
    expect(result).toEqual({
      truncated: false,
      projects: [
        {
          projectId: hash(repo), name: 'repo', sessionId: 'wt-pane',
          sessions: [
            { sessionId: 'wt-pane', branch: 'feature', linkedWorktree: true },
            { sessionId: 'main-pane', branch: 'main', linkedWorktree: false },
          ],
        },
        { projectId: hash(other), name: 'other', sessionId: 'other-pane', sessions: [{ sessionId: 'other-pane', branch: 'main', linkedWorktree: false }] },
      ],
    });
  });

  it('lists local branches with upstream and the caller panes of each worktree (longest path wins)', async () => {
    const reads = new PhoneGitReads(git);
    const sessions = [
      { id: 'main-pane', spawnCwd: repo },
      { id: 'sub-pane', spawnCwd: path.join(repo, 'nested') },
      { id: 'wt-pane', spawnCwd: linked },
    ];
    const answer = await reads.branches(repo, sessions);
    expect(answer.current).toEqual({ branch: 'main', head: run(repo, 'rev-parse', 'HEAD'), detached: false });
    expect(answer.truncated).toBe(false);
    expect(answer.branches.map((b) => b.name)).toEqual(['feature', 'main']);
    expect(answer.branches[0]).toMatchObject({
      head: run(linked, 'rev-parse', 'HEAD'),
      upstream: { name: 'main', ahead: 1, behind: 0, gone: false },
      worktree: { leaf: 'wt', main: false, sessionIds: ['wt-pane'] },
    });
    expect(answer.branches[0].committedAt).toBeGreaterThan(1_600_000_000_000);
    expect(answer.branches[1].worktree).toEqual({ leaf: 'repo', main: true, sessionIds: ['main-pane', 'sub-pane'] });
  });

  it('reports a detached HEAD and refuses a directory outside any repository', async () => {
    const detached = path.join(root, 'detached');
    run(repo, 'worktree', 'add', '-q', '--detach', detached, 'main');
    const reads = new PhoneGitReads(git);
    expect((await reads.branches(detached, [])).current).toEqual({ branch: null, head: run(repo, 'rev-parse', 'main'), detached: true });
    await expect(reads.branches(plain, [])).rejects.toMatchObject({ status: 409, tag: 'not-a-git-repo' });
  });

  it('caches repository facts per spawnCwd for ten seconds', async () => {
    let calls = 0;
    let now = 1_000;
    const counted: GitRunner = (args, cwd) => { calls += 1; return git(args, cwd); };
    const reads = new PhoneGitReads(counted, undefined, undefined, () => now);
    const sessions = [{ id: 'a', spawnCwd: repo }, { id: 'b', spawnCwd: repo }];
    await reads.projects(sessions);
    const cold = calls;
    expect(cold).toBeGreaterThan(0);
    await reads.projects(sessions);
    expect(calls).toBe(cold);
    now += 10_000;
    await reads.projects(sessions);
    expect(calls).toBe(cold * 2);
  });

  it('bounds the listing by its deadline and stops when the caller is gone', async () => {
    let now = 0;
    const slow: GitRunner = async (args, cwd) => { now += 6_000; return git(args, cwd); };
    const reads = new PhoneGitReads(slow, undefined, undefined, () => now);
    const sessions = [
      { id: 'a', spawnCwd: repo, lastActivity: '2026-09-03T00:00:00.000Z' },
      { id: 'b', spawnCwd: other, lastActivity: '2026-09-02T00:00:00.000Z' },
    ];
    // Each repository costs three git calls (18 s here): the second is past the deadline.
    const bounded = await reads.projects(sessions);
    expect(bounded.truncated).toBe(true);
    expect(bounded.projects.map((p) => p.name)).toEqual(['repo']);
    const gone = await new PhoneGitReads(git).projects(sessions, { aborted: () => true });
    expect(gone).toEqual({ projects: [], truncated: true });
  });

  it('attributes a pane to a worktree only within the same repository', async () => {
    // Another repository nested inside the main checkout: its pane is under
    // repo's path but is not one of repo's worktrees.
    const inner = path.join(repo, 'vendor', 'inner');
    init(inner);
    const answer = await new PhoneGitReads(git).branches(repo, [{ id: 'main-pane', spawnCwd: repo }, { id: 'inner-pane', spawnCwd: inner }]);
    expect(answer.branches.find((b) => b.name === 'main')?.worktree?.sessionIds).toEqual(['main-pane']);
  });

  it('resolves a submodule checkout to its own worktree', async () => {
    const lib = path.join(root, 'lib');
    init(lib);
    const host = path.join(root, 'host');
    init(host);
    run(host, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    const sub = path.join(host, 'lib');
    const repoFacts = await new PhoneGitReads(git).repo(sub);
    expect(repoFacts).toMatchObject({ name: 'lib', linkedWorktree: false });
    const branches = await new PhoneGitReads(git).branches(sub, [{ id: 'sub-pane', spawnCwd: sub }]);
    expect(branches.current.branch).toBe('main');
    expect(branches.branches.find((b) => b.name === 'main')?.worktree).toEqual({ leaf: 'lib', main: true, sessionIds: ['sub-pane'] });
  });

  it('lists worktrees without -z on a git that lacks it', async () => {
    const oldGit: GitRunner = async (args, cwd) =>
      args.includes('-z') && args.includes('worktree') ? { ok: false, ran: true, code: 129, stdout: '', stderr: 'unknown switch' } : git(args, cwd);
    const answer = await new PhoneGitReads(oldGit).branches(repo, [{ id: 'wt-pane', spawnCwd: linked }]);
    expect(answer.branches.find((b) => b.name === 'feature')?.worktree).toEqual({ leaf: 'wt', main: false, sessionIds: ['wt-pane'] });
  });
});

describe('phone Git read parsers', () => {
  it('parses a gone upstream and ignores refs outside refs/heads', () => {
    const oid = 'a'.repeat(40);
    expect(parseBranchLine(['refs/heads/x', oid, '1700000000', 'origin/x', 'gone'].join('\0')))
      .toEqual({ name: 'x', head: oid, committedAt: 1_700_000_000_000, upstream: { name: 'origin/x', ahead: 0, behind: 0, gone: true } });
    expect(parseBranchLine(['refs/heads/y', oid, '1', 'origin/y', 'ahead 3, behind 2'].join('\0'))?.upstream)
      .toEqual({ name: 'origin/y', ahead: 3, behind: 2, gone: false });
    expect(parseBranchLine(['refs/tags/v1', oid, '1', '', ''].join('\0'))).toBeNull();
    expect(parseBranchLine(['refs/heads/z', 'not-an-oid', '1', '', ''].join('\0'))).toBeNull();
  });
  it('parses NUL-separated worktree records', () => {
    expect(parseWorktreeList('worktree /r\0HEAD abc\0branch refs/heads/main\0\0worktree /w\0HEAD def\0detached\0\0'))
      .toEqual([{ path: '/r', branch: 'main' }, { path: '/w', branch: null }]);
  });
  it('keeps the lock reason and the prunable mark of a worktree record', () => {
    expect(parseWorktreeList('worktree /a branch refs/heads/x locked initializing  worktree /b locked  worktree /c prunable gitdir file points to non-existent location  '))
      .toEqual([
        { path: '/a', branch: 'x', locked: true, lockReason: 'initializing' },
        { path: '/b', branch: null, locked: true, lockReason: '' },
        { path: '/c', branch: null, prunable: true },
      ]);
  });
});

describe('phone CI checks', () => {
  const head = 'b'.repeat(40);
  const stubGit = (origin: string | null, calls: string[][] = []): GitRunner => async (args) => {
    calls.push([...args]);
    if (args.includes('--git-common-dir')) return { ok: true, stdout: '/repo\n/repo/.git\n/repo/.git\n', stderr: '' };
    if (args.includes('--show-toplevel')) return { ok: true, stdout: '/repo\n', stderr: '' };
    if (args.includes('remote')) {
      return origin === null ? { ok: false, ran: true, code: 2, stdout: '', stderr: 'error: No such remote' } : { ok: true, stdout: `${origin}\n`, stderr: '' };
    }
    if (args.includes('symbolic-ref')) return { ok: true, stdout: 'feature/x\n', stderr: '' };
    return { ok: true, stdout: `${head}\n`, stderr: '' };
  };
  const pr = (number: number, state: string, owner = 'team/project') => ({
    number, title: `PR ${number}`, state, url: `https://github.com/team/project/pull/${number}`, isDraft: false,
    headRefName: 'feature/x', headRepository: { nameWithOwner: owner },
  });
  const rollup = [
    { __typename: 'CheckRun', name: 'validate', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI', detailsUrl: 'https://github.com/team/project/actions/runs/1' },
    { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'CodeRabbit', state: 'FAILURE', targetUrl: 'https://evil.invalid/x' },
  ];

  it('answers unsupported when origin is not a credential-free github.com repository', async () => {
    for (const origin of ['https://token@github.com/team/project.git', 'https://gitlab.com/team/project.git', 'https://github.com.evil.invalid/team/project']) {
      let listed = false;
      const reads = new PhoneGitReads(stubGit(origin), async () => { listed = true; return []; }, async () => { throw new Error('unused'); });
      expect(await reads.checks('/repo')).toMatchObject({ state: 'unsupported', overall: 'none', checks: [] });
      expect(listed).toBe(false);
    }
  });

  it('answers no-pr for no PR or only another fork head, and unavailable on CLI failure', async () => {
    const view = async () => { throw new Error('unused'); };
    expect((await new PhoneGitReads(stubGit('git@github.com:team/project.git'), async () => [], view).checks('/r')).state).toBe('no-pr');
    expect((await new PhoneGitReads(stubGit('git@github.com:team/project.git'), async () => [pr(3, 'OPEN', 'fork/project')], view).checks('/r')).state).toBe('no-pr');
    expect((await new PhoneGitReads(stubGit('git@github.com:team/project.git'), async () => { throw new Error('auth'); }, view).checks('/r')).state).toBe('unavailable');
  });

  it('picks the open PR, validates the view answer and summarizes the rollup', async () => {
    const calls: string[][] = [];
    const reads = new PhoneGitReads(stubGit('https://github.com/team/project.git'), async () => [pr(9, 'CLOSED'), pr(7, 'OPEN')],
      async (args) => { calls.push([...args]); return { number: 7, url: 'https://github.com/team/project/pull/7', headRefOid: head, statusCheckRollup: rollup }; });
    const answer = await reads.checks('/r');
    expect(calls).toEqual([['pr', 'view', '7', '--repo', 'github.com/team/project', '--json', 'number,url,headRefOid,statusCheckRollup']]);
    expect(answer).toMatchObject({
      state: 'available',
      pr: { number: 7, url: 'https://github.com/team/project/pull/7', headOid: head, headMatchesLocal: true },
      overall: 'failure',
      counts: { total: 3, passed: 1, failed: 1, pending: 1, skipped: 0 },
      truncated: false,
    });
    expect(answer.checks[2]).toEqual({ kind: 'status', name: 'CodeRabbit', state: 'failure' });
  });

  it('answers unavailable when the view names another repository or a malformed head', async () => {
    const list = async () => [pr(7, 'OPEN')];
    for (const view of [
      { number: 7, url: 'https://github.com/other/project/pull/7', headRefOid: head, statusCheckRollup: [] },
      { number: 7, url: 'https://github.com/team/project/pull/7', headRefOid: 'main', statusCheckRollup: [] },
      { number: 8, url: 'https://github.com/team/project/pull/7', headRefOid: head, statusCheckRollup: [] },
    ]) {
      const reads = new PhoneGitReads(stubGit('git@github.com:team/project.git'), list, async () => view);
      expect((await reads.checks('/r')).state).toBe('unavailable');
    }
  });

  it('answers unsupported without an origin, 409 outside a repository, and caches definite answers', async () => {
    expect(await new PhoneGitReads(stubGit(null), async () => { throw new Error('unused'); }).checks('/r'))
      .toMatchObject({ state: 'unsupported', checks: [] });
    const notRepo: GitRunner = async () => ({ ok: false, ran: true, code: 128, stdout: '', stderr: 'fatal: not a git repository' });
    await expect(new PhoneGitReads(notRepo).checks('/r')).rejects.toMatchObject({ status: 409, tag: 'not-a-git-repo' });
    let now = 0;
    let views = 0;
    const reads = new PhoneGitReads(stubGit('git@github.com:team/project.git'), async () => [pr(7, 'OPEN')],
      async () => { views += 1; return { number: 7, url: 'https://github.com/team/project/pull/7', headRefOid: head, statusCheckRollup: [] }; }, () => now);
    await reads.checks('/r');
    await reads.checks('/r');
    expect(views).toBe(1);
    now += 20_000;
    await reads.checks('/r');
    expect(views).toBe(2);
  });

  it('keeps a git failure distinct from a non-repository', async () => {
    const dead: GitRunner = async () => ({ ok: false, ran: false, stdout: '', stderr: 'spawn ENOENT' });
    await expect(new PhoneGitReads(dead).branches('/r', [])).rejects.toBeInstanceOf(SessionGitError);
    await expect(new PhoneGitReads(dead).branches('/r', [])).rejects.toMatchObject({ tag: 'git-operation-failed' });
    // Every repository read failed to run: an error, not an empty list.
    await expect(new PhoneGitReads(dead).projects([{ id: 'x', spawnCwd: '/r' }])).rejects.toMatchObject({ tag: 'git-operation-failed' });
    // Some did: the answer says it is partial.
    const half: GitRunner = async (args, cwd) => (cwd.includes('broken') ? dead(args, cwd) : stubGit('git@github.com:t/p.git')(args, cwd));
    expect(await new PhoneGitReads(half).projects([{ id: 'x', spawnCwd: '/repo' }, { id: 'y', spawnCwd: '/broken' }]))
      .toMatchObject({ projects: [{ sessionId: 'x' }], truncated: false, degraded: true });
  });
});

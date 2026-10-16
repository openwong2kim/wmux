// task.push: main pushes a worker's own task branch (real git, local bare
// remote), and the RPC derives everything from the caller's pane.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultGit, parseLsRemoteHead, pushTaskBranch, taskPushArgs, taskPushBranchRefusal, taskPushGitTarget, wslGitArgv, wslTaskPushGit, type TaskPushExec } from '../taskPush';
import { originUrlRepoKey, runWorkerGitRead } from '../workerGit';
import { registerTaskPushRpc } from '../../pipe/handlers/taskPush.rpc';
import { TASK_PUSHES_FILENAME, TaskPushRecord, taskPushRecordOf } from '../taskPushRecord';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { completeMergedTask, recordNoChangesGate } from '../../factory/taskGate';
import { parseRemoteKey } from '../../github/PrProvider';
import { normalizeRepoKey } from '../../../shared/repoKey';
import { readRepoDefaultBranchByKey } from '../../agents/botWorkerDefaultBranch';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

describe('pushTaskBranch', () => {
  let root: string;
  let work: string;
  let origin: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-'));
    origin = path.join(root, 'origin.git');
    work = path.join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'init');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-qb', 'wtask/one');
    fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'work');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const input = (branch = 'wtask/one') => ({ worktreePath: work, branch, defaultBranches: [], noHooksDir: path.join(root, 'no-hooks') });

  it('pushes HEAD to the task branch on origin and sets the upstream', async () => {
    const r = await pushTaskBranch(input());
    expect(r).toMatchObject({ ok: true, branch: 'wtask/one', remote: 'origin', head: git(work, 'rev-parse', 'HEAD') });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(git(work, 'config', '--get', 'branch.wtask/one.remote')).toBe('origin');
  });

  it('never force-pushes: a rewritten branch is rejected and the remote keeps its tip', async () => {
    expect((await pushTaskBranch(input())).ok).toBe(true);
    const before = git(origin, 'rev-parse', 'refs/heads/wtask/one');
    git(work, 'reset', '-q', '--hard', 'main');
    fs.writeFileSync(path.join(work, 'c.txt'), 'c\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'rewrite');
    const r = await pushTaskBranch(input());
    expect(r).toMatchObject({ ok: false, reason: 'rejected' });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(before);
  });

  it('pushes the branch alone: no tag follows it, whatever the repository config says', async () => {
    git(work, 'tag', '-a', 'v9', '-m', 'v9');
    git(work, 'config', 'push.followTags', 'true');
    expect((await pushTaskBranch(input())).ok).toBe(true);
    expect(git(origin, 'tag', '--list')).toBe('');
  });

  it('runs none of the worktree\'s own hooks', async () => {
    const hook = path.join(work, '.git', 'hooks', 'pre-push');
    const marker = path.join(root, 'hook-ran');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    expect((await pushTaskBranch(input())).ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses a default branch, a recorded one and a name that is not a plain ref', async () => {
    expect(await pushTaskBranch(input('main'))).toMatchObject({ ok: false, reason: 'branch-refused' });
    expect(taskPushBranchRefusal('develop', ['develop'])).toMatch(/default branch/);
    expect(taskPushBranchRefusal('-f', [])).toMatch(/cannot be pushed/);
    expect(taskPushBranchRefusal('wtask/x', ['develop'])).toBeNull();
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
  });

  it('main\'s reads in a worker worktree refuse a content filter and never run an fsmonitor', async () => {
    const marker = path.join(root, 'ran');
    const prog = path.join(root, 'p.sh');
    fs.writeFileSync(prog, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    git(work, 'config', 'core.fsmonitor', prog);
    expect((await runWorkerGitRead(['status', '--porcelain'], work)).code).toBe(0);
    git(work, 'config', 'filter.x.clean', prog);
    expect(await runWorkerGitRead(['status', '--porcelain'], work)).toMatchObject({ code: 1, stderr: expect.stringMatching(/filter\.x\.clean/) });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses origin\'s own default branch (origin/HEAD) for a task of the operator\'s', async () => {
    git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    expect(await pushTaskBranch(input('trunk'))).toMatchObject({ ok: false, reason: 'branch-refused' });
  });

  it('refuses a repository with no origin', async () => {
    git(work, 'remote', 'remove', 'origin');
    expect(await pushTaskBranch(input())).toMatchObject({ ok: false, reason: 'no-origin' });
  });

  it('pushes exactly the commit HEAD was resolved to, to refs/heads/<task branch> at origin\'s URL, fast-forward only', () => {
    const sha = 'a'.repeat(40);
    const args = taskPushArgs('wtask/one', 'git@github.com:o/r.git', sha);
    expect(args).toEqual(['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--porcelain', '--', 'git@github.com:o/r.git', `${sha}:refs/heads/wtask/one`]);
    expect(args.some((a) => a.startsWith('+') || a.includes('force'))).toBe(false);
  });

  it('HEAD moving during the push: the commit pushed, set upstream and reported is the one resolved first', async () => {
    const resolved = git(work, 'rev-parse', 'HEAD');
    // A git that commits in the worktree (moving HEAD) right before it pushes.
    const moving = async (args: string[], cwd: string) => {
      if (args.includes('push')) {
        fs.writeFileSync(path.join(work, 'late.txt'), 'late\n');
        git(work, 'add', '.');
        git(work, 'commit', '-qm', 'late');
      }
      return defaultGit(args, cwd);
    };
    const r = await pushTaskBranch(input(), moving);
    const moved = git(work, 'rev-parse', 'HEAD');
    expect(moved).not.toBe(resolved);
    expect(r).toMatchObject({ ok: true, head: resolved });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(resolved);
    expect(git(work, 'rev-parse', 'refs/remotes/origin/wtask/one')).toBe(resolved);
  });

  it('refuses when the repository config redirects the push or names a program, and runs none of it', async () => {
    const marker = path.join(root, 'program-ran');
    const prog = path.join(root, 'prog.sh');
    fs.writeFileSync(prog, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const other = path.join(root, 'other.git');
    execFileSync('git', ['init', '-q', '--bare', other]);
    const cases: Array<[string, string, string]> = [
      ['url.' + other + '.pushInsteadOf', origin, 'config-refused'],
      ['url.' + other + '.insteadOf', origin, 'config-refused'],
      ['remote.origin.pushurl', other, 'remote-refused'],
      ['remote.origin.receivepack', prog, 'config-refused'],
      ['core.fsmonitor', prog, 'config-refused'],
      ['core.sshCommand', prog, 'config-refused'],
      ['credential.helper', `!${prog}`, 'config-refused'],
      ['include.path', path.join(root, 'more.config'), 'config-refused'],
      ['http.curloptResolve', 'github.com:443:127.0.0.1', 'config-refused'],
      ['gpg.program', prog, 'config-refused'],
      ['filter.x.clean', prog, 'config-refused'],
    ];
    for (const [key, value, reason] of cases) {
      git(work, 'config', key, value);
      expect(await pushTaskBranch(input()), key).toMatchObject({ ok: false, reason });
      git(work, 'config', '--unset-all', key);
    }
    expect(fs.existsSync(marker)).toBe(false);
    expect(git(other, 'for-each-ref')).toBe('');
    // A renamed origin is no origin; an added remote is never pushed to.
    git(work, 'remote', 'rename', 'origin', 'up');
    expect(await pushTaskBranch(input())).toMatchObject({ ok: false, reason: 'no-origin' });
  });

  it('a bot\'s task lands only in the bot\'s repository', async () => {
    expect(await pushTaskBranch({ ...input(), expectedRepoKey: 'acme/app' })).toMatchObject({ ok: false, reason: 'remote-refused' });
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
    expect(originUrlRepoKey('git@github.com:Acme/App.git')).toBe('github.com/acme/app');
    expect(originUrlRepoKey('https://github.com/acme/app')).toBe('github.com/acme/app');
    expect(originUrlRepoKey('ssh://git@github.com/acme/app.git')).toBe('github.com/acme/app');
    expect(originUrlRepoKey('ssh://git@github.com:22/acme/app.git')).toBe('github.com/acme/app');
    for (const bad of ['/srv/app.git', 'file:///srv/app.git', 'ext::sh -c x', 'https://github.com/acme/app?x=1', '--upload-pack=x', 'git@github.com:22:acme/app.git', 'https://u:secret@gitlab.example.com/g/p.git', 'http://gitlab.example.com/g/p.git', 'https://gitlab.example.com/g/../p.git']) {
      expect(originUrlRepoKey(bad), bad).toBeNull();
    }
  });
});

describe('task.push: GitLab remotes', () => {
  const key = 'gitlab.corp.example/group/sub/proj';
  const forms = [
    'https://gitlab.corp.example/group/sub/proj.git',
    'https://GitLab.Corp.Example/group/sub/proj',
    'https://gitlab.corp.example:8443/group/sub/proj.git/',
    'https://deploy@gitlab.corp.example/group/sub/proj.git',
    'ssh://git@gitlab.corp.example:2222/group/sub/proj.git',
    'ssh://git@gitlab.corp.example/group/sub/proj',
    'ssh://gitlab.corp.example/group/sub/proj.git',
    'git@gitlab.corp.example:group/sub/proj.git',
    'git@GITLAB.corp.example:Group/Sub/Proj',
  ];

  it('keys every https, ssh:// and scp-like form of a self-hosted subgroup project the same', () => {
    for (const u of forms) expect(originUrlRepoKey(u), u).toBe(key);
    expect(originUrlRepoKey('git@gitlab.com:group/proj.git')).toBe('gitlab.com/group/proj');
  });

  it('agrees with the key a bot\'s repository is stored under', () => {
    // botCreate stores normalizeRepoKey(parseRemoteKey(origin)); task.push
    // compares originUrlRepoKey(origin) against it.
    for (const u of forms.filter((f) => !f.startsWith('https://deploy@'))) {
      expect(normalizeRepoKey(parseRemoteKey(u)), u).toBe(originUrlRepoKey(u));
    }
    expect(normalizeRepoKey('gitlab.corp.example/Group/Sub/Proj.git')).toBe(key);
    expect(normalizeRepoKey('acme/app')).toBe('github.com/acme/app');
    expect(normalizeRepoKey('gitlab.corp.example/' + Array(22).fill('g').join('/'))).toBeNull();
  });

  it('a bot\'s GitLab task pushes to its own project and to no other', async () => {
    const calls: string[][] = [];
    const fake = async (args: string[]) => {
      calls.push(args);
      const sub = args[args.indexOf('-c', 2) + 2];
      if (sub === 'config') return { code: 0, stdout: 'local\0remote.origin.url\nssh://git@gitlab.corp.example:2222/group/sub/proj.git\0', stderr: '' };
      if (sub === 'rev-parse') return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      if (sub === 'ls-remote') return { code: 0, stdout: 'ref: refs/heads/develop\tHEAD\nabc\tHEAD\n', stderr: '' };
      // A worker-written origin/HEAD naming some other branch.
      if (sub === 'symbolic-ref') return { code: 0, stdout: 'refs/remotes/origin/elsewhere\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    // GitHub knows nothing of a GitLab project.
    const repoDefaultBranch = vi.fn(async () => null);
    const base = { worktreePath: '/w', defaultBranches: [], noHooksDir: '/tmp/nh', repoDefaultBranch };
    expect(await pushTaskBranch({ ...base, branch: 'wtask/one', expectedRepoKey: key }, fake)).toMatchObject({ ok: true });
    // The remote's own HEAD is read whatever GitHub and origin/HEAD say, and
    // refused; so is origin/HEAD's branch.
    expect(calls.some((a) => a.includes('ls-remote'))).toBe(true);
    expect(await pushTaskBranch({ ...base, branch: 'develop', expectedRepoKey: key }, fake)).toMatchObject({ ok: false, reason: 'branch-refused' });
    expect(await pushTaskBranch({ ...base, branch: 'elsewhere', expectedRepoKey: key }, fake)).toMatchObject({ ok: false, reason: 'branch-refused' });
    expect(await pushTaskBranch({ ...base, branch: 'develop', expectedRepoKey: key, repoDefaultBranch: async () => 'main' }, fake)).toMatchObject({ ok: false, reason: 'branch-refused' });
    expect(await readRepoDefaultBranchByKey(key, { run: async () => { throw new Error('gh asked'); } })).toBeNull();
    expect(await pushTaskBranch({ ...base, branch: 'wtask/one', expectedRepoKey: 'gitlab.corp.example/group/other' }, fake)).toMatchObject({ ok: false, reason: 'remote-refused' });
    expect(await pushTaskBranch({ ...base, branch: 'wtask/one', expectedRepoKey: 'gitlab.corp.example/group/proj' }, fake)).toMatchObject({ ok: false, reason: 'remote-refused' });
    expect(parseLsRemoteHead('ref: refs/heads/main\tHEAD\r\n0123\tHEAD\n')).toBe('main');
    expect(parseLsRemoteHead('0123\tHEAD\n')).toBeNull();
  });
});

describe('task.push: a repository inside WSL', () => {
  it('reads the distro and Linux gitdir from the worktree\'s .git file, on Windows only', () => {
    expect(taskPushGitTarget('gitdir: //wsl$/Ubuntu/home/me/repo/.git/worktrees/one\n', 'win32'))
      .toEqual({ kind: 'wsl', distro: 'Ubuntu', gitDir: '/home/me/repo/.git/worktrees/one' });
    expect(taskPushGitTarget('gitdir: \\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\my repo\\.git\\worktrees\\one\r\n', 'win32'))
      .toEqual({ kind: 'wsl', distro: 'Ubuntu-24.04', gitDir: '/home/me/my repo/.git/worktrees/one' });
    expect(taskPushGitTarget('gitdir: //WSL.LOCALHOST/Debian/srv/r/.git/worktrees/x', 'win32')).toMatchObject({ kind: 'wsl', distro: 'Debian' });
    expect(taskPushGitTarget('gitdir: D:/repo/.git/worktrees/one', 'win32')).toEqual({ kind: 'host' });
    expect(taskPushGitTarget('gitdir: //server/share/repo/.git/worktrees/one', 'win32')).toEqual({ kind: 'host' });
    expect(taskPushGitTarget(null, 'win32')).toEqual({ kind: 'host' });
    expect(taskPushGitTarget('gitdir: //wsl$/Ubuntu/home/me/repo/.git/worktrees/one', 'linux')).toEqual({ kind: 'host' });
  });

  it('refuses a WSL gitdir whose distro or path cannot be read, instead of guessing', () => {
    for (const bad of [
      'gitdir: //wsl$//home/me/repo/.git',
      'gitdir: //wsl$/-d/home/me/repo/.git',
      'gitdir: //wsl.localhost/Ubuntu',
      'gitdir: //wsl$/Ubuntu/home/me/../other/.git',
      'gitdir: //wsl$/Ubuntu/home/me/a\u0001b/.git',
    ]) {
      const t = taskPushGitTarget(bad, 'win32');
      expect(t.kind, bad).toBe('refused');
      expect((t as { error: string }).error).toMatch(/inside WSL/);
    }
  });

  it('runs git inside the distro: wsl.exe by its full path, argv only, prompts off', async () => {
    const exec = vi.fn<TaskPushExec>(async () => ({ code: 0, stdout: '', stderr: '' }));
    await wslTaskPushGit('Ubuntu', '/home/me/repo/.git/worktrees/one', exec, 'C:\\Windows')(['push', '--', 'u'], 'C:\\ignored');
    const [file, args, env] = exec.mock.calls[0];
    expect(file).toBe('C:\\Windows\\System32\\wsl.exe');
    expect(args).toEqual(['-d', 'Ubuntu', '--cd', '/', '--exec', 'git', '--git-dir=/home/me/repo/.git/worktrees/one', 'push', '--', 'u']);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.WSLENV?.split(':')).toContain('GIT_TERMINAL_PROMPT');
    expect(wslGitArgv('D', '/g', ['x'])).toEqual(['-d', 'D', '--cd', '/', '--exec', 'git', '--git-dir=/g', 'x']);
  });

  // The stand-in hands the Linux gitdir straight to this machine's git, which
  // holds only where host paths are POSIX paths.
  describe.skipIf(process.platform === 'win32')('end to end, with a stand-in wsl.exe that runs this machine\'s git', () => {
    let root: string;
    let work: string;
    let wt: string;
    let origin: string;
    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-wsl-')));
      origin = path.join(root, 'origin.git');
      work = path.join(root, 'work');
      wt = path.join(root, 'wt');
      execFileSync('git', ['init', '-q', '--bare', origin]);
      execFileSync('git', ['init', '-q', '-b', 'main', work]);
      fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
      git(work, 'add', '.');
      git(work, 'commit', '-qm', 'init');
      git(work, 'remote', 'add', 'origin', origin);
      git(work, 'push', '-q', 'origin', 'main');
      git(work, 'worktree', 'add', '-q', '-b', 'wtask/one', wt);
      fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
      git(wt, 'add', '.');
      git(wt, 'commit', '-qm', 'work');
    });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    const gitDir = () => path.join(work, '.git', 'worktrees', 'wt');
    const run = (wslCalls: string[][], hostCalls: string[][]) => ({
      git: async (args: string[]) => { hostCalls.push(args); return { code: 1, stdout: '', stderr: 'host git' }; },
      deps: {
        platform: 'win32' as const,
        // The worktree's .git as Git for Windows writes it for a repository in a distro.
        readDotGit: () => `gitdir: //wsl.localhost/Ubuntu${gitDir()}\n`,
        wslExec: (async (_file, args) => {
          wslCalls.push(args);
          expect(args.slice(0, 7)).toEqual(['-d', 'Ubuntu', '--cd', '/', '--exec', 'git', `--git-dir=${gitDir()}`]);
          try {
            const stdout = execFileSync('git', args.slice(6), { cwd: '/', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            return { code: 0, stdout, stderr: '' };
          } catch (e) {
            const err = e as { status?: number; stdout?: string; stderr?: string };
            return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
          }
        }) as TaskPushExec,
      },
    });

    it('pushes every step through the distro\'s git, hooks from /dev/null, never main\'s', async () => {
      const wslCalls: string[][] = [];
      const hostCalls: string[][] = [];
      const { git: hostGit, deps } = run(wslCalls, hostCalls);
      const r = await pushTaskBranch({ worktreePath: wt, branch: 'wtask/one', defaultBranches: [], noHooksDir: path.join(root, 'nh') }, hostGit, deps);
      expect(r).toMatchObject({ ok: true, branch: 'wtask/one', head: git(wt, 'rev-parse', 'HEAD') });
      expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(git(wt, 'rev-parse', 'HEAD'));
      expect(git(work, 'config', '--get', 'branch.wtask/one.remote')).toBe('origin');
      expect(hostCalls).toEqual([]);
      for (const a of wslCalls) expect(a.slice(7, 11)).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']);
    });

    it('checks the config in the same git it pushes with, and keeps every refusal', async () => {
      const { git: hostGit, deps } = run([], []);
      git(work, 'config', 'core.sshCommand', 'false');
      const input = { worktreePath: wt, branch: 'wtask/one', defaultBranches: [], noHooksDir: path.join(root, 'nh') };
      expect(await pushTaskBranch(input, hostGit, deps)).toMatchObject({ ok: false, reason: 'config-refused' });
      git(work, 'config', '--unset', 'core.sshCommand');
      expect(await pushTaskBranch({ ...input, expectedRepoKey: 'acme/app' }, hostGit, deps)).toMatchObject({ ok: false, reason: 'remote-refused' });
      expect(await pushTaskBranch({ ...input, branch: 'main' }, hostGit, deps)).toMatchObject({ ok: false, reason: 'branch-refused' });
      // The remote's own HEAD, read through the distro's git, is refused too.
      git(work, 'push', '-q', 'origin', 'main:develop');
      execFileSync('git', ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/develop']);
      expect(await pushTaskBranch({ ...input, branch: 'develop' }, hostGit, deps)).toMatchObject({ ok: false, reason: 'branch-refused' });
      expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/develop\nrefs/heads/main');
      expect(git(origin, 'rev-parse', 'develop')).toBe(git(work, 'rev-parse', 'main'));
    });

    it('fails closed, with the cause, when the distro cannot be resolved', async () => {
      const { git: hostGit, deps } = run([], []);
      const r = await pushTaskBranch(
        { worktreePath: wt, branch: 'wtask/one', defaultBranches: [], noHooksDir: path.join(root, 'nh') },
        hostGit,
        { ...deps, readDotGit: () => 'gitdir: //wsl$//home/me/.git/worktrees/wt' },
      );
      expect(r).toMatchObject({ ok: false, reason: 'git-failed', error: expect.stringMatching(/inside WSL/) });
      const gone = await pushTaskBranch(
        { worktreePath: wt, branch: 'wtask/one', defaultBranches: [], noHooksDir: path.join(root, 'nh') },
        hostGit,
        { ...deps, wslExec: async () => ({ code: 1, stdout: '', stderr: 'There is no distribution with the supplied name.' }) },
      );
      expect(gone).toMatchObject({ ok: false, reason: 'config-refused', error: expect.stringMatching(/no distribution/) });
    });
  });
});

describe('task.push RPC', () => {
  type Handler = (params: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>;
  const setup = (over: { row?: unknown; tasks?: unknown[]; caller?: string | null; repoDefault?: string | null; botRepo?: string; head?: string; fail?: boolean } = {}) => {
    const handlers = new Map<string, Handler>();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-rpc-'));
    const push = vi.fn(async (i: { branch: string }) => (over.fail
      ? { ok: false as const, reason: 'rejected' as const, error: 'non-fast-forward' }
      : { ok: true as const, branch: i.branch, remote: 'origin' as const, head: over.head ?? 'abc', output: '' }));
    const row = over.row === undefined ? { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task' } : over.row;
    registerTaskPushRpc({ register: (m: string, h: Handler) => handlers.set(m, h) } as never, {
      getWindow: () => null,
      daemon: { rpc: vi.fn(async () => ({ ok: true, tasks: over.tasks ?? [{ id: 'wtask-1', status: 'open', branch: 'wtask/one', worktreePath: '/w/one' }] })) },
      getLedger: () => ({
        findOpenByTaskWorkspace: (ws: string) => (ws === 'ws-task' ? row : null),
        get: (id: string) => (row && (row as { id?: string }).id === id ? row : null),
      }) as never,
      resolveCallerWorkspace: async () => (over.caller === undefined ? 'ws-task' : over.caller),
      wmuxDir: () => dir,
      push: push as never,
      repoDefaultBranch: async () => (over.repoDefault === undefined ? 'main' : over.repoDefault),
      botRepoKey: () => over.botRepo,
    });
    return { call: handlers.get('task.push')!, push, dir };
  };
  const local = { origin: 'local' };

  it('refuses a push while the task\'s report stands checked as making no changes; one sent back pushes', async () => {
    const reported = { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'review_requested', reportedAtRev: 2, gate: { exitCode: 0, tail: '', at: 1, command: 'none', skipped: 'no_changes', recordedBy: 'system', reportRev: 2 } };
    const held = setup({ row: reported });
    expect(await held.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(held.push).not.toHaveBeenCalled();
    // Its push record is not left "under way" by the refusal.
    expect(taskPushRecordOf(held.dir).get('wtask-1')).toBeNull();
    // Sent back (or reported again since): the old skip holds nothing up.
    for (const row of [{ ...reported, status: 'working' }, { ...reported, reportedAtRev: 5 }]) {
      const free = setup({ row });
      expect(await free.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: true });
    }
  });

  it('a resumed worker of a task completed as making no changes cannot push; one of a task completed on a passing gate still can', async () => {
    const ended = (gate: Record<string, unknown>) => ({
      id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'completed',
      dispatch: { origin: { kind: 'bot', botId: 'bot-1' }, repoKey: 'github.com/acme/app' },
      reportedAtRev: 2, gate,
    });
    const resumedPush = async (row: Record<string, unknown>) => {
      const handlers = new Map<string, Handler>();
      const push = vi.fn(async (i: { branch: string }) => ({ ok: true as const, branch: i.branch, remote: 'origin' as const, head: 'f'.repeat(40), output: '' }));
      registerTaskPushRpc({ register: (m: string, h: Handler) => handlers.set(m, h) } as never, {
        getWindow: () => null,
        daemon: { rpc: vi.fn(async () => ({ ok: true, tasks: [{ id: 'wtask-1', status: 'closed', branch: 'wtask/one', worktreePath: '/w/one' }] })) },
        // No open task in the pane's workspace: the resumed worker's record stands for it.
        getLedger: () => ({ findOpenByTaskWorkspace: () => null, get: (id: string) => (id === 'wtask-1' ? row : null) }) as never,
        resolveCallerWorkspace: async () => 'ws-resumed',
        reclaimedWorkerOfPane: () => ({ taskId: 'wtask-1', botId: 'bot-1', ownerWorkspaceId: 'ws-owner' }),
        exists: () => true,
        wmuxDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-rpc-')),
        push: push as never,
        repoDefaultBranch: async () => 'main',
      });
      return { result: await (handlers.get('task.push') as Handler)({ senderPtyId: 'pty-9' }, local), push };
    };
    const skipped = await resumedPush(ended({ exitCode: 0, tail: '', at: 1, command: 'none', skipped: 'no_changes', recordedBy: 'system', reportRev: 2 }));
    expect(skipped.result).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION', message: expect.stringContaining('completed as making no changes') } });
    expect(skipped.push).not.toHaveBeenCalled();
    const gated = await resumedPush(ended({ exitCode: 0, tail: 'ok', at: 1, command: 'npm test', recordedBy: 'system' }));
    expect(gated.result).toMatchObject({ ok: true });
  });

  it('a skip a later report superseded holds nothing back: sent back, reported again, completed by its merged PR, the resumed worker pushes', async () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-ledger-'));
    try {
      const ledger = new TaskLedger({ dir: ledgerDir });
      const id = 'wtask-1';
      await ledger.register({ id, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 't', dispatch: { origin: { kind: 'bot', botId: 'bot-1' }, preset: 'default', repoKey: 'github.com/acme/app' } });
      const step = async (status: string, actor: { kind: 'worker' | 'brain'; workspaceId: string }): Promise<void> => {
        const r = await ledger.update({ id, status, actor, expectedRev: (ledger.get(id) as { rev: number }).rev });
        if (!r.ok) throw new Error(r.message);
      };
      // A no-changes report (rev 2), its skip (rev 3), sent back (rev 4).
      await step('review_requested', { kind: 'worker', workspaceId: 'ws-task' });
      expect(await recordNoChangesGate(ledger, id, 'no commits', Date.now, 'b'.repeat(40))).toBe(true);
      await step('input_required', { kind: 'brain', workspaceId: 'ws-owner' });
      // A code report (rev 5) whose gate recorded nothing, completed by its merged PR (rev 6).
      await step('review_requested', { kind: 'worker', workspaceId: 'ws-task' });
      const merged = await completeMergedTask(ledger, id, 7, (ledger.get(id) as { rev: number }).rev);
      expect(merged.entry).toMatchObject({ status: 'completed', completion: { source: 'merge', pr: 7 }, reportedAtRev: 5, gate: { skipped: 'no_changes', reportRev: 2 } });
      const handlers = new Map<string, Handler>();
      const push = vi.fn(async (i: { branch: string }) => ({ ok: true as const, branch: i.branch, remote: 'origin' as const, head: 'f'.repeat(40), output: '' }));
      registerTaskPushRpc({ register: (m: string, h: Handler) => handlers.set(m, h) } as never, {
        getWindow: () => null,
        daemon: { rpc: vi.fn(async () => ({ ok: true, tasks: [{ id, status: 'closed', branch: 'wtask/one', worktreePath: '/w/one' }] })) },
        getLedger: () => ledger,
        resolveCallerWorkspace: async () => 'ws-resumed',
        reclaimedWorkerOfPane: () => ({ taskId: id, botId: 'bot-1', ownerWorkspaceId: 'ws-owner' }),
        exists: () => true,
        wmuxDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-rpc-')),
        push: push as never,
        repoDefaultBranch: async () => 'main',
      });
      expect(await (handlers.get('task.push') as Handler)({ senderPtyId: 'pty-9' }, local)).toMatchObject({ ok: true });
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it('a push under way reads as unknown in main\'s record until it ends', async () => {
    const sha = 'f'.repeat(40);
    const r = setup({ head: sha });
    let during: unknown = null;
    r.push.mockImplementationOnce(async (i: { branch: string }) => {
      during = taskPushRecordOf(r.dir).get('wtask-1');
      return { ok: true as const, branch: i.branch, remote: 'origin' as const, head: sha, output: '' };
    });
    expect(await r.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: true });
    expect(during).toBe('unknown');
    expect(taskPushRecordOf(r.dir).get('wtask-1')).toBe(sha);
  });

  it('records the commit a landed push published, in main\'s own record; a refused push records nothing', async () => {
    const sha = 'f'.repeat(40);
    const landed = setup({ head: sha });
    expect(await landed.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: true });
    expect(taskPushRecordOf(landed.dir).get('wtask-1')).toBe(sha);
    // A fresh reader of the same file (after a restart) sees it too.
    expect(new TaskPushRecord(path.join(landed.dir, 'factory', TASK_PUSHES_FILENAME)).get('wtask-1')).toBe(sha);
    const refused = setup({ head: sha, fail: true });
    expect(await refused.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false });
    expect(taskPushRecordOf(refused.dir).get('wtask-1')).toBeNull();
  });

  it('pushes the branch of the caller\'s own task, named by main\'s record only', async () => {
    const { call, push } = setup();
    const r = await call({ senderPtyId: 'pty-1', branch: 'main', worktreePath: '/elsewhere' }, local);
    expect(r).toMatchObject({ ok: true, branch: 'wtask/one', taskId: 'wtask-1' });
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ branch: 'wtask/one', worktreePath: '/w/one' }));
  });

  it('refuses a remote caller, a brain, a bot, an unresolvable pane and a pane with no task', async () => {
    expect(await setup().call({ senderPtyId: 'pty-1' }, {})).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup().call({ senderPtyId: 'pty-1' }, { ...local, commanderWorkspace: 'ws-owner' })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup().call({ senderPtyId: 'pty-1' }, { ...local, bot: { botId: 'bot-1' } })).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup({ caller: null }).call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
    expect(await setup({ caller: 'ws-other' }).call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('hands the push a reader of the repository\'s own default branch, for any task', async () => {
    const { call, push } = setup({ repoDefault: 'trunk' });
    await call({ senderPtyId: 'pty-1' }, local);
    const given = push.mock.calls[0][0] as unknown as { repoDefaultBranch: (k: string) => Promise<string | null>; expectedRepoKey?: string };
    expect(await given.repoDefaultBranch('github.com/o/r')).toBe('trunk');
    expect(given.expectedRepoKey).toBeUndefined();
  });

  it('pins a bot\'s task to the bot\'s repository, and refuses a bot that names none', async () => {
    const botRow = { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', dispatch: { origin: { kind: 'bot', botId: 'bot-1', tainted: false } } };
    const pinned = setup({ row: botRow, botRepo: 'acme/app' });
    await pinned.call({ senderPtyId: 'pty-1' }, local);
    expect(pinned.push).toHaveBeenCalledWith(expect.objectContaining({ expectedRepoKey: 'acme/app' }));
    const none = setup({ row: botRow });
    expect(await none.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(none.push).not.toHaveBeenCalled();
  });

  it('refuses a detached checkout (verify) and a closed or branchless task', async () => {
    const detached = setup({ row: { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', dispatch: { checkout: { sha: 'a'.repeat(40), detached: true } } } });
    expect(await detached.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(detached.push).not.toHaveBeenCalled();
    expect(await setup({ tasks: [{ id: 'wtask-1', status: 'closed', branch: 'b', worktreePath: '/w' }] }).call({ senderPtyId: 'p' }, local))
      .toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(await setup({ tasks: [{ id: 'wtask-1', status: 'open' }] }).call({ senderPtyId: 'p' }, local))
      .toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });
});

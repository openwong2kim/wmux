// task.push: main pushes a worker's own task branch (real git, local bare
// remote), and the RPC derives everything from the caller's pane.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultGit, parseLsRemoteHead, pushTaskBranch as pushTask, taskPushArgs, taskPushBranchRefusal, taskPushGitTarget, wslGitArgv, wslTaskPushGit, type TaskPushExec } from '../taskPush';
import { originUrlRepoKey, runWorkerGitRead } from '../workerGit';
import { registerTaskPushRpc } from '../../pipe/handlers/taskPush.rpc';
import { TASK_PUSHES_FILENAME, TaskPushRecord, taskPushRecordOf } from '../taskPushRecord';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { completeMergedTask, recordNoChangesGate } from '../../factory/taskGate';
import { parseRemoteKey } from '../../github/PrProvider';
import { normalizeRepoKey } from '../../../shared/repoKey';
import { readRepoDefaultBranchByKey } from '../../agents/botWorkerDefaultBranch';
import { fakeSshUrl, writeFakeSsh } from '../../../test-utils/fakeSsh';
import { originPinMatches } from '../../../shared/originPin';
import { fetchTaskRefs } from '../taskFetch';
import { resolveBotRepo } from '../../factory/botCreate';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

// The fixtures' origins are local folders: git's `file` transport, which
// main's own calls never allow.
const FILE_OK = { protocols: ['https', 'ssh', 'file'] };

describe('pushTaskBranch', () => {
  let root: string;
  let repo: string;
  let repoCommon: string;
  let work: string;
  let wtGitDir: string;
  let origin: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-')));
    origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    work = path.join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    // The task runs in its own linked worktree, as a fan-out task does.
    git(repo, 'worktree', 'add', '-q', '-b', 'wtask/one', work);
    fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'work');
    repoCommon = fs.realpathSync.native(path.join(repo, '.git'));
    wtGitDir = fs.realpathSync.native(git(work, 'rev-parse', '--path-format=absolute', '--git-dir'));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const input = (branch = 'wtask/one') => ({
    worktreePath: work, branch, defaultBranches: [], noHooksDir: path.join(root, 'no-hooks'),
    gitCommonDir: repoCommon, gitWorktreeDir: wtGitDir, relayRoot: path.join(root, 'relay'), taskId: 'wtask-1',
  });
  const pushTaskBranch = (i: Parameters<typeof pushTask>[0], g: Parameters<typeof pushTask>[1] = defaultGit) => pushTask(i, g, FILE_OK);

  it('pushes HEAD to the task branch on origin and writes nothing under the recorded repository', async () => {
    const refsBefore = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
    const r = await pushTaskBranch(input());
    expect(r).toMatchObject({ ok: true, branch: 'wtask/one', remote: 'origin', head: git(work, 'rev-parse', 'HEAD') });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(git(work, 'rev-parse', 'HEAD'));
    // Main sets no remote-tracking ref and no branch config in the repository.
    expect(git(repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore);
    expect(() => git(work, 'config', '--get', 'branch.wtask/one.remote')).toThrow();
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

  it('refuses a remote named by origin\'s URL, and writes nothing to it', async () => {
    const other = path.join(root, 'other.git');
    execFileSync('git', ['init', '-q', '--bare', other]);
    git(work, 'config', `remote.${origin}.pushurl`, other);
    expect(await pushTaskBranch(input())).toMatchObject({ ok: false, reason: 'config-refused', error: expect.stringContaining(`remote.${origin.toLowerCase()}.pushurl`) });
    expect(git(other, 'for-each-ref')).toBe('');
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
  });

  it('runs none of the worktree\'s own hooks', async () => {
    const hook = path.join(repoCommon, 'hooks', 'pre-push');
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
    const moving = async (args: string[], cwd: string, env?: Record<string, string>) => {
      if (args.includes('push')) {
        fs.writeFileSync(path.join(work, 'late.txt'), 'late\n');
        git(work, 'add', '.');
        git(work, 'commit', '-qm', 'late');
      }
      return defaultGit(args, cwd, env);
    };
    const r = await pushTaskBranch(input(), moving);
    const moved = git(work, 'rev-parse', 'HEAD');
    expect(moved).not.toBe(resolved);
    expect(r).toMatchObject({ ok: true, head: resolved });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(resolved);
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

// The stand-in ssh origin is a /bin/sh script.
describe.skipIf(process.platform === 'win32')('task.push and task.fetch: the recorded origin pin', () => {
  let root: string;
  let repo: string;
  let work: string;
  let common: string;
  let wtGitDir: string;
  let bare: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-origin-pin-')));
    bare = path.join(root, 'srv', 'acme', 'app.git');
    repo = path.join(root, 'repo');
    work = path.join(root, 'work');
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'push', '-q', bare, 'main');
    git(repo, 'worktree', 'add', '-q', '-b', 'wtask/one', work);
    fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'work');
    common = fs.realpathSync.native(path.join(repo, '.git'));
    wtGitDir = fs.realpathSync.native(git(work, 'rev-parse', '--path-format=absolute', '--git-dir'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(os.homedir(), '.gitconfig'), { force: true });
  });
  const input = () => ({
    worktreePath: work, branch: 'wtask/one', defaultBranches: [], noHooksDir: path.join(root, 'no-hooks'),
    gitCommonDir: common, gitWorktreeDir: wtGitDir, relayRoot: path.join(root, 'relay'), taskId: 'wtask-1',
  });
  /** The owner's global config: the stand-in ssh, and `extra`. */
  const globalConfig = (extra = '') => fs.writeFileSync(path.join(os.homedir(), '.gitconfig'), `[core]\n\tsshCommand = ${writeFakeSsh(root)}\n${extra}`);

  it('the owner\'s global insteadOf (https to ssh) changes neither side of the compare: the pin is recorded and compared from the raw URL', async () => {
    // The repository says https; the owner's global config sends it over ssh.
    git(repo, 'remote', 'add', 'origin', 'https://git.corp.example/acme/app.git');
    globalConfig(`[url "${fakeSshUrl(path.join(root, 'srv'))}/"]\n\tinsteadOf = https://git.corp.example/\n`);
    expect(git(repo, 'remote', 'get-url', 'origin')).toBe(fakeSshUrl(bare));
    // Recorded as a bot's repository is: from the raw URL, never get-url.
    const resolved = await resolveBotRepo(repo);
    expect(resolved).toMatchObject({ ok: true, repo: { repoKey: 'git.corp.example/acme/app', originPin: 'https://git.corp.example/acme/app.git' } });
    const expectedOriginPin = resolved.ok ? resolved.repo.originPin : undefined;
    expect(await pushTask({ ...input(), expectedRepoKey: 'git.corp.example/acme/app', expectedOriginPin })).toMatchObject({ ok: true });
    expect(git(bare, 'rev-parse', 'refs/heads/wtask/one')).toBe(git(work, 'rev-parse', 'HEAD'));
    // Another spelling of the same address the same rule rewrites the same way.
    git(repo, 'remote', 'set-url', 'origin', 'https://git.corp.example/acme/App');
    expect(await fetchTaskRefs({ ...input(), expectedRepoKey: 'git.corp.example/acme/app', expectedOriginPin })).toMatchObject({ ok: true });
  });

  it('a row with no pin is pinned at its first use, then held to it: a port change is refused and nothing reaches the other server', async () => {
    git(repo, 'remote', 'add', 'origin', fakeSshUrl(bare));
    globalConfig();
    const expectedRepoKey = originUrlRepoKey(fakeSshUrl(bare)) as string;
    const recorded: string[] = [];
    const recordOriginPin = vi.fn(async (pin: string) => {
      if (recorded.length === 0) recorded.push(pin);
      return recorded[0];
    });
    const ledgerPinned = async () => ({ ...input(), expectedRepoKey, ...(recorded[0] ? { expectedOriginPin: recorded[0] } : { recordOriginPin }) });
    expect(await pushTask(await ledgerPinned())).toMatchObject({ ok: true });
    expect(recorded).toEqual([fakeSshUrl(bare)]);
    // The same repository key on another port: the pin refuses it.
    git(repo, 'remote', 'set-url', 'origin', fakeSshUrl(bare).replace('ssh://localhost', 'ssh://localhost:2222'));
    expect(await pushTask(await ledgerPinned())).toMatchObject({ ok: false, reason: 'remote-refused', error: expect.stringContaining('recorded') });
    expect(await fetchTaskRefs(await ledgerPinned())).toMatchObject({ ok: false, reason: 'remote-refused' });
    expect(recordOriginPin).toHaveBeenCalledTimes(1);
    // Back on the recorded address it works again.
    git(repo, 'remote', 'set-url', 'origin', fakeSshUrl(bare));
    expect(await fetchTaskRefs(await ledgerPinned())).toMatchObject({ ok: true, defaultBranch: 'main' });
  });

  it('a row with no pin is not pinned to a URL naming another port, nor without its repository key', async () => {
    const record = vi.fn(async (p: string) => p);
    git(repo, 'remote', 'add', 'origin', fakeSshUrl(bare).replace('ssh://localhost', 'ssh://localhost:2222'));
    // The stand-in ssh takes `-p <port>` like OpenSSH.
    globalConfig('[ssh]\n\tvariant = ssh\n');
    const expectedRepoKey = originUrlRepoKey(fakeSshUrl(bare)) as string;
    expect(await pushTask({ ...input(), expectedRepoKey, recordOriginPin: record })).toMatchObject({ ok: false, reason: 'remote-refused', error: expect.stringContaining('start a new task') });
    git(repo, 'remote', 'set-url', 'origin', fakeSshUrl(bare).replace('ssh://localhost', 'ssh://localhost:22'));
    expect(await pushTask({ ...input(), recordOriginPin: record })).toMatchObject({ ok: false, reason: 'remote-refused', error: expect.stringContaining('start a new task') });
    expect(record).not.toHaveBeenCalled();
    // The default port, written out, is pinned.
    const pinned = await pushTask({ ...input(), expectedRepoKey, recordOriginPin: record });
    expect(pinned).toMatchObject({ ok: true });
    expect(record).toHaveBeenCalledWith(fakeSshUrl(bare).replace('ssh://localhost', 'ssh://localhost:22'));
  });

  it('a pin that cannot be recorded refuses the push', async () => {
    git(repo, 'remote', 'add', 'origin', fakeSshUrl(bare));
    globalConfig();
    const expectedRepoKey = originUrlRepoKey(fakeSshUrl(bare)) as string;
    expect(await pushTask({ ...input(), expectedRepoKey, recordOriginPin: async () => null })).toMatchObject({ ok: false, reason: 'remote-refused' });
    expect(await pushTask({ ...input(), expectedRepoKey, recordOriginPin: async () => { throw new Error('disk full'); } })).toMatchObject({ ok: false, reason: 'remote-refused' });
    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
  });

  /** A second bare origin at `<root>/<dir>/acme/app.git`. */
  const otherServer = (dir: string) => {
    const other = path.join(root, dir, 'acme', 'app.git');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', other]);
    return other;
  };
  const rule = (dir: string, prefix: string, key = 'insteadOf') => `[url "${fakeSshUrl(path.join(root, dir))}/"]\n\t${key} = ${prefix}\n`;
  const assertRefusedThenOk = async (pin: string, moved: string, other: string) => {
    git(repo, 'remote', 'set-url', 'origin', moved);
    expect(originPinMatches(pin, moved)).toBe(true);
    expect(await pushTask({ ...input(), expectedOriginPin: pin })).toMatchObject({ ok: false, reason: 'remote-refused', error: expect.stringContaining('reach') });
    expect(git(other, 'for-each-ref')).toBe('');
    git(repo, 'remote', 'set-url', 'origin', pin);
    expect(await pushTask({ ...input(), expectedOriginPin: pin })).toMatchObject({ ok: true });
  };

  it('a spelling of the pinned address that the owner\'s rewrites send to another server is refused (as git resolves them)', async () => {
    const other = otherServer('srv2');
    const pin = 'https://git.corp.example/acme/app.git';
    git(repo, 'remote', 'add', 'origin', pin);
    globalConfig(rule('srv', 'https://git.corp.example/') + rule('srv2', 'https://git.corp.example:443/'));
    await assertRefusedThenOk(pin, 'https://git.corp.example:443/acme/app.git', other);
  });

  it('a longer rule for the `.git` spelling: dropping `.git` reaches the shorter rule\'s server, and is refused', async () => {
    const other = otherServer('srv2');
    const pin = 'https://git.corp.example/acme/app.git';
    git(repo, 'remote', 'add', 'origin', pin);
    // The pinned spelling goes to srv by the longer rule; without `.git`, to srv2.
    globalConfig(rule('srv2', 'https://git.corp.example/') + `[url "${fakeSshUrl(bare)}"]\n\tinsteadOf = https://git.corp.example/acme/app.git\n`);
    await assertRefusedThenOk(pin, 'https://git.corp.example/acme/app', other);
  });

  it('a host spelled in another case misses the owner\'s rule (git matches it literally), and is refused', async () => {
    const other = otherServer('srv2');
    const pin = 'https://git.corp.example/acme/app.git';
    git(repo, 'remote', 'add', 'origin', pin);
    // Equal-length rules: git takes the first; the other case of the host takes the other.
    globalConfig(rule('srv', 'https://git.corp.example/') + rule('srv2', 'https://Git.Corp.Example/'));
    await assertRefusedThenOk(pin, 'https://Git.Corp.Example/acme/app.git', other);
  });

  it('a push rewrite counts for a push', async () => {
    const other = otherServer('srv2');
    const pin = 'https://git.corp.example/acme/app.git';
    git(repo, 'remote', 'add', 'origin', pin);
    globalConfig(rule('srv', 'https://git.corp.example/') + rule('srv2', 'https://git.corp.example/acme/app', 'pushInsteadOf'));
    // The pinned spelling (with `.git`) is pushed by the push rule too: to pin
    // the spelling the push rule misses, record the URL without `.git`.
    await assertRefusedThenOk('https://git.corp.example/acme/App.git', 'https://git.corp.example/acme/app.git', other);
  });

  it('a switch between https and ssh is refused; the owner picks the repository again', async () => {
    git(repo, 'remote', 'add', 'origin', 'git@git.corp.example:acme/app.git');
    globalConfig();
    expect(await pushTask({ ...input(), expectedOriginPin: 'https://git.corp.example/acme/app.git' })).toMatchObject({ ok: false, reason: 'remote-refused' });
  });

  it('a different host is refused even under the same repository path', async () => {
    git(repo, 'remote', 'add', 'origin', 'git@git.corp.example:acme/app.git');
    globalConfig();
    expect(await pushTask({ ...input(), expectedOriginPin: 'git@git.other.example:acme/app.git' })).toMatchObject({ ok: false, reason: 'remote-refused' });
    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
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
    // The subcommand: the first argument that is neither an option nor a `-c` value.
    const subOf = (args: string[]) => args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c');
    const fake = async (args: string[]) => {
      calls.push(args);
      if (args.includes('--version')) return { code: 0, stdout: 'git version 2.50.0\n', stderr: '' };
      const sub = subOf(args);
      if (sub === 'config' && args.includes('--list')) return { code: 0, stdout: 'local\0remote.origin.url\nssh://git@gitlab.corp.example:2222/group/sub/proj.git\0', stderr: '' };
      if (sub === 'rev-parse') return { code: 0, stdout: args.includes('--is-shallow-repository') ? 'false\n' : `${'a'.repeat(40)}\n`, stderr: '' };
      if (sub === 'ls-remote') return { code: 0, stdout: 'ref: refs/heads/develop\tHEAD\nabc\tHEAD\n', stderr: '' };
      // A worker-written origin/HEAD naming some other branch.
      if (sub === 'symbolic-ref') return { code: 0, stdout: 'refs/remotes/origin/elsewhere\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    // GitHub knows nothing of a GitLab project.
    const repoDefaultBranch = vi.fn(async () => null);
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-gl-')));
    fs.mkdirSync(path.join(tmp, 'worktrees', 'one'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'worktrees', 'one', 'HEAD'), `${'a'.repeat(40)}\n`);
    const base = { worktreePath: '/w', defaultBranches: [], noHooksDir: '/tmp/nh', gitCommonDir: tmp, gitWorktreeDir: path.join(tmp, 'worktrees', 'one'), relayRoot: path.join(tmp, 'relay'), taskId: 'wtask-1', repoDefaultBranch };
    try {
      expect(await pushTask({ ...base, branch: 'wtask/one', expectedRepoKey: key }, fake)).toMatchObject({ ok: true });
      // The remote's own HEAD is read whatever GitHub and origin/HEAD say, and
      // refused; so is origin/HEAD's branch.
      expect(calls.some((a) => a.includes('ls-remote'))).toBe(true);
      expect(await pushTask({ ...base, branch: 'develop', expectedRepoKey: key }, fake)).toMatchObject({ ok: false, reason: 'branch-refused' });
      expect(await pushTask({ ...base, branch: 'elsewhere', expectedRepoKey: key }, fake)).toMatchObject({ ok: false, reason: 'branch-refused' });
      expect(await pushTask({ ...base, branch: 'develop', expectedRepoKey: key, repoDefaultBranch: async () => 'main' }, fake)).toMatchObject({ ok: false, reason: 'branch-refused' });
      expect(await readRepoDefaultBranchByKey(key, { run: async () => { throw new Error('gh asked'); } })).toBeNull();
      expect(await pushTask({ ...base, branch: 'wtask/one', expectedRepoKey: 'gitlab.corp.example/group/other' }, fake)).toMatchObject({ ok: false, reason: 'remote-refused' });
      expect(await pushTask({ ...base, branch: 'wtask/one', expectedRepoKey: 'gitlab.corp.example/group/proj' }, fake)).toMatchObject({ ok: false, reason: 'remote-refused' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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

});


describe('task.push RPC', () => {
  type Handler = (params: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>;
  const setup = (over: { row?: unknown; tasks?: unknown[]; caller?: string | null; repoDefault?: string | null; botRepo?: string; head?: string; fail?: boolean; ended?: unknown; reclaimed?: (ws: string, pty: string) => { taskId: string; botId: string; ownerWorkspaceId: string } | null } = {}) => {
    const handlers = new Map<string, Handler>();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-rpc-'));
    const push = vi.fn(async (i: { branch: string }) => (over.fail
      ? { ok: false as const, reason: 'rejected' as const, error: 'non-fast-forward' }
      : { ok: true as const, branch: i.branch, remote: 'origin' as const, head: over.head ?? 'abc', output: '' }));
    const row = over.row === undefined ? { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', dispatch: { origin: { kind: 'pane' }, repoKey: 'github.com/acme/app', gitCommonDir: '/r/.git' } } : over.row;
    registerTaskPushRpc({ register: (m: string, h: Handler) => handlers.set(m, h) } as never, {
      getWindow: () => null,
      daemon: { rpc: vi.fn(async () => ({ ok: true, tasks: over.tasks ?? [{ id: 'wtask-1', status: 'open', branch: 'wtask/one', worktreePath: '/w/one' }] })) },
      getLedger: () => ({
        findOpenByTaskWorkspace: (ws: string) => (ws === 'ws-task' ? row : null),
        get: (id: string) => (over.ended !== undefined ? (id === 'wtask-1' ? over.ended : null) : row && (row as { id?: string }).id === id ? row : null),
      }) as never,
      reclaimedWorkerOfPane: over.reclaimed ?? (() => null),
      exists: () => true,
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
    const reported = { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', dispatch: { origin: { kind: 'pane' }, repoKey: 'github.com/acme/app', gitCommonDir: '/r/.git' }, status: 'review_requested', reportedAtRev: 2, gate: { exitCode: 0, tail: '', at: 1, command: 'none', skipped: 'no_changes', recordedBy: 'system', reportRev: 2 } };
    const held = setup({ row: reported });
    expect(await held.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION', message: expect.stringMatching(/no changes/) } });
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
      dispatch: { origin: { kind: 'bot', botId: 'bot-1' }, repoKey: 'github.com/acme/app', gitCommonDir: '/r/.git' },
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
      await ledger.register({ id, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 't', dispatch: { origin: { kind: 'bot', botId: 'bot-1' }, preset: 'default', repoKey: 'github.com/acme/app', gitCommonDir: '/r/.git' } });
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

  it('holds the push to the pin on the dispatch, else the bot\'s profile\'s; a row with neither is pinned on the ledger at its first use', async () => {
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-ledger-'));
    try {
      const ledger = new TaskLedger({ dir: ledgerDir });
      const dispatch = { origin: { kind: 'bot', botId: 'bot-1' }, repoKey: 'github.com/acme/app', gitCommonDir: '/r/.git' };
      const pushWith = async (row: Record<string, unknown>, profilePin?: string) => {
        const handlers = new Map<string, Handler>();
        const push = vi.fn(async (i: { branch: string; recordOriginPin?: (p: string) => Promise<string | null> }) => {
          // The push records origin's pin as read from the recorded repository.
          if (i.recordOriginPin) await i.recordOriginPin('git@github.com:acme/app');
          return { ok: true as const, branch: i.branch, remote: 'origin' as const, head: 'f'.repeat(40), output: '' };
        });
        await ledger.register({ id: row.id as string, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 't', dispatch: row.dispatch as never });
        registerTaskPushRpc({ register: (m: string, h: Handler) => handlers.set(m, h) } as never, {
          getWindow: () => null,
          daemon: { rpc: vi.fn(async () => ({ ok: true, tasks: [{ id: row.id, status: 'open', branch: 'wtask/one', worktreePath: '/w/one' }] })) },
          getLedger: () => ({ findOpenByTaskWorkspace: () => ledger.get(row.id as string), get: (id: string) => ledger.get(id), recordOriginPin: (id: string, p: string) => ledger.recordOriginPin(id, p) }) as never,
          resolveCallerWorkspace: async () => 'ws-task',
          exists: () => true,
          wmuxDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-rpc-')),
          push: push as never,
          repoDefaultBranch: async () => 'main',
          botOriginPin: () => profilePin,
        });
        expect(await (handlers.get('task.push') as Handler)({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: true });
        return push.mock.calls[0][0] as { expectedOriginPin?: string; recordOriginPin?: unknown };
      };
      const pinned = await pushWith({ id: 'wtask-a', dispatch: { ...dispatch, originPin: 'https://github.com/acme/app.git' } }, 'git@github.com:acme/other');
      expect(pinned).toMatchObject({ expectedOriginPin: 'https://github.com/acme/app.git' });
      expect(pinned.recordOriginPin).toBeUndefined();
      expect(await pushWith({ id: 'wtask-b', dispatch }, 'git@github.com:acme/app')).toMatchObject({ expectedOriginPin: 'git@github.com:acme/app' });
      // A legacy row: pinned at its first push, and held to that pin after a reload.
      const legacy = await pushWith({ id: 'wtask-c', dispatch });
      expect(legacy.expectedOriginPin).toBeUndefined();
      expect(typeof legacy.recordOriginPin).toBe('function');
      await ledger.flush();
      expect(new TaskLedger({ dir: ledgerDir }).get('wtask-c')?.dispatch?.originPin).toBe('git@github.com:acme/app');
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

  it('runs the push on the git dir main recorded, with a relay under main\'s folder; a task with none recorded is refused, a bot\'s falls back to its profile', async () => {
    const r = setup();
    expect(await r.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: true });
    expect(r.push).toHaveBeenCalledWith(expect.objectContaining({ gitCommonDir: '/r/.git', relayRoot: path.join(r.dir, 'factory', 'git-relay'), taskId: 'wtask-1', worktreePath: '/w/one' }));
    const none = setup({ row: { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', dispatch: { origin: { kind: 'pane' }, repoKey: 'github.com/acme/app' } } });
    expect(await none.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION', message: expect.stringMatching(/recorded no repository folder/) } });
    expect(none.push).not.toHaveBeenCalled();
    // A bot's row from before the record: the bot's own repository folder.
    const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-botrepo-')));
    try {
      execFileSync('git', ['init', '-q', repo]);
      const handlers = new Map<string, Handler>();
      const push = vi.fn(async (i: { branch: string }) => ({ ok: true as const, branch: i.branch, remote: 'origin' as const, head: 'abc', output: '' }));
      const row = { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', dispatch: { origin: { kind: 'bot', botId: 'bot-1' }, repoKey: 'github.com/acme/app' } };
      registerTaskPushRpc({ register: (m: string, h: Handler) => handlers.set(m, h) } as never, {
        getWindow: () => null,
        daemon: { rpc: vi.fn(async () => ({ ok: true, tasks: [{ id: 'wtask-1', status: 'open', branch: 'wtask/one', worktreePath: '/w/one' }] })) },
        getLedger: () => ({ findOpenByTaskWorkspace: () => row, get: () => row }) as never,
        resolveCallerWorkspace: async () => 'ws-task',
        wmuxDir: () => r.dir,
        push: push as never,
        repoDefaultBranch: async () => 'main',
        botRepoPath: (id) => (id === 'bot-1' ? repo : undefined),
      });
      expect(await (handlers.get('task.push') as Handler)({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: true });
      expect(push).toHaveBeenCalledWith(expect.objectContaining({ gitCommonDir: path.join(repo, '.git') }));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('sweeps relays whose task is no longer open, when it registers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-task-push-sweep-'));
    const relayRoot = path.join(dir, 'factory', 'git-relay');
    fs.mkdirSync(path.join(relayRoot, 'wtask-open'), { recursive: true });
    fs.mkdirSync(path.join(relayRoot, 'wtask-gone'), { recursive: true });
    registerTaskPushRpc({ register: () => undefined } as never, {
      getWindow: () => null,
      daemon: { rpc: async () => ({}) },
      wmuxDir: () => dir,
      getLedger: () => ({ get: (id: string) => (id === 'wtask-open' ? { status: 'working' } : undefined) }) as never,
    });
    expect(fs.readdirSync(relayRoot).sort()).toEqual(['wtask-open']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hands the push a reader of the repository\'s own default branch, for any task', async () => {
    const { call, push } = setup({ repoDefault: 'trunk' });
    await call({ senderPtyId: 'pty-1' }, local);
    const given = push.mock.calls[0][0] as unknown as { repoDefaultBranch: (k: string) => Promise<string | null>; expectedRepoKey?: string };
    expect(await given.repoDefaultBranch('github.com/o/r')).toBe('trunk');
    // The origin main recorded for the task.
    expect(given.expectedRepoKey).toBe('github.com/acme/app');
  });

  it('applies the same origin pin as task_fetch: a task with no recorded origin is refused; a resumed worker\'s pane pushes its own task', async () => {
    const none = setup({ row: { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task' } });
    expect(await none.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION', message: expect.stringMatching(/recorded no origin/) } });
    expect(none.push).not.toHaveBeenCalled();
    const ended = { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', dispatch: { origin: { kind: 'bot', botId: 'bot-1' }, repoKey: 'github.com/acme/app', gitCommonDir: '/r/.git' } };
    const reclaimed = (ws: string, pty: string) => (ws === 'ws-task' && pty === 'pty-1' ? { taskId: 'wtask-1', botId: 'bot-1', ownerWorkspaceId: 'ws-owner' } : null);
    const tasks = [{ id: 'wtask-1', status: 'closed', branch: 'wtask/one', worktreePath: '/w/one' }];
    const resumed = setup({ row: null, ended, reclaimed, tasks });
    expect(await resumed.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: true, branch: 'wtask/one', taskId: 'wtask-1' });
    expect(resumed.push).toHaveBeenCalledWith(expect.objectContaining({ expectedRepoKey: 'github.com/acme/app', worktreePath: '/w/one' }));
    expect(await setup({ row: null, ended, reclaimed, tasks }).call({ senderPtyId: 'pty-2' }, local)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('pins a bot\'s task to the bot\'s repository, and refuses a bot that names none', async () => {
    const botRow = { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', dispatch: { origin: { kind: 'bot', botId: 'bot-1', tainted: false }, gitCommonDir: '/r/.git' } };
    const pinned = setup({ row: botRow, botRepo: 'acme/app' });
    await pinned.call({ senderPtyId: 'pty-1' }, local);
    expect(pinned.push).toHaveBeenCalledWith(expect.objectContaining({ expectedRepoKey: 'acme/app' }));
    const none = setup({ row: botRow });
    expect(await none.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(none.push).not.toHaveBeenCalled();
  });

  it('refuses a detached checkout (verify) and a closed or branchless task', async () => {
    const detached = setup({ row: { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', dispatch: { origin: { kind: 'pane' }, repoKey: 'github.com/acme/app', checkout: { sha: 'a'.repeat(40), detached: true } } } });
    expect(await detached.call({ senderPtyId: 'pty-1' }, local)).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION', message: expect.stringMatching(/detached checkout/) } });
    expect(detached.push).not.toHaveBeenCalled();
    expect(await setup({ tasks: [{ id: 'wtask-1', status: 'closed', branch: 'b', worktreePath: '/w' }] }).call({ senderPtyId: 'p' }, local))
      .toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
    expect(await setup({ tasks: [{ id: 'wtask-1', status: 'open' }] }).call({ senderPtyId: 'p' }, local))
      .toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION' } });
  });
});

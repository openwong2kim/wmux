// task.push / task.fetch run main's network git in a main-owned relay that
// borrows the recorded repository's objects; main writes nothing under the
// recorded repository (real git where it can run here; the WSL shape by its
// argv and env).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultGit, openTaskGitRepo, pushTaskBranch, readWorkerFile, type TaskPushExec, type TaskPushGit } from '../taskPush';
import { fetchTaskRefs } from '../taskFetch';
import { recordedTaskGitCommonDir, recordedTaskGitWorktreeDir } from '../taskGitCommonDir';
import { liveNoChangesPorts } from '../../factory/noChangesCheck';
import type { LedgerEntry } from '../../../shared/ledger';
import {
  fetchCommandFor, gitVersionRefusal, lazyFetchProbeRefusal, parseRawGitConfigList, parseTaskHead, relayGitConfigArgs, shellQuote, transportConfigReplay,
} from '../../../shared/taskGitRelay';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

const FILE_OK = { protocols: ['https', 'ssh', 'file'] };

describe('relay git: argv, env and config replay', () => {
  it('forces no gc, no maintenance, no commit-graph or multi-pack index, fetched objects kept as a pack, and the given transports', () => {
    expect(relayGitConfigArgs(['-c', 'core.fsmonitor=false'])).toEqual([
      '-c', 'core.fsmonitor=false',
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false',
      '-c', 'fetch.unpackLimit=1', '-c', 'transfer.unpackLimit=1',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
    ]);
  });

  const list = (rows: Array<[string, string, string]>) => rows.map(([scope, key, value]) => `${scope}\0${key}\n${value}\0`).join('');

  it('matches the owner\'s transport config: credentials as one ordered list, extraHeader cleared and replayed, single values replayed, URL rewrites only added', () => {
    const relay = parseRawGitConfigList(list([
      ['global', 'http.sslVerify', 'false'],
      ['global', 'credential.helper', 'store'],
      ['global', 'http.extraHeader', 'X-A: 1'],
    ]));
    const context = parseRawGitConfigList(list([
      ['global', 'http.sslVerify', 'false'],
      ['global', 'credential.helper', 'store'],
      ['global', 'http.extraHeader', 'X-A: 1'],
      // Added for the recorded repository by an includeIf gitdir: rule.
      ['global', 'http.sslVerify', 'true'],
      ['global', 'credential.https://work.example.helper', 'work-helper'],
      ['global', 'credential.helper', ''],
      ['global', 'http.extraHeader', ''],
      ['global', 'url.git@work:Team/.insteadOf', 'https://work/Team/'],
      ['global', 'core.sshcommand', 'ssh -i key'],
    ]));
    expect(transportConfigReplay(context, relay)).toEqual([
      // One cleared and replayed list, URL-scoped helpers in their place.
      'credential.helper=', 'credential.helper=store', 'credential.https://work.example.helper=work-helper', 'credential.helper=',
      // A single value: the last recorded one wins, no empty reset.
      'http.sslVerify=false', 'http.sslVerify=true',
      'http.extraHeader=', 'http.extraHeader=X-A: 1', 'http.extraHeader=',
      'url.git@work:Team/.insteadOf=https://work/Team/',
      'core.sshcommand=ssh -i key',
    ]);
    expect(transportConfigReplay(relay, relay)).toEqual([]);
    // A URL rewrite is never reset; a single value only the relay has is left
    // alone (an empty value would not mean "unset"); a relay-only extraHeader is cleared.
    const relayOnly = parseRawGitConfigList(list([['global', 'http.sslVerify', 'true'], ['global', 'http.extraHeader', 'X-B: 2'], ['global', 'url.x.insteadOf', 'y']]));
    expect(transportConfigReplay([], relayOnly)).toEqual(['http.extraHeader=']);
  });

  it('accepts only the patched releases from 2.43.4 on', () => {
    for (const ok of ['2.43.4', '2.43.7', '2.44.1', '2.45.1', '2.46.0', '2.50.1 (Apple Git-155)', '3.0.0']) expect(gitVersionRefusal(`git version ${ok}`), ok).toBeNull();
    for (const bad of ['2.43.3', '2.44.0', '2.45.0', '2.39.5', '1.9.9']) expect(gitVersionRefusal(`git version ${bad}`), bad).toMatch(/is not one a task's network git runs with/);
    expect(gitVersionRefusal('nonsense')).toMatch(/could not be read/);
  });

  it('the capability check accepts only a lazy fetch git stopped for GIT_NO_LAZY_FETCH', () => {
    const v = 'git version 2.43.0\n';
    expect(lazyFetchProbeRefusal(v, { code: 128, stderr: 'warning: lazy fetching disabled; some objects may not be available\nfatal: unable to read 1234\n' })).toBeNull();
    for (const out of [
      // git tried to fetch from the promisor remote.
      { code: 128, stderr: "fatal: '/tmp/p/missing' does not appear to be a git repository\nfatal: Could not read from remote repository.\n" },
      { code: 128, stderr: "fatal: transport 'file' not allowed\nfatal: unable to read 1234\n" },
      // Another error, or no error at all.
      { code: 128, stderr: 'fatal: unable to read 1234\n' },
      { code: 0, stderr: '' },
      // A timeout, whatever was printed before it.
      { code: -1, stderr: 'warning: lazy fetching disabled; some objects may not be available\n', timedOut: true },
    ]) expect(lazyFetchProbeRefusal(v, out), JSON.stringify(out)).toMatch(/^git version 2\.43\.0 does not honour GIT_NO_LAZY_FETCH/);
  });

  it('reads a HEAD file strictly: a full commit id of the object format, or a plain branch ref', () => {
    const a = 'a'.repeat(40);
    expect(parseTaskHead(`${a}\n`, 'sha1')).toEqual({ kind: 'oid', oid: a });
    expect(parseTaskHead(`${'b'.repeat(64)}\n`, 'sha256')).toEqual({ kind: 'oid', oid: 'b'.repeat(64) });
    expect(parseTaskHead('ref: refs/heads/wtask/one\n', 'sha1')).toEqual({ kind: 'ref', ref: 'refs/heads/wtask/one' });
    for (const bad of [
      `${'b'.repeat(64)}\n`, `${a.toUpperCase()}\n`, `${a}\n\n`, ` ${a}`, a.slice(1),
      'ref: refs/heads/x^{blob}\n', 'ref: refs/heads/x~1', 'ref: refs/heads/x:y', 'ref: refs/heads/x?', 'ref: refs/heads/x*',
      'ref: refs/heads/x[1]', 'ref: refs/heads/x\\y', 'ref: refs/heads/x@{1}', 'ref: refs/heads/x y', 'ref: refs/heads/x\ty',
      'ref: refs/heads/-x', 'ref: refs/heads/a..b', 'ref: refs/heads/a.lock/b', 'ref: refs/heads/a/', 'ref: refs/heads/',
      'ref: refs/tags/v1', 'ref: refs/remotes/origin/main', 'ref:refs/heads/x', 'ref: refs/heads/x\nref: refs/heads/y',
    ]) expect(parseTaskHead(bad, 'sha1'), JSON.stringify(bad)).toBeNull();
    expect(parseTaskHead(`${a}\n`, 'other')).toBeNull();
  });

  it('quotes the fetch line for the worker\'s shell', () => {
    expect(shellQuote("a b", 'linux')).toBe("'a b'");
    expect(shellQuote("a'b", 'darwin')).toBe("'a'\\''b'");
    expect(shellQuote('a b', 'win32')).toBe('"a b"');
    for (const w of ['a$b', 'a%b', 'a"b', 'a!b', 'a`b']) expect(shellQuote(w, 'win32'), w).toBeNull();
    expect(fetchCommandFor('C:\\data%x\\relay', ['+refs/heads/main:refs/remotes/origin/main'], 'win32')).toBeNull();
    // A WSL shell on a Windows-host repository: git.exe, the Windows path kept
    // as-is inside bash single quotes.
    expect(fetchCommandFor("C:\\Users\\me's\\git-relay\\wtask-1", ['+refs/heads/main:refs/remotes/origin/main'], 'linux', 'git.exe'))
      .toBe("git.exe fetch --no-tags --no-write-fetch-head 'C:\\Users\\me'\\''s\\git-relay\\wtask-1' '+refs/heads/main:refs/remotes/origin/main'");
    expect(fetchCommandFor('/r e/relay', ['+refs/heads/main:refs/remotes/origin/main'], 'linux'))
      .toBe("git fetch --no-tags --no-write-fetch-head '/r e/relay' '+refs/heads/main:refs/remotes/origin/main'");
  });
});

describe('relay git: inside WSL', () => {
  it('runs the network call in the distro with the relay\'s drvfs path, borrowed objects, no GIT_OBJECT_DIRECTORY/GIT_COMMON_DIR and no GIT_CONFIG_NOSYSTEM', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-relay-wsl-')));
    const relayRoot = path.join(root, 'relay');
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const sha = 'a'.repeat(40);
    const exec: TaskPushExec = async (_file, args, env) => {
      calls.push({ args, env });
      const prog = args[5];
      // No `shallow`; HEAD is a plain file.
      if (prog === 'test') return { code: args.includes('-e') ? 1 : 0, stdout: '', stderr: '' };
      if (prog === 'timeout') return { code: 0, stdout: 'ref: refs/heads/wtask/one\n', stderr: '' };
      if (prog === 'wslpath') return { code: 0, stdout: `/mnt/c/wmux${String(args[args.length - 1]).slice(root.length).replace(/\\/g, '/')}\n`, stderr: '' };
      if (args.includes('--version')) return { code: 0, stdout: 'git version 2.50.0\n', stderr: '' };
      if (args.includes('--list')) return { code: 0, stdout: 'local\0remote.origin.url\nssh://git@github.com/acme/app.git\0', stderr: '' };
      if (args.includes('--is-shallow-repository')) return { code: 0, stdout: 'false\n', stderr: '' };
      if (args.includes('rev-parse')) return { code: 0, stdout: `${sha}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    try {
      const r = await pushTaskBranch(
        { worktreePath: 'C:\\Users\\me\\.wmux\\worktrees\\h\\t', branch: 'wtask/one', defaultBranches: [], noHooksDir: 'C:\\Users\\me\\.wmux\\factory\\no-hooks', gitCommonDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git', gitWorktreeDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git\\worktrees\\t', relayRoot, taskId: 'wtask-1' },
        async () => ({ code: 1, stdout: '', stderr: 'host git' }),
        { platform: 'win32', wslExec: exec },
      );
      expect(r).toMatchObject({ ok: true, head: sha });
      const push = calls.find((c) => c.args.includes('push'));
      expect(push).toBeDefined();
      const { args, env } = push as { args: string[]; env: NodeJS.ProcessEnv };
      expect(args.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--cd', '/', '--exec', 'git']);
      expect(args[6]).toMatch(/^--git-dir=\/mnt\/c\/wmux\/relay\/wtask-1$/);
      expect(args).toEqual(expect.arrayContaining(['protocol.allow=never', 'gc.auto=0', 'core.hooksPath=/dev/null']));
      // A relay call never names the recorded objects or common dir by env.
      expect('GIT_OBJECT_DIRECTORY' in env).toBe(false);
      expect('GIT_COMMON_DIR' in env).toBe(false);
      expect(env.GIT_DIR).toBeUndefined();
      expect(calls.some((c) => 'GIT_CONFIG_NOSYSTEM' in c.env)).toBe(false);
      // The borrowed objects are named by the alternates file (a Linux path).
      expect(fs.readFileSync(path.join(relayRoot, 'wtask-1', 'objects', 'info', 'alternates'), 'utf8')).toBe('/home/me/repo/.git/objects\n');
      // HEAD is the recorded worktree git dir's HEAD file, read bounded in the
      // distro; its branch is resolved in the recorded repository's refs.
      const read = calls.find((c) => c.args[5] === 'timeout') as { args: string[] };
      expect(read.args.slice(5)).toEqual(['timeout', '5', 'head', '-c', '4097', '--', '/home/me/repo/.git/worktrees/t/HEAD']);
      const ref = calls.find((c) => c.args.includes('refs/heads/wtask/one') && c.args.includes('rev-parse')) as { args: string[]; env: NodeJS.ProcessEnv };
      expect(ref.args).toContain('--git-dir=/home/me/repo/.git');
      expect(ref.env.GIT_COMMON_DIR).toBe('/home/me/repo/.git');
      expect(calls.some((c) => c.args.includes(`${sha}^{commit}`))).toBe(true);
      // Every git call runs with GIT_NO_LAZY_FETCH, named in WSLENV.
      const gitCalls = calls.filter((c) => c.args[5] === 'git');
      expect(gitCalls.length).toBeGreaterThan(3);
      for (const c of gitCalls) {
        expect(c.env.GIT_NO_LAZY_FETCH).toBe('1');
        expect(String(c.env.WSLENV).split(':')).toContain('GIT_NO_LAZY_FETCH');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('task.fetch: a repository inside a WSL distro', () => {
  it('returns the WSL line, the relay by its Linux path (the same line as fetchCommand)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-relay-wsl-fetch-')));
    const sha = 'a'.repeat(40);
    const exec: TaskPushExec = async (_file, args) => {
      const prog = args[5];
      if (prog === 'test') return { code: args.includes('-e') ? 1 : 0, stdout: '', stderr: '' };
      if (prog === 'wslpath') return { code: 0, stdout: `/mnt/c/wmux${String(args[args.length - 1]).slice(root.length).replace(/\\/g, '/')}\n`, stderr: '' };
      if (args.includes('--version')) return { code: 0, stdout: 'git version 2.50.0\n', stderr: '' };
      if (args.includes('--list')) return { code: 0, stdout: 'local\0remote.origin.url\nssh://git@github.com/acme/app.git\0', stderr: '' };
      if (args.includes('--is-shallow-repository')) return { code: 0, stdout: 'false\n', stderr: '' };
      if (args.includes('--symref')) return { code: 0, stdout: `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n`, stderr: '' };
      if (args.includes('--heads')) return { code: 0, stdout: `${sha}\trefs/heads/main\n`, stderr: '' };
      if (args.includes('rev-parse')) return { code: 0, stdout: `${sha}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    try {
      const r = await fetchTaskRefs(
        { worktreePath: 'C:\\w', branch: 'wtask/one', noHooksDir: 'C:\\nh', gitCommonDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git', relayRoot: path.join(root, 'relay'), taskId: 'wtask-1' },
        async () => ({ code: 1, stdout: '', stderr: 'host git' }),
        { platform: 'win32', wslExec: exec },
      );
      expect(r).toMatchObject({ ok: true, defaultBranch: 'main', fetchCommandShell: 'linux', fetched: [{ ref: 'origin/main', sha }], missing: ['origin/wtask/one'] });
      const { fetchCommand, fetchCommandWsl } = r as { fetchCommand: string; fetchCommandWsl?: string };
      expect(fetchCommand).toBe("git fetch --no-tags --no-write-fetch-head '/mnt/c/wmux/relay/wtask-1' '+refs/heads/main:refs/remotes/origin/main'");
      expect(fetchCommandWsl).toBe(fetchCommand);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('relay git: the capability check inside WSL', () => {
  const PROBE = '/tmp/wmux-git-probe.AbCd1234';
  // The argv after `wsl.exe -d <distro> --cd / --exec`, and after a
  // `timeout -k 1 <s>` prefix.
  const cmd = (args: string[]) => (args[5] === 'timeout' ? args.slice(9) : args.slice(5));
  const fakeDistro = (diff: { code: number; stdout: string; stderr: string }) => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const exec: TaskPushExec = async (_file, args, env) => {
      calls.push({ args, env });
      const prog = cmd(args)[0];
      if (prog === 'test') return { code: args.includes('-e') ? 1 : 0, stdout: '', stderr: '' };
      if (prog === 'mktemp') return { code: 0, stdout: `${PROBE}\n`, stderr: '' };
      if (prog === 'stat') return { code: 0, stdout: '2049:1234:3704880:1760000000\n', stderr: '' };
      if (prog === 'rm') return { code: 0, stdout: '', stderr: '' };
      if (prog === 'wslpath') return { code: 0, stdout: '/mnt/c/wmux/relay\n', stderr: '' };
      if (args.includes('--version')) return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (args.includes('--exec-path')) return { code: 0, stdout: '/usr/lib/git-core\n', stderr: '' };
      if (args.includes('write-tree')) return { code: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
      if (args.includes('diff-tree')) return diff;
      if (args.includes('--list')) return { code: 0, stdout: 'local\0remote.origin.url\nssh://git@github.com/acme/app.git\0', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    return { calls, exec };
  };
  const input = (distro: string) => ({
    worktreePath: 'C:\\w', noHooksDir: 'C:\\nh', gitCommonDir: `\\\\wsl.localhost\\${distro}\\home\\me\\repo\\.git`, relayRoot: 'C:\\relay', taskId: 'wtask-1',
  });
  const hostGit: TaskPushGit = async () => ({ code: 1, stdout: '', stderr: 'host git' });

  it('runs in the distro: a temp folder mktemp made there, offline, no system or global config, English, each call bounded, then that folder alone removed; accepted once, then cached', async () => {
    const { calls, exec } = fakeDistro({ code: 128, stdout: '', stderr: 'warning: lazy fetching disabled; some objects may not be available\nfatal: unable to read 1234\n' });
    const r = await openTaskGitRepo(input('ProbeOk'), hostGit, { platform: 'win32', wslExec: exec });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(calls.filter((c) => cmd(c.args)[0] === 'mktemp').map((c) => c.args.slice(0, 5))).toEqual([['-d', 'ProbeOk', '--cd', '/', '--exec']]);
    expect(calls.filter((c) => cmd(c.args)[0] === 'mktemp').map((c) => cmd(c.args))).toEqual([['mktemp', '-d', '/tmp/wmux-git-probe.XXXXXXXX']]);
    expect(calls.filter((c) => cmd(c.args)[0] === 'stat').map((c) => cmd(c.args))).toEqual([['stat', '-L', '-c', '%d:%i:%s:%Y', '--', '/usr/lib/git-core/git']]);
    const probeCalls = calls.filter((c) => cmd(c.args)[0] === 'git' && cmd(c.args)[1] === `--git-dir=${PROBE}`);
    expect(probeCalls.map((c) => c.args.find((a) => ['init', 'update-index', 'write-tree', 'config', 'diff-tree'].includes(a))))
      .toEqual(['init', 'update-index', 'write-tree', 'config', 'config', 'config', 'config', 'diff-tree']);
    expect(probeCalls.find((c) => c.args.includes('remote.probe.url'))?.args.slice(-2)).toEqual(['remote.probe.url', `${PROBE}/missing`]);
    for (const c of probeCalls) {
      expect(c.args.slice(5, 8)).toEqual(['timeout', '-k', '1']);
      expect(Number(c.args[8])).toBeLessThanOrEqual(20);
      expect(c.args).toContain('core.hooksPath=/dev/null');
      expect(c.env).toMatchObject({
        GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C', GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: `${PROBE}/no-system-config`, GIT_CONFIG_GLOBAL: `${PROBE}/no-global-config`,
      });
      expect(String(c.env.WSLENV).split(':')).toEqual(expect.arrayContaining(['GIT_NO_LAZY_FETCH', 'LC_ALL', 'GIT_ALLOW_PROTOCOL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL']));
    }
    expect(calls.filter((c) => cmd(c.args)[0] === 'rm').map((c) => cmd(c.args))).toEqual([['rm', '-r', '-f', '--', PROBE]]);
    // The same distro, git binary and version: no second check.
    const before = calls.length;
    expect(await openTaskGitRepo(input('ProbeOk'), hostGit, { platform: 'win32', wslExec: exec })).toMatchObject({ ok: true });
    expect(calls.slice(before).some((c) => cmd(c.args)[0] === 'mktemp')).toBe(false);
  });

  it('refuses a git that tried to fetch, and still removes its temp folder; a refusal is not cached', async () => {
    const { calls, exec } = fakeDistro({ code: 128, stdout: '', stderr: `fatal: '${PROBE}/missing' does not appear to be a git repository\n` });
    const r = await openTaskGitRepo(input('ProbeBad'), hostGit, { platform: 'win32', wslExec: exec });
    expect(r).toEqual({ ok: false, reason: 'config-refused', error: 'git version 2.43.0 does not honour GIT_NO_LAZY_FETCH' });
    expect(calls.filter((c) => cmd(c.args)[0] === 'rm').map((c) => cmd(c.args))).toEqual([['rm', '-r', '-f', '--', PROBE]]);
    await openTaskGitRepo(input('ProbeBad'), hostGit, { platform: 'win32', wslExec: exec });
    expect(calls.filter((c) => cmd(c.args)[0] === 'mktemp')).toHaveLength(2);
  });
});

describe.skipIf(process.platform === 'win32')('relay git: real git', () => {
  let root: string;
  let origin: string;
  let repo: string;
  let work: string;
  let common: string;
  let wtGitDir: string;
  let other: string;
  let otherOrigin: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-relay-git-')));
    origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    work = path.join(root, 'work');
    other = path.join(root, 'other');
    otherOrigin = path.join(root, 'other-origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', otherOrigin]);
    for (const [dir, remote] of [[repo, origin], [other, otherOrigin]]) {
      execFileSync('git', ['init', '-q', '-b', 'main', dir]);
      fs.writeFileSync(path.join(dir, 'a.txt'), `${dir}\n`);
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'init');
      git(dir, 'remote', 'add', 'origin', remote);
      git(dir, 'push', '-q', 'origin', 'main');
    }
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

  const input = (over: Record<string, unknown> = {}) => ({
    worktreePath: work, branch: 'wtask/one', defaultBranches: [], noHooksDir: path.join(root, 'nh'),
    gitCommonDir: common, gitWorktreeDir: wtGitDir, relayRoot: path.join(root, 'relay'), taskId: 'wtask-1', ...over,
  });

  // A stable, order-independent hash of every file under a directory: its
  // relative path, its lstat kind, and (for a plain file) its bytes.
  const hashTree = (dir: string): string => {
    const out: string[] = [];
    const walk = (d: string, rel: string) => {
      for (const name of fs.readdirSync(d).sort()) {
        const abs = path.join(d, name);
        const r = path.posix.join(rel, name);
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink()) out.push(`L ${r} -> ${fs.readlinkSync(abs)}`);
        else if (st.isDirectory()) { out.push(`D ${r}`); walk(abs, r); }
        else if (st.isFile()) out.push(`F ${r} ${execFileSync('shasum', [abs]).toString().split(' ')[0]}`);
        else out.push(`O ${r}`);
      }
    };
    walk(dir, '');
    return out.join('\n');
  };
  const runFetchLine = (cmd: string) => {
    const m = /^git fetch --no-tags --no-write-fetch-head (['"])(.*?)\1 (.+)$/.exec(cmd)!;
    const refspecs = m[3].split(' ').map((r) => r.replace(/^(['"])(.*)\1$/, '$2'));
    git(work, 'fetch', '--no-tags', m[2], ...refspecs);
  };

  it('tree-hash invariant: push and fetch leave the recorded repository byte-identical, with objects/pack and a reflog leaf symlinked out', async () => {
    // A Codex worker has symlinked objects/pack out and planted a symlinked reflog leaf.
    const extPack = path.join(root, 'ext-pack');
    fs.mkdirSync(extPack);
    fs.rmSync(path.join(common, 'objects', 'pack'), { recursive: true, force: true });
    fs.symlinkSync(extPack, path.join(common, 'objects', 'pack'));
    const extLog = path.join(root, 'ext-log');
    fs.writeFileSync(extLog, 'owner reflog\n');
    fs.mkdirSync(path.join(common, 'logs', 'refs', 'remotes', 'origin'), { recursive: true });
    fs.rmSync(path.join(common, 'logs', 'refs', 'remotes', 'origin', 'main'), { force: true });
    fs.symlinkSync(extLog, path.join(common, 'logs', 'refs', 'remotes', 'origin', 'main'));
    // Another clone of origin moves main so the fetch has real work.
    const mover = path.join(root, 'mover');
    execFileSync('git', ['clone', '-q', origin, mover]);
    fs.writeFileSync(path.join(mover, 'c.txt'), 'c\n');
    git(mover, 'add', '.');
    git(mover, 'commit', '-qm', 'moved');
    git(mover, 'push', '-q', 'origin', 'main');

    // And a loose-object path for an object the fetch will receive, symlinked
    // out to a file with old times.
    const blob = git(mover, 'rev-parse', 'HEAD:c.txt');
    const extObj = path.join(root, 'ext-obj');
    fs.copyFileSync(path.join(mover, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), extObj);
    fs.mkdirSync(path.join(common, 'objects', blob.slice(0, 2)), { recursive: true });
    fs.symlinkSync(extObj, path.join(common, 'objects', blob.slice(0, 2), blob.slice(2)));
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(extObj, old, old);

    const before = hashTree(common);
    const extBefore = fs.readFileSync(extLog, 'utf8');
    const extPackBefore = fs.readdirSync(extPack);

    const pushed = await pushTaskBranch(input(), undefined, FILE_OK);
    expect(pushed).toMatchObject({ ok: true, head: git(work, 'rev-parse', 'HEAD') });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(git(work, 'rev-parse', 'HEAD'));

    const fetched = await fetchTaskRefs(input(), undefined, FILE_OK);
    expect(fetched).toMatchObject({ ok: true });
    expect((fetched as { fetched: Array<{ ref: string; sha: string }> }).fetched).toContainEqual({ ref: 'origin/main', sha: git(mover, 'rev-parse', 'HEAD') });

    // Nothing under the recorded repository changed, and nothing was written
    // through the symlinks.
    expect(hashTree(common)).toBe(before);
    expect(fs.readFileSync(extLog, 'utf8')).toBe(extBefore);
    expect(fs.readdirSync(extPack)).toEqual(extPackBefore);
    // The fetch kept what it received as a pack in the relay: no loose object
    // was written, so none was freshened through the alternate. atime is not
    // asserted: index-pack reads an object it already has through the
    // alternate to compare it with the one received.
    expect(fs.statSync(extObj).mtimeMs).toBe(old.getTime());
    const relayObjects = path.join(root, 'relay', 'wtask-1', 'objects');
    expect(fs.readdirSync(relayObjects).filter((d) => /^[0-9a-f]{2}$/.test(d))).toEqual([]);

    // The worker's fetch line brings the branch in, from the relay.
    runFetchLine((fetched as { fetchCommand: string }).fetchCommand);
    expect(git(work, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(mover, 'rev-parse', 'HEAD'));
  });

  it('a worktree .git changed during the call does not change where the push goes: the recorded origin', async () => {
    const before = hashTree(common);
    // After main reads the recorded config, the worktree's .git is rewritten.
    const hook: TaskPushGit = async (args, cwd, env) => {
      const r = await defaultGit(args, cwd, env);
      if (args.includes('--list')) {
        try { fs.writeFileSync(path.join(work, '.git'), `gitdir: ${path.join(other, '.git', 'worktrees', 'x')}\n`); } catch { /* ignore */ }
      }
      return r;
    };
    const headSha = git(work, 'rev-parse', 'HEAD');
    const pushed = await pushTaskBranch(input(), hook, FILE_OK);
    expect(pushed, JSON.stringify(pushed)).toMatchObject({ ok: true, head: headSha });
    // The push went to the recorded origin, not the one the worktree .git now names.
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/one')).toBe(headSha);
    expect(git(otherOrigin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    expect(hashTree(common)).toBe(before);
  });

  it('config replay: an includeIf gitdir: sshCommand reaches the relay; a reset clears an unconditional one', async () => {
    const marker = path.join(root, 'ssh-ran');
    const prog = path.join(root, 'ssh.sh');
    fs.writeFileSync(prog, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    git(repo, 'remote', 'set-url', 'origin', 'ssh://127.0.0.1:1/o/x');
    const inc = path.join(root, 'work.gitconfig');
    fs.writeFileSync(inc, `[core]\n\tsshCommand = ${prog}\n`);
    fs.writeFileSync(path.join(os.homedir(), '.gitconfig'), `[includeIf "gitdir:${repo}/"]\n\tpath = ${inc}\n`);
    await pushTaskBranch(input());
    expect(fs.existsSync(marker)).toBe(true);

    // Reset: unconditional sshCommand, cleared for the repository by the include.
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(inc, '[core]\n\tsshCommand = \n');
    fs.writeFileSync(path.join(os.homedir(), '.gitconfig'), `[core]\n\tsshCommand = ${prog}\n[includeIf "gitdir:${repo}/"]\n\tpath = ${inc}\n`);
    await fetchTaskRefs(input());
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('the recorded repository keeps its object format; a second fetch transfers nothing, and a shallow repository works', async () => {
    const shallowRepo = path.join(root, 'shallow-repo');
    execFileSync('git', ['clone', '-q', '--depth', '1', '--no-local', origin, shallowRepo]);
    const shallowWt = path.join(root, 'shallow-wt');
    git(shallowRepo, 'worktree', 'add', '-q', '-b', 'wtask/two', shallowWt);
    fs.writeFileSync(path.join(shallowWt, 'w.txt'), 'w\n');
    git(shallowWt, 'add', '.');
    git(shallowWt, 'commit', '-qm', 'work');
    const sCommon = fs.realpathSync.native(path.join(shallowRepo, '.git'));
    const sWt = fs.realpathSync.native(git(shallowWt, 'rev-parse', '--path-format=absolute', '--git-dir'));
    const sInput = { worktreePath: shallowWt, branch: 'wtask/two', defaultBranches: [], noHooksDir: path.join(root, 'nh'), gitCommonDir: sCommon, gitWorktreeDir: sWt, relayRoot: path.join(root, 'relay-s'), taskId: 'wtask-2' };
    const before = hashTree(sCommon);
    expect(await pushTaskBranch(sInput, undefined, FILE_OK)).toMatchObject({ ok: true });
    expect(git(origin, 'rev-parse', 'refs/heads/wtask/two')).toBe(git(shallowWt, 'rev-parse', 'HEAD'));
    expect(await fetchTaskRefs(sInput, undefined, FILE_OK)).toMatchObject({ ok: true });
    const second = await fetchTaskRefs(sInput, undefined, FILE_OK);
    expect(second).toMatchObject({ ok: true });
    expect(hashTree(sCommon)).toBe(before);
  });

  const rowFor = (over: Record<string, unknown> = {}): LedgerEntry => ({
    id: 'wtask-1', taskWorkspaceId: 'ws-t', ownerWorkspaceId: 'ws-o', title: 't', status: 'review_requested', rev: 1, updatedAt: 1,
    dispatch: { origin: { kind: 'operator' }, baseOid: 'a'.repeat(40), gitCommonDir: common, gitWorktreeDir: wtGitDir, ...over },
  }) as LedgerEntry;
  const noChangesPorts = () => liveNoChangesPorts({ rpc: () => null, wmuxDir: () => path.join(root, 'data'), botRepoKey: () => undefined, gitDeps: FILE_OK });

  it('a HEAD that is not a commit id or a plain branch ref is refused: git is never handed it, and the recorded repository is unchanged', async () => {
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/wtask/one^{blob}\n');
    const before = hashTree(common);
    const calls: string[][] = [];
    const spy: TaskPushGit = async (args, cwd, env) => { calls.push(args); return defaultGit(args, cwd, env); };
    expect(await pushTaskBranch(input(), spy, FILE_OK)).toMatchObject({ ok: false, reason: 'git-failed', error: expect.stringContaining('neither a commit id nor a plain branch') });
    expect(await noChangesPorts().headOf(work, rowFor())).toBeNull();
    expect(calls.some((a) => a.some((x) => x.includes('^{blob}')))).toBe(false);
    expect(git(origin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    expect(hashTree(common)).toBe(before);
  });

  it('a partial clone with a missing object is refused before any object is read: nothing is fetched, the recorded repository is unchanged', async () => {
    git(repo, 'config', 'core.repositoryformatversion', '1');
    git(repo, 'config', 'extensions.partialclone', 'origin');
    git(repo, 'config', 'remote.origin.promisor', 'true');
    const blob = git(work, 'rev-parse', 'HEAD:b.txt');
    fs.rmSync(path.join(common, 'objects', blob.slice(0, 2), blob.slice(2)));
    const before = hashTree(common);
    const calls: string[][] = [];
    const spy: TaskPushGit = async (args, cwd, env) => { calls.push(args); return defaultGit(args, cwd, env); };
    expect(await pushTaskBranch(input(), spy, FILE_OK)).toMatchObject({ ok: false, reason: 'config-refused', error: expect.stringContaining('partial clone') });
    expect(await fetchTaskRefs(input(), spy, FILE_OK)).toMatchObject({ ok: false, reason: 'config-refused' });
    const ports = noChangesPorts();
    expect(await ports.headOf(work, rowFor())).toBeNull();
    expect(await ports.branchRef(work, 'wtask/one', rowFor())).toBe('unknown');
    // Only the version and the config list ran: no ref or object was read.
    expect(calls.every((a) => a.includes('--version') || a.includes('--list'))).toBe(true);
    expect(hashTree(common)).toBe(before);
    expect(git(origin, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
  });

  it('worker-writable files are read only as small plain files: a FIFO, a symlink or a large file is refused at once', async () => {
    const fifo = path.join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const t0 = Date.now();
    expect(await readWorkerFile(fifo)).toBeNull();
    fs.symlinkSync(path.join(wtGitDir, 'HEAD'), path.join(root, 'link'));
    expect(await readWorkerFile(path.join(root, 'link'))).toBeNull();
    fs.writeFileSync(path.join(root, 'big'), 'x'.repeat(5000));
    expect(await readWorkerFile(path.join(root, 'big'))).toBeNull();
    expect(await readWorkerFile(path.join(wtGitDir, 'HEAD'))).toBe('ref: refs/heads/wtask/one\n');
    // HEAD and a legacy row's gitdir as FIFOs: refused, promptly.
    fs.rmSync(path.join(wtGitDir, 'HEAD'));
    execFileSync('mkfifo', [path.join(wtGitDir, 'HEAD')]);
    expect(await noChangesPorts().headOf(work, rowFor())).toBeNull();
    expect(await pushTaskBranch(input(), undefined, FILE_OK)).toMatchObject({ ok: false, error: expect.stringContaining('not a small plain file') });
    expect(await recordedTaskGitWorktreeDir({ origin: { kind: 'operator' } }, common, work)).toBe(wtGitDir);
    fs.rmSync(path.join(wtGitDir, 'gitdir'));
    execFileSync('mkfifo', [path.join(wtGitDir, 'gitdir')]);
    expect(await recordedTaskGitWorktreeDir({ origin: { kind: 'operator' } }, common, work)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('a file that turns into a FIFO, a symlink or another file after it was checked is refused on the opened handle', async () => {
    const plain = path.join(root, 'plain');
    fs.writeFileSync(plain, 'x\n');
    const plainStat = await fs.promises.lstat(plain);
    const fifo = path.join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    fs.symlinkSync(plain, path.join(root, 'link'));
    fs.writeFileSync(path.join(root, 'another'), 'y\n');
    // The check saw a plain file; what is opened is not that file.
    const lstat = vi.spyOn(fs.promises, 'lstat').mockResolvedValue(plainStat);
    try {
      const t0 = Date.now();
      // Opened without blocking, then refused by its type.
      expect(await readWorkerFile(fifo)).toBeNull();
      // Not followed.
      expect(await readWorkerFile(path.join(root, 'link'))).toBeNull();
      // Another file than the one checked.
      expect(await readWorkerFile(path.join(root, 'another'))).toBeNull();
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      lstat.mockRestore();
    }
    // Grown past the cap after the check.
    const grown = path.join(root, 'grown');
    fs.writeFileSync(grown, 'x');
    const small = await fs.promises.lstat(grown);
    fs.writeFileSync(grown, 'x'.repeat(5000));
    const again = vi.spyOn(fs.promises, 'lstat').mockResolvedValue(small);
    try {
      expect(await readWorkerFile(grown)).toBeNull();
    } finally {
      again.mockRestore();
    }
  });

  it('a shallow list that is not a small plain file is refused before git reads it', async () => {
    const calls: string[][] = [];
    const spy: TaskPushGit = async (args, cwd, env) => { calls.push(args); return defaultGit(args, cwd, env); };
    const shallow = path.join(common, 'shallow');
    execFileSync('mkfifo', [shallow]);
    const t0 = Date.now();
    expect(await pushTaskBranch(input(), spy, FILE_OK)).toMatchObject({ ok: false, reason: 'config-refused', error: expect.stringContaining('shallow list') });
    fs.rmSync(shallow);
    fs.writeFileSync(path.join(root, 'elsewhere'), `${'a'.repeat(40)}\n`);
    fs.symlinkSync(path.join(root, 'elsewhere'), shallow);
    expect(await fetchTaskRefs(input(), spy, FILE_OK)).toMatchObject({ ok: false, reason: 'config-refused', error: expect.stringContaining('shallow list') });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(calls.every((a) => a.includes('--version') || a.includes('--list'))).toBe(true);
  });

  it('a git below the known versions runs the capability check with the same git: accepted, its temp folder removed, then cached', async () => {
    const version = `git version 2.43.0 (wmux test ${process.pid})`;
    const probeDirs = new Set<string>();
    let diffTree: { code: number; stderr: string } | undefined;
    const spy: TaskPushGit = async (args, cwd, env) => {
      if (args[0] === '--version') return { code: 0, stdout: `${version}\n`, stderr: '' };
      const dir = args.find((a) => a.startsWith('--git-dir=') && a.includes('wmux-git-probe-'));
      if (dir) probeDirs.add(dir.slice('--git-dir='.length));
      const r = await defaultGit(args, cwd, env);
      if (dir && args.includes('diff-tree')) diffTree = r;
      return r;
    };
    expect(await pushTaskBranch(input(), spy, FILE_OK)).toMatchObject({ ok: true });
    expect(diffTree?.code).toBe(128);
    expect(diffTree?.stderr).toContain('lazy fetching disabled');
    expect(probeDirs.size).toBe(1);
    for (const d of probeDirs) expect(fs.existsSync(d)).toBe(false);
    // Cached for this git and version: the next call runs no check.
    probeDirs.clear();
    expect(await fetchTaskRefs(input(), spy, FILE_OK)).toMatchObject({ ok: true });
    expect(probeDirs.size).toBe(0);
  });

  it('never sets GIT_CONFIG_NOSYSTEM on any call, and sets GIT_NO_LAZY_FETCH on every one', async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const spy: TaskPushGit = async (args, cwd, env) => { envs.push(env); return defaultGit(args, cwd, env); };
    expect(await pushTaskBranch(input(), spy, FILE_OK)).toMatchObject({ ok: true });
    expect(await fetchTaskRefs(input(), spy, FILE_OK)).toMatchObject({ ok: true });
    const ports = liveNoChangesPorts({ rpc: () => null, git: spy, wmuxDir: () => path.join(root, 'data'), botRepoKey: () => undefined, botRepoPath: () => repo, gitDeps: FILE_OK });
    expect(await ports.headOf(work, rowFor())).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(await ports.branchRef(work, 'wtask/one', rowFor())).toBe(git(work, 'rev-parse', 'HEAD'));
    expect(await ports.remoteHead(rowFor(), { worktreePath: work, branch: 'wtask/one' })).toMatchObject({ ok: true });
    // A legacy row: the repository found from the bot's folder.
    expect(await recordedTaskGitCommonDir({ origin: { kind: 'bot', botId: 'b1' } }, () => repo, spy)).toBe(common);
    expect(envs.length).toBeGreaterThan(10);
    expect(envs.some((e) => e && 'GIT_CONFIG_NOSYSTEM' in e)).toBe(false);
    expect(envs.some((e) => e && 'GIT_CONFIG_GLOBAL' in e)).toBe(false);
    // Every call runs with GIT_NO_LAZY_FETCH.
    expect(envs.every((e) => e?.GIT_NO_LAZY_FETCH === '1')).toBe(true);
  });
});

// The ship button's failures in plain words: which git output is which cause,
// the one-commit unsigned retry, and a signer that wants a passphrase typed
// failing at once instead of waiting out the timeout. The samples are git's
// real output, produced with real git (local bare remotes, a pre-receive hook,
// a passphrase-protected ssh signing key) or copied as the hosts word them.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { ipcMain } from 'electron';
import { ShipActions, classifyShipFailure, shipActions, signerAskEnv, spawnRun } from '../shipActions';
import { setSecretGuardEnabled } from '../secretGuardSetting';
import { registerGitShipHandlers } from '../../ipc/handlers/gitShip.handler';
import { IPC } from '../../../shared/constants';

const posix = process.platform !== 'win32';

/** The OpenSSH version a command prints (`ssh -V` writes it to stderr), or null when it cannot run. */
function opensshVersion(cmd: string, args: string[]): [number, number] | null {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  const m = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
/** SSH_ASKPASS_REQUIRE is OpenSSH 8.4+. */
const forcesAskpass = (v: [number, number] | null) => v !== null && (v[0] > 8 || (v[0] === 8 && v[1] >= 4));
const keygenOnPath = spawnSync('ssh-keygen', ['-?'], { windowsHide: true, timeout: 15_000 }).error === undefined;
/** The ssh on PATH, and the one git itself finds (on Windows, Git for Windows' own). */
const pathSsh = opensshVersion('ssh', ['-V']);
const gitSsh = opensshVersion('git', ['-c', 'alias.wmuxsshv=!ssh -V', 'wmuxsshv']);
/** `gpg.format=ssh` is git 2.34+. */
const gitSignsWithSsh = (() => {
  const m = /git version (\d+)\.(\d+)/.exec(spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).stdout ?? '');
  return m !== null && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 34));
})();

/** A passphrase-protected ed25519 key in `dir`, in no agent. */
function passphraseKey(dir: string): string {
  const key = path.join(dir, 'signing-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'wmux-test-passphrase', '-C', 'wmux-test', '-f', key], { stdio: 'ignore', windowsHide: true });
  return key;
}

/** git's own output, as real git prints it (paths shortened). */
const SAMPLES = {
  // A pre-receive hook on a local bare remote that words it as GitHub does.
  protectedGithub: [
    'remote: GH006: Protected branch update failed for refs/heads/main.        ',
    'remote: Changes must be made through a pull request.        ',
    'To ../remote.git',
    ' ! [remote rejected] HEAD -> main (pre-receive hook declined)',
    "error: failed to push some refs to '../remote.git'",
  ].join('\n'),
  protectedGitlab: [
    'remote: GitLab: You are not allowed to push code to protected branches on this project.',
    'To gitlab.com:o/r.git',
    ' ! [remote rejected] main -> main (pre-receive hook declined)',
    "error: failed to push some refs to 'gitlab.com:o/r.git'",
  ].join('\n'),
  fetchFirst: [
    'To /tmp/r2.git',
    ' ! [rejected]        d35701baf2858eb6c404cdc0d3197ddac02ed4f4 -> main (fetch first)',
    "error: failed to push some refs to '/tmp/r2.git'",
    'hint: Updates were rejected because the remote contains work that you do not',
    'hint: have locally. This is usually caused by another repository pushing to',
    "hint: the same ref. If you want to integrate the remote changes, use",
    "hint: 'git pull' before pushing again.",
  ].join('\n'),
  nonFastForward: [
    'To /tmp/r2.git',
    ' ! [rejected]        HEAD -> main (non-fast-forward)',
    "error: failed to push some refs to '/tmp/r2.git'",
    'hint: Updates were rejected because the tip of your current branch is behind',
    'hint: its remote counterpart. If you want to integrate the remote changes,',
    "hint: use 'git pull' before pushing again.",
  ].join('\n'),
  publickey: [
    'git@github.com: Permission denied (publickey).',
    'fatal: Could not read from remote repository.',
    '',
    'Please make sure you have the correct access rights',
    'and the repository exists.',
  ].join('\n'),
  httpsNoPrompt: "fatal: could not read Username for 'http://127.0.0.1:53821': terminal prompts disabled",
  httpsRefused: "fatal: Authentication failed for 'http://127.0.0.1:53826/o/r.git/'",
  ghSignedOut: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
  gpgFailed: 'error: gpg failed to sign the data:\ngpg: signing failed: Inappropriate ioctl for device\n\nfatal: failed to write commit object',
  sshNoKey: "error: Couldn't load public key /tmp/nokey: No such file or directory?\n\nfatal: failed to write commit object",
  sshPassphrase: 'error: Enter passphrase for "/tmp/pk": Load key "/tmp/pk": incorrect passphrase supplied to decrypt private key?\n\nfatal: failed to write commit object',
};

describe('classifyShipFailure (real git output)', () => {
  it('names a protected branch, GitHub or GitLab wording', () => {
    expect(classifyShipFailure('push', SAMPLES.protectedGithub)).toBe('protected');
    expect(classifyShipFailure('push', SAMPLES.protectedGitlab)).toBe('protected');
  });

  it('names a remote with new commits, fetched or not', () => {
    expect(classifyShipFailure('push', SAMPLES.fetchFirst)).toBe('remote-ahead');
    expect(classifyShipFailure('push', SAMPLES.nonFastForward)).toBe('remote-ahead');
  });

  it('names a refused key or sign-in, ssh or https, and gh signed out', () => {
    expect(classifyShipFailure('push', SAMPLES.publickey)).toBe('auth');
    expect(classifyShipFailure('push', SAMPLES.httpsNoPrompt)).toBe('auth');
    expect(classifyShipFailure('push', SAMPLES.httpsRefused)).toBe('auth');
    expect(classifyShipFailure('createPr', SAMPLES.ghSignedOut)).toBe('auth');
  });

  it('names a signing failure, gpg or ssh', () => {
    expect(classifyShipFailure('commit', SAMPLES.gpgFailed)).toBe('signing');
    expect(classifyShipFailure('commit', SAMPLES.sshNoKey)).toBe('signing');
    expect(classifyShipFailure('commit', SAMPLES.sshPassphrase)).toBe('signing');
  });

  it('names Windows signer failures only alongside the failed commit write', () => {
    // Git for Windows with OpenSSH: ssh-keygen missing from its configured path, and a key file Windows lets others read.
    const cannotSpawn = 'error: cannot spawn C:/Program Files/OpenSSH/ssh-keygen.exe: No such file or directory\n\nfatal: failed to write commit object';
    const unprotected = [
      'error: @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
      '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @',
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
      "Permissions for 'C:\\Users\\me\\.ssh\\id_ed25519' are too open.",
      'It is required that your private key files are NOT accessible by others.',
      'This private key will be ignored.',
      'No private key found for "C:\\Users\\me\\.ssh\\id_ed25519"?',
      '',
      'fatal: failed to write commit object',
    ].join('\n');
    expect(classifyShipFailure('commit', cannotSpawn)).toBe('signing');
    expect(classifyShipFailure('commit', unprotected)).toBe('signing');
    // The same words from a hook, with the commit not refused for them, name nothing.
    expect(classifyShipFailure('commit', 'error: cannot spawn C:/Program Files/OpenSSH/ssh-keygen.exe: No such file or directory')).toBeNull();
    expect(classifyShipFailure('commit', 'WARNING: UNPROTECTED PRIVATE KEY FILE!\nNo private key found for "x"')).toBeNull();
  });

  it('leaves anything else unnamed', () => {
    // Any hook says "pre-receive hook declined"; a full disk also fails to write the commit object.
    expect(classifyShipFailure('push', ' ! [remote rejected] HEAD -> main (pre-receive hook declined)')).toBeNull();
    expect(classifyShipFailure('commit', 'error: insufficient permission\nfatal: failed to write commit object')).toBeNull();
    expect(classifyShipFailure('commit', 'error: pathspec did not match')).toBeNull();
  });
});

type Call = { args: string[] };
const HEAD = 'a'.repeat(40);
const EXPECT = { branch: 'feat/x', head: HEAD };

/** A fake git on `feat/x` at HEAD; `rest` answers everything else. */
function fake(rest: (args: string[]) => string | Error) {
  const calls: Call[] = [];
  const run = vi.fn(async (_cmd: string, args: string[]) => {
    calls.push({ args });
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${HEAD}\n` };
    if (args[0] === 'symbolic-ref' && args[1] === '-q') return { stdout: 'feat/x\n' };
    const r = rest(args);
    if (r instanceof Error) throw r;
    return { stdout: r };
  });
  return { svc: new ShipActions(run as never, async () => null, () => undefined, () => 1, () => true, () => async () => true), calls };
}

describe('commit once without signing', () => {
  it('passes -c commit.gpgsign=false only on the call that asks, before the subcommand', async () => {
    const { svc, calls } = fake(() => '');
    expect(await svc.commit('/repo', 'msg', EXPECT)).toEqual({ ok: true });
    expect(await svc.commit('/repo', 'msg', EXPECT, { noSign: true })).toEqual({ ok: true });
    expect(await svc.commit('/repo', 'msg', EXPECT)).toEqual({ ok: true });
    const commits = calls.filter((c) => c.args.includes('commit')).map((c) => c.args);
    expect(commits).toEqual([
      ['commit', '-m', 'msg'],
      ['-c', 'commit.gpgsign=false', 'commit', '-m', 'msg'],
      ['commit', '-m', 'msg'],
    ]);
    // Never a write to the user's config.
    expect(calls.some((c) => c.args[0] === 'config' && !c.args.includes('--get'))).toBe(false);
  });

  it('a commit that timed out with no signer words is a timeout, not signing (a slow hook takes as long)', async () => {
    const { svc, calls } = fake((args) => {
      if (args[0] === 'commit') return Object.assign(new Error('git commit timed out and was stopped'), { killed: true, timedOut: true, stderr: 'running the pre-commit checks…\n' });
      if (args[0] === 'config' && args.includes('commit.gpgsign')) return 'true\n';
      return '';
    });
    const res = await svc.commit('/repo', 'msg', EXPECT);
    expect(res).toMatchObject({ ok: false, reason: 'timeout' });
    // Whether signing is on says nothing about what took the time.
    expect(calls.some((c) => c.args.includes('commit.gpgsign'))).toBe(false);
  });

  it('a commit that timed out after the signer spoke is signing', async () => {
    const { svc } = fake((args) => {
      if (args[0] === 'commit') return Object.assign(new Error('git commit timed out and was stopped'), { killed: true, timedOut: true, stderr: 'gpg: signing failed: Timeout\n' });
      return '';
    });
    expect(await svc.commit('/repo', 'msg', EXPECT)).toMatchObject({ ok: false, reason: 'signing' });
  });

  it('output stopped for size is not a timeout', async () => {
    const { svc } = fake((args) => {
      if (args[0] === 'commit') return Object.assign(new Error('git commit printed too much and was stopped'), { killed: true, timedOut: false, stderr: 'x' });
      return '';
    });
    const res = await svc.commit('/repo', 'msg', EXPECT);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBeUndefined();
  });

  it('git runs with untranslated messages but the user\'s own locale otherwise', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const run = vi.fn(async (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      envs.push(opts.env);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${HEAD}\n` };
      if (args[0] === 'symbolic-ref') return { stdout: 'feat/x\n' };
      return { stdout: '' };
    });
    const before = process.env.LC_ALL;
    process.env.LC_ALL = 'ko_KR.UTF-8';
    try {
      const svc = new ShipActions(run as never, async () => null, () => undefined, () => 1, () => true, () => async () => true);
      await svc.commit('/repo', 'msg', EXPECT);
    } finally {
      if (before === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = before;
    }
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(env.LANGUAGE).toBe('C');
      expect(env.LC_MESSAGES).toBe('C');
    }
  });

  it('the commit runs its signer with askpass forced, so a passphrase cannot be asked on a hidden console', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run = vi.fn(async (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: opts.env });
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${HEAD}\n` };
      if (args[0] === 'symbolic-ref') return { stdout: 'feat/x\n' };
      return { stdout: '' };
    });
    const svc = new ShipActions(run as never, async () => null, () => undefined, () => 1, () => true, () => async () => true);
    // Both commit paths: through the secret guard's index copy, and without it.
    for (const guard of [true, false]) {
      setSecretGuardEnabled(guard);
      calls.length = 0;
      try {
        await svc.commit('/repo', 'msg', EXPECT);
      } finally {
        setSecretGuardEnabled(true);
      }
      const commit = calls.find((c) => c.args.includes('commit'));
      expect(commit?.env.SSH_ASKPASS_REQUIRE).toBe('force');
      expect(commit?.env.SSH_ASKPASS).toBeTruthy();
      // Only a call that can run a signer gets it; nothing else is changed.
      for (const c of calls.filter((x) => !x.args.includes('commit'))) expect(c.env.SSH_ASKPASS_REQUIRE).toBeUndefined();
    }
    // A push signs too (push.gpgSign), and ssh's own questions on it fail at once as well.
    const pushCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const pushRun = vi.fn(async (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      pushCalls.push({ args, env: opts.env });
      if (args[0] === 'config') return { stdout: args[2].endsWith('.remote') ? 'origin\n' : 'refs/heads/feat/x\n' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${HEAD}\n` };
      if (args[0] === 'symbolic-ref') return { stdout: 'feat/x\n' };
      return { stdout: '' };
    });
    await new ShipActions(pushRun as never, async () => null, () => undefined, () => 1, () => true, () => async () => true).push('/repo', EXPECT);
    const push = pushCalls.find((c) => c.args[0] === 'push');
    expect(push?.env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force', GIT_TERMINAL_PROMPT: '0' });
    for (const c of pushCalls.filter((x) => x.args[0] !== 'push')) expect(c.env.SSH_ASKPASS_REQUIRE).toBeUndefined();
    // No askpass of the user's: one that always fails. A user's own (a GUI one) is kept, and now always used.
    expect(signerAskEnv({})).toEqual({ SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: 'false' });
    expect(signerAskEnv({ SSH_ASKPASS: '/opt/bin/ssh-askpass-gui' })).toEqual({ SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: '/opt/bin/ssh-askpass-gui' });
  });
});

describe('auth failures name the forge from the remote', () => {
  it('a github.com remote → github', async () => {
    const { svc } = fake((args) => {
      if (args[0] === 'config') return args[2].endsWith('.remote') ? 'origin' : 'refs/heads/feat/x';
      if (args[0] === 'remote') return 'git@github.com:o/r.git\n';
      if (args[0] === 'push') return Object.assign(new Error('x'), { stderr: SAMPLES.publickey });
      return '';
    });
    expect(await svc.push('/repo', EXPECT)).toMatchObject({ ok: false, reason: 'auth', forge: 'github' });
  });
});

describe('spawnRun: no terminal to wait on', () => {
  // Every platform: a timeout settles the run even while a grandchild holds
  // its pipes, and that grandchild dies with the tree.
  it('a timeout ends the run and the whole tree, a pipe-holding grandchild included', async () => {
    const script = [
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });",
      'process.stdout.write(String(c.pid) + "\\n");',
      'setTimeout(() => {}, 30000);',
    ].join(' ');
    const t0 = Date.now();
    const err = await spawnRun(process.execPath, ['-e', script], { cwd: os.tmpdir(), env: process.env, timeout: 1_000 }).catch((e) => e);
    // Settled by its own timeout path (the grandchild would hold the pipes for 30 s).
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(err).toMatchObject({ killed: true, timedOut: true });
    const pid = Number(String(err.stdout).trim());
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
  }, 15_000);

  // Every platform: a signer started by git (a grandchild) that would read a
  // console nobody sees asks the forced askpass instead, which gives it no
  // passphrase, so it fails at once with words the commit names as signing.
  // The fake keeps OpenSSH's rule: SSH_ASKPASS_REQUIRE=force runs SSH_ASKPASS,
  // and an askpass that fails or cannot start means no passphrase.
  it('a signer that wants a passphrase fails at once under the commit\'s env, never waits out the timeout', async () => {
    const signer = [
      "const { spawnSync } = require('child_process');",
      "if (process.env.SSH_ASKPASS_REQUIRE === 'force' && process.env.SSH_ASKPASS) {",
      "  const r = spawnSync(process.env.SSH_ASKPASS, ['Enter passphrase for \"/k\":'], { stdio: ['ignore', 'pipe', 'ignore'] });",
      '  if (r.status === 0 && String(r.stdout).trim()) process.exit(0);',
      "  process.stderr.write('Load key \"/k\": incorrect passphrase supplied to decrypt private key\\n');",
      '  process.exit(255);',
      '}',
      'setTimeout(() => {}, 30000);',
    ].join('\n');
    const git = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(signer)}], { stdio: 'inherit' }); c.on('exit', (code) => process.exit(code ?? 1));`;
    const env = { ...process.env, ...signerAskEnv({}) };
    const t0 = Date.now();
    const err = await spawnRun(process.execPath, ['-e', git], { cwd: os.tmpdir(), env, timeout: 10_000 }).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(err).toMatchObject({ killed: false, code: 255 });
    expect(err.timedOut).toBeUndefined();
    expect(classifyShipFailure('commit', String(err.stderr))).toBe('signing');
    // Without it, the same signer waits on the console until the timeout
    // (whatever askpass the shell that runs the tests exports).
    const plain = { ...process.env };
    delete plain.SSH_ASKPASS;
    delete plain.SSH_ASKPASS_REQUIRE;
    delete plain.DISPLAY;
    const waited = await spawnRun(process.execPath, ['-e', git], { cwd: os.tmpdir(), env: plain, timeout: 500 }).catch((e) => e);
    expect(waited).toMatchObject({ timedOut: true });
  }, 15_000);

  // The real thing on every OS whose ssh-keygen honours the force (8.4+): a
  // passphrase key in no agent, signed under the commit's env, gets no
  // passphrase from the `false` askpass (or from one that cannot start) and
  // fails at once with the words the commit names as signing.
  it.skipIf(!keygenOnPath || !forcesAskpass(pathSsh))('real ssh-keygen -Y sign with a passphrase key fails at once under the commit\'s env', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wmux-realsign-'));
    try {
      const key = passphraseKey(dir);
      const file = path.join(dir, 'payload');
      writeFileSync(file, 'payload');
      const env = { ...process.env, ...signerAskEnv({}) };
      delete env.SSH_AUTH_SOCK;
      const t0 = Date.now();
      const err = await spawnRun('ssh-keygen', ['-Y', 'sign', '-n', 'git', '-f', key, file], { cwd: dir, env, timeout: 30_000 }).catch((e) => e);
      const stderr = String(err?.stderr ?? '');
      expect(Date.now() - t0, stderr).toBeLessThan(5_000);
      expect(err, 'ssh-keygen signed without a passphrase').toBeInstanceOf(Error);
      expect(err.timedOut).toBeUndefined();
      expect(err.code).not.toBe(0);
      expect(classifyShipFailure('commit', stderr), stderr).toBe('signing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it.skipIf(!posix)('stdin is empty, the child leads its own group, GPG_TTY is dropped', async () => {
    const script = 'read x; echo "read=$?"; echo "pgid=$(ps -o pgid= -p $$ | tr -d " ")"; echo "pid=$$"; echo "tty=${GPG_TTY:-none}"';
    const t0 = Date.now();
    const { stdout } = await spawnRun('sh', ['-c', script], { cwd: os.tmpdir(), env: { ...process.env, GPG_TTY: '/dev/ttys999' }, timeout: 10_000 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    const v = Object.fromEntries(stdout.trim().split('\n').map((l) => l.split('=')));
    expect(v.read).toBe('1');
    expect(v.pgid).toBe(v.pid);
    expect(v.tty).toBe('none');
  });

  it.skipIf(!posix)('a timeout kills the whole group, grandchildren included', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wmux-spawnrun-'));
    try {
      const pidFile = path.join(dir, 'pid');
      const err = await spawnRun('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], { cwd: dir, env: process.env, timeout: 300 }).catch((e) => e);
      expect(err).toMatchObject({ killed: true });
      const pid = Number(execFileSync('cat', [pidFile], { encoding: 'utf8' }).trim());
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('against real git', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tmp = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'wmux-shipfail-'));
    dirs.push(d);
    return d;
  };
  /** A clone of a fresh bare remote with one pushed commit on `branch`, tracking it. */
  const repo = (root: string, branch = 'main') => {
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    g(root, 'init', '-q', '--bare', '-b', 'main', origin);
    g(root, 'clone', '-q', origin, work);
    g(work, 'config', 'user.email', 'ship@example.invalid');
    g(work, 'config', 'user.name', 'ship');
    g(work, 'config', 'commit.gpgsign', 'false');
    g(work, 'switch', '-qc', branch);
    writeFileSync(path.join(work, 'a.txt'), 'a');
    g(work, 'add', '-A');
    g(work, 'commit', '-qm', 'init');
    g(work, 'push', '-q', '-u', 'origin', branch);
    return { origin, work };
  };
  const commitLocal = (work: string, file: string) => {
    writeFileSync(path.join(work, file), file);
    g(work, 'add', '-A');
    g(work, 'commit', '-qm', file);
    return { branch: g(work, 'symbolic-ref', '--short', 'HEAD'), head: g(work, 'rev-parse', 'HEAD') };
  };

  it.skipIf(!posix)('a pre-receive hook that refuses a protected branch → protected', async () => {
    const { origin, work } = repo(tmp(), 'feat/x');
    const hook = path.join(origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "GH006: Protected branch update failed for refs/heads/feat/x." >&2\necho "Changes must be made through a pull request." >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const res = await new ShipActions().push(work, commitLocal(work, 'b.txt'));
    expect(res).toMatchObject({ ok: false, reason: 'protected' });
    expect(!res.ok && res.error).toContain('GH006');
  }, 30_000);

  it('the remote moved on → remote-ahead', async () => {
    const root = tmp();
    const { origin, work } = repo(root, 'feat/x');
    const other = path.join(root, 'other');
    g(root, 'clone', '-q', '-b', 'feat/x', origin, other);
    g(other, 'config', 'user.email', 'o@example.invalid');
    g(other, 'config', 'user.name', 'o');
    g(other, 'config', 'commit.gpgsign', 'false');
    commitLocal(other, 'o.txt');
    g(other, 'push', '-q', 'origin', 'feat/x');
    const res = await new ShipActions().push(work, commitLocal(work, 'w.txt'));
    expect(res).toMatchObject({ ok: false, reason: 'remote-ahead' });
  }, 30_000);

  it.skipIf(!posix)('ssh refusing the key on a github.com remote → auth, github', async () => {
    const root = tmp();
    const { work } = repo(root, 'feat/x');
    const ssh = path.join(root, 'fake-ssh');
    writeFileSync(ssh, '#!/bin/sh\necho "git@github.com: Permission denied (publickey)." >&2\nexit 255\n');
    chmodSync(ssh, 0o755);
    g(work, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
    g(work, 'config', 'core.sshCommand', ssh);
    const res = await new ShipActions().push(work, commitLocal(work, 'k.txt'));
    expect(res).toMatchObject({ ok: false, reason: 'auth', forge: 'github' });
  }, 30_000);

  it.skipIf(!posix)('a failing signer → signing; once without signing commits unsigned and leaves the config on', async () => {
    const root = tmp();
    const { work } = repo(root);
    const gpg = path.join(root, 'fake-gpg');
    writeFileSync(gpg, '#!/bin/sh\ncat >/dev/null\necho "gpg: signing failed: No pinentry" >&2\nexit 2\n');
    chmodSync(gpg, 0o755);
    g(work, 'config', 'commit.gpgsign', 'true');
    g(work, 'config', 'gpg.program', gpg);
    writeFileSync(path.join(work, 'c.txt'), 'c');
    const pin = { branch: 'main', head: g(work, 'rev-parse', 'HEAD') };
    const svc = new ShipActions();
    expect(await svc.commit(work, 'signed?', pin)).toMatchObject({ ok: false, reason: 'signing' });
    expect(await svc.commit(work, 'unsigned once', pin, { noSign: true })).toEqual({ ok: true });
    expect(g(work, 'log', '-1', '--format=%s')).toBe('unsigned once');
    expect(g(work, 'cat-file', 'commit', 'HEAD')).not.toContain('gpgsig');
    expect(g(work, 'config', '--get', 'commit.gpgsign')).toBe('true');
  }, 30_000);

  it.skipIf(!posix)('an ssh signing key that wants its passphrase typed fails at once, leaving no signer behind', async () => {
    const root = tmp();
    const { work } = repo(root);
    const key = path.join(root, 'signing-key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'a passphrase nobody types', '-C', '', '-f', key], { stdio: 'ignore' });
    g(work, 'config', 'commit.gpgsign', 'true');
    g(work, 'config', 'gpg.format', 'ssh');
    g(work, 'config', 'user.signingkey', key);
    writeFileSync(path.join(work, 'p.txt'), 'p');
    const pin = { branch: 'main', head: g(work, 'rev-parse', 'HEAD') };
    const t0 = Date.now();
    const res = await new ShipActions().commit(work, 'msg', pin);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(res).toMatchObject({ ok: false, reason: 'signing' });
    const left = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(key));
    expect(left).toEqual([]);
  }, 30_000);

  // Every OS whose git-found OpenSSH honours the force. On Windows this is
  // the hidden-console case: PATH git is Git for Windows' cmd\git.exe
  // launcher and the signer is its bundled ssh-keygen, which used to wait
  // out the 60 s timeout for a passphrase.
  it.skipIf(!keygenOnPath || !gitSignsWithSsh || !forcesAskpass(gitSsh))('a commit signed by the ssh-keygen git finds, with a passphrase key, fails at once as signing', async () => {
    const root = tmp();
    const { work } = repo(root);
    const key = passphraseKey(root);
    g(work, 'config', 'commit.gpgsign', 'true');
    g(work, 'config', 'gpg.format', 'ssh');
    g(work, 'config', 'gpg.ssh.program', 'ssh-keygen');
    g(work, 'config', 'user.signingkey', key);
    writeFileSync(path.join(work, 'w.txt'), 'w');
    const pin = { branch: 'main', head: g(work, 'rev-parse', 'HEAD') };
    const t0 = Date.now();
    const res = await new ShipActions().commit(work, 'msg', pin);
    const tookMs = Date.now() - t0;
    // The cause first: a signer that waited for the passphrase would end as a
    // timeout (or a hang) instead, and this names which one it was.
    expect(res, `after ${tookMs} ms`).toMatchObject({ ok: false, reason: 'signing' });
    // "At once" is before the product would have stopped it: ShipActions' git
    // runs under a 30 s timeout (its private default), so a signer waiting on
    // the prompt would take at least that long.
    expect(tookMs, JSON.stringify(res)).toBeLessThan(30_000);
  }, 90_000);

  it('a folder moved away → missing-folder, for the status and for a commit', async () => {
    const root = tmp();
    const { work } = repo(root);
    writeFileSync(path.join(work, 'm.txt'), 'm');
    const pin = { branch: 'main', head: g(work, 'rev-parse', 'HEAD') };
    const moved = path.join(root, 'moved');
    mkdirSync(moved);
    renameSync(work, path.join(moved, 'work'));
    expect(existsSync(work)).toBe(false);
    const svc = new ShipActions();
    expect(await svc.status(work)).toMatchObject({ ok: false, reason: 'missing-folder' });
    expect(await svc.commit(work, 'msg', pin)).toMatchObject({ ok: false, reason: 'missing-folder' });
    expect(await svc.push(work, pin)).toMatchObject({ ok: false, reason: 'missing-folder' });
  }, 30_000);
});

describe('the IPC handler', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** The handler registered for `channel`. */
  const handlerFor = (channel: string) => {
    registerGitShipHandlers();
    const hit = vi.mocked(ipcMain.handle).mock.calls.filter(([c]) => c === channel).pop();
    if (!hit) throw new Error(`no handler for ${channel}`);
    return hit[1] as (...args: unknown[]) => Promise<unknown>;
  };

  it('a repo path whose folder is gone → missing-folder, before any git runs', async () => {
    const gone = path.join(os.tmpdir(), `wmux-shipfail-gone-${process.pid}-${Date.now()}`);
    expect(await handlerFor(IPC.GIT_SHIP_STATUS)({}, gone)).toMatchObject({ ok: false, reason: 'missing-folder' });
    expect(await handlerFor(IPC.GIT_SHIP_COMMIT)({}, gone, 'msg', EXPECT)).toMatchObject({ ok: false, reason: 'missing-folder' });
    expect(await handlerFor(IPC.GIT_SHIP_PUSH)({}, gone, EXPECT)).toMatchObject({ ok: false, reason: 'missing-folder' });
 
    // A path wmux refuses gets one answer, whether or not it exists.
    const home = mkdtempSync(path.join(os.tmpdir(), 'wmux-shipfail-home-'));
    dirs.push(home);
    mkdirSync(path.join(home, '.ssh', 'there'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const there = await handlerFor(IPC.GIT_SHIP_STATUS)({}, path.join(home, '.ssh', 'there'));
    const absent = await handlerFor(IPC.GIT_SHIP_STATUS)({}, path.join(home, '.ssh', 'absent'));
    expect(there).toEqual({ ok: false, error: 'repoPath required' });
    expect(absent).toEqual(there);
    // A network path is never looked up on disk, so it is never called missing.
    expect(await handlerFor(IPC.GIT_SHIP_STATUS)({}, '\\\\server\\share\\repo')).toEqual({ ok: false, error: 'repoPath required' });
  });

  it('commits unsigned only when that call says noSign: true', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wmux-shipfail-ipc-'));
    dirs.push(root);
    const work = path.join(root, 'work');
    const g = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    mkdirSync(work);
    g('init', '-q', '-b', 'feat/x');
    g('config', 'user.email', 'ship@example.invalid');
    g('config', 'user.name', 'ship');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(work, 'a.txt'), 'a');
    g('add', '-A');
    g('commit', '-qm', 'init');
    writeFileSync(path.join(work, 'b.txt'), 'b');
    const pin = { branch: 'feat/x', head: g('rev-parse', 'HEAD') };
    const commit = vi.spyOn(shipActions, 'commit').mockResolvedValue({ ok: true });
    const handler = handlerFor(IPC.GIT_SHIP_COMMIT);
    await handler({}, work, 'msg', pin);
    await handler({}, work, 'msg', pin, { noSign: 'yes' });
    await handler({}, work, 'msg', pin, { noSign: true });
    expect(commit.mock.calls.map((c) => c[3])).toEqual([{}, {}, { noSign: true }]);
  }, 30_000);
});

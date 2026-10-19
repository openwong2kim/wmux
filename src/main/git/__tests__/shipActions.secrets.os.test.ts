// The Git page's commit / push / PR refuse a change that carries a secret
// file or a key-shaped value — against a real git repository.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { ShipActions } from '../shipActions';
import { spawnGitLines, type GitLines } from '../secretScan';
import { setSecretGuardEnabled } from '../secretGuardSetting';

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n';
let dir: string;
let remote: string;
let repo: string;
let gh: ReturnType<typeof vi.fn<(args: string[]) => Promise<{ stdout: string }>>>;
let svc: ShipActions;
/** The secret check's git reads; tests swap in a failing or racing one. */
let lines: (cwd: string, env?: NodeJS.ProcessEnv) => GitLines;
/** Makes the real index's catch-up reset fail, as an index.lock would. */
let failReset = false;

const write = (rel: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const commitAll = (msg: string) => {
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', msg], repo);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ship-secrets-'));
  remote = path.join(dir, 'remote.git');
  repo = path.join(dir, 'repo');
  git(['init', '-q', '--bare', '-b', 'main', remote], dir);
  git(['clone', '-q', remote, repo], dir);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 't'], repo);
  write('a.txt', 'a\n');
  // A key fixture already on the remote: not part of any later change.
  write('fixtures/old.pem', PRIVATE_KEY);
  commitAll('init');
  git(['push', '-q', 'origin', 'HEAD:main'], repo);
  git(['remote', 'set-head', 'origin', 'main'], repo);
  git(['checkout', '-q', '-b', 'feat/x'], repo);
  git(['push', '-q', '-u', 'origin', 'feat/x'], repo);
  gh = vi.fn(async (_args: string[]) => ({ stdout: 'https://github.com/o/r/pull/1\n' }));
  const exec = (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
    if (cmd.startsWith('gh')) return gh(args);
    if (failReset && args[0] === 'reset') return Promise.reject(Object.assign(new Error('x'), { stderr: 'fatal: index.lock exists' }));
    try {
      return Promise.resolve({ stdout: execFileSync(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8', maxBuffer: 1 << 24 }) });
    } catch (e) {
      return Promise.reject(e);
    }
  };
  lines = spawnGitLines;
  failReset = false;
  svc = new ShipActions(exec as never, async () => null, () => undefined, () => 1000, () => false, (cwd, env) => lines(cwd, env));
});

afterEach(() => {
  setSecretGuardEnabled(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

const pin = () => ({ branch: 'feat/x', head: git(['rev-parse', 'HEAD'], repo) });

describe('ShipActions secret guard: commit', () => {
  it('refuses a .env file, leaves nothing staged or committed, and says why', async () => {
    const before = pin().head;
    write('.env', 'X=1\n');
    write('b.txt', 'b\n');
    const res = await svc.commit(repo, 'add', pin());
    expect(res).toMatchObject({ ok: false, secrets: [{ path: '.env', what: 'file', kind: 'env' }] });
    expect(!res.ok && res.error).toContain('.env holds passwords and keys, so it was not committed');
    expect(git(['rev-parse', 'HEAD'], repo)).toBe(before);
    expect(git(['diff', '--cached', '--name-only'], repo)).toBe('');
  });

  it('a refused commit leaves the index exactly as the user staged it', async () => {
    write('a.txt', 'a2\n');
    write('b.txt', 'b\n');
    git(['add', 'b.txt'], repo); // b staged, a modified but unstaged
    write('.env', 'X=1\n'); // untracked
    const index = () => [git(['ls-files', '-s'], repo), git(['diff', '--cached', '--name-status'], repo), git(['status', '--porcelain'], repo)];
    const before = index();
    expect(await svc.commit(repo, 'add', pin())).toMatchObject({ ok: false, secrets: [{ path: '.env' }] });
    expect(index()).toEqual(before);
  });

  it('commits exactly the tree it checked: a file written during the check is not in the commit', async () => {
    write('b.txt', 'b\n');
    lines = (cwd, env) => {
      const real = spawnGitLines(cwd, env);
      return async (args, onLine) => {
        const ok = await real(args, onLine);
        if (args.includes('--text')) write('.env', 'X=1\n'); // lands after the check read the change
        return ok;
      };
    };
    expect(await svc.commit(repo, 'add b', pin())).toEqual({ ok: true });
    expect(git(['show', '--name-only', '--format=', 'HEAD'], repo)).toBe('b.txt');
    expect(git(['status', '--porcelain'], repo)).toBe('?? .env');
  });

  it('says so when the commit was made but the staging area could not catch up', async () => {
    write('b.txt', 'b\n');
    failReset = true;
    const res = await svc.commit(repo, 'add b', pin());
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.error).toMatch(/^committed, but the staging area could not be updated \(fatal: index.lock exists\)/);
    expect(git(['show', '--name-only', '--format=', 'HEAD'], repo)).toBe('b.txt');
  });

  it('refuses a key-shaped value and never echoes it', async () => {
    const key = `sk-proj-${'A1b2'.repeat(8)}`;
    write('cfg.ts', `export const k = "${key}";\n`);
    const res = await svc.commit(repo, 'add', pin());
    expect(res).toMatchObject({ ok: false, secrets: [{ path: 'cfg.ts', what: 'value', kind: 'openai', line: 1 }] });
    expect(!res.ok && res.error).not.toContain(key);
  });

  it('reads files .gitattributes marks -diff, non-ASCII paths, and a rename onto a secret name', async () => {
    write('.gitattributes', '*.cfg -diff\n');
    commitAll('attrs');
    write('app.cfg', 'aws = AKIAIOSFODNN7EXAMPLE\n');
    expect(await svc.commit(repo, 'cfg', pin())).toMatchObject({ ok: false, secrets: [{ path: 'app.cfg', kind: 'aws' }] });
    fs.rmSync(path.join(repo, 'app.cfg'));
    write('설정/.env', 'X=1\n');
    expect(await svc.commit(repo, 'env', pin())).toMatchObject({ ok: false, secrets: [{ path: '설정/.env', what: 'file' }] });
    fs.rmSync(path.join(repo, '설정'), { recursive: true });
    write('env.txt', 'X=1\n');
    commitAll('env.txt');
    git(['mv', 'env.txt', '.env'], repo);
    expect(await svc.commit(repo, 'rename', pin())).toMatchObject({ ok: false, secrets: [{ path: '.env', what: 'file' }] });
  });

  it('lets everyday files through: templates, public certs, tracked env files without secrets', async () => {
    write('.env.example', 'OPENAI_API_KEY=\n');
    write('certs/fullchain.pem', '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    write('Pitch.key', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2]));
    write('android/debug.keystore', Buffer.from([0xfe, 0xed, 0xfe, 0xed, 0, 0]));
    write('.env.production', 'NEXT_PUBLIC_API_URL=https://api.example.com\n');
    write('src/storage.ts', "export const STORAGE_KEY = 'wmux.channelMentionHandled.v1';\n");
    expect(await svc.commit(repo, 'everyday', pin())).toEqual({ ok: true });
    // An env file already in the repository is judged by what is added to it.
    write('.env.production', 'NEXT_PUBLIC_API_URL=https://api2.example.com\n');
    expect(await svc.commit(repo, 'url', pin())).toEqual({ ok: true });
    write('.env.production', 'NEXT_PUBLIC_API_URL=https://api2.example.com\nSTRIPE_SECRET=q8Zr2LpX0vKt9mNw\n');
    expect(await svc.commit(repo, 'secret', pin())).toMatchObject({ ok: false, secrets: [{ path: '.env.production', what: 'value', kind: 'env', line: 2 }] });
  });

  it('with the guard turned off in Settings, commits as before', async () => {
    setSecretGuardEnabled(false);
    write('.env', 'X=1\n');
    expect(await svc.commit(repo, 'env', pin())).toEqual({ ok: true });
    expect(git(['show', '--name-only', '--format=', 'HEAD'], repo)).toBe('.env');
  });
});

describe('ShipActions secret guard: push and PR', () => {
  it('fails closed: when the check cannot run, commit, push and PR are refused with a plain reason', async () => {
    const before = pin().head;
    write('b.txt', 'b\n');
    git(['add', 'b.txt'], repo);
    const staged = git(['ls-files', '-s'], repo);
    lines = () => async () => false;
    const commit = await svc.commit(repo, 'add', pin());
    expect(commit).toMatchObject({ ok: false, secretScanFailed: true });
    expect(!commit.ok && commit.error).toContain('could not read this change to check it for passwords and keys, so it was not committed');
    expect(git(['rev-parse', 'HEAD'], repo)).toBe(before);
    expect(git(['ls-files', '-s'], repo)).toBe(staged);
    git(['commit', '-q', '-m', 'b'], repo);
    expect(await svc.push(repo, pin())).toMatchObject({ ok: false, secretScanFailed: true });
    expect(git(['ls-remote', 'origin', 'feat/x'], repo)).not.toContain(pin().head);
    expect(await svc.createPr(repo, 't', pin())).toMatchObject({ ok: false, secretScanFailed: true });
    expect(gh).not.toHaveBeenCalled();
  });

  it('refuse a branch whose commits add a private key; gh is never called', async () => {
    write('certs/server.key', PRIVATE_KEY);
    write('certs/server.p12', Buffer.from([0x30, 0x82, 0, 1, 0]));
    commitAll('oops');
    const push = await svc.push(repo, pin());
    expect(push).toMatchObject({ ok: false, secrets: [
      { path: 'certs/server.key', what: 'value', kind: 'private-key', line: 1 },
      { path: 'certs/server.p12', what: 'file', kind: 'private-key' },
    ] });
    expect(git(['ls-remote', 'origin', 'feat/x'], repo)).not.toContain(pin().head);
    expect(await svc.createPr(repo, 'title', pin())).toMatchObject({ ok: false, secrets: [{ path: 'certs/server.key' }, { path: 'certs/server.p12' }] });
    expect(gh).not.toHaveBeenCalled();
  });

  it('a file added in one commit and removed in the next is still refused', async () => {
    write('.env', 'X=1\n');
    commitAll('add');
    git(['rm', '-q', '.env'], repo);
    git(['commit', '-q', '-m', 'drop'], repo);
    expect(await svc.push(repo, pin())).toMatchObject({ ok: false, secrets: [{ path: '.env', what: 'file' }] });
  });

  it('reads what a merge commit itself adds', async () => {
    git(['checkout', '-q', 'main'], repo);
    write('m.txt', 'm\n');
    commitAll('m');
    git(['push', '-q', 'origin', 'main'], repo);
    git(['checkout', '-q', 'feat/x'], repo);
    git(['merge', '-q', '--no-ff', '--no-commit', 'main'], repo);
    write('m.txt', `m\nGITLAB=glpat-${'x1Y2'.repeat(5)}\n`);
    git(['add', '-A'], repo);
    git(['commit', '-q', '--no-edit'], repo);
    expect(await svc.push(repo, pin())).toMatchObject({ ok: false, secrets: [{ path: 'm.txt', kind: 'gitlab' }] });
    // git without remerge diffs: the merge is read against each parent.
    lines = (cwd, env) => {
      const real = spawnGitLines(cwd, env);
      return async (args, onLine) => (args.includes('--diff-merges=remerge') ? false : real(args, onLine));
    };
    expect(await svc.push(repo, pin())).toMatchObject({ ok: false, secrets: [{ path: 'm.txt', kind: 'gitlab' }] });
  });

  it('a push to another remote reads the commits that remote does not have', async () => {
    write('.env', 'X=1\n');
    commitAll('env');
    git(['push', '-q', 'origin', 'feat/x'], repo);
    const pub = path.join(dir, 'pub.git');
    git(['init', '-q', '--bare', '-b', 'main', pub], dir);
    git(['remote', 'add', 'pub', pub], repo);
    git(['push', '-q', 'pub', 'main'], repo);
    git(['config', 'branch.feat/x.remote', 'pub'], repo);
    expect(await svc.push(repo, pin())).toMatchObject({ ok: false, secrets: [{ path: '.env' }] });
  });

  it('with no local origin/<default> ref, checks the commits no remote has — never the whole history', async () => {
    write('b.txt', 'b\n');
    commitAll('b');
    git(['push', '-q', 'origin', 'feat/x'], repo);
    git(['symbolic-ref', '-d', 'refs/remotes/origin/HEAD'], repo);
    git(['update-ref', '-d', 'refs/remotes/origin/main'], repo);
    git(['config', 'remote.origin.url', path.join(dir, 'missing.git')], repo);
    expect(await svc.createPr(repo, 'title', pin())).toMatchObject({ ok: true });
  });

  it('a PR is checked against gh-merge-base when the branch sets one', async () => {
    git(['checkout', '-q', '-b', 'dev', 'main'], repo);
    write('dev/.env', 'X=1\n');
    commitAll('dev env');
    git(['push', '-q', 'origin', 'dev'], repo);
    git(['checkout', '-q', '-B', 'feat/x', 'dev'], repo);
    write('b.txt', 'b\n');
    commitAll('b');
    expect(await svc.createPr(repo, 'title', pin())).toMatchObject({ ok: false, secrets: [{ path: 'dev/.env' }] });
    git(['config', 'branch.feat/x.gh-merge-base', 'dev'], repo);
    expect(await svc.createPr(repo, 'title', pin())).toMatchObject({ ok: true });
  });

  it('a clean branch still pushes and opens its PR', async () => {
    write('b.txt', 'b\n');
    commitAll('b');
    expect(await svc.push(repo, pin())).toEqual({ ok: true });
    expect(await svc.createPr(repo, 'title', pin())).toMatchObject({ ok: true, url: 'https://github.com/o/r/pull/1' });
  });

  it('with the guard turned off in Settings, pushes and opens the PR as before', async () => {
    write('.env', 'X=1\n');
    commitAll('env');
    setSecretGuardEnabled(false);
    expect(await svc.push(repo, pin())).toEqual({ ok: true });
    expect(await svc.createPr(repo, 'title', pin())).toMatchObject({ ok: true });
  });
});

// The pre-commit secret check wmux installs: chains (never overwrites) the
// user's hook, leaves a custom hooks folder alone, covers worktrees, and —
// run by real git — blocks a commit adding .env or a key with a plain message.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPreCommitHook, installSecretHook, SECRET_HOOK_MARKER, USER_HOOK_NAME, type SecretHookRuntime } from '../secretHook';
import { checkStaged, formatBlockedCommit } from '../../../cli/commands/secretsCheck';

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitPort = async (args: string[], cwd: string) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8' }); } catch { return null; }
};

let dir: string;
let repo: string;
let rt: SecretHookRuntime;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-secret-hook-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 't'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  // A stand-in for the wmux CLI: runs the real check (checkStaged) via a tiny
  // node script, so the hook path is exercised end to end with real git.
  const cli = path.join(dir, 'cli.js');
  fs.writeFileSync(cli, `
    require('child_process');
    const r = require('child_process').spawnSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' });
    const names = r.stdout.split('\\n').filter(Boolean);
    const diff = require('child_process').spawnSync('git', ['diff', '--cached', '-U0'], { encoding: 'utf8' }).stdout;
    if (names.some((n) => /(^|\\/)\\.env$/.test(n)) || /sk-proj-/.test(diff)) { process.stderr.write('wmux stopped this commit: it would save a password or key into git.\\n'); process.exit(1); }
    process.exit(0);
  `);
  rt = { runtime: process.execPath, cli };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const hooks = () => path.join(repo, '.git', 'hooks');
const commit = (cwd = repo) => spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd, encoding: 'utf8' });

describe('installSecretHook', () => {
  it('installs an executable hook that blocks a .env commit with a plain message and lets a clean one through', async () => {
    const r = await installSecretHook(repo, rt, { git: gitPort });
    expect(r).toMatchObject({ ok: true, chained: false });
    const hook = path.join(hooks(), 'pre-commit');
    expect(fs.readFileSync(hook, 'utf8')).toContain(SECRET_HOOK_MARKER);
    if (process.platform !== 'win32') expect(fs.statSync(hook).mode & 0o111).not.toBe(0);

    fs.writeFileSync(path.join(repo, '.env'), 'X=1\n');
    git(['add', '.env'], repo);
    const blocked = commit();
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain('wmux stopped this commit');
    git(['rm', '-q', '--cached', '.env'], repo);

    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(['add', 'b.txt'], repo);
    expect(commit().status).toBe(0);
  });

  it("keeps the user's own hook, chains it after the check, and it still decides", async () => {
    const mine = path.join(hooks(), 'pre-commit');
    fs.writeFileSync(mine, '#!/bin/sh\necho "user hook ran" >&2\nexit 7\n', { mode: 0o755 });
    const r = await installSecretHook(repo, rt, { git: gitPort });
    expect(r).toMatchObject({ ok: true, chained: true });
    expect(fs.readFileSync(path.join(hooks(), USER_HOOK_NAME), 'utf8')).toContain('user hook ran');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(['add', 'b.txt'], repo);
    const res = commit();
    expect(res.stderr).toContain('user hook ran');
    expect(res.status).not.toBe(0);
  });

  it('is idempotent and refreshes its own hook without chaining itself', async () => {
    await installSecretHook(repo, rt, { git: gitPort });
    expect(await installSecretHook(repo, rt, { git: gitPort })).toMatchObject({ ok: true, updated: false, chained: false });
    expect(await installSecretHook(repo, { ...rt, cli: `${rt.cli}2` }, { git: gitPort })).toMatchObject({ ok: true, updated: true, chained: false });
    expect(fs.existsSync(path.join(hooks(), USER_HOOK_NAME))).toBe(false);
  });

  it('never overwrites when both a user hook and a chained one exist', async () => {
    fs.writeFileSync(path.join(hooks(), 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(hooks(), USER_HOOK_NAME), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await installSecretHook(repo, rt, { git: gitPort })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(fs.readFileSync(path.join(hooks(), 'pre-commit'), 'utf8')).not.toContain(SECRET_HOOK_MARKER);
  });

  it('leaves a custom core.hooksPath (husky etc.) alone', async () => {
    git(['config', 'core.hooksPath', '.husky'], repo);
    expect(await installSecretHook(repo, rt, { git: gitPort })).toMatchObject({ ok: false, reason: 'hooks-path' });
    expect(fs.existsSync(path.join(repo, '.husky'))).toBe(false);
  });

  it('covers a task worktree: installed from the worktree, it lands in the shared hooks and blocks there', async () => {
    const wt = path.join(dir, 'wt');
    git(['worktree', 'add', '-q', '-b', 'wtask/a', wt], repo);
    expect(await installSecretHook(wt, rt, { git: gitPort })).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(hooks(), 'pre-commit'))).toBe(true);
    fs.writeFileSync(path.join(wt, 'k.ts'), `const k = "sk-proj-${'A1b2'.repeat(8)}";\n`);
    git(['add', 'k.ts'], wt);
    expect(commit(wt).status).not.toBe(0);
  });

  it('builds a hook that quotes paths with spaces and quotes', () => {
    const h = buildPreCommitHook({ runtime: "C:\\Program Files\\wmux's\\wmux.exe", cli: '/x y/cli.js' });
    expect(h).toContain(`WMUX_RUNTIME='C:/Program Files/wmux'\\''s/wmux.exe'`);
    expect(h).toContain(`WMUX_CLI='/x y/cli.js'`);
    expect(h).toContain(`exec "$USER_HOOK" "$@"`);
  });
});

describe('wmux secrets check-staged', () => {
  it('blocks staged secrets with plain words and no value, and fails closed', async () => {
    const key = `sk-proj-${'A1b2'.repeat(8)}`;
    fs.writeFileSync(path.join(repo, '.env'), 'X=1\n');
    fs.writeFileSync(path.join(repo, 'k.ts'), `const k = "${key}";\n`);
    git(['add', '.'], repo);
    let err = '';
    const code = await checkStaged(repo, (a) => gitPort(a, repo), (s) => { err += s; });
    expect(code).toBe(1);
    expect(err).toContain('.env: this file holds passwords and keys.');
    expect(err).toContain('k.ts line 1: this looks like an AI service API key.');
    expect(err).not.toContain(key);
    let failed = '';
    expect(await checkStaged(repo, async () => null, (s) => { failed += s; })).toBe(1);
    expect(failed).toContain('could not check this commit');
    git(['reset', '-q'], repo);
    expect(await checkStaged(repo, (a) => gitPort(a, repo), () => undefined)).toBe(0);
  });

  it('formats one line per finding', () => {
    expect(formatBlockedCommit([{ path: 'certs/x.pem', what: 'file', kind: 'private-key' }])).toContain('certs/x.pem: this file holds a private key.');
  });
});

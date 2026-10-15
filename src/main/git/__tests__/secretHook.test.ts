// The pre-commit secret check wmux installs: chains (never overwrites) the
// user's hook, leaves a custom hooks folder alone, covers worktrees, and —
// run by real git — blocks a commit adding .env or a key with a plain message.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPreCommitHook, WSL_HOOK_LINES, filePrefs, installSecretHook, SecretHookInstaller, SECRET_HOOK_MARKER, uninstallSecretHook, USER_HOOK_NAME, type SecretHookRuntime } from '../secretHook';
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

describe('turning the automatic install off', () => {
  const USER = '#!/bin/sh\necho "user hook ran" >&2\nexit 0\n';

  it("uninstall puts the user's original hook back byte for byte, and commits work as before", async () => {
    fs.writeFileSync(path.join(hooks(), 'pre-commit'), USER, { mode: 0o755 });
    await installSecretHook(repo, rt, { git: gitPort });
    expect(await uninstallSecretHook(repo, { git: gitPort })).toEqual({ ok: true, removed: true, restored: true });
    expect(fs.readFileSync(path.join(hooks(), 'pre-commit'), 'utf8')).toBe(USER);
    expect(fs.existsSync(path.join(hooks(), USER_HOOK_NAME))).toBe(false);
    fs.writeFileSync(path.join(repo, '.env'), 'X=1\n');
    git(['add', '.env'], repo);
    expect(commit().status).toBe(0); // no wmux check any more
  });

  it('uninstall with no user hook leaves no pre-commit, and never touches a hook that is not wmux\'s', async () => {
    await installSecretHook(repo, rt, { git: gitPort });
    expect(await uninstallSecretHook(repo, { git: gitPort })).toEqual({ ok: true, removed: true, restored: false });
    expect(fs.existsSync(path.join(hooks(), 'pre-commit'))).toBe(false);
    fs.writeFileSync(path.join(hooks(), 'pre-commit'), USER, { mode: 0o755 });
    expect(await uninstallSecretHook(repo, { git: gitPort })).toEqual({ ok: true, removed: false, restored: false });
    expect(fs.readFileSync(path.join(hooks(), 'pre-commit'), 'utf8')).toBe(USER);
  });

  it('the setting defaults on, survives a restart, and off uninstalls everywhere and stops new installs', async () => {
    const file = path.join(dir, 'home', 'secret-hook.json');
    const make = () => new SecretHookInstaller(() => rt, { git: gitPort }, filePrefs(file));
    const a = make();
    expect(a.autoInstall).toBe(true);
    fs.writeFileSync(path.join(hooks(), 'pre-commit'), USER, { mode: 0o755 });
    expect(await a.ensure(repo)).toMatchObject({ ok: true, chained: true });

    expect(await make().setAutoInstall(false)).toEqual({ autoInstall: false, failed: [] });
    expect(fs.readFileSync(path.join(hooks(), 'pre-commit'), 'utf8')).toBe(USER);
    const b = make(); // a restart
    expect(b.autoInstall).toBe(false);
    expect(b.ensure(repo)).toBeNull();
    expect(fs.readFileSync(path.join(hooks(), 'pre-commit'), 'utf8')).toBe(USER);

    await b.setAutoInstall(true);
    expect(await b.ensure(repo)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(hooks(), 'pre-commit'), 'utf8')).toContain(SECRET_HOOK_MARKER);
  });

  it('a broken prefs file means the default (on)', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{nope');
    expect(filePrefs(file).load()).toEqual({ autoInstall: true, repos: [] });
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

  it('words a found value once ("this looks like a password or key")', () => {
    const text = formatBlockedCommit([{ path: 'src/a.ts', what: 'value', line: 3, kind: 'random' }]);
    expect(text).toContain('src/a.ts line 3: this looks like a password or key.');
    expect(text).not.toContain('looks like what looks like');
  });

  it('formats one line per finding', () => {
    expect(formatBlockedCommit([{ path: 'certs/x.pem', what: 'file', kind: 'private-key' }])).toContain('certs/x.pem: this file holds a private key.');
  });
});

// #2231 — the hook under WSL: Windows paths through their /mnt mount, the
// Windows app through interop. Real sh; no /mnt on this machine, so the
// translation is checked on its own and the fallback must still refuse.
describe.skipIf(process.platform === 'win32')('the hook in a WSL shell', () => {
  const fn = WSL_HOOK_LINES.slice(WSL_HOOK_LINES.findIndex((l) => l.includes('wmux_mnt() {')), WSL_HOOK_LINES.findIndex((l) => l.trim() === '}') + 1).join('\n');
  const mnt = (p: string) => execFileSync('/bin/sh', ['-c', `${fn}\nwmux_mnt "$1"`, 'sh', p], { encoding: 'utf8' });

  it('reads an X:/ path through /mnt/x and leaves every other path alone', () => {
    expect(mnt('D:/wmux-work/out/wmux.exe')).toBe('/mnt/d/wmux-work/out/wmux.exe');
    expect(mnt('C:/Users/me/AppData/Local/wmux/app-4.5.0/resources/cli-bundle/index.js')).toBe('/mnt/c/Users/me/AppData/Local/wmux/app-4.5.0/resources/cli-bundle/index.js');
    expect(mnt("/Applications/wmux.app/it's/x")).toBe("/Applications/wmux.app/it's/x");
  });

  it('a mount that is not there keeps the guard: no wmux to run, the commit is refused', () => {
    const hook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wslhook-')), 'pre-commit');
    fs.writeFileSync(hook, buildPreCommitHook({ runtime: 'D:\\nowhere\\wmux.exe', cli: 'D:\\nowhere\\cli-bundle\\index.js' }), { mode: 0o755 });
    const r = spawnSync('/bin/sh', [hook], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', WSL_DISTRO_NAME: 'Ubuntu' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('wmux could not check this commit');
  });

  it('runs the app it found with the Windows CLI path, and hands ELECTRON_RUN_AS_NODE over WSLENV', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wslhook-'));
    const runtime = path.join(dir, 'wmux.exe');
    const cli = path.join(dir, 'index.js');
    fs.writeFileSync(cli, '');
    // A stand-in for the app: records what it was run with.
    fs.writeFileSync(runtime, '#!/bin/sh\nprintf "%s|%s|%s" "$1" "$ELECTRON_RUN_AS_NODE" "$WSLENV" > "$0.log"\n', { mode: 0o755 });
    // The hook as built, with the mount helper pointed at this folder.
    const script = buildPreCommitHook({ runtime: 'D:/app/wmux.exe', cli: 'D:/app/index.js' })
      .replace("printf '/mnt/%s/%s'", `printf '${dir}/%.0s%s'`)
      .replace('"${1#?:/}"', '"$(basename "$1")"');
    const hook = path.join(dir, 'pre-commit');
    fs.writeFileSync(hook, script, { mode: 0o755 });
    const r = spawnSync('/bin/sh', [hook], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', WSL_DISTRO_NAME: 'Ubuntu', WSLENV: 'FOO/p', GIT_INDEX_FILE: '/mnt/d/r/.git/index.lock' } });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(`${runtime}.log`, 'utf8')).toBe('D:/app/index.js|1|FOO/p:ELECTRON_RUN_AS_NODE/w:GIT_INDEX_FILE/p');
  });
});

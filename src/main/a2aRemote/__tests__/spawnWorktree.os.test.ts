// createSpawnWorktree against real git in temp folders. The owner's git
// config is a temp file (GIT_CONFIG_GLOBAL), the system one is off.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSpawnWorktree, type SpawnWorktreeInput } from '../spawnWorktree';

const ID = 'sp-0123abcd-4567-89ab-cdef-0123456789ab';
const BRANCH = `wmux/remote/${ID}`;

let root: string;
let repo: string;
let wtRoot: string;
let globalConfig: string;
let marker: string;

const gitEnv = (): Record<string, string> => ({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' });
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv() }, encoding: 'utf8' }).trim();
/** A POSIX shell line that writes the marker (Git for Windows runs it in its sh). */
const touchMarker = (): string => `echo x > "${marker.replace(/\\/g, '/')}"`;
const hookScript = (): string => `#!/bin/sh\n${touchMarker()}\n`;
const realpath = (p: string): string => fs.realpathSync.native(p);

const create = (over: Partial<SpawnWorktreeInput> = {}) =>
  createSpawnWorktree(
    { repoPath: repo, sub: '', spawnId: ID, ...over },
    { worktreesRoot: wtRoot, noHooksDir: path.join(root, 'no-hooks'), env: gitEnv() },
  );
const branchExists = (): boolean => g(repo, 'branch', '--list', BRANCH) !== '';
const spawnDir = (): string => path.join(wtRoot, `remote-${ID}`);
/** A plain checkout of HEAD into a new worktree: what runs without the hardening. */
const control = (): void => { g(repo, 'worktree', 'add', '-q', '-b', 'control', path.join(root, 'control'), 'HEAD'); };

beforeEach(() => {
  root = realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-spawn-wt-')));
  repo = path.join(root, 'repo');
  wtRoot = path.join(root, 'worktrees');
  globalConfig = path.join(root, 'global.gitconfig');
  marker = path.join(root, 'ran.marker');
  fs.writeFileSync(globalConfig, '');
  fs.mkdirSync(path.join(repo, 'apps', 'site'), { recursive: true });
  g(root, 'init', '-q', '-b', 'main', repo);
  g(repo, 'config', 'user.name', 't');
  g(repo, 'config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'r\n');
  fs.writeFileSync(path.join(repo, 'apps', 'site', 'index.txt'), 'site\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-qm', 'init');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const expectNothingLeft = (): void => {
  expect(fs.existsSync(spawnDir())).toBe(false);
  expect(branchExists()).toBe(false);
  expect(g(repo, 'worktree', 'list', '--porcelain')).not.toContain(`remote-${ID}`);
};

describe('createSpawnWorktree', () => {
  it('creates the worktree on its own branch and returns the folder inside it', async () => {
    const r = await create({ sub: 'apps/site' });
    expect(r).toEqual({
      ok: true,
      worktreePath: realpath(spawnDir()),
      cwd: realpath(path.join(spawnDir(), 'apps', 'site')),
      branch: BRANCH,
      // No origin: the branch starts at HEAD, and says so.
      base: g(repo, 'rev-parse', 'HEAD'),
      baseNote: expect.stringContaining('the repository has no origin remote'),
    });
    expect(g(spawnDir(), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(fs.readFileSync(path.join(spawnDir(), 'apps', 'site', 'index.txt'), 'utf8')).toBe('site\n');
  });

  it('takes a folder whose name starts with two dots as inside the worktree', async () => {
    fs.mkdirSync(path.join(repo, '..cfg'));
    fs.writeFileSync(path.join(repo, '..cfg', 'a.txt'), 'a\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-qm', 'dots');
    const r = await create({ sub: '..cfg' });
    expect(r).toMatchObject({ ok: true, cwd: realpath(path.join(spawnDir(), '..cfg')) });
  });

  it('runs no hook from .git/hooks', async () => {
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, hookScript(), { mode: 0o755 });
    control();
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);

    expect((await create()).ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('runs no hook from a core.hooksPath the repository sets', async () => {
    const hooks = path.join(root, 'planted-hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'post-checkout'), hookScript(), { mode: 0o755 });
    g(repo, 'config', 'core.hooksPath', hooks);
    control();
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);

    expect((await create()).ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('runs no fsmonitor the repository sets', async () => {
    const script = path.join(root, 'fsmonitor.sh');
    fs.writeFileSync(script, `${hookScript()}exit 1\n`, { mode: 0o755 });
    g(repo, 'config', 'core.fsmonitor', script);
    // The control proves the checkout would run it; how Git for Windows
    // starts an fsmonitor script is not this test's subject.
    if (process.platform !== 'win32') {
      control();
      expect(fs.existsSync(marker)).toBe(true);
      fs.unlinkSync(marker);
    }

    expect((await create()).ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses a repository whose own config defines a filter driver', async () => {
    g(repo, 'config', 'filter.evil.smudge', 'cat');
    const r = await create();
    expect(r).toMatchObject({ ok: false, code: 'folder-not-allowed' });
    expectNothingLeft();
  });

  // `--local` reads no include, and an onbranch include defines its filter
  // only once the new branch exists: both are refused outright.
  it.each([
    ['include.path'],
    ['includeIf.onbranch:wmux/**.path'],
  ])('refuses a repository whose own config sets %s', async (key) => {
    const included = path.join(root, 'included.gitconfig');
    fs.writeFileSync(included, `[filter "evil"]\n\tsmudge = ${touchMarker()}; cat\n`);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n');
    g(repo, 'add', '.gitattributes');
    g(repo, 'commit', '-qm', 'attrs');
    g(repo, 'config', key, included);

    const r = await create();
    expect(r).toMatchObject({ ok: false, code: 'folder-not-allowed' });
    expectNothingLeft();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('runs no filter the global config defines, even a required one', async () => {
    // A name with a capital and a dot: -c must name it exactly as written.
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=Ev.il\n');
    g(repo, 'add', '.gitattributes');
    g(repo, 'commit', '-qm', 'attrs');
    fs.writeFileSync(globalConfig, `[filter "Ev.il"]\n\tsmudge = ${touchMarker()}; cat\n\tclean = cat\n\trequired = true\n`);
    control();
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);

    const r = await create();
    expect(r.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(spawnDir(), 'README.md'), 'utf8')).toBe('r\n');
  });

  it('works with a global branch.autoSetupMerge, which would otherwise write tracking keys for the new branch', async () => {
    fs.writeFileSync(globalConfig, '[branch]\n\tautoSetupMerge = always\n');
    const r = await create();
    expect(r.ok).toBe(true);
    expect(g(repo, 'config', '--local', '--list').split('\n').filter((l) => l.startsWith('branch.wmux/'))).toEqual([]);
  });

  it('runs no filter a global includeIf.onbranch defines for the new branch only', async () => {
    // Applies once wmux/remote/<id> exists: after the config was first read.
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=late\n');
    g(repo, 'add', '.gitattributes');
    g(repo, 'commit', '-qm', 'attrs');
    const onBranch = path.join(root, 'onbranch.gitconfig');
    fs.writeFileSync(onBranch, `[filter "late"]\n\tsmudge = ${touchMarker()}; cat\n\tclean = cat\n`);
    fs.writeFileSync(globalConfig, `[includeIf "onbranch:wmux/remote/**"]\n\tpath = ${onBranch.replace(/\\/g, '/')}\n`);
    g(repo, 'worktree', 'add', '-q', '-b', 'wmux/remote/control', path.join(root, 'control'), 'HEAD');
    expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);

    const r = await create();
    expect(r.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(spawnDir(), 'README.md'), 'utf8')).toBe('r\n');
  });

  it.skipIf(process.platform === 'win32')('refuses a folder that is a link out of the worktree, and removes the worktree', async () => {
    fs.symlinkSync(root, path.join(repo, 'out'));
    g(repo, 'add', 'out');
    g(repo, 'commit', '-qm', 'link');
    const r = await create({ sub: 'out' });
    expect(r).toMatchObject({ ok: false, code: 'folder-not-allowed' });
    expectNothingLeft();
  });

  it('refuses a folder the tree does not hold, and removes the worktree', async () => {
    const r = await create({ sub: 'apps/missing' });
    expect(r).toMatchObject({ ok: false, code: 'folder-not-allowed' });
    expectNothingLeft();
  });

  it('refuses a repository path that is not the top level', async () => {
    const r = await create({ repoPath: realpath(path.join(repo, 'apps')) });
    expect(r).toMatchObject({ ok: false, code: 'folder-not-allowed' });
    expectNothingLeft();
  });

  it('fails without touching a branch it did not make', async () => {
    g(repo, 'branch', BRANCH);
    const r = await create();
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect(branchExists()).toBe(true);
    expect(fs.existsSync(spawnDir())).toBe(false);
  });
});

describe('createSpawnWorktree: the base', () => {
  /** A bare origin with one commit more on main than this checkout has, which is on an older feature branch. */
  const originAhead = (): { origin: string; tip: string } => {
    const origin = path.join(root, 'origin.git');
    g(root, 'clone', '-q', '--bare', repo, origin);
    const other = path.join(root, 'other');
    g(root, 'clone', '-q', origin, other);
    g(other, 'config', 'user.name', 't');
    g(other, 'config', 'user.email', 't@example.invalid');
    fs.writeFileSync(path.join(other, 'NEW.md'), 'new\n');
    g(other, 'add', '.');
    g(other, 'commit', '-qm', 'ahead');
    g(other, 'push', '-q', 'origin', 'main');
    g(repo, 'checkout', '-q', '-b', 'old-feature');
    g(repo, 'remote', 'add', 'origin', origin);
    return { origin, tip: g(other, 'rev-parse', 'HEAD') };
  };

  it('branches from origin\'s default branch as fetched now, not from the checkout\'s HEAD', async () => {
    const { tip } = originAhead();
    // Never fetched here: the default branch is read from the remote, then fetched.
    expect(() => g(repo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')).toThrow();
    const r = await create();
    expect(r).toMatchObject({ ok: true, base: tip, baseRef: 'origin/main' });
    expect(r.ok && r.baseNote).toBeFalsy();
    expect(g(spawnDir(), 'rev-parse', 'HEAD')).toBe(tip);
    expect(fs.existsSync(path.join(spawnDir(), 'NEW.md'))).toBe(true);
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('old-feature');
  });

  it('an origin it cannot reach: HEAD, with the reason', async () => {
    g(repo, 'remote', 'add', 'origin', path.join(root, 'no-such-origin.git'));
    const head = g(repo, 'rev-parse', 'HEAD');
    const r = await create();
    expect(r).toMatchObject({ ok: true, base: head, baseNote: expect.stringContaining("branched from this PC's HEAD") });
    expect(g(spawnDir(), 'rev-parse', 'HEAD')).toBe(head);
  });

  it('a stale origin/main and a fetch that fails: HEAD, never the stale ref', async () => {
    originAhead();
    g(repo, 'fetch', '-q', 'origin');
    const stale = g(repo, 'rev-parse', 'refs/remotes/origin/main');
    g(repo, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'));
    g(repo, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const head = g(repo, 'rev-parse', 'HEAD');
    const r = await create();
    expect(r).toMatchObject({ ok: true, base: head, baseNote: expect.stringContaining('git fetch origin main failed') });
    expect(head).not.toBe(stale);
  });

  it('fetches nothing when the repository\'s own config names how git connects', async () => {
    originAhead();
    g(repo, 'config', 'http.proxy', 'http://127.0.0.1:9');
    const head = g(repo, 'rev-parse', 'HEAD');
    const r = await create();
    expect(r).toMatchObject({ ok: true, base: head, baseNote: expect.stringContaining('http.proxy') });
    expect(() => g(repo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')).toThrow();
  });

  it('a configured fetch mapping of origin moves no local branch: only origin/<default> is written', async () => {
    originAhead();
    g(repo, 'branch', 'important');
    const before = g(repo, 'rev-parse', 'important');
    g(repo, 'config', '--add', 'remote.origin.fetch', '+refs/heads/main:refs/heads/important');
    const r = await create();
    expect(r).toMatchObject({ ok: true, baseRef: 'origin/main' });
    expect(g(repo, 'rev-parse', 'important')).toBe(before);
  });

  it('takes a default branch name git takes, `+` included', async () => {
    const { tip } = originAhead();
    const other = path.join(root, 'other');
    g(other, 'push', '-q', 'origin', 'main:release+stable');
    g(root, '-C', path.join(root, 'origin.git'), 'symbolic-ref', 'HEAD', 'refs/heads/release+stable');
    const r = await create();
    expect(r).toMatchObject({ ok: true, base: tip, baseRef: 'origin/release+stable' });
  });
});

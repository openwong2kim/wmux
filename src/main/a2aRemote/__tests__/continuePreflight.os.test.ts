// continuePreflight against real git in temp folders. The owner's git config
// is a temp file (GIT_CONFIG_GLOBAL), the system one is off, and origin is
// never contacted: its branch is a local remote-tracking ref.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { continuePreflight } from '../continuePreflight';

let root: string;
let repo: string;
let globalConfig: string;

const gitEnv = (): Record<string, string> => ({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' });
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv() }, encoding: 'utf8' }).trim();
const check = (cwd = repo) => continuePreflight(cwd, { noHooksDir: path.join(root, 'no-hooks'), env: gitEnv() });
/** origin's copy of the current branch is where HEAD is now, and the branch tracks it. */
const pushed = (branch = 'main'): void => {
  g(repo, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
  g(repo, 'branch', `--set-upstream-to=origin/${branch}`);
};

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-continue-pf-')));
  repo = path.join(root, 'repo');
  globalConfig = path.join(root, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  fs.mkdirSync(path.join(repo, 'apps', 'site'), { recursive: true });
  g(root, 'init', '-q', '-b', 'main', repo);
  g(repo, 'config', 'user.name', 't');
  g(repo, 'config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'r\n');
  fs.writeFileSync(path.join(repo, 'apps', 'site', 'index.txt'), 'site\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-qm', 'init');
  g(repo, 'remote', 'add', 'origin', 'https://github.com/Acme/Widget.git');
  pushed();
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('continuePreflight', () => {
  it('names a clean, pushed checkout by its origin key, branch and commit, with the folder below the top level', async () => {
    const head = g(repo, 'rev-parse', 'HEAD');
    expect(await check()).toEqual({ ok: true, repo: { origin: 'github.com/acme/widget', branch: 'main', head } });
    expect(await check(path.join(repo, 'apps', 'site'))).toEqual({ ok: true, repo: { origin: 'github.com/acme/widget', branch: 'main', head, sub: 'apps/site' } });
  });

  it('refuses a changed file and an untracked one', async () => {
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    expect(await check()).toEqual({ ok: false, code: 'dirty' });
    g(repo, 'checkout', '--', 'README.md');
    fs.writeFileSync(path.join(repo, 'apps', 'new.txt'), 'n\n');
    expect(await check()).toEqual({ ok: false, code: 'dirty' });
  });

  it('refuses a commit origin does not have, a detached HEAD, and a branch that tracks nothing or another branch', async () => {
    fs.writeFileSync(path.join(repo, 'README.md'), 'two\n');
    g(repo, 'commit', '-qam', 'two');
    expect(await check()).toEqual({ ok: false, code: 'unpushed' });
    g(repo, 'checkout', '-q', '--detach');
    expect(await check()).toEqual({ ok: false, code: 'detached' });
    g(repo, 'checkout', '-q', '-b', 'feat');
    expect(await check()).toEqual({ ok: false, code: 'no-upstream' });
    g(repo, 'branch', '--set-upstream-to=origin/main');
    expect(await check()).toEqual({ ok: false, code: 'upstream-mismatch' });
  });

  it('refuses an origin that is not a plain https or ssh address, a missing one, and a repository that sets a content filter', async () => {
    g(repo, 'remote', 'set-url', 'origin', path.join(root, 'bare.git'));
    expect(await check()).toEqual({ ok: false, code: 'origin-unsupported' });
    g(repo, 'remote', 'remove', 'origin');
    expect(await check()).toEqual({ ok: false, code: 'no-origin' });
    g(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git');
    pushed();
    expect((await check()).ok).toBe(true);
    g(repo, 'config', 'filter.x.clean', 'cat');
    expect(await check()).toEqual({ ok: false, code: 'unsafe-config' });
  });

  it('refuses a repository with a submodule, also from a folder that does not hold it, and a branch with no commit yet', async () => {
    g(repo, 'update-index', '--add', '--cacheinfo', `160000,${g(repo, 'rev-parse', 'HEAD')},vendor/lib`);
    expect(await check()).toEqual({ ok: false, code: 'submodules' });
    expect(await check(path.join(repo, 'apps', 'site'))).toEqual({ ok: false, code: 'submodules' });
    const fresh = path.join(root, 'fresh');
    g(root, 'init', '-q', '-b', 'main', fresh);
    g(fresh, 'remote', 'add', 'origin', 'https://github.com/acme/fresh.git');
    expect(await check(fresh)).toEqual({ ok: false, code: 'no-commit' });
  });

  // Windows cannot make these folders at all, so there is nothing to refuse there.
  it.skipIf(process.platform === 'win32')('refuses a folder below the top level that another PC could not hold', async () => {
    for (const name of [['docs', 'aux'], ['docs', 'notes ']]) {
      const dir = path.join(repo, ...name);
      fs.mkdirSync(dir, { recursive: true });
      expect(await check(dir)).toEqual({ ok: false, code: 'folder-unsupported' });
    }
  });

  it('refuses a change status does not show: an assume-unchanged or skip-worktree entry', async () => {
    g(repo, 'update-index', '--assume-unchanged', 'README.md');
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    expect(await check(path.join(repo, 'apps', 'site'))).toEqual({ ok: false, code: 'hidden-changes' });
    g(repo, 'update-index', '--no-assume-unchanged', 'README.md');
    g(repo, 'checkout', '--', 'README.md');
    expect((await check()).ok).toBe(true);
    g(repo, 'update-index', '--skip-worktree', 'apps/site/index.txt');
    expect(await check()).toEqual({ ok: false, code: 'hidden-changes' });
  });

  it('refuses a folder outside any repository', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await check(plain)).toEqual({ ok: false, code: 'not-a-repo' });
  });
});

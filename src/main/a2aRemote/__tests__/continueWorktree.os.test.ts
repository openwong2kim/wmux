// createContinueWorktree against real git in temp folders. The owner's git
// config is a temp file (GIT_CONFIG_GLOBAL), the system one is off. Origin is
// a local bare repository: B's repository names it by its https address, and
// the owner's config rewrites that address to the bare repository's path.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContinueWorktree, removeContinueWorktree, type ContinueWorktreeInput } from '../continueWorktree';

const ID = 'ct-0123abcd-4567-89ab-cdef-0123456789ab';
const ORIGIN_URL = 'https://github.com/acme/widget.git';
const ORIGIN = 'github.com/acme/widget';

let root: string;
let bare: string;
let seed: string;
let repo: string;
let wtRoot: string;
let globalConfig: string;
/** The commits of `feat` on origin: its first, and A's head. */
let first: string;
let head: string;

const gitEnv = (): Record<string, string> => ({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' });
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv() }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const opts = () => ({ worktreesRoot: wtRoot, noHooksDir: path.join(root, 'no-hooks'), env: gitEnv() });
const create = (over: Partial<ContinueWorktreeInput> = {}) =>
  createContinueWorktree({ repoPath: repo, origin: ORIGIN, branch: 'feat', head, sub: 'apps', continueId: ID, ...over }, opts());
const tipOf = (branch: string): string | null => {
  try { return g(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); } catch { return null; }
};
const treeDir = (): string => path.join(wtRoot, `continue-${ID}`);
const commit = (cwd: string, file: string, body: string, msg: string): string => {
  fs.writeFileSync(path.join(cwd, file), body);
  g(cwd, 'add', '.');
  g(cwd, 'commit', '-qm', msg);
  return g(cwd, 'rev-parse', 'HEAD');
};

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-continue-wt-')));
  bare = path.join(root, 'origin.git');
  seed = path.join(root, 'seed');
  repo = path.join(root, 'repo');
  wtRoot = path.join(root, 'worktrees');
  globalConfig = path.join(root, 'global.gitconfig');
  fs.writeFileSync(globalConfig, `[url "${bare.replace(/\\/g, '/')}"]\n\tinsteadOf = ${ORIGIN_URL}\n[user]\n\tname = t\n\temail = t@example.invalid\n`);
  g(root, 'init', '-q', '--bare', '-b', 'main', bare);
  g(root, 'init', '-q', '-b', 'main', seed);
  fs.mkdirSync(path.join(seed, 'apps'));
  fs.writeFileSync(path.join(seed, 'apps', 'index.txt'), 'site\n');
  commit(seed, 'README.md', 'r\n', 'init');
  g(seed, 'remote', 'add', 'origin', ORIGIN_URL);
  g(seed, 'push', '-q', 'origin', 'main');
  // B: a clone from before `feat` existed, naming origin by its address.
  g(root, 'clone', '-q', ORIGIN_URL, repo);
  g(seed, 'checkout', '-q', '-b', 'feat');
  first = commit(seed, 'one.txt', '1\n', 'one');
  head = commit(seed, 'two.txt', '2\n', 'two');
  g(seed, 'tag', 'v1', head);
  g(seed, 'push', '-q', 'origin', 'feat', 'v1');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('createContinueWorktree', () => {
  it('makes the branch at A\'s commit when B has none, and checks it out in the folder', async () => {
    expect(tipOf('feat')).toBeNull();
    // B has none of `feat` until the start fetches it.
    expect(() => g(repo, 'cat-file', '-e', `${head}^{commit}`)).toThrow();
    const res = await create();
    expect(res).toMatchObject({ ok: true, worktreePath: treeDir(), cwd: path.join(treeDir(), 'apps'), made: { oldTip: null, branch: 'feat', head } });
    expect(tipOf('feat')).toBe(head);
    expect(g(treeDir(), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat');
    expect(fs.readFileSync(path.join(treeDir(), 'two.txt'), 'utf8')).toBe('2\n');
    // That branch, into its remote-tracking ref, and no tag with it.
    expect(g(repo, 'rev-parse', 'refs/remotes/origin/feat')).toBe(head);
    expect(g(repo, 'tag', '--list')).toBe('');
  });

  it('moves B\'s branch on to A\'s commit when it is behind, and its undo puts the old tip back', async () => {
    g(repo, 'fetch', '-q', 'origin', 'feat');
    g(repo, 'branch', 'feat', first);
    const res = await create();
    expect(res).toMatchObject({ ok: true, made: { oldTip: first } });
    expect(tipOf('feat')).toBe(head);
    if (!res.ok) throw new Error('not made');
    await removeContinueWorktree(res.made, opts());
    expect(tipOf('feat')).toBe(first);
    expect(fs.existsSync(treeDir())).toBe(false);
    expect(g(repo, 'worktree', 'list', '--porcelain')).not.toContain(`continue-${ID}`);
  });

  it('its undo deletes a branch it made, and leaves one that moved since', async () => {
    const res = await create();
    if (!res.ok) throw new Error('not made');
    await removeContinueWorktree(res.made, opts());
    expect(tipOf('feat')).toBeNull();
    expect(fs.existsSync(treeDir())).toBe(false);

    const again = await create();
    if (!again.ok) throw new Error('not made');
    // A commit made in the pane: the branch is no longer at the value this start left.
    const later = commit(again.cwd, 'three.txt', '3\n', 'three');
    await removeContinueWorktree(again.made, opts());
    expect(tipOf('feat')).toBe(later);
  });

  it('refuses B\'s branch with commits A\'s lacks, and changes nothing', async () => {
    g(repo, 'checkout', '-q', '-b', 'feat');
    const mine = commit(repo, 'mine.txt', 'm\n', 'mine');
    g(repo, 'checkout', '-q', 'main');
    expect(await create()).toMatchObject({ ok: false, code: 'diverged' });
    expect(tipOf('feat')).toBe(mine);
    expect(fs.existsSync(treeDir())).toBe(false);
  });

  it('refuses a branch checked out in a worktree', async () => {
    g(repo, 'fetch', '-q', 'origin', 'feat');
    g(repo, 'checkout', '-q', '-b', 'feat', first);
    expect(await create()).toMatchObject({ ok: false, code: 'branch-busy' });
    expect(tipOf('feat')).toBe(first);
  });

  it('refuses a commit neither origin nor B has', async () => {
    expect(await create({ head: '1234567890abcdef1234567890abcdef12345678' })).toMatchObject({ ok: false, code: 'head-missing' });
    expect(tipOf('feat')).toBeNull();
  });

  it('refuses a branch origin does not have', async () => {
    expect(await create({ branch: 'nope' })).toMatchObject({ ok: false, code: 'branch-not-found' });
    expect(tipOf('nope')).toBeNull();
  });

  it('refuses a repository whose own config sets a content filter, or whose origin is another repository', async () => {
    g(repo, 'config', 'filter.x.clean', 'cat');
    expect(await create()).toMatchObject({ ok: false, code: 'failed' });
    g(repo, 'config', '--unset', 'filter.x.clean');
    expect(await create({ origin: 'github.com/acme/other' })).toMatchObject({ ok: false, code: 'failed' });
    expect(tipOf('feat')).toBeNull();
    expect(fs.existsSync(treeDir())).toBe(false);
  });

  // A stand-in `ssh` on PATH records how it was run; it needs a POSIX shell.
  it.skipIf(process.platform === 'win32')('runs ssh in batch mode for the fetch and ls-remote, unless an ssh command is set already', async () => {
    const bin = path.join(root, 'bin');
    const calls = path.join(root, 'ssh.calls');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit 1\n`, { mode: 0o755 });
    // The owner's config now sends origin's address over ssh, to a host that never answers.
    fs.writeFileSync(globalConfig, `[url "ssh://git@example.invalid/acme/widget.git"]\n\tinsteadOf = ${ORIGIN_URL}\n`);
    const run = (env: Record<string, string>) => createContinueWorktree(
      { repoPath: repo, origin: ORIGIN, branch: 'feat', head, sub: 'apps', continueId: ID },
      { ...opts(), env: { ...gitEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, ...env } },
    );
    expect(await run({ GIT_SSH_COMMAND: '', GIT_SSH: '' })).toMatchObject({ ok: false, code: 'failed' });
    const batch = fs.readFileSync(calls, 'utf8').trim().split('\n');
    // The fetch, then ls-remote to tell a missing branch from a failure.
    expect(batch.length).toBe(2);
    for (const line of batch) expect(line).toContain('BatchMode=yes');

    fs.rmSync(calls);
    expect(await run({ GIT_SSH_COMMAND: 'ssh -o SendEnv=MINE' })).toMatchObject({ ok: false, code: 'failed' });
    const own = fs.readFileSync(calls, 'utf8').trim().split('\n');
    for (const line of own) {
      expect(line).toContain('SendEnv=MINE');
      expect(line).not.toContain('BatchMode');
    }
  });

  it('refuses a folder past Windows\' path limit on win32 only', async () => {
    wtRoot = path.join(root, 'w'.repeat(240));
    const long = (platform: NodeJS.Platform) =>
      createContinueWorktree({ repoPath: repo, origin: ORIGIN, branch: 'feat', head, sub: 'apps', continueId: ID }, { ...opts(), platform });
    expect(await long('win32')).toMatchObject({ ok: false, code: 'path-too-long' });
    expect(tipOf('feat')).toBeNull();
    const other = await long('darwin');
    // Git on Windows cannot use a folder this long (core.longpaths is off), so there only the limit's absence is checked.
    if (process.platform === 'win32') expect(other).not.toMatchObject({ code: 'path-too-long' });
    else expect(other).toMatchObject({ ok: true });
  });
});

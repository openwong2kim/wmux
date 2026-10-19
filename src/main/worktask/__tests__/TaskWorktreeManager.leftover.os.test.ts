// ─── #2388: a task worktree's removal after its panes are stopped ──────────
//
// The status is read again after the panes stop; a folder `git worktree
// remove` leaves behind after dropping the worktree's record is finished only
// by the second layer, under its checks (inside the worktrees root by its
// canonical path, git confirming by file identity that it is no longer a
// worktree, contents matching the commit found clean); a removal that cannot
// finish stays recorded for a later close. git is faked where the point is a
// decision, and real where the point is what git does to a held folder.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { TaskWorktreeManager, type RunGitOptions } from '../TaskWorktreeManager';
import { PendingWorktreeRemovals, sweepPendingRemovals } from '../pendingWorktreeRemovals';

const HEAD = 'a'.repeat(40);
const onWindows = process.platform === 'win32';

let tmp: string;
let root: string;
let repo: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-leftover-test-')));
  root = path.join(tmp, 'home', '.wmux', 'worktrees');
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(root, 'hash1'), { recursive: true });
  fs.mkdirSync(repo);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A folder under the root, as `git worktree remove` leaves one: some files left. */
function leftover(rel = 'hash1/task-a'): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x');
  return dir;
}

interface FakeGitOpts {
  /** What `worktree list --porcelain` names besides the repository. */
  listed?: string[];
  /** Whether the list names the repository itself. */
  namesRepo?: boolean;
  /** The repository the list names (default: the test's repo). */
  repoPath?: string;
  /** Status lines of the worktree before / after the panes stopped. */
  statusBefore?: string;
  statusAfter?: string;
  /** The leftover against the recorded commit: `diff-files --name-status`
   *  and the untracked files. */
  leftoverDiff?: string;
  leftoverUntracked?: string;
  /** `worktree remove` fails and drops the record. */
  removeFails?: boolean;
}

function fakeGit(o: FakeGitOpts = {}) {
  const calls: string[][] = [];
  let stopped = false;
  const git = vi.fn(async (args: string[], _cwd: string, _opts?: RunGitOptions) => {
    calls.push(args);
    const out = (stdout: string) => ({ stdout, stderr: '' });
    if (args.includes('read-tree')) return out('');
    if (args.some((a) => a.startsWith('--work-tree=')) && args.includes('diff-files')) return out(o.leftoverDiff ?? 'D\tsrc/b.ts\n');
    if (args.some((a) => a.startsWith('--work-tree=')) && args.includes('ls-files')) return out(o.leftoverUntracked ?? '');
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return out(`${HEAD}\n`);
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return out(`${path.join(repo, '.git')}\n`);
    if (args[0] === 'status') return out((stopped ? o.statusAfter : o.statusBefore) ?? '');
    if (args[0] === 'worktree' && args[1] === 'list') {
      const entries = [...(o.namesRepo === false ? [] : [o.repoPath ?? repo]), ...(o.listed ?? [])];
      return out(entries.map((p) => `worktree ${p.replace(/\\/g, '/')}\nHEAD ${HEAD}\n`).join('\n'));
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      if (o.removeFails) throw new Error(`error: failed to delete '${args[args.length - 1]}': Permission denied`);
      fs.rmSync(args[args.length - 1], { recursive: true, force: true });
    }
    return out('');
  });
  return { git, calls, markStopped: () => { stopped = true; } };
}

/** The 8.3 short spelling of `dir` (the same when 8.3 names are off). */
function shortName(dir: string): string {
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${dir}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
}

function manager(git: ReturnType<typeof fakeGit>['git'], extra: { pendingRemovals?: PendingWorktreeRemovals; removeTree?: (d: string, r: string) => Promise<void> } = {}) {
  const removeTree = vi.fn(extra.removeTree ?? (async (d: string) => { fs.rmSync(d, { recursive: true, force: true }); }));
  const mgr = new TaskWorktreeManager({ runGit: git, worktreesRoot: root, removeTree, pendingRemovals: extra.pendingRemovals });
  return { mgr, removeTree };
}

describe('the status is read again once the panes are stopped', () => {
  it('a worktree a stopped pane wrote to is kept as dirty, and nothing is removed', async () => {
    const dir = leftover();
    const g = fakeGit({ statusBefore: '', statusAfter: '?? late.txt\n' });
    const { mgr } = manager(g.git);
    const res = await mgr.removeWorktree(repo, 'hash1', dir, async () => g.markStopped());
    expect(res).toMatchObject({ ok: false, preserved: true, dirty: true });
    expect(g.calls.some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('compares a leftover with the commit the stopped panes made, not the one before', async () => {
    const dir = leftover();
    const later = 'b'.repeat(40);
    const g = fakeGit({ removeFails: true });
    const git = vi.fn(async (args: string[], cwd: string, opts?: RunGitOptions) => {
      if (args[0] === 'rev-parse' && args.includes('HEAD') && stopped) return { stdout: `${later}\n`, stderr: '' };
      return g.git(args, cwd, opts);
    });
    let stopped = false;
    const store = new PendingWorktreeRemovals(path.join(tmp, 'wmux', 'worktask', 'pending-removals.json'));
    let locked = true;
    const { mgr } = manager(git as unknown as ReturnType<typeof fakeGit>['git'], {
      pendingRemovals: store,
      removeTree: async (d) => {
        if (locked) throw new Error('EBUSY');
        fs.rmSync(d, { recursive: true, force: true });
      },
    });
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => { stopped = true; })).toMatchObject({ ok: false });
    expect(store.get(dir)?.head).toBe(later);
    locked = false;
    expect(await mgr.finishPendingRemoval(dir)).toEqual({ ok: true });
    expect(git.mock.calls.some(([a]) => a.includes('read-tree') && a.includes(later))).toBe(true);
  });

  it('a worktree still clean after the stop is removed', async () => {
    const dir = leftover();
    const g = fakeGit();
    const { mgr } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => g.markStopped())).toEqual({ ok: true });
    expect(g.calls.filter((a) => a[0] === 'status')).toHaveLength(2);
  });
});

describe('second layer: a folder git left after dropping the worktree', () => {
  it('is deleted from the trusted root when every check holds', async () => {
    const dir = leftover();
    const g = fakeGit({ removeFails: true });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toEqual({ ok: true });
    expect(removeTree).toHaveBeenCalledWith(dir, root);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('never in force mode: no clean check happened', async () => {
    const dir = leftover();
    const g = fakeGit({ removeFails: true });
    const { mgr, removeTree } = manager(g.git);
    const res = await mgr.removeWorktree(repo, 'hash1', dir, undefined, { force: true });
    expect(res).toMatchObject({ ok: false, preserved: true });
    expect(g.calls.some((a) => a[1] === 'remove' && a.includes('--force'))).toBe(true);
    expect(removeTree).not.toHaveBeenCalled();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('never outside the worktrees root', async () => {
    const dir = path.join(tmp, 'elsewhere', 'task-a');
    fs.mkdirSync(dir, { recursive: true });
    const g = fakeGit({ removeFails: true });
    const { mgr, removeTree } = manager(g.git);
    const res = await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined);
    expect(res).toMatchObject({ ok: false, preserved: true });
    if (!res.ok) expect(res.error).toMatch(/not inside the wmux worktrees folder/);
    expect(removeTree).not.toHaveBeenCalled();
  });

  it('never the root itself', async () => {
    const g = fakeGit({ removeFails: true });
    const { mgr, removeTree } = manager(g.git);
    const res = await mgr.removeWorktree(repo, 'hash1', root, async () => undefined);
    expect(res).toMatchObject({ ok: false, preserved: true });
    expect(removeTree).not.toHaveBeenCalled();
    expect(fs.existsSync(root)).toBe(true);
  });

  it('never the repository, nor a folder holding it, even inside the root', async () => {
    const inner = path.join(root, 'hash1', 'repo-inside');
    fs.mkdirSync(inner, { recursive: true });
    const g = fakeGit({ removeFails: true, repoPath: inner });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(inner, 'hash1', inner, async () => undefined)).toMatchObject({ ok: false, preserved: true });
    expect(await mgr.removeWorktree(inner, 'hash1', path.join(root, 'hash1'), async () => undefined)).toMatchObject({ ok: false, preserved: true });
    expect(removeTree).not.toHaveBeenCalled();
  });

  it('never a folder that is a repository of its own (.git folder)', async () => {
    const dir = leftover();
    fs.mkdirSync(path.join(dir, '.git'));
    const g = fakeGit({ removeFails: true });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toMatchObject({ ok: false, preserved: true });
    expect(removeTree).not.toHaveBeenCalled();
  });

  it('never a folder whose .git file names a git dir that exists (the path reused for a live checkout)', async () => {
    const dir = leftover();
    const gitDir = path.join(tmp, 'other-repo', '.git', 'worktrees', 'x');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
    const g = fakeGit({ removeFails: true });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toMatchObject({ ok: false, preserved: true });
    expect(removeTree).not.toHaveBeenCalled();
  });

  it('a .git file naming the git dir git just deleted is the dropped worktree\'s marker', async () => {
    const dir = leftover();
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'task-a')}\n`);
    const g = fakeGit({ removeFails: true });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toEqual({ ok: true });
    expect(removeTree).toHaveBeenCalled();
  });

  it('never through a link or junction on the way that leads out of the root', async () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(outside, 'task-a', 'src'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'hash2'), 'junction');
    const g = fakeGit({ removeFails: true });
    const { mgr, removeTree } = manager(g.git);
    const res = await mgr.removeWorktree(repo, 'hash2', path.join(root, 'hash2', 'task-a'), async () => undefined);
    expect(res).toMatchObject({ ok: false, preserved: true });
    expect(removeTree).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(outside, 'task-a', 'src'))).toBe(true);
  });

  it('never while git still lists it under another spelling (a junction alias)', async () => {
    const dir = leftover();
    const alias = path.join(tmp, 'alias');
    fs.symlinkSync(path.join(root, 'hash1'), alias, 'junction');
    const g = fakeGit({ removeFails: true, listed: [path.join(alias, 'task-a')] });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toMatchObject({ ok: false, preserved: true });
    expect(removeTree).not.toHaveBeenCalled();
  });

  it.skipIf(!onWindows)('never while git still lists it under its 8.3 short name', async () => {
    const dir = leftover('hash1/a-long-task-folder-name');
    const short = shortName(dir);
    if (short.toLowerCase() === dir.toLowerCase()) return; // 8.3 names off on this volume
    const g = fakeGit({ removeFails: true, listed: [short] });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toMatchObject({ ok: false, preserved: true });
    expect(removeTree).not.toHaveBeenCalled();
  });

  it.skipIf(!onWindows)('an 8.3 spelling of a folder inside the root is the folder inside the root', async () => {
    const dir = leftover('hash1/a-long-task-folder-name');
    const short = shortName(dir);
    const g = fakeGit({ removeFails: true });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', short, async () => undefined)).toEqual({ ok: true });
    expect(removeTree).toHaveBeenCalledWith(fs.realpathSync.native(root) + path.sep + path.join('hash1', 'a-long-task-folder-name'), fs.realpathSync.native(root));
  });

  it('never when git\'s list does not name the repository (an answer it cannot trust)', async () => {
    const dir = leftover();
    const g = fakeGit({ removeFails: true, namesRepo: false });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toMatchObject({ ok: false, preserved: true });
    expect(removeTree).not.toHaveBeenCalled();
  });

  it('never when the leftover holds anything git did not leave (kept as dirty)', async () => {
    const dir = leftover();
    const g = fakeGit({ removeFails: true, leftoverDiff: 'D\tsrc/b.ts\nM\tsrc/a.ts\n' });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toMatchObject({ ok: false, preserved: true, dirty: true });
    expect(removeTree).not.toHaveBeenCalled();
  });

  it('never when the leftover holds a file git does not track', async () => {
    const dir = leftover();
    const g = fakeGit({ removeFails: true, leftoverUntracked: 'notes.md\n' });
    const { mgr, removeTree } = manager(g.git);
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toMatchObject({ ok: false, preserved: true, dirty: true });
    expect(removeTree).not.toHaveBeenCalled();
  });
});

describe('a removal that could not finish is recorded for a later close', () => {
  it('is persisted, and a later manager finishes it once the folder lets go', async () => {
    const dir = leftover();
    const file = path.join(tmp, 'wmux', 'worktask', 'pending-removals.json');
    const g = fakeGit({ removeFails: true });
    const store = new PendingWorktreeRemovals(file);
    let locked = true;
    const { mgr } = manager(g.git, {
      pendingRemovals: store,
      removeTree: async (d) => {
        if (locked) throw new Error('EBUSY: resource busy or locked');
        fs.rmSync(d, { recursive: true, force: true });
      },
    });
    const first = await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined);
    expect(first).toMatchObject({ ok: false, preserved: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).removals).toEqual([expect.objectContaining({ path: dir, repoRoot: repo, head: HEAD })]);

    // A new start: the record is read back from disk.
    locked = false;
    const reread = new PendingWorktreeRemovals(file);
    reread.load();
    const { mgr: later } = manager(g.git, { pendingRemovals: reread });
    const stop = vi.fn(async () => undefined);
    expect(await later.finishPendingRemoval(dir, stop)).toEqual({ ok: true });
    expect(stop).toHaveBeenCalledWith(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(reread.all()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).removals).toEqual([]);
  });

  it('a leftover that is kept anyway is never stopped: the checks run before the panes are', async () => {
    const dir = leftover();
    const store = new PendingWorktreeRemovals(path.join(tmp, 'wmux', 'worktask', 'pending-removals.json'));
    await store.put({ path: dir, repoRoot: repo, repoHash: 'hash1', head: HEAD, at: 1 });
    const { mgr, removeTree } = manager(fakeGit({ leftoverUntracked: 'notes.md\n' }).git, { pendingRemovals: store });
    const stop = vi.fn(async () => undefined);
    expect(await mgr.finishPendingRemoval(dir, stop)).toMatchObject({ ok: false, dirty: true });
    expect(stop).not.toHaveBeenCalled();
    expect(removeTree).not.toHaveBeenCalled();
  });

  it('a stop that refuses (a process of an earlier stop still runs) keeps the leftover', async () => {
    const dir = leftover();
    const store = new PendingWorktreeRemovals(path.join(tmp, 'wmux', 'worktask', 'pending-removals.json'));
    await store.put({ path: dir, repoRoot: repo, repoHash: 'hash1', head: HEAD, at: 1 });
    const { mgr, removeTree } = manager(fakeGit().git, { pendingRemovals: store });
    const res = await mgr.finishPendingRemoval(dir, async () => { throw new Error('1 process(es) started in the worktree are still running'); });
    expect(res).toMatchObject({ ok: false, preserved: true });
    expect(removeTree).not.toHaveBeenCalled();
    expect(store.get(dir)).not.toBeNull();
  });

  it('the sweep at start finishes it, but not while a session was started in it or recovery runs', async () => {
    const dir = leftover();
    const store = new PendingWorktreeRemovals(path.join(tmp, 'wmux', 'worktask', 'pending-removals.json'));
    await store.put({ path: dir, repoRoot: repo, repoHash: 'hash1', head: HEAD, at: 1 });
    const { mgr } = manager(fakeGit().git, { pendingRemovals: store });
    const ports = (sessions: Array<{ id: string; spawnCwd?: string }>, recoveryDone = true) => ({
      paths: () => mgr.pendingRemovalPaths(),
      sessions: async () => ({ sessions, recoveryDone }),
      startedIn: async (folder: string, list: Array<{ id: string; spawnCwd?: string }>) => list.filter((s) => s.spawnCwd?.startsWith(folder)).map((s) => s.id),
      finish: (folder: string) => mgr.finishPendingRemoval(folder),
    });
    expect(await sweepPendingRemovals(ports([], false))).toBe(false);
    expect(await sweepPendingRemovals(ports([{ id: 's', spawnCwd: dir }]))).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
    expect(await sweepPendingRemovals(ports([]))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(store.all()).toEqual([]);
  });

  // Every reason the sweep at start keeps a folder: the folder and its
  // record stay, and one line says why.
  describe('the sweep at start keeps the folder and its record when a check cannot be proven', () => {
    type Case = {
      why: string;
      log: RegExp;
      git?: FakeGitOpts;
      sessions?: Array<{ id: string; spawnCwd?: string; cwd?: string }>;
      recoveryDone?: boolean;
      setup?: (dir: string) => { path?: string };
      removeTree?: (d: string) => Promise<void>;
    };
    const cases: Case[] = [
      { why: 'the daemon is still recovering', recoveryDone: false, log: /still recovering/ },
      { why: 'a session was started in it', sessions: [{ id: 's', spawnCwd: 'DIR' }], log: /were started or work in it/ },
      { why: 'a session works in it now (its cwd)', sessions: [{ id: 's', spawnCwd: '/elsewhere', cwd: 'DIR' }], log: /were started or work in it/ },
      { why: 'it is outside the worktrees root', setup: () => {
        const out = path.join(tmp, 'elsewhere', 'task-a');
        fs.mkdirSync(out, { recursive: true });
        return { path: out };
      }, log: /not inside the wmux worktrees folder/ },
      { why: 'git does not name the repository', git: { namesRepo: false }, log: /git did not confirm/ },
      { why: 'git still lists it', setup: () => ({}), git: { listed: ['DIR'] }, log: /worktree of its repository again/ },
      { why: 'its contents differ from the recorded commit', git: { leftoverDiff: 'M\tsrc/a.ts\n' }, log: /not what git left/ },
      { why: 'a file git does not track is in it', git: { leftoverUntracked: 'notes.md\n' }, log: /not what git left/ },
      { why: 'its .git file names a live git dir', setup: (dir) => {
        const gitDir = path.join(tmp, 'other', '.git');
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
        return {};
      }, log: /live checkout/ },
      { why: 'the folder cannot be deleted', removeTree: async () => { throw new Error('EBUSY: resource busy or locked'); }, log: /could not be deleted: EBUSY/ },
    ];
    for (const c of cases) {
      it(c.why, async () => {
        const made = leftover();
        const dir = c.setup?.(made).path ?? made;
        const sub = (v: string): string => (v === 'DIR' ? dir : v);
        const store = new PendingWorktreeRemovals(path.join(tmp, 'wmux', 'worktask', 'pending-removals.json'));
        await store.put({ path: dir, repoRoot: repo, repoHash: 'hash1', head: HEAD, at: 1 });
        const git = fakeGit({ ...c.git, ...(c.git?.listed ? { listed: c.git.listed.map(sub) } : {}) }).git;
        const { mgr, removeTree } = manager(git, { pendingRemovals: store, ...(c.removeTree ? { removeTree: c.removeTree } : {}) });
        const lines: string[] = [];
        const sessions = (c.sessions ?? []).map((x) => ({ ...x, ...(x.spawnCwd ? { spawnCwd: sub(x.spawnCwd) } : {}), ...(x.cwd ? { cwd: sub(x.cwd) } : {}) }));
        await sweepPendingRemovals({
          paths: () => mgr.pendingRemovalPaths(),
          sessions: async () => ({ sessions, recoveryDone: c.recoveryDone ?? true }),
          startedIn: async (folder, list) => list.filter((x) => [x.spawnCwd, x.cwd].some((d) => d?.startsWith(folder))).map((x) => x.id),
          finish: (folder) => mgr.finishPendingRemoval(folder),
          log: (m) => lines.push(m),
        });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(c.log);
        expect(fs.existsSync(dir)).toBe(true);
        if (!c.removeTree) expect(removeTree).not.toHaveBeenCalled();
        // A folder git still lists is a worktree again: its pending record ends.
        if (c.git?.listed) expect(store.get(dir)).toBeNull();
        else expect(store.get(dir)).not.toBeNull();
      });
    }
  });

  it('a removal that finished forgets its record', async () => {
    const dir = leftover();
    const store = new PendingWorktreeRemovals(path.join(tmp, 'wmux', 'worktask', 'pending-removals.json'));
    const { mgr } = manager(fakeGit().git, { pendingRemovals: store });
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toEqual({ ok: true });
    expect(store.all()).toEqual([]);
  });
});

// Real git, any platform: a leftover of a task whose branch moved past the
// repository's own HEAD is compared with the task's commit, not with that HEAD.
describe("real git: the leftover is compared with the task's own commit", () => {
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

  /** A task worktree with a commit of its own, then dropped by git with
   *  part of it left in the folder (what a failed `git worktree remove` leaves). */
  function droppedWorktree(slug: string): { dir: string; head: string } {
    if (!fs.existsSync(path.join(repo, '.git'))) {
      fs.mkdirSync(repo, { recursive: true });
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
      run(repo, 'init');
      run(repo, 'add', '.');
      run(repo, 'commit', '-m', 'one');
    }
    const dir = path.join(root, 'hash1', slug);
    run(repo, 'worktree', 'add', dir, '-b', `wtask/${slug}`);
    fs.mkdirSync(path.join(dir, 'kept'));
    fs.writeFileSync(path.join(dir, 'kept', 'task.ts'), 'task work');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed by the task');
    run(dir, 'add', '.');
    run(dir, 'commit', '-m', 'task');
    const head = run(dir, 'rev-parse', 'HEAD');
    // git drops the record (its admin folder) and deletes part of the folder.
    fs.rmSync(path.join(repo, '.git', 'worktrees', slug), { recursive: true, force: true });
    fs.rmSync(path.join(dir, '.git'));
    fs.rmSync(path.join(dir, 'a.txt'));
    return { dir, head };
  }

  async function finish(dir: string, head: string): Promise<unknown> {
    const store = new PendingWorktreeRemovals(path.join(tmp, 'wmux', 'worktask', `${path.basename(dir)}.json`));
    await store.put({ path: dir, repoRoot: repo, repoHash: 'hash1', head, at: 1 });
    return new TaskWorktreeManager({ worktreesRoot: root, pendingRemovals: store }).finishPendingRemoval(dir);
  }

  it('a clean leftover is removed, the branch kept', { timeout: 60_000 }, async () => {
    const { dir, head } = droppedWorktree('task-d');
    expect(await finish(dir, head)).toEqual({ ok: true });
    expect(fs.existsSync(dir)).toBe(false);
    expect(run(repo, 'rev-parse', 'refs/heads/wtask/task-d')).toBe(head);
  });

  it('a file the task ignored is still ignored once git deleted the ignore file', { timeout: 60_000 }, async () => {
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, '.gitignore'), 'deps/\n');
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', '.gitignore'), '*.log\n');
    fs.writeFileSync(path.join(repo, 'sub', 'keep.txt'), 'k');
    const { dir, head } = droppedWorktree('task-g');
    fs.mkdirSync(path.join(dir, 'deps', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'deps', 'pkg', 'index.js'), 'dependency');
    fs.writeFileSync(path.join(dir, 'sub', 'run.log'), 'log');
    // What git deleted before it stopped: the ignore files among them.
    fs.rmSync(path.join(dir, '.gitignore'));
    fs.rmSync(path.join(dir, 'sub', '.gitignore'));
    expect(await finish(dir, head)).toEqual({ ok: true });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a leftover with a changed or a new file is kept as dirty', { timeout: 60_000 }, async () => {
    for (const [slug, change] of [['task-e', 'kept/task.ts'], ['task-f', 'kept/new.ts']] as const) {
      const { dir, head } = droppedWorktree(slug);
      fs.writeFileSync(path.join(dir, change), 'written after git dropped it');
      expect(await finish(dir, head)).toMatchObject({ ok: false, dirty: true });
      expect(fs.readFileSync(path.join(dir, change), 'utf8')).toBe('written after git dropped it');
    }
  });
});

// What git really does to a worktree a process still holds (Windows): the
// first `git worktree remove` drops the record and fails on the folder.
describe.skipIf(!onWindows)('real git: a worktree a process still holds', () => {
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill();
  });

  /** A process (started by this test) whose current folder is `dir`. */
  async function hold(dir: string): Promise<ChildProcess> {
    const c = spawn('ping.exe', ['-n', '60', '127.0.0.1'], { cwd: dir, windowsHide: true, stdio: 'ignore' });
    children.push(c);
    // Its current folder is set when it is created.
    await new Promise((r) => c.once('spawn', r));
    return c;
  }
  async function release(c: ChildProcess): Promise<void> {
    const exited = new Promise((r) => c.once('exit', r));
    c.kill();
    await exited;
  }

  it('the second layer finishes the leftover once the holder is gone, on the first close', { timeout: 60_000 }, async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    run(repo, 'init');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'one');
    const dir = path.join(root, 'hash1', 'task-a');
    run(repo, 'worktree', 'add', dir, '-b', 'wtask/a');
    fs.mkdirSync(path.join(dir, 'held'));
    let holder: ChildProcess | null = null;
    const realGit = vi.fn(async (args: string[], cwd: string, opts?: RunGitOptions) => {
      const { execFile } = await import('node:child_process');
      const r = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile('git', args, { cwd, env: { ...process.env, ...(opts?.env ?? {}) } }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })));
      }).catch(async (err: unknown) => {
        // The removal failed on the held folder: the holder exits after.
        if (args[0] === 'worktree' && args[1] === 'remove' && holder) await release(holder);
        throw err;
      });
      return r;
    });
    const store = new PendingWorktreeRemovals(path.join(tmp, 'wmux', 'worktask', 'pending-removals.json'));
    const mgr = new TaskWorktreeManager({ runGit: realGit, worktreesRoot: root, pendingRemovals: store });
    const res = await mgr.removeWorktree(repo, 'hash1', dir, async () => { holder = await hold(path.join(dir, 'held')); });
    expect(realGit.mock.calls.some(([a]) => a[0] === 'worktree' && a[1] === 'remove')).toBe(true);
    expect(res).toEqual({ ok: true });
    expect(fs.existsSync(dir)).toBe(false);
    expect(run(repo, 'worktree', 'list', '--porcelain')).not.toContain('task-a');
    expect(run(repo, 'rev-parse', '--verify', 'refs/heads/wtask/a')).toMatch(/^[0-9a-f]{40}$/);
    expect(store.all()).toEqual([]);
  });

  it('a leftover still held is kept and recorded; a later close finishes it', { timeout: 60_000 }, async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    run(repo, 'init');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'one');
    const dir = path.join(root, 'hash1', 'task-b');
    run(repo, 'worktree', 'add', dir, '-b', 'wtask/b');
    fs.mkdirSync(path.join(dir, 'held'));
    const file = path.join(tmp, 'wmux', 'worktask', 'pending-removals.json');
    const store = new PendingWorktreeRemovals(file);
    const mgr = new TaskWorktreeManager({ worktreesRoot: root, pendingRemovals: store });
    const holder = await hold(path.join(dir, 'held'));
    const res = await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined);
    expect(res).toMatchObject({ ok: false, preserved: true });
    expect(fs.existsSync(dir)).toBe(true);
    // git dropped the record: the folder is no longer a worktree.
    expect(run(repo, 'worktree', 'list', '--porcelain')).not.toContain('task-b');
    expect(store.get(dir)).toMatchObject({ repoRoot: repo });

    await release(holder);
    const reread = new PendingWorktreeRemovals(file);
    reread.load();
    const later = new TaskWorktreeManager({ worktreesRoot: root, pendingRemovals: reread });
    expect(await later.finishPendingRemoval(dir)).toEqual({ ok: true });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a leftover a file was written to is kept as dirty', { timeout: 60_000 }, async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    run(repo, 'init');
    run(repo, 'add', '.');
    run(repo, 'commit', '-m', 'one');
    const dir = path.join(root, 'hash1', 'task-c');
    run(repo, 'worktree', 'add', dir, '-b', 'wtask/c');
    fs.mkdirSync(path.join(dir, 'held'));
    const store = new PendingWorktreeRemovals(path.join(tmp, 'wmux', 'worktask', 'pending-removals.json'));
    const mgr = new TaskWorktreeManager({ worktreesRoot: root, pendingRemovals: store });
    const holder = await hold(path.join(dir, 'held'));
    expect(await mgr.removeWorktree(repo, 'hash1', dir, async () => undefined)).toMatchObject({ ok: false });
    await release(holder);
    // Written after git dropped the worktree: never deleted.
    fs.writeFileSync(path.join(dir, 'held', 'notes.md'), 'unsaved work');
    expect(await mgr.finishPendingRemoval(dir)).toMatchObject({ ok: false, dirty: true });
    expect(fs.readFileSync(path.join(dir, 'held', 'notes.md'), 'utf8')).toBe('unsaved work');
  });
});

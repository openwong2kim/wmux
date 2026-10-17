// An ended bot task's folder goes once nothing runs in it and nothing in it
// is uncommitted; its branch stays, and a resume puts it back at the same
// path. Nothing that is not a bot task's own folder is ever touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { TaskWorktreeManager } from '../../worktask/TaskWorktreeManager';
import {
  TASK_FOLDERS_KEPT_MAX,
  TASK_FOLDERS_MAX,
  TASK_FOLDER_KEPT_TTL_MS,
  TASK_FOLDER_RESTORE_HOLD_MS,
  TaskFolders,
  cleanTaskFolder,
  cleanTaskFolders,
  forgetKeptFolder,
  gitRepoInfo,
  holdTaskFolder,
  gitWorktreeRegistered,
  installTaskFolderCleanup,
  noteKeptFolderStopped,
  removeTreeNoFollow,
  MountPointError,
  parseMountInfo,
  removeEmptyResearchBatch,
  restoreTaskFolder,
  taskFolderKind,
  taskFolderUsage,
  type TaskFolderPorts,
  type TaskMission,
} from '../taskFolderCleanup';
import { ReclaimedWorkers, resumeWorker, type ReclaimedWorker, type WorkerResumePorts } from '../workerReclaim';

// Every test here runs real git over real worktrees, several spawns in a
// row; on a loaded CI runner (the Windows shard) one spawn can take a few
// hundred ms, so the file's tests and its waits are bounded here, not by
// vitest's 5s / 1s defaults. Seen as "expected undefined to be 'kept_dirty'"
// on main four times in a day before the waits were widened.
vi.setConfig({ testTimeout: 30_000 });

const BOT = 'bot-0000000a';
const UUID = '2eca904b-b4cc-4243-81d3-67a121351892';

function row(status: LedgerEntry['status'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: 'wtask-abc-12345678', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'perf-A',
    status, rev: 3, updatedAt: 1_000, updatedBy: { kind: 'brain', workspaceId: 'ws-owner' },
    dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default' },
    ...over,
  };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

let dir: string;
let home: string;
let wmuxDir: string;
let repo: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-folders-')));
  home = path.join(dir, 'home');
  wmuxDir = path.join(dir, 'data');
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-m', 'one');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const roots = () => ({ worktrees: path.join(home, 'worktrees'), wmuxDir });

/** A bot task worktree, made as the fan-out makes it, with one commit. */
async function taskWorktree(mgr: TaskWorktreeManager, slug = 'perf-a-12345678'): Promise<string> {
  const wt = path.join(home, 'worktrees', 'h', slug);
  const r = await mgr.createWorktree({ repoRoot: repo, repoHash: 'h', taskSlug: slug, metaDir: path.join(dir, 'meta'), worktreePath: wt, branch: `wtask/${slug}` });
  if (!r.ok) throw new Error(r.error);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'work');
  git(wt, 'add', 'a.txt');
  git(wt, 'commit', '-m', 'task work');
  return wt;
}

function ports(over: Partial<TaskFolderPorts> = {}, missions: Map<string, TaskMission> = new Map()): TaskFolderPorts {
  return {
    store: TaskFolders.at(wmuxDir),
    roots: roots(),
    missions: async () => missions,
    listSessions: async () => [],
    workerState: () => 'stopped',
    worktrees: new TaskWorktreeManager(),
    repoInfo: gitRepoInfo,
    now: () => 50_000,
    log: () => undefined,
    ...over,
  };
}

describe('taskFolderKind: only a bot task\'s own folder', () => {
  it('a task worktree under the worktree root on a wtask/ branch, or a task folder under the bot\'s research root', () => {
    const r = roots();
    expect(taskFolderKind(path.join(r.worktrees, 'h', 'slug'), 'wtask/slug', BOT, r)).toBe('worktree');
    expect(taskFolderKind(path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-1', 'task-1'), undefined, BOT, r)).toBe('research');
  });

  it('never an owner\'s branch, the roots themselves, another bot\'s research, a phone or a hand-made worktree', () => {
    const r = roots();
    expect(taskFolderKind(path.join(r.worktrees, 'h', 'slug'), 'feature/mine', BOT, r)).toBeNull();
    expect(taskFolderKind(r.worktrees, 'wtask/x', BOT, r)).toBeNull();
    expect(taskFolderKind(path.join(r.worktrees, 'h'), 'wtask/x', BOT, r)).toBeNull();
    expect(taskFolderKind(path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-1'), undefined, BOT, r)).toBeNull();
    expect(taskFolderKind(path.join(wmuxDir, 'factory', 'bots', 'bot-0000000b', 'research', 'b', 't'), undefined, BOT, r)).toBeNull();
    expect(taskFolderKind(path.join(home, 'phone-worktrees', 'x', 'y'), 'wtask/y', BOT, r)).toBeNull();
    expect(taskFolderKind(path.join(repo, '..', 'my-worktree'), 'wtask/y', BOT, r)).toBeNull();
    expect(taskFolderKind(path.join(r.worktrees, '..', 'worktrees-other', 'h', 's'), 'wtask/s', BOT, r)).toBeNull();
  });
});

describe('cleanTaskFolder', () => {
  it('removes a clean ended task\'s worktree (ignored files with it), keeps its branch, and puts it back at the same path', async () => {
    const mgr = new TaskWorktreeManager();
    const wt = await taskWorktree(mgr);
    const tip = git(wt, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.join(wt, 'node_modules'));
    fs.writeFileSync(path.join(wt, 'node_modules', 'x.js'), '1');
    const p = ports();
    const mission = { folder: wt, branch: 'wtask/perf-a-12345678' };
    expect(await cleanTaskFolder(p, row('completed'), mission, [])).toBe('removed');
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, 'rev-parse', 'refs/heads/wtask/perf-a-12345678')).toBe(tip);
    expect(p.store.get('wtask-abc-12345678')).toMatchObject({ kind: 'worktree', state: 'removed', branch: 'wtask/perf-a-12345678', path: wt });
    // Done once: a second look does nothing.
    expect(await cleanTaskFolder(p, row('completed'), mission, [])).toBe('skipped');

    expect(await restoreTaskFolder(p, 'wtask-abc-12345678', wt)).toBe(true);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wtask/perf-a-12345678');
    expect(p.store.get('wtask-abc-12345678')?.state).toBe('restored');
    // Only the path it was removed from.
    expect(await restoreTaskFolder(p, 'wtask-abc-12345678', path.join(dir, 'elsewhere'))).toBe(false);
  });

  it('keeps a worktree with uncommitted changes, never removes it automatically, and Clean up now removes it once it is clean', async () => {
    const mgr = new TaskWorktreeManager();
    const wt = await taskWorktree(mgr);
    fs.writeFileSync(path.join(wt, 'draft.txt'), 'not committed');
    const changed = vi.fn();
    const p = ports({ changed });
    const mission = { folder: wt, branch: 'wtask/perf-a-12345678' };
    expect(await cleanTaskFolder(p, row('cancelled'), mission, [])).toBe('kept_dirty');
    expect(fs.existsSync(path.join(wt, 'draft.txt'))).toBe(true);
    expect(p.store.get('wtask-abc-12345678')?.state).toBe('kept_dirty');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await cleanTaskFolder(p, row('cancelled'), mission, [])).toBe('skipped');
    // Clean up now looks again: still dirty, still kept.
    expect(await cleanTaskFolder(p, row('cancelled'), mission, [], { force: true })).toBe('kept_dirty');
    git(wt, 'add', 'draft.txt');
    git(wt, 'commit', '-m', 'saved');
    expect(await cleanTaskFolder(p, row('cancelled'), mission, [], { force: true })).toBe('removed');
    expect(fs.existsSync(wt)).toBe(false);
  });

  it('waits while a pane or process uses the folder, or the worker was resumed or is stopping', async () => {
    const wt = await taskWorktree(new TaskWorktreeManager());
    const mission = { folder: wt, branch: 'wtask/perf-a-12345678' };
    expect(await cleanTaskFolder(ports(), row('failed'), mission, [{ id: 'daemon-1', spawnCwd: wt }])).toBe('busy');
    expect(await cleanTaskFolder(ports(), row('failed'), mission, [{ id: 'daemon-2', spawnCwd: dir, cwd: path.join(wt, 'src') }])).toBe('busy');
    expect(await cleanTaskFolder(ports({ workerState: () => 'resumed' }), row('completed'), mission, [])).toBe('skipped');
    expect(await cleanTaskFolder(ports({ workerState: () => 'stopping' }), row('completed'), mission, [])).toBe('skipped');
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('never touches an open task, an owner\'s fan-out, or a folder outside the bot roots', async () => {
    const wt = await taskWorktree(new TaskWorktreeManager());
    const mission = { folder: wt, branch: 'wtask/perf-a-12345678' };
    expect(await cleanTaskFolder(ports(), row('review_requested'), mission, [])).toBe('skipped');
    expect(await cleanTaskFolder(ports(), row('completed', { dispatch: { origin: { kind: 'pane' }, preset: 'default' } }), mission, [])).toBe('skipped');
    // A worktree made by hand next to the repository, on a task-like branch.
    const manual = path.join(dir, 'manual');
    git(repo, 'worktree', 'add', manual, '-b', 'wtask/manual');
    expect(await cleanTaskFolder(ports(), row('completed'), { folder: manual, branch: 'wtask/manual' }, [])).toBe('skipped');
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(manual)).toBe(true);
  });

  it('removes an ended research task\'s scratch folder, and a resume makes an empty one at the same path', async () => {
    const scratch = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-1', 'task-1');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'notes.md'), 'found it');
    const p = ports();
    const research = row('completed', { dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' } });
    expect(await cleanTaskFolder(p, research, { folder: scratch }, [])).toBe('removed');
    expect(fs.existsSync(scratch)).toBe(false);
    // Its batch held nothing else: it went too.
    expect(fs.existsSync(path.dirname(scratch))).toBe(false);
    expect(await restoreTaskFolder(p, research.id, scratch)).toBe(true);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('removes a research batch once its task folders are gone and its .meta holds only removed tasks; never while a task of it is open', async () => {
    const batch = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-2');
    const one = path.join(batch, '1-claude-11111111');
    const two = path.join(batch, '2-claude-22222222');
    for (const f of [one, two, path.join(batch, '.meta', '1-claude-11111111'), path.join(batch, '.meta', '2-claude-22222222')]) fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(batch, '.meta', '1-claude-11111111', 'prompt.md'), 'look');
    const p = ports();
    const research = (id: string) => row('completed', { id, dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' } });
    // The first ends: the second task's folder (and its .meta) keep the batch.
    expect(await cleanTaskFolder(p, research('wtask-one-11111111'), { folder: one }, [])).toBe('removed');
    expect(fs.existsSync(batch)).toBe(true);
    // The second's folder gone by hand, its task still open: its .meta keeps the batch.
    fs.rmSync(two, { recursive: true });
    const third = path.join(batch, '3-claude-33333333');
    fs.mkdirSync(third);
    expect(await cleanTaskFolder(p, research('wtask-three-33333333'), { folder: third }, [])).toBe('removed');
    expect(fs.existsSync(path.join(batch, '.meta', '2-claude-22222222'))).toBe(true);
    // Once that task ended and was handled, the next removal in the batch takes it.
    await p.store.put({ taskId: 'wtask-two-22222222', kind: 'research', path: two, state: 'removed', at: 1 });
    const fourth = path.join(batch, '4-claude-44444444');
    fs.mkdirSync(fourth);
    expect(await cleanTaskFolder(p, research('wtask-four-44444444'), { folder: fourth }, [])).toBe('removed');
    expect(fs.existsSync(batch)).toBe(false);
  });
});

describe('review safeguards', () => {
  it('a resume holding the folder keeps it; a hold taken during a removal waits for it, then the folder comes back', async () => {
    const mgr = new TaskWorktreeManager();
    const wt = await taskWorktree(mgr);
    let entered: () => void = () => undefined;
    const removalStarted = new Promise<void>((resolve) => { entered = resolve; });
    const p = ports({
      worktrees: {
        removeWorktree: async (root, hash, folder) => {
          entered();
          return mgr.removeWorktree(root, hash, folder);
        },
        restoreWorktree: (root, hash, folder, ref, detached) => mgr.restoreWorktree(root, hash, folder, ref, detached),
      },
    });
    const mission = { folder: wt, branch: 'wtask/perf-a-12345678' };
    const release = await holdTaskFolder('wtask-abc-12345678');
    try {
      expect(await cleanTaskFolder(p, row('completed'), mission, [])).toBe('skipped');
    } finally {
      release();
    }
    // A removal already past its checks: the resume's hold waits for it.
    const removing = cleanTaskFolder(p, row('completed'), mission, []);
    await removalStarted;
    const held = await holdTaskFolder('wtask-abc-12345678');
    try {
      expect(fs.existsSync(wt)).toBe(false);
      expect(await removing).toBe('removed');
      expect(await restoreTaskFolder(p, 'wtask-abc-12345678', wt)).toBe(true);
    } finally {
      held();
    }
  });

  it('waits while a gate runs on the task; leaves a detached task\'s worktree to the owner', async () => {
    const wt = await taskWorktree(new TaskWorktreeManager());
    const mission = { folder: wt, branch: 'wtask/perf-a-12345678' };
    expect(await cleanTaskFolder(ports({ gateRunning: () => true }), row('cancelled'), mission, [])).toBe('busy');
    expect(await cleanTaskFolder(ports(), row('cancelled'), { ...mission, detached: true }, [])).toBe('skipped');
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('never removes through a link: a research batch replaced by a link to elsewhere is left alone', async () => {
    const outside = path.join(dir, 'outside', 'task-1');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep');
    const research = path.join(wmuxDir, 'factory', 'bots', BOT, 'research');
    fs.mkdirSync(research, { recursive: true });
    fs.symlinkSync(path.dirname(outside), path.join(research, 'batch-1'), 'dir');
    const scratch = path.join(research, 'batch-1', 'task-1');
    const research_row = row('completed', { dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' } });
    expect(await cleanTaskFolder(ports(), research_row, { folder: scratch }, [])).toBe('skipped');
    expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
    // Nor its batch, emptied or not, nor a folder deeper than one batch.
    fs.rmSync(outside, { recursive: true });
    expect(removeEmptyResearchBatch(new TaskFolders(path.join(dir, 'tf.json')), path.join(research, 'batch-1'), research)).toBe(false);
    expect(fs.existsSync(path.dirname(outside))).toBe(true);
    const deep = path.join(research, 'batch-3', 'nested');
    fs.mkdirSync(deep, { recursive: true });
    expect(removeEmptyResearchBatch(new TaskFolders(path.join(dir, 'tf.json')), deep, research)).toBe(false);
    expect(fs.existsSync(deep)).toBe(true);
  });

  it('a detached checkout (a verify task) comes back on its commit; how to put it back is written before the folder goes', async () => {
    const mgr = new TaskWorktreeManager();
    const tip = git(repo, 'rev-parse', 'HEAD');
    const wt = path.join(home, 'worktrees', 'h', 'verify-1');
    expect((await mgr.createDetachedWorktree({ repoRoot: repo, repoHash: 'h', taskSlug: 'verify-1', metaDir: path.join(dir, 'meta'), worktreePath: wt, branch: 'wtask/verify-1' }, tip)).ok).toBe(true);
    const store = TaskFolders.at(wmuxDir);
    let stateAtRemoval: string | undefined;
    const p = ports({
      store,
      worktrees: {
        removeWorktree: async (root, hash, folder) => {
          stateAtRemoval = store.get('wtask-abc-12345678')?.state;
          return mgr.removeWorktree(root, hash, folder);
        },
        restoreWorktree: (root, hash, folder, ref, detached) => mgr.restoreWorktree(root, hash, folder, ref, detached),
      },
    });
    expect(await cleanTaskFolder(p, row('completed'), { folder: wt }, [])).toBe('removed');
    expect(stateAtRemoval).toBe('removing');
    expect(store.get('wtask-abc-12345678')).toMatchObject({ state: 'removed', head: tip });
    expect(await restoreTaskFolder(p, 'wtask-abc-12345678', wt)).toBe(true);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(tip);
  });

  it('a detached checkout with a commit no ref holds: the commit stays reachable from refs/wmux/keep/<taskId> after removal', async () => {
    const mgr = new TaskWorktreeManager();
    const base = git(repo, 'rev-parse', 'HEAD');
    const wt = path.join(home, 'worktrees', 'h', 'verify-2');
    expect((await mgr.createDetachedWorktree({ repoRoot: repo, repoHash: 'h', taskSlug: 'verify-2', metaDir: path.join(dir, 'meta'), worktreePath: wt, branch: 'wtask/verify-2' }, base)).ok).toBe(true);
    fs.writeFileSync(path.join(wt, 'fix.txt'), 'fix');
    git(wt, 'add', 'fix.txt');
    git(wt, 'commit', '-m', 'worker fix');
    const work = git(wt, 'rev-parse', 'HEAD');
    const p = ports();
    const verify = row('completed', { dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default', checkout: { sha: base, detached: true } } });
    expect(await cleanTaskFolder(p, verify, { folder: wt }, [])).toBe('removed');
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, 'rev-parse', 'refs/wmux/keep/wtask-abc-12345678')).toBe(work);
    expect(p.store.get('wtask-abc-12345678')).toMatchObject({ state: 'removed', head: work, keepRef: 'refs/wmux/keep/wtask-abc-12345678' });
    // gc cannot drop it now, and a resume comes back on it.
    git(repo, 'gc', '--prune=now', '--quiet');
    expect(git(repo, 'cat-file', '-t', work)).toBe('commit');
    expect(await restoreTaskFolder(p, 'wtask-abc-12345678', wt)).toBe(true);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(work);
  });

  it('a detached checkout with no new commits is removed as before, with no keep ref, even when no ref holds its commit', async () => {
    const mgr = new TaskWorktreeManager();
    // A fetched PR commit: in the repository, on no ref.
    git(repo, 'checkout', '-q', '-b', 'pr-tmp');
    fs.writeFileSync(path.join(repo, 'pr.txt'), 'pr');
    git(repo, 'add', 'pr.txt');
    git(repo, 'commit', '-m', 'pr');
    const pr = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'pr-tmp');
    const wt = path.join(home, 'worktrees', 'h', 'verify-3');
    expect((await mgr.createDetachedWorktree({ repoRoot: repo, repoHash: 'h', taskSlug: 'verify-3', metaDir: path.join(dir, 'meta'), worktreePath: wt, branch: 'wtask/verify-3' }, pr)).ok).toBe(true);
    const p = ports();
    const verify = row('completed', { dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default', checkout: { sha: pr, detached: true } } });
    expect(await cleanTaskFolder(p, verify, { folder: wt }, [])).toBe('removed');
    expect(fs.existsSync(wt)).toBe(false);
    expect(() => git(repo, 'rev-parse', '--verify', '--quiet', 'refs/wmux/keep/wtask-abc-12345678')).toThrow();
    expect(p.store.get('wtask-abc-12345678')).toMatchObject({ state: 'removed', head: pr });
    expect(p.store.get('wtask-abc-12345678')?.keepRef).toBeUndefined();
  });
});

describe('the automatic pass and Settings › Bots', () => {
  it('a folder put back for a resume is left alone while its pane opens, then removed again once its worker stopped', async () => {
    const wt = await taskWorktree(new TaskWorktreeManager());
    let now = 50_000;
    const p = ports({ now: () => now });
    const mission = { folder: wt, branch: 'wtask/perf-a-12345678' };
    await cleanTaskFolder(p, row('completed'), mission, []);
    await restoreTaskFolder(p, 'wtask-abc-12345678', wt);
    expect(await cleanTaskFolder(p, row('completed'), mission, [], { force: true })).toBe('skipped');
    now += TASK_FOLDER_RESTORE_HOLD_MS;
    expect(await cleanTaskFolder(p, row('completed'), mission, [])).toBe('removed');
  });

  it('runs on a bot task\'s end, over ended tasks of the last day; Clean up now counts what it did; usage sums the folders', async () => {
    const mgr = new TaskWorktreeManager();
    const clean = await taskWorktree(mgr, 'clean-11111111');
    const dirty = await taskWorktree(mgr, 'dirty-22222222');
    fs.writeFileSync(path.join(dirty, 'draft.txt'), 'x'.repeat(1000));
    const missions = new Map<string, TaskMission>([
      ['wtask-clean-11111111', { folder: clean, branch: 'wtask/clean-11111111' }],
      ['wtask-dirty-22222222', { folder: dirty, branch: 'wtask/dirty-22222222' }],
    ]);
    const rows = [
      row('completed', { id: 'wtask-clean-11111111', updatedAt: 49_000 }),
      row('failed', { id: 'wtask-dirty-22222222', updatedAt: 49_000 }),
    ];
    const p = ports({}, missions);
    const usage = await taskFolderUsage(p, rows);
    expect(usage.folders).toBe(2);
    expect(usage.bytes).toBeGreaterThan(1000);

    let listener: ((t: { entry: LedgerEntry; to: string }) => void) | null = null;
    const installed = installTaskFolderCleanup({ ...p, onTransition: (fn) => { listener = fn; return () => { listener = null; }; }, allRows: () => rows });
    await vi.waitFor(() => {
      expect(fs.existsSync(clean)).toBe(false);
      expect(p.store.get('wtask-dirty-22222222')?.state).toBe('kept_dirty');
    }, { timeout: 10_000 });
    expect(listener).not.toBeNull();
    installed.dispose();

    expect(await taskFolderUsage(p, rows)).toMatchObject({ folders: 1, dirty: 1 });
    expect(await cleanTaskFolders(p, rows, { force: true })).toEqual({ removed: 0, keptDirty: 1, busy: 0, failed: 0 });
    fs.rmSync(path.join(dirty, 'draft.txt'));
    expect(await cleanTaskFolders(p, rows, { force: true })).toEqual({ removed: 1, keptDirty: 0, busy: 0, failed: 0 });
    expect(await taskFolderUsage(p, rows)).toEqual({ bytes: 0, folders: 0, dirty: 0 });
  });

  it('a task the owner stopped keeps its worktree and research folder; another cancel does not; Clean up now still applies', async () => {
    const mgr = new TaskWorktreeManager();
    const stoppedWt = await taskWorktree(mgr, 'stop-33333333');
    const otherWt = await taskWorktree(mgr, 'other-44444444');
    const scratch = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-1', 'task-1');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'notes.md'), 'found it');
    const missions = new Map<string, TaskMission>([
      ['wtask-stop-33333333', { folder: stoppedWt, branch: 'wtask/stop-33333333' }],
      ['wtask-other-44444444', { folder: otherWt, branch: 'wtask/other-44444444' }],
      ['wtask-research-5555', { folder: scratch }],
    ]);
    // As factoryStop writes it: cancelled by the system, "stopped by owner".
    const stoppedBy = { summary: 'stopped by owner', updatedBy: { kind: 'system' as const, workspaceId: 'ws-daemon' }, updatedAt: 49_000 };
    const rows = [
      row('cancelled', { id: 'wtask-stop-33333333', ...stoppedBy }),
      row('cancelled', { id: 'wtask-research-5555', ...stoppedBy, dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' } }),
      row('cancelled', { id: 'wtask-other-44444444', updatedAt: 49_000 }),
    ];
    const p = ports({}, missions);
    const installed = installTaskFolderCleanup({ ...p, onTransition: () => () => undefined, allRows: () => rows });
    await vi.waitFor(() => expect(fs.existsSync(otherWt)).toBe(false), { timeout: 10_000 });
    installed.dispose();
    expect(fs.existsSync(path.join(stoppedWt, 'a.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(scratch, 'notes.md'), 'utf8')).toBe('found it');
    expect(p.store.get('wtask-stop-33333333')).toMatchObject({ state: 'kept_stopped', stopped: { botId: BOT } });
    expect(await cleanTaskFolder(p, rows[0], missions.get('wtask-stop-33333333')!, [])).toBe('skipped');
    expect(fs.existsSync(stoppedWt)).toBe(true);
    // The owner's Clean up now: the rules apply (a clean one goes, its branch stays).
    expect(await cleanTaskFolders(p, rows, { force: true })).toMatchObject({ removed: 2 });
    expect(fs.existsSync(stoppedWt)).toBe(false);
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/wtask/stop-33333333')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a folder a stop kept is recorded on disk, so usage and Clean up now still find it after the ledger pruned its row', async () => {
    const mgr = new TaskWorktreeManager();
    const cleanWt = await taskWorktree(mgr, 'keep-66666666');
    const dirtyWt = await taskWorktree(mgr, 'mess-77777777');
    fs.writeFileSync(path.join(dirtyWt, 'draft.txt'), 'x'.repeat(500));
    const scratch = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-2', 'task-2');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'notes.md'), 'found it');
    const missions = new Map<string, TaskMission>([
      ['wtask-keep-66666666', { folder: cleanWt, branch: 'wtask/keep-66666666' }],
      ['wtask-mess-77777777', { folder: dirtyWt, branch: 'wtask/mess-77777777' }],
      ['wtask-research-8888', { folder: scratch }],
    ]);
    const stoppedBy = { summary: 'stopped by owner', updatedBy: { kind: 'system' as const, workspaceId: 'ws-daemon' }, updatedAt: 49_000 };
    const rows = [
      row('cancelled', { id: 'wtask-keep-66666666', ...stoppedBy }),
      row('cancelled', { id: 'wtask-mess-77777777', ...stoppedBy }),
      row('cancelled', { id: 'wtask-research-8888', ...stoppedBy, dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' } }),
    ];
    const p = ports({}, missions);
    // The automatic pass keeps them and records each, with its bot.
    expect(await cleanTaskFolders(p, rows)).toEqual({ removed: 0, keptDirty: 0, busy: 0, failed: 0 });
    for (const id of ['wtask-keep-66666666', 'wtask-mess-77777777', 'wtask-research-8888']) {
      expect(p.store.get(id)).toMatchObject({ state: 'kept_stopped', stopped: { botId: BOT } });
    }
    expect(p.store.get('wtask-research-8888')).toMatchObject({ kind: 'research', path: scratch });

    // Past the retention window: the ledger pruned the rows (and the daemon
    // its missions), and wmux restarted (the records are read from disk).
    const later = ports({ store: TaskFolders.at(wmuxDir) }, new Map());
    later.store.load();
    expect(later.store.get('wtask-keep-66666666')?.state).toBe('kept_stopped');
    const usage = await taskFolderUsage(later, []);
    expect(usage.folders).toBe(3);
    expect(usage.bytes).toBeGreaterThan(500);
    // The automatic pass still leaves them alone.
    const installed = installTaskFolderCleanup({ ...later, onTransition: () => () => undefined, allRows: () => [] });
    await new Promise((r) => setTimeout(r, 50));
    installed.dispose();
    expect(fs.existsSync(cleanWt) && fs.existsSync(scratch)).toBe(true);

    // Clean up now: the clean worktree and the research folder go (the branch
    // stays); the dirty one is kept and still listed.
    expect(await cleanTaskFolders(later, [], { force: true })).toEqual({ removed: 2, keptDirty: 1, busy: 0, failed: 0 });
    expect(fs.existsSync(cleanWt)).toBe(false);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/wtask/keep-66666666')).toMatch(/^[0-9a-f]{40}$/);
    expect(later.store.get('wtask-keep-66666666')?.state).toBe('removed');
    expect(later.store.get('wtask-mess-77777777')).toMatchObject({ state: 'kept_dirty', stopped: { botId: BOT } });
    expect(await taskFolderUsage(later, [])).toMatchObject({ folders: 1, dirty: 1 });
    // Once committed, a later Clean up now finds it again and removes it.
    fs.rmSync(path.join(dirtyWt, 'draft.txt'));
    expect(await cleanTaskFolders(later, [], { force: true })).toMatchObject({ removed: 1 });
    expect(await taskFolderUsage(later, [])).toEqual({ bytes: 0, folders: 0, dirty: 0 });
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/wtask/mess-77777777')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a resumed worker using its kept folder again keeps the kept record, its 7 days started again', async () => {
    const mgr = new TaskWorktreeManager();
    const wt = await taskWorktree(mgr, 'back-99999999');
    const missions = new Map<string, TaskMission>([['wtask-back-99999999', { folder: wt, branch: 'wtask/back-99999999' }]]);
    const stopped = row('cancelled', { id: 'wtask-back-99999999', summary: 'stopped by owner', updatedBy: { kind: 'system', workspaceId: 'ws-daemon' }, updatedAt: 49_000 });
    let now = 50_000;
    const p = ports({ now: () => now }, missions);
    await cleanTaskFolders(p, [stopped]);
    expect(p.store.get(stopped.id)).toMatchObject({ state: 'kept_stopped', at: 50_000 });
    now = 60_000;
    await forgetKeptFolder(p, stopped.id);
    expect(p.store.get(stopped.id)).toMatchObject({ state: 'kept_stopped', at: 60_000, stopped: { botId: BOT, title: 'perf-A' } });
    // Only a folder a stop kept is touched.
    await p.store.put({ taskId: 'wtask-x-00000001', kind: 'worktree', path: wt, state: 'removed', at: 1 });
    await forgetKeptFolder(p, 'wtask-x-00000001');
    expect(p.store.get('wtask-x-00000001')).toMatchObject({ state: 'removed', at: 1 });
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('a record file that cannot be read is never taken as empty (the host leaves cleanup off)', () => {
    fs.mkdirSync(path.join(wmuxDir, 'factory'), { recursive: true });
    fs.writeFileSync(path.join(wmuxDir, 'factory', 'task-folders.json'), '{ not json');
    expect(() => TaskFolders.at(wmuxDir).load()).toThrow();
  });

  it('a kept record whose bot id climbs out of the bots\' root, or whose path is outside the roots, deletes nothing', async () => {
    // With wmuxDir <dir>/data, bot "../../../outside" would make the research
    // root <dir>/outside/research.
    const outside = path.join(dir, 'outside', 'research', 'batch', 'task');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'mine');
    const elsewhere = path.join(dir, 'elsewhere', 'batch', 'task');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'mine');
    const evil = { taskId: 'wtask-evil-00000001', kind: 'research', path: outside, state: 'kept_stopped', stopped: { botId: '../../../outside' }, at: 1 };
    const stray = { taskId: 'wtask-stray-0000002', kind: 'research', path: elsewhere, state: 'kept_stopped', stopped: { botId: BOT }, at: 1 };
    // From disk: a record whose bot is not a bot id is not read at all.
    fs.mkdirSync(path.join(wmuxDir, 'factory'), { recursive: true });
    fs.writeFileSync(path.join(wmuxDir, 'factory', 'task-folders.json'), JSON.stringify({ version: 1, folders: [evil, stray] }));
    const store = TaskFolders.at(wmuxDir);
    store.load();
    expect(store.get(evil.taskId)).toBeNull();
    expect(store.get(stray.taskId)?.state).toBe('kept_stopped');
    // Written in memory anyway (no validation on put): still refused.
    await store.put(evil as never);
    const p = ports({ store, removeDir: vi.fn(async () => undefined) });
    expect(await cleanTaskFolders(p, [], { force: true })).toEqual({ removed: 0, keptDirty: 0, busy: 0, failed: 0 });
    expect(p.removeDir).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('mine');
    expect(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8')).toBe('mine');
    expect(await taskFolderUsage(p, [])).toEqual({ bytes: 0, folders: 0, dirty: 0 });
    // And no folder kind for a bot id that is not one.
    expect(taskFolderKind(outside, undefined, '../../../outside', roots())).toBeNull();
  });

  it('a kept record is never evicted by the record cap; other records are', async () => {
    const store = TaskFolders.at(wmuxDir);
    await store.put({ taskId: 'wtask-kept-00000001', kind: 'worktree', path: path.join(home, 'worktrees', 'h', 'k'), state: 'kept_stopped', stopped: { botId: BOT }, at: 1 });
    await store.put({ taskId: 'wtask-gone-00000001', kind: 'worktree', path: path.join(home, 'worktrees', 'h', 'g'), state: 'removed', at: 2 });
    for (let i = 0; i < TASK_FOLDERS_MAX + 5; i++) {
      void store.put({ taskId: `wtask-r-${String(i).padStart(8, '0')}`, kind: 'worktree', path: path.join(home, 'worktrees', 'h', `r${i}`), state: 'removed', at: 10 + i });
    }
    expect(store.get('wtask-kept-00000001')?.state).toBe('kept_stopped');
    expect(store.get('wtask-gone-00000001')).toBeNull();
    // The other records keep their own budget; the kept one is on top of it.
    expect(store.all().filter((r) => r.state === 'removed').length).toBe(TASK_FOLDERS_MAX);
    expect(store.all().length).toBe(TASK_FOLDERS_MAX + 1);
  });

  it('with a full budget of kept records, an ordinary task\'s removal record is still stored and its folder can be put back', async () => {
    const store = TaskFolders.at(wmuxDir);
    // Records only (outside the roots, so a Clean up now passes them over quickly).
    const keptPath = (i: number) => path.join(dir, 'records-only', `k${i}`);
    for (let i = 0; i < TASK_FOLDERS_KEPT_MAX; i++) {
      void store.put({ taskId: `wtask-k-${String(i).padStart(8, '0')}`, kind: 'worktree', path: keptPath(i), state: 'kept_stopped', stopped: { botId: BOT }, at: i });
    }
    // An ordinary research task's folder is removed: its record (how to put
    // it back) is written and kept, and Resume puts the folder back.
    const scratch = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-4', 'task-4');
    fs.mkdirSync(scratch, { recursive: true });
    const research = row('completed', { id: 'wtask-res-00000004', dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' } });
    const p = ports({ store });
    expect(await cleanTaskFolder(p, research, { folder: scratch }, [])).toBe('removed');
    expect(store.get(research.id)?.state).toBe('removed');
    expect(await restoreTaskFolder(p, research.id, scratch)).toBe(true);
    expect(fs.existsSync(scratch)).toBe(true);
    expect(store.all().filter((r) => r.state === 'kept_stopped').length).toBe(TASK_FOLDERS_KEPT_MAX);

    // One more kept folder (2,001): the oldest kept record goes, never the new one.
    const extra = { taskId: 'wtask-k-extra-0001', kind: 'research' as const, path: path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-5', 'task-5'), state: 'kept_stopped' as const, stopped: { botId: BOT }, at: 99_999 };
    fs.mkdirSync(extra.path, { recursive: true });
    await store.put(extra);
    expect(store.get(extra.taskId)?.state).toBe('kept_stopped');
    expect(store.get('wtask-k-00000000')).toBeNull();
    // Cleaning one of those kept folders: its removed record is stored.
    expect(await cleanTaskFolders(p, [], { force: true })).toMatchObject({ removed: 1 });
    expect(fs.existsSync(extra.path)).toBe(false);
    expect(store.get(extra.taskId)?.state).toBe('removed');
  });

  it('a removal of a kept folder that fails (EBUSY) stays found, is reported, and the next Clean up now finishes it', async () => {
    const scratch = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-3', 'task-3');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'notes.md'), 'found it');
    const stopped = row('cancelled', {
      id: 'wtask-busy-00000003', summary: 'stopped by owner', updatedBy: { kind: 'system', workspaceId: 'ws-daemon' }, updatedAt: 49_000,
      dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' },
    });
    const p = ports({}, new Map([[stopped.id, { folder: scratch }]]));
    await cleanTaskFolders(p, [stopped]);
    expect(p.store.get(stopped.id)?.state).toBe('kept_stopped');
    // Past retention (no row), the folder held open: the removal fails.
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    const failing = { ...p, removeDir: vi.fn(async () => { throw busy; }) };
    expect(await cleanTaskFolders(failing, [], { force: true })).toEqual({
      removed: 0, keptDirty: 0, busy: 0, failed: 1, notRemoved: [{ path: scratch, reason: 'Error: EBUSY: resource busy or locked' }],
    });
    expect(fs.existsSync(path.join(scratch, 'notes.md'))).toBe(true);
    expect(p.store.get(stopped.id)).toMatchObject({ state: 'removing', stopped: { botId: BOT } });
    // Still found: counted, and the automatic pass does not take it as gone.
    expect(await taskFolderUsage(p, [])).toMatchObject({ folders: 1 });
    await cleanTaskFolders(p, [stopped]);
    expect(p.store.get(stopped.id)?.state).toBe('kept_stopped');
    // The next Clean up now removes it.
    expect(await cleanTaskFolders(p, [], { force: true })).toMatchObject({ removed: 1, failed: 0 });
    expect(fs.existsSync(scratch)).toBe(false);
    expect(await taskFolderUsage(p, [])).toEqual({ bytes: 0, folders: 0, dirty: 0 });
  });
});

describe('a folder a stop kept, after 7 days', () => {
  const DAY = 24 * 3_600_000;
  const stoppedBy = { summary: 'stopped by owner', updatedBy: { kind: 'system' as const, workspaceId: 'ws-daemon' }, updatedAt: 49_000 };
  /** One automatic pass (installTaskFolderCleanup runs one at install). */
  async function pass(p: TaskFolderPorts, rows: LedgerEntry[], settle?: () => void): Promise<void> {
    const installed = installTaskFolderCleanup({ ...p, onTransition: () => () => undefined, allRows: () => rows });
    if (settle) await vi.waitFor(settle, { timeout: 10_000 });
    else await new Promise((r) => setTimeout(r, 100));
    installed.dispose();
  }

  it('is kept at 6 days; at 7 a clean one is removed (branch kept, one card), a dirty one is kept, a research folder goes too', async () => {
    const mgr = new TaskWorktreeManager();
    const cleanWt = await taskWorktree(mgr, 'ttl-11111111');
    const dirtyWt = await taskWorktree(mgr, 'ttld-22222222');
    fs.writeFileSync(path.join(dirtyWt, 'draft.txt'), 'unsaved');
    const scratch = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-7', 'task-7');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'notes.md'), 'found it');
    const missions = new Map<string, TaskMission>([
      ['wtask-ttl-11111111', { folder: cleanWt, branch: 'wtask/ttl-11111111' }],
      ['wtask-ttld-22222222', { folder: dirtyWt, branch: 'wtask/ttld-22222222' }],
      ['wtask-ttlr-33333333', { folder: scratch }],
    ]);
    const rows = [
      row('cancelled', { id: 'wtask-ttl-11111111', title: 'clean one', ...stoppedBy, dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default', threadId: `dm:${BOT}` } }),
      row('cancelled', { id: 'wtask-ttld-22222222', title: 'dirty one', ...stoppedBy }),
      row('cancelled', { id: 'wtask-ttlr-33333333', title: 'research one', ...stoppedBy, dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' } }),
    ];
    let now = 50_000;
    const keptFolderCleaned = vi.fn();
    const p = ports({ now: () => now, keptFolderCleaned }, missions);
    await cleanTaskFolders(p, rows);
    expect(p.store.get('wtask-ttl-11111111')).toMatchObject({
      state: 'kept_stopped', at: 50_000, stopped: { botId: BOT, title: 'clean one', workspaceId: 'ws-owner', threadId: `dm:${BOT}` },
    });
    expect(p.store.get('wtask-ttld-22222222')?.stopped?.threadId).toBe('task:wtask-ttld-22222222');

    now = 50_000 + 6 * DAY;
    await pass(p, rows);
    expect(fs.existsSync(cleanWt) && fs.existsSync(dirtyWt) && fs.existsSync(scratch)).toBe(true);
    expect(keptFolderCleaned).not.toHaveBeenCalled();

    // Day 7: the ledger has pruned the rows (and the daemon the missions).
    now = 50_000 + TASK_FOLDER_KEPT_TTL_MS;
    const later = { ...p, missions: async () => new Map<string, TaskMission>() };
    await pass(later, [], () => {
      expect(fs.existsSync(cleanWt)).toBe(false);
      expect(fs.existsSync(scratch)).toBe(false);
      expect(p.store.get('wtask-ttld-22222222')?.state).toBe('kept_dirty');
      // The card follows the removal's record.
      expect(keptFolderCleaned).toHaveBeenCalledTimes(2);
    });
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/wtask/ttl-11111111')).toMatch(/^[0-9a-f]{40}$/);
    expect(p.store.get('wtask-ttl-11111111')?.state).toBe('removed');
    expect(fs.readFileSync(path.join(dirtyWt, 'draft.txt'), 'utf8')).toBe('unsaved');
    expect(keptFolderCleaned).toHaveBeenCalledTimes(2);
    expect(keptFolderCleaned).toHaveBeenCalledWith({
      taskId: 'wtask-ttl-11111111', botId: BOT, kind: 'worktree', title: 'clean one', days: 7, workspaceId: 'ws-owner', threadId: `dm:${BOT}`,
    });
    expect(keptFolderCleaned).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'wtask-ttlr-33333333', kind: 'research', title: 'research one', days: 7 }));
    // The dirty one is never removed automatically, however long it sits.
    now += 30 * DAY;
    await pass(later, []);
    expect(fs.existsSync(path.join(dirtyWt, 'draft.txt'))).toBe(true);
    expect(keptFolderCleaned).toHaveBeenCalledTimes(2);
  });

  it('a resume in between starts the 7 days again; a resumed worker or a session in the folder keeps it', async () => {
    const wt = await taskWorktree(new TaskWorktreeManager(), 'again-44444444');
    const missions = new Map<string, TaskMission>([['wtask-again-44444444', { folder: wt, branch: 'wtask/again-44444444' }]]);
    const stopped = row('cancelled', { id: 'wtask-again-44444444', ...stoppedBy });
    let now = 50_000;
    let worker: 'stopped' | 'resumed' = 'stopped';
    let sessions: Array<{ id: string; cwd: string }> = [];
    const p = ports({ now: () => now, workerState: () => worker, listSessions: async () => sessions }, missions);
    await cleanTaskFolders(p, [stopped]);
    // Day 5: resumed (the kept record ends), then stopped again.
    now = 50_000 + 5 * DAY;
    await forgetKeptFolder(p, stopped.id);
    await cleanTaskFolders(p, [stopped]);
    expect(p.store.get(stopped.id)).toMatchObject({ state: 'kept_stopped', at: 50_000 + 5 * DAY });
    now = 50_000 + 7 * DAY;
    await pass(p, [stopped]);
    expect(fs.existsSync(wt)).toBe(true);
    // Past its new 7 days, but its worker runs again or a pane works there.
    now = 50_000 + 13 * DAY;
    worker = 'resumed';
    await pass(p, [stopped]);
    expect(fs.existsSync(wt)).toBe(true);
    worker = 'stopped';
    sessions = [{ id: 'daemon-1', cwd: wt }];
    await pass(p, [stopped]);
    expect(fs.existsSync(wt)).toBe(true);
    sessions = [];
    await pass(p, [stopped], () => expect(fs.existsSync(wt)).toBe(false));
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/wtask/again-44444444')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a removal after the TTL that fails is kept again with its clock, tried again on the next pass, and bounded', async () => {
    const scratch = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-9', 'task-9');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'notes.md'), 'found it');
    const stopped = row('cancelled', { id: 'wtask-busy-00000009', ...stoppedBy, dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' } });
    let now = 50_000;
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    let failing = true;
    const removeDir = vi.fn(async (d: string) => {
      if (failing) throw busy;
      await fs.promises.rm(d, { recursive: true });
    });
    const p = ports({ now: () => now, removeDir }, new Map([[stopped.id, { folder: scratch }]]));
    await cleanTaskFolders(p, [stopped]);
    now = 50_000 + TASK_FOLDER_KEPT_TTL_MS;
    // One install; a failed removal is tried again only on the retry timer,
    // never on a kick (a ledger change, a workspace closing).
    const installed = installTaskFolderCleanup({ ...p, onTransition: () => () => undefined, allRows: () => [stopped], retryMs: 150 });
    await vi.waitFor(() => expect(removeDir).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(p.store.get(stopped.id)).toMatchObject({ state: 'kept_stopped', at: 50_000, stopped: { botId: BOT, title: 'perf-A' } });
    // The ordinary pass over its row records nothing new.
    await cleanTaskFolders(p, [stopped]);
    expect(p.store.get(stopped.id)?.at).toBe(50_000);
    const times: number[] = [];
    removeDir.mockImplementation(async () => {
      times.push(Date.now());
      throw busy;
    });
    for (let i = 0; i < 5; i++) installed.kick();
    await new Promise((r) => setTimeout(r, 50));
    expect(removeDir).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(removeDir).toHaveBeenCalledTimes(3), { timeout: 5_000 });
    // Bounded: no fourth try from this install, kicked or timed.
    installed.kick();
    await new Promise((r) => setTimeout(r, 400));
    expect(removeDir).toHaveBeenCalledTimes(3);
    installed.dispose();
    // The retries came a timer period apart.
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(100);
    removeDir.mockImplementation(async (d: string) => {
      if (failing) throw busy;
      await removeTreeNoFollow(d);
    });
    expect(fs.existsSync(path.join(scratch, 'notes.md'))).toBe(true);
    // A later start tries again, and it goes.
    failing = false;
    await pass(p, [stopped], () => expect(fs.existsSync(scratch)).toBe(false));
  });

  it('a removal that did not finish (a crash after its record) keeps the folder\'s clock when its row records it again', async () => {
    const scratch = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-10', 'task-10');
    fs.mkdirSync(scratch, { recursive: true });
    const stopped = row('cancelled', { id: 'wtask-crash-0000010', ...stoppedBy, dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' } });
    const p = ports({ now: () => 50_000 + 9 * DAY }, new Map([[stopped.id, { folder: scratch }]]));
    await p.store.put({ taskId: stopped.id, kind: 'research', path: scratch, state: 'removing', stopped: { botId: BOT, workspaceId: 'ws-owner' }, at: 50_000 });
    await cleanTaskFolders(p, [stopped]);
    expect(p.store.get(stopped.id)).toMatchObject({ state: 'kept_stopped', at: 50_000 });
  });

  it('a kept record whose path is outside the roots is never removed, however old', async () => {
    const elsewhere = path.join(dir, 'elsewhere', 'batch', 'task');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'mine');
    const store = TaskFolders.at(wmuxDir);
    await store.put({ taskId: 'wtask-stray-0000002', kind: 'research', path: elsewhere, state: 'kept_stopped', stopped: { botId: BOT, workspaceId: 'ws-owner' }, at: 1 });
    // A link inside the research root to a folder outside it.
    const linked = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-8', 'task-8');
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(path.dirname(elsewhere), linked, 'dir');
    await store.put({ taskId: 'wtask-link-0000003', kind: 'research', path: linked, state: 'kept_stopped', stopped: { botId: BOT, workspaceId: 'ws-owner' }, at: 1 });
    const removeDir = vi.fn(async () => undefined);
    const keptFolderCleaned = vi.fn();
    const p = ports({ store, removeDir, keptFolderCleaned, now: () => 1 + 30 * DAY });
    await pass(p, []);
    expect(removeDir).not.toHaveBeenCalled();
    expect(keptFolderCleaned).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('after the row is pruned, a mission the owner detached, or a record with no owner workspace, is never removed', async () => {
    const mgr = new TaskWorktreeManager();
    const handed = await taskWorktree(mgr, 'hand-55555555');
    const legacy = await taskWorktree(mgr, 'old-66666666');
    const store = TaskFolders.at(wmuxDir);
    await store.put({ taskId: 'wtask-hand-55555555', kind: 'worktree', path: handed, branch: 'wtask/hand-55555555', state: 'kept_stopped', stopped: { botId: BOT, workspaceId: 'ws-owner' }, at: 1 });
    // Recorded before the record named its owner workspace.
    await store.put({ taskId: 'wtask-old-66666666', kind: 'worktree', path: legacy, branch: 'wtask/old-66666666', state: 'kept_stopped', stopped: { botId: BOT }, at: 1 });
    const missions = new Map<string, TaskMission>([['wtask-hand-55555555', { folder: handed, branch: 'wtask/hand-55555555', detached: true }]]);
    const p = ports({ store, now: () => 1 + 30 * DAY }, missions);
    await pass(p, []);
    expect(fs.existsSync(handed) && fs.existsSync(legacy)).toBe(true);
    // The daemon's missions cannot be read: nothing is removed either.
    await pass({ ...p, missions: async () => null }, []);
    expect(fs.existsSync(handed)).toBe(true);
  });

  it('resumed after 2 days and stopped again: the folder is recorded at that stop, and cleaned 7 days after it', async () => {
    const wt = await taskWorktree(new TaskWorktreeManager(), 'run-77777777');
    const missions = new Map<string, TaskMission>([['wtask-run-77777777', { folder: wt, branch: 'wtask/run-77777777' }]]);
    const stopped = row('cancelled', { id: 'wtask-run-77777777', ...stoppedBy });
    let now = 50_000;
    let worker: 'stopped' | 'resumed' = 'stopped';
    let stoppedAt = 0; // no stop of a resumed worker yet
    const keptFolderCleaned = vi.fn();
    const p = ports({ now: () => now, workerState: () => worker, workerStoppedAt: () => (worker === 'stopped' ? stoppedAt : undefined), keptFolderCleaned }, missions);
    await pass(p, [stopped], () => expect(p.store.get(stopped.id)).toMatchObject({ state: 'kept_stopped', at: 50_000 }));
    // Day 2: resumed (the record stays, its clock restarts); a pass while it
    // runs records nothing new and removes nothing.
    now = 50_000 + 2 * DAY;
    worker = 'resumed';
    await forgetKeptFolder(p, stopped.id);
    now = 50_000 + 8 * DAY;
    await pass(p, [stopped]);
    expect(fs.existsSync(wt)).toBe(true);
    // Day 9: the resumed worker is stopped again (row unchanged, over a day old).
    now = 50_000 + 9 * DAY;
    worker = 'stopped';
    stoppedAt = now;
    await pass(p, [stopped]);
    expect(p.store.get(stopped.id)).toMatchObject({ state: 'kept_stopped', at: 50_000 + 9 * DAY });
    expect(fs.existsSync(wt)).toBe(true);
    now = 50_000 + 15 * DAY;
    await pass(p, [stopped]);
    expect(fs.existsSync(wt)).toBe(true);
    // Seven days after the second stop, with the row pruned by then.
    now = 50_000 + 16 * DAY;
    await pass({ ...p, missions: async () => new Map<string, TaskMission>() }, [], () => expect(keptFolderCleaned).toHaveBeenCalled());
    expect(fs.existsSync(wt)).toBe(false);
    expect(keptFolderCleaned).toHaveBeenCalledWith(expect.objectContaining({ taskId: stopped.id, days: 7 }));
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/wtask/run-77777777')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the stop itself moves the clock, so a stop time the reclaimed record no longer holds still counts', async () => {
    const wt = await taskWorktree(new TaskWorktreeManager(), 'evict-99999999');
    const stopped = row('cancelled', { id: 'wtask-evict-99999999', ...stoppedBy });
    let now = 50_000;
    const p = ports({ now: () => now, workerStoppedAt: () => undefined }, new Map([[stopped.id, { folder: wt, branch: 'wtask/evict-99999999' }]]));
    await cleanTaskFolders(p, [stopped]);
    now = 50_000 + 2 * DAY;
    await forgetKeptFolder(p, stopped.id);
    // Stopped on day 10; its reclaimed record is evicted before the next pass.
    await noteKeptFolderStopped(p, stopped.id, 50_000 + 10 * DAY);
    await noteKeptFolderStopped(p, stopped.id, 50_000 + 3 * DAY);
    expect(p.store.get(stopped.id)).toMatchObject({ state: 'kept_stopped', at: 50_000 + 10 * DAY });
    now = 50_000 + 10 * DAY + 60_000;
    await pass(p, []);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('a record an older build dropped on resume is written again at the worker\'s next stop, though the row is over a day old', async () => {
    const wt = await taskWorktree(new TaskWorktreeManager(), 'lost-88888888');
    const missions = new Map<string, TaskMission>([['wtask-lost-88888888', { folder: wt, branch: 'wtask/lost-88888888' }]]);
    const stopped = row('cancelled', { id: 'wtask-lost-88888888', title: 'lost one', ...stoppedBy });
    const now = 50_000 + 9 * DAY;
    const p = ports({ now: () => now, workerStoppedAt: () => 50_000 + 9 * DAY - 60_000 }, missions);
    await pass(p, [stopped], () => expect(p.store.get(stopped.id)).toMatchObject({
      state: 'kept_stopped', at: 50_000 + 9 * DAY - 60_000, stopped: { botId: BOT, title: 'lost one', workspaceId: 'ws-owner' },
    }));
    expect(fs.existsSync(wt)).toBe(true);
  });
});

describe('a worktree git removed only half way', () => {
  const keptRowOf = (id: string): LedgerEntry => row('cancelled', { id, summary: 'stopped by owner', updatedBy: { kind: 'system', workspaceId: 'ws-daemon' }, updatedAt: 49_000 });
  const stoppedBy = { summary: 'stopped by owner', updatedBy: { kind: 'system' as const, workspaceId: 'ws-daemon' }, updatedAt: 49_000 };
  /** A link that is a junction on Windows and a symlink elsewhere. */
  const dirLink = (target: string, at: string): void => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  /** What git leaves when it stops part way: the folder without its .git
   *  and its admin entry pruned, with one file it could not delete. */
  function halfRemove(wt: string): void {
    fs.rmSync(path.join(wt, '.git'));
    git(repo, 'worktree', 'prune');
  }

  it('a folder with no .git that git no longer lists is finished without git: links unlinked, never followed; the branch stays', async () => {
    const mgr = new TaskWorktreeManager();
    const wt = await taskWorktree(mgr, 'half-12121212');
    const canary = path.join(dir, 'canary');
    fs.mkdirSync(path.join(canary, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(canary, 'deep', 'keep.txt'), 'mine');
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
    dirLink(canary, path.join(wt, 'node_modules'));
    dirLink(canary, path.join(wt, 'sub', 'link'));
    try {
      fs.symlinkSync(path.join(canary, 'deep', 'keep.txt'), path.join(wt, 'file-link'));
    } catch (err) {
      // A file symlink on Windows needs a privilege the runner may lack.
      if (process.platform !== 'win32') throw err;
    }
    const repoRoot = fs.realpathSync(repo);
    expect(await gitWorktreeRegistered(repoRoot, wt)).toBe(true);
    halfRemove(wt);
    expect(await gitWorktreeRegistered(repoRoot, wt)).toBe(false);
    const done = row('completed', { id: 'wtask-half-12121212' });
    const p = ports({}, new Map());
    await p.store.put({ taskId: done.id, kind: 'worktree', path: wt, branch: 'wtask/half-12121212', repoRoot, repoHash: 'h', state: 'removing', at: 1 });
    expect(await cleanTaskFolder(p, done, { folder: wt, branch: 'wtask/half-12121212' }, [])).toBe('removed');
    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.readFileSync(path.join(canary, 'deep', 'keep.txt'), 'utf8')).toBe('mine');
    expect(git(repo, 'rev-parse', '--verify', 'refs/heads/wtask/half-12121212')).toMatch(/^[0-9a-f]{40}$/);
    expect(p.store.get(done.id)?.state).toBe('removed');
  });

  it('files git left behind (a node_modules link) are finished in the same removal', async () => {
    const mgr = new TaskWorktreeManager();
    const wt = await taskWorktree(mgr, 'left-13131313');
    const canary = path.join(dir, 'canary2');
    fs.mkdirSync(canary, { recursive: true });
    fs.writeFileSync(path.join(canary, 'pkg.json'), '{}');
    const done = row('completed', { id: 'wtask-left-13131313' });
    // git removes the worktree but a link it would not delete stays.
    const worktrees = {
      removeWorktree: vi.fn(async (root: string, hash: string, folder: string) => {
        const r = await mgr.removeWorktree(root, hash, folder);
        if (!r.ok) return r;
        fs.mkdirSync(folder);
        dirLink(canary, path.join(folder, 'node_modules'));
        return { ok: false as const, error: 'removeWorktree: files were left behind in the worktree folder' };
      }),
      restoreWorktree: vi.fn(async () => ({ ok: true as const })),
    };
    const p = ports({ worktrees });
    expect(await cleanTaskFolder(p, done, { folder: wt, branch: 'wtask/left-13131313' }, [])).toBe('removed');
    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.readFileSync(path.join(canary, 'pkg.json'), 'utf8')).toBe('{}');
  });

  it('a lock that outlives a pass: kept and named by Clean up now; once released, the next pass finishes it', async () => {
    const mgr = new TaskWorktreeManager();
    const wt = await taskWorktree(mgr, 'lock-14141414');
    const repoRoot = fs.realpathSync(repo);
    halfRemove(wt);
    const done = row('completed', { id: 'wtask-lock-14141414', updatedAt: 49_000 });
    let locked = true;
    const removeDir = vi.fn(async (d: string) => {
      if (locked) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      await removeTreeNoFollow(d);
    });
    const missions = new Map<string, TaskMission>([[done.id, { folder: wt, branch: 'wtask/lock-14141414' }]]);
    const p = ports({ removeDir }, missions);
    await p.store.put({ taskId: done.id, kind: 'worktree', path: wt, branch: 'wtask/lock-14141414', repoRoot, repoHash: 'h', state: 'removing', at: 1 });
    const r = await cleanTaskFolders(p, [done], { force: true });
    expect(r.failed).toBe(1);
    expect(r.notRemoved).toEqual([{ path: wt, reason: expect.stringContaining('half removed') }]);
    expect(p.store.get(done.id)).toMatchObject({ state: 'removing', repoRoot });
    locked = false;
    expect(await cleanTaskFolders(p, [done], { force: true })).toMatchObject({ removed: 1, failed: 0 });
    expect(fs.existsSync(wt)).toBe(false);
  });

  it('a registered worktree still goes through git (its dirty check too), and its .git keeps it from the link-safe removal', async () => {
    const mgr = new TaskWorktreeManager();
    const wt = await taskWorktree(mgr, 'reg-15151515');
    fs.writeFileSync(path.join(wt, 'draft.txt'), 'unsaved');
    const repoRoot = fs.realpathSync(repo);
    const removeDir = vi.fn(async () => undefined);
    const worktreeRegistered = vi.fn(async () => false);
    const done = row('completed', { id: 'wtask-reg-15151515' });
    const p = ports({ removeDir, worktreeRegistered });
    await p.store.put({ taskId: done.id, kind: 'worktree', path: wt, branch: 'wtask/reg-15151515', repoRoot, repoHash: 'h', state: 'removing', at: 1 });
    // Even a git list that does not name it (a path spelled otherwise) is not
    // enough while its .git is there.
    expect(await cleanTaskFolder(p, done, { folder: wt, branch: 'wtask/reg-15151515' }, [])).toBe('kept_dirty');
    expect(removeDir).not.toHaveBeenCalled();
    expect(worktreeRegistered).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(wt, 'draft.txt'), 'utf8')).toBe('unsaved');
  });

  it('never outside the roots, through a link, or while a session works in it', async () => {
    const outside = path.join(dir, 'outside-wt', 'h', 'x-16161616');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'mine');
    const removeDir = vi.fn(async () => undefined);
    const worktreeRegistered = vi.fn(async () => false);
    const done = row('completed', { id: 'wtask-x-16161616' });
    const p = ports({ removeDir, worktreeRegistered });
    await p.store.put({ taskId: done.id, kind: 'worktree', path: outside, repoRoot: repo, repoHash: 'h', state: 'removing', at: 1 });
    expect(await cleanTaskFolder(p, done, { folder: outside }, [])).toBe('skipped');
    // A link inside the worktree root to that folder.
    const linked = path.join(home, 'worktrees', 'h', 'x-16161616');
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    dirLink(outside, linked);
    expect(await cleanTaskFolder(p, done, { folder: linked }, [])).toBe('skipped');
    // A real half-removed folder that a pane still works in.
    const real = path.join(home, 'worktrees', 'h', 'busy-17171717');
    fs.mkdirSync(real, { recursive: true });
    const busyRow = row('completed', { id: 'wtask-busy-17171717' });
    await p.store.put({ taskId: busyRow.id, kind: 'worktree', path: real, repoRoot: repo, repoHash: 'h', state: 'removing', at: 1 });
    expect(await cleanTaskFolder(p, busyRow, { folder: real }, [{ id: 'daemon-1', cwd: real }])).toBe('busy');
    expect(removeDir).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('removeTreeNoFollow leaves a folder swapped for a link while it is being listed, and what the link points at', async () => {
    const top = path.join(dir, 'swap-top');
    const victim = path.join(top, 'victim');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'a.txt'), 'x');
    const canary = path.join(dir, 'canary4');
    fs.mkdirSync(canary, { recursive: true });
    fs.writeFileSync(path.join(canary, 'a.txt'), 'mine');
    const real = fs.promises.readdir.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      const out = await (real as (...a: unknown[]) => Promise<string[]>)(p, ...rest);
      if (String(p) === victim) {
        fs.renameSync(victim, path.join(dir, 'victim-moved'));
        dirLink(canary, victim);
      }
      return out;
    }) as never);
    try {
      await expect(removeTreeNoFollow(top)).rejects.toThrow(/left alone/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(canary, 'a.txt'), 'utf8')).toBe('mine');
  });

  it('git unable to list its worktrees after a partial removal: the kept folder is kept again and tried later', async () => {
    const mgr = new TaskWorktreeManager();
    const wt = await taskWorktree(mgr, 'nolist-18181818');
    const repoRoot = fs.realpathSync(repo);
    const stopped = row('cancelled', { id: 'wtask-nolist-18181818', ...stoppedBy });
    const worktrees = {
      removeWorktree: vi.fn(async () => {
        halfRemove(wt);
        return { ok: false as const, error: 'removeWorktree: git worktree remove failed: Invalid argument' };
      }),
      restoreWorktree: vi.fn(async () => ({ ok: true as const })),
    };
    const p = ports({ worktrees, worktreeRegistered: async () => null, now: () => 50_000 + TASK_FOLDER_KEPT_TTL_MS }, new Map());
    await p.store.put({
      taskId: stopped.id, kind: 'worktree', path: wt, branch: 'wtask/nolist-18181818', state: 'kept_stopped',
      stopped: { botId: BOT, workspaceId: 'ws-owner' }, at: 50_000,
    });
    expect(await cleanTaskFolder(p, keptRowOf(stopped.id), { folder: wt, branch: 'wtask/nolist-18181818' }, [], { keptTtl: true })).toBe('failed');
    const rec = p.store.get(stopped.id);
    expect(rec).toMatchObject({ state: 'kept_stopped', at: 50_000 });
    // git spells the root its own way (forward slashes, long names on Windows).
    expect(fs.realpathSync.native(rec?.repoRoot ?? '')).toBe(fs.realpathSync.native(repoRoot));
  });

  it('removeTreeNoFollow with a root refuses a folder that resolves elsewhere (a link or mount point at or above it)', async () => {
    const root = path.join(dir, 'root5');
    const elsewhere = path.join(dir, 'elsewhere5', 'task');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'mine');
    fs.mkdirSync(root, { recursive: true });
    dirLink(path.dirname(elsewhere), path.join(root, 'h'));
    await expect(removeTreeNoFollow(path.join(root, 'h', 'task'), root)).rejects.toThrow(/left alone/);
    await expect(removeTreeNoFollow(elsewhere, root)).rejects.toThrow(/not inside/);
    expect(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8')).toBe('mine');
    // Where it sits: removed.
    fs.mkdirSync(path.join(root, 'real', 'task', 'sub'), { recursive: true });
    await removeTreeNoFollow(path.join(root, 'real', 'task'), root);
    expect(fs.existsSync(path.join(root, 'real', 'task'))).toBe(false);
  });

  /** lstat as the OS gives it, but with the folders in `mounted` (and what
   *  is below them) on another device, as a mounted volume is. */
  function fakeMounts(mounted: string[]) {
    const real = fs.promises.lstat.bind(fs.promises);
    return vi.spyOn(fs.promises, 'lstat').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
      const st = await (real as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest);
      const at = path.resolve(String(p));
      if (mounted.some((m) => at === m || at.startsWith(m + path.sep))) Object.defineProperty(st, 'dev', { value: st.dev + 1 });
      return st;
    }) as never);
  }

  it('removeTreeNoFollow never enters a mount point below the folder: it stays whole, the rest goes, and it is reported', async () => {
    const top = path.join(dir, 'mnt-top');
    const mnt = path.join(top, 'sub', 'volume');
    fs.mkdirSync(path.join(mnt, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(mnt, 'deep', 'keep.txt'), 'mine');
    fs.mkdirSync(path.join(top, 'other'), { recursive: true });
    fs.writeFileSync(path.join(top, 'other', 'gone.txt'), 'x');
    const spy = fakeMounts([mnt]);
    try {
      await expect(removeTreeNoFollow(top)).rejects.toBeInstanceOf(MountPointError);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(mnt, 'deep', 'keep.txt'), 'utf8')).toBe('mine');
    expect(fs.existsSync(path.join(top, 'other'))).toBe(false);
  });

  it('a mount the mount table lists on the same device (a bind mount) is never entered, at the folder or below it', async () => {
    const top = path.join(dir, 'bind-top');
    const bound = path.join(top, 'sub', 'bound');
    fs.mkdirSync(bound, { recursive: true });
    fs.writeFileSync(path.join(bound, 'keep.txt'), 'mine');
    fs.mkdirSync(path.join(top, 'other'), { recursive: true });
    fs.writeFileSync(path.join(top, 'other', 'gone.txt'), 'x');
    const real = (p: string): string => {
      const r = fs.realpathSync.native(p);
      return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
    };
    await expect(removeTreeNoFollow(top, undefined, async () => new Set([real(bound)]))).rejects.toBeInstanceOf(MountPointError);
    expect(fs.readFileSync(path.join(bound, 'keep.txt'), 'utf8')).toBe('mine');
    expect(fs.existsSync(path.join(top, 'other'))).toBe(false);
    // At the folder itself: nothing is removed.
    await expect(removeTreeNoFollow(top, undefined, async () => new Set([real(top)]))).rejects.toBeInstanceOf(MountPointError);
    expect(fs.readFileSync(path.join(bound, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('a mount above the folder, below its root, is refused too: by the mount table or by its device', async () => {
    const root = path.join(dir, 'root6');
    const task = path.join(root, 'batch', 'task');
    fs.mkdirSync(task, { recursive: true });
    fs.writeFileSync(path.join(task, 'keep.txt'), 'mine');
    const real = (p: string): string => {
      const r = fs.realpathSync.native(p);
      return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
    };
    await expect(removeTreeNoFollow(task, root, async () => new Set([real(path.join(root, 'batch'))]))).rejects.toBeInstanceOf(MountPointError);
    const spy = fakeMounts([path.join(root, 'batch')]);
    try {
      await expect(removeTreeNoFollow(task, root, async () => new Set())).rejects.toBeInstanceOf(MountPointError);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(task, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('a root that is itself a link still has its folders removed', async () => {
    const realRoot = path.join(dir, 'root7-real');
    fs.mkdirSync(path.join(realRoot, 'batch', 'task', 'sub'), { recursive: true });
    const root = path.join(dir, 'root7');
    dirLink(realRoot, root);
    await removeTreeNoFollow(path.join(root, 'batch', 'task'), root, async () => new Set());
    expect(fs.existsSync(path.join(realRoot, 'batch', 'task'))).toBe(false);
    expect(fs.existsSync(path.join(realRoot, 'batch'))).toBe(true);
  });

  it('parseMountInfo reads the mount points of /proc/self/mountinfo, escapes undone', () => {
    const table = [
      '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
      '45 22 8:1 /home/u/src /tmp/wt/h/task\\040one rw,relatime shared:1 - ext4 /dev/sda1 rw',
      '',
    ].join('\n');
    const m = parseMountInfo(table);
    expect(m.has('/')).toBe(true);
    expect(m.has('/tmp/wt/h/task one')).toBe(true);
  });

  it('a task folder that is itself a mount point is left whole, and Clean up now names it with the reason', async () => {
    const scratch = path.join(wmuxDir, 'factory', 'bots', BOT, 'research', 'batch-11', 'task-11');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'keep.txt'), 'mine');
    const done = row('completed', { id: 'wtask-mnt-00000011', dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'research' } });
    const p = ports({}, new Map([[done.id, { folder: scratch }]]));
    const spy = fakeMounts([scratch]);
    let r: Awaited<ReturnType<typeof cleanTaskFolders>>;
    try {
      r = await cleanTaskFolders(p, [done], { force: true });
    } finally {
      spy.mockRestore();
    }
    expect(r.failed).toBe(1);
    expect(r.notRemoved).toEqual([{ path: scratch, reason: expect.stringContaining('mount point') }]);
    expect(fs.readFileSync(path.join(scratch, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('removeTreeNoFollow unlinks a link given to it, never its target', async () => {
    const canary = path.join(dir, 'canary3');
    fs.mkdirSync(canary, { recursive: true });
    fs.writeFileSync(path.join(canary, 'keep.txt'), 'mine');
    const link = path.join(dir, 'link3');
    dirLink(canary, link);
    await removeTreeNoFollow(link);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(canary, 'keep.txt'), 'utf8')).toBe('mine');
  });
});

describe('resume after removal', () => {
  it('worker_resume puts the removed worktree back at the same path before the new pane opens there', async () => {
    const wt = await taskWorktree(new TaskWorktreeManager());
    const folderPorts = ports();
    await cleanTaskFolder(folderPorts, row('completed'), { folder: wt, branch: 'wtask/perf-a-12345678' }, []);
    expect(fs.existsSync(wt)).toBe(false);

    const store = ReclaimedWorkers.at(wmuxDir);
    const rec: ReclaimedWorker = {
      taskId: 'wtask-abc-12345678', botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 'perf-A',
      threadId: 'task:wtask-abc-12345678', ended: 'completed', state: 'stopped', at: 2_000, endRev: 3,
      sessions: [{ sessionId: 'daemon-1', cwd: wt, resumeSessionId: UUID, permissionMode: 'bypassPermissions' }],
    };
    await store.put({ ...rec });
    let folderAtSpawn = false;
    const respawn = vi.fn(async (input: { cwd: string }) => {
      folderAtSpawn = fs.existsSync(path.join(input.cwd, 'a.txt'));
      return { ok: true as const, workspaceId: 'ws-new', sessionId: 'daemon-9' };
    });
    const p: WorkerResumePorts = {
      store, listSessions: async () => [], typeLine: vi.fn(() => true), respawn,
      restoreFolder: (taskId, folder) => restoreTaskFolder(folderPorts, taskId, folder),
      holdFolder: holdTaskFolder,
    };
    expect(await resumeWorker(p, 'wtask-abc-12345678', { kind: 'bot', botId: BOT })).toMatchObject({ ok: true, workspaceId: 'ws-new' });
    expect(respawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: wt }));
    expect(folderAtSpawn).toBe(true);
    // The resume's hold is released: a cleanup may look at the folder again
    // (its resumed worker keeps it now).
    expect(await cleanTaskFolder(ports({ workerState: () => 'stopped', now: () => 50_000 + 10 * 60_000 }), row('completed'), { folder: wt, branch: 'wtask/perf-a-12345678' }, [])).toBe('removed');
    // Without the cleanup's record, a gone folder still refuses.
    const other = ReclaimedWorkers.at(path.join(dir, 'other'));
    await other.put({ ...rec, state: 'stopped', taskId: 'wtask-gone-12345678', sessions: [{ ...rec.sessions[0], sessionId: 'daemon-5', cwd: path.join(dir, 'gone') }] });
    const refused = await resumeWorker({ ...p, store: other }, 'wtask-gone-12345678', { kind: 'owner' });
    expect(refused).toMatchObject({ ok: false, code: 'worktree_gone' });
  });
});

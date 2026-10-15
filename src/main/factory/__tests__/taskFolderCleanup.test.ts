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
  TASK_FOLDER_RESTORE_HOLD_MS,
  TaskFolders,
  cleanTaskFolder,
  cleanTaskFolders,
  gitRepoInfo,
  holdTaskFolder,
  installTaskFolderCleanup,
  restoreTaskFolder,
  taskFolderKind,
  taskFolderUsage,
  type TaskFolderPorts,
  type TaskMission,
} from '../taskFolderCleanup';
import { ReclaimedWorkers, resumeWorker, type ReclaimedWorker, type WorkerResumePorts } from '../workerReclaim';

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
    expect(fs.existsSync(path.dirname(scratch))).toBe(true);
    expect(await restoreTaskFolder(p, research.id, scratch)).toBe(true);
    expect(fs.readdirSync(scratch)).toEqual([]);
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
    });
    expect(listener).not.toBeNull();
    installed.dispose();

    expect(await taskFolderUsage(p, rows)).toMatchObject({ folders: 1, dirty: 1 });
    expect(await cleanTaskFolders(p, rows, { force: true })).toEqual({ removed: 0, keptDirty: 1, busy: 0, failed: 0 });
    fs.rmSync(path.join(dirty, 'draft.txt'));
    expect(await cleanTaskFolders(p, rows, { force: true })).toEqual({ removed: 1, keptDirty: 0, busy: 0, failed: 0 });
    expect(await taskFolderUsage(p, rows)).toEqual({ bytes: 0, folders: 0, dirty: 0 });
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

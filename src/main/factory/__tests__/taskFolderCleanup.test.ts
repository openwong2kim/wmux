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
  TASK_FOLDER_RESTORE_HOLD_MS,
  TaskFolders,
  cleanTaskFolder,
  cleanTaskFolders,
  forgetKeptFolder,
  gitRepoInfo,
  holdTaskFolder,
  installTaskFolderCleanup,
  removeEmptyResearchBatch,
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
    });
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
    await vi.waitFor(() => expect(fs.existsSync(otherWt)).toBe(false));
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

  it('a resumed worker using its kept folder again ends the kept record; its next stop records it again', async () => {
    const mgr = new TaskWorktreeManager();
    const wt = await taskWorktree(mgr, 'back-99999999');
    const missions = new Map<string, TaskMission>([['wtask-back-99999999', { folder: wt, branch: 'wtask/back-99999999' }]]);
    const stopped = row('cancelled', { id: 'wtask-back-99999999', summary: 'stopped by owner', updatedBy: { kind: 'system', workspaceId: 'ws-daemon' }, updatedAt: 49_000 });
    const p = ports({}, missions);
    await cleanTaskFolders(p, [stopped]);
    expect(p.store.get(stopped.id)?.state).toBe('kept_stopped');
    await forgetKeptFolder(p, stopped.id);
    expect(p.store.get(stopped.id)).toBeNull();
    // Only a folder a stop kept is forgotten.
    await p.store.put({ taskId: 'wtask-x-00000001', kind: 'worktree', path: wt, state: 'removed', at: 1 });
    await forgetKeptFolder(p, 'wtask-x-00000001');
    expect(p.store.get('wtask-x-00000001')?.state).toBe('removed');
    await cleanTaskFolders(p, [stopped]);
    expect(p.store.get(stopped.id)?.state).toBe('kept_stopped');
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
    expect(await cleanTaskFolders(failing, [], { force: true })).toEqual({ removed: 0, keptDirty: 0, busy: 0, failed: 1 });
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

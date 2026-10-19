// An ended bot task is cleared: its agent stops (workerReclaim) and its task
// workspace closes, except a failed task the owner has not looked at and a
// workspace the owner is viewing. A resume whose pane was cleared opens a new
// pane in the worktree on the bot worker spawn; a worktree that is gone is
// refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import {
  ReclaimedWorkers,
  clearVerdict,
  createWorkerClear,
  isTaskWorkspaceOf,
  reclaimWorker,
  resumeWorker,
  workerWorkspaceOf,
  CLEAR_RETRY_MS,
  CLEAR_FOREIGN_RETRY_MS,
  type ReclaimedWorker,
  type WorkerClearPorts,
  type WorkerResumePorts,
  type WorkerSessionInfo,
} from '../workerReclaim';
import { FanOutService } from '../../worktask/FanOutService';
import type { TaskWorktreeManager } from '../../worktask/TaskWorktreeManager';
import { FanOutGuards, setFanOutGuardsForTests } from '../../worktask/fanoutGuards';
import { botWorkerForCreate } from '../../agents/botWorkerMergeGuard';

const BOT = 'bot-0000000a';
const UUID = '2eca904b-b4cc-4243-81d3-67a121351892';
const TASK = 'wtask-abc-12345678';

let dir: string;
let wt: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w6-clear-'));
  wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
});
afterEach(() => {
  setFanOutGuardsForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function row(status: LedgerEntry['status']): LedgerEntry {
  return {
    schemaVersion: 1, id: TASK, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'perf-A',
    status, rev: 3, updatedAt: 1_000, updatedBy: { kind: 'brain', workspaceId: 'ws-owner' },
    dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default' },
  };
}

function session(over: Partial<WorkerSessionInfo> = {}): WorkerSessionInfo {
  return { id: 'daemon-1', pid: 10, spawnCwd: wt, agentProcessAlive: false, commandRunning: false, resumeBinding: { agent: 'claude', sessionId: UUID, cwd: wt, permissionMode: 'bypassPermissions' }, ...over };
}

async function reclaimed(ended: 'completed' | 'cancelled' | 'failed'): Promise<ReclaimedWorkers> {
  const store = ReclaimedWorkers.at(dir);
  await reclaimWorker({
    onTransition: () => () => undefined,
    store,
    worktreeOf: async () => wt,
    listSessions: async () => [session({ agentProcessAlive: true })],
    stopAgent: async () => ({ ok: true, stopped: true }),
    now: () => 5_000,
    log: () => undefined,
  }, row(ended), ended);
  return store;
}

function clearRig(store: ReclaimedWorkers, over: Partial<WorkerClearPorts> = {}) {
  const state = { open: new Set(['ws-task', 'ws-owner']) as Set<string> | null, viewed: 'ws-owner' as string | null, now: 10_000 };
  const closeWorkspace = vi.fn(async (id: string) => {
    state.open?.delete(id);
    return true;
  });
  const changed = vi.fn();
  const ports: WorkerClearPorts = {
    store,
    openWorkspaces: () => (state.open ? new Set(state.open) : null),
    viewedWorkspace: () => state.viewed,
    workspacePtys: (id) => (id === 'ws-task' ? ['daemon-1'] : []),
    listSessions: async () => [session()],
    isTaskWorkspace: (_rec, id) => id === 'ws-task',
    closeWorkspace,
    changed,
    now: () => state.now,
    log: () => undefined,
    ...over,
  };
  return { ports, state, closeWorkspace, changed, clear: createWorkerClear(ports) };
}

describe('clearVerdict', () => {
  const rec = (over: Partial<ReclaimedWorker> = {}): ReclaimedWorker => ({
    taskId: TASK, botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 't', threadId: `task:${TASK}`,
    ended: 'completed', sessions: [], state: 'stopped', at: 1, ...over,
  });
  it('clears a stopped completed or cancelled task, keeps a resumed one and an unseen failure, defers while viewed or unknown', () => {
    expect(clearVerdict(rec(), true, 'ws-owner')).toBe('clear');
    expect(clearVerdict(rec({ ended: 'cancelled' }), true, 'ws-owner')).toBe('clear');
    expect(clearVerdict(rec({ state: 'resumed' }), true, 'ws-owner')).toBe('keep');
    expect(clearVerdict(rec({ ended: 'failed' }), true, 'ws-owner')).toBe('keep');
    expect(clearVerdict(rec({ ended: 'failed', seenAt: 2 }), true, 'ws-owner')).toBe('clear');
    expect(clearVerdict(rec(), true, 'ws-task')).toBe('defer');
    expect(clearVerdict(rec(), true, null)).toBe('defer');
    expect(clearVerdict(rec(), false, 'ws-owner')).toBe('gone');
    // A resume's new pane is the one looked at.
    expect(workerWorkspaceOf(rec({ paneWorkspaceId: 'ws-new' }))).toBe('ws-new');
    expect(clearVerdict(rec({ paneWorkspaceId: 'ws-new' }), true, 'ws-new')).toBe('defer');
  });
});

describe('isTaskWorkspaceOf', () => {
  const rec = { taskId: TASK, botId: BOT, ownerWorkspaceId: 'ws-owner', paneWorkspaceId: 'ws-new' };
  const ledgerTaskOf = (ws: string) => (ws === 'ws-task' ? TASK : ws === 'ws-other' ? 'wtask-other-0000001' : null);
  const stamps: Record<string, { owner: string; origin?: { kind: string; botId?: string } }> = {
    'ws-new': { owner: 'ws-owner', origin: { kind: 'bot', botId: BOT } },
    'ws-human': { owner: 'ws-owner', origin: { kind: 'pane' } },
  };
  const stampOf = (ws: string) => stamps[ws] ?? null;
  it('is true only for the ledger row\'s workspace or the stamped pane a resume opened', () => {
    expect(isTaskWorkspaceOf(rec, 'ws-task', ledgerTaskOf, stampOf)).toBe(true);
    expect(isTaskWorkspaceOf(rec, 'ws-new', ledgerTaskOf, stampOf)).toBe(true);
    expect(isTaskWorkspaceOf(rec, 'ws-other', ledgerTaskOf, stampOf)).toBe(false);
    expect(isTaskWorkspaceOf(rec, 'ws-owner', () => TASK, stampOf)).toBe(false);
    expect(isTaskWorkspaceOf({ ...rec, paneWorkspaceId: 'ws-human' }, 'ws-human', ledgerTaskOf, stampOf)).toBe(false);
    expect(isTaskWorkspaceOf({ ...rec, botId: 'bot-0000000b' }, 'ws-new', ledgerTaskOf, stampOf)).toBe(false);
    expect(isTaskWorkspaceOf({ ...rec, paneWorkspaceId: undefined }, 'ws-new', ledgerTaskOf, stampOf)).toBe(false);
    expect(isTaskWorkspaceOf(rec, 'ws-new', ledgerTaskOf, () => null)).toBe(false);
  });
});

describe('createWorkerClear', () => {
  it('closes the workspace of a completed task and of a cancelled one', async () => {
    for (const ended of ['completed', 'cancelled'] as const) {
      const store = await reclaimed(ended);
      const r = clearRig(store);
      expect(await r.clear.reconcile()).toBe(1);
      expect(r.closeWorkspace).toHaveBeenCalledWith('ws-task');
      expect(r.changed).toHaveBeenCalled();
      // The record stays: Resume still works from it.
      expect(store.get(TASK)?.state).toBe('stopped');
      expect(await r.clear.reconcile()).toBe(0);
      expect(r.closeWorkspace).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps a failed task\'s workspace until the owner has looked at it, then closes it once they leave', async () => {
    const store = await reclaimed('failed');
    const r = clearRig(store);
    expect(await r.clear.reconcile()).toBe(0);
    expect(r.closeWorkspace).not.toHaveBeenCalled();
    r.state.viewed = 'ws-task';
    expect(await r.clear.reconcile()).toBe(0);
    expect(store.get(TASK)?.seenAt).toBe(10_000);
    // Persisted: a restart still knows it was seen.
    await vi.waitFor(() => {
      const reloaded = ReclaimedWorkers.at(dir);
      reloaded.load();
      expect(reloaded.get(TASK)?.seenAt).toBe(10_000);
    }, { timeout: 10_000 });
    r.state.viewed = 'ws-owner';
    expect(await r.clear.reconcile()).toBe(1);
    expect(r.closeWorkspace).toHaveBeenCalledWith('ws-task');
  });

  it('defers while the owner views the workspace (or what they view is unknown) and clears once they move away', async () => {
    const store = await reclaimed('completed');
    const r = clearRig(store);
    r.state.viewed = 'ws-task';
    expect(await r.clear.reconcile()).toBe(0);
    r.state.viewed = null;
    expect(await r.clear.reconcile()).toBe(0);
    r.state.open = null;
    r.state.viewed = 'ws-owner';
    expect(await r.clear.reconcile()).toBe(0);
    expect(r.closeWorkspace).not.toHaveBeenCalled();
    r.state.open = new Set(['ws-task', 'ws-owner']);
    expect(await r.clear.reconcile()).toBe(1);
  });

  it('never closes a workspace main cannot show to be the task\'s own, nor one where an agent or a command runs', async () => {
    const store = await reclaimed('completed');
    let known = false;
    const foreign = clearRig(store, { isTaskWorkspace: () => known });
    expect(await foreign.clear.reconcile()).toBe(0);
    expect(await foreign.clear.reconcile()).toBe(0);
    expect(foreign.closeWorkspace).not.toHaveBeenCalled();
    // Looked at again only after the long wait (a lineage read may fail for a moment).
    known = true;
    foreign.state.now += CLEAR_RETRY_MS;
    expect(await foreign.clear.reconcile()).toBe(0);
    foreign.state.now += CLEAR_FOREIGN_RETRY_MS;
    expect(await foreign.clear.reconcile()).toBe(1);

    for (const busy of [{ agentProcessAlive: true }, { commandRunning: true }]) {
      const r = clearRig(store, { listSessions: async () => [session(busy)] });
      expect(await r.clear.reconcile()).toBe(0);
      expect(r.closeWorkspace).not.toHaveBeenCalled();
    }
    // The pane list unknown: nothing closes.
    const unknown = clearRig(store, { workspacePtys: () => null });
    expect(await unknown.clear.reconcile()).toBe(0);
    expect(unknown.closeWorkspace).not.toHaveBeenCalled();
  });

  it('a pane whose state is not known is busy: a command may run without a prompt mark', async () => {
    const store = await reclaimed('completed');
    const r = clearRig(store, { listSessions: async () => [session({ commandRunning: undefined })] });
    expect(await r.clear.reconcile()).toBe(0);
    expect(r.closeWorkspace).not.toHaveBeenCalled();
    // A pane the daemon no longer has is gone, not busy.
    const gone = clearRig(store, { listSessions: async () => [] });
    expect(await gone.clear.reconcile()).toBe(1);
  });

  it('reads the sessions again for each close, so a command started meanwhile keeps its workspace', async () => {
    const a = await reclaimed('completed');
    await a.put({ ...a.get(TASK)!, taskId: 'wtask-two-00000002', taskWorkspaceId: 'ws-two', sessions: [{ sessionId: 'daemon-2', cwd: wt }] });
    let reads = 0;
    const r = clearRig(a, {
      workspacePtys: (id) => (id === 'ws-task' ? ['daemon-1'] : id === 'ws-two' ? ['daemon-2'] : []),
      isTaskWorkspace: (_rec, id) => id === 'ws-task' || id === 'ws-two',
      // The second read sees a command started in ws-two during the first close.
      listSessions: async () => (++reads === 1 ? [session(), session({ id: 'daemon-2' })] : [session(), session({ id: 'daemon-2', commandRunning: true })]),
    });
    r.state.open = new Set(['ws-task', 'ws-two', 'ws-owner']);
    expect(await r.clear.reconcile()).toBe(1);
    expect(r.closeWorkspace).toHaveBeenCalledWith('ws-task');
    expect(r.closeWorkspace).not.toHaveBeenCalledWith('ws-two');
  });

  it('a look at a failed task while a pass waits on the daemon still counts as seen', async () => {
    const store = await reclaimed('failed');
    await store.put({ ...store.get(TASK)!, taskId: 'wtask-done-00000003', taskWorkspaceId: 'ws-done', ended: 'completed', sessions: [] });
    let release: () => void = () => undefined;
    let first = true;
    const r = clearRig(store, {
      isTaskWorkspace: () => true,
      workspacePtys: () => [],
      // Only the first read waits.
      listSessions: () => {
        if (!first) return Promise.resolve([]);
        first = false;
        return new Promise((resolve) => { release = () => resolve([]); });
      },
    });
    r.state.open = new Set(['ws-task', 'ws-done', 'ws-owner']);
    const pass = r.clear.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The owner looks at the failed task and leaves while the pass waits.
    r.state.viewed = 'ws-task';
    void r.clear.reconcile();
    r.state.viewed = 'ws-owner';
    expect(store.get(TASK)?.seenAt).toBe(10_000);
    release();
    await pass;
    expect(r.closeWorkspace).toHaveBeenCalledWith('ws-task');
  });

  it('a refused close is tried again only after the retry wait', async () => {
    const store = await reclaimed('completed');
    let refuse = true;
    const r = clearRig(store, { closeWorkspace: vi.fn(async () => !refuse) });
    expect(await r.clear.reconcile()).toBe(0);
    refuse = false;
    expect(await r.clear.reconcile()).toBe(0);
    r.state.now += CLEAR_RETRY_MS;
    expect(await r.clear.reconcile()).toBe(1);
  });

  it('a resume is refused while the task\'s workspace is being closed', async () => {
    const store = await reclaimed('completed');
    let finish: (v: boolean) => void = () => undefined;
    const r = clearRig(store, { closeWorkspace: () => new Promise<boolean>((resolve) => { finish = resolve; }) });
    const pass = r.clear.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const typeLine = vi.fn(() => true);
    const res = await resumeWorker({ store, listSessions: async () => [session()], typeLine }, TASK, { kind: 'owner' });
    expect(res).toMatchObject({ ok: false, code: 'busy' });
    expect(typeLine).not.toHaveBeenCalled();
    finish(true);
    expect(await pass).toBe(1);
  });
});

describe('resume of a cleared worker', () => {
  function resumeRig(store: ReclaimedWorkers, over: Partial<WorkerResumePorts> = {}) {
    const typeLine = vi.fn(() => true);
    const respawn = vi.fn(async () => ({ ok: true as const, workspaceId: 'ws-new', sessionId: 'daemon-2' }));
    const ports: WorkerResumePorts = { store, listSessions: async () => [], typeLine, respawn, now: () => 9_000, ...over };
    return { ports, typeLine, respawn };
  }

  it('opens a new pane in the recorded worktree with the resume line and records it as the worker\'s pane', async () => {
    const store = await reclaimed('completed');
    const r = resumeRig(store);
    const res = await resumeWorker(r.ports, TASK, { kind: 'owner' });
    expect(res).toMatchObject({ ok: true, sessionId: 'daemon-2', resumeSessionId: UUID, workspaceId: 'ws-new' });
    expect(r.respawn).toHaveBeenCalledWith({
      taskId: TASK, botId: BOT, ownerWorkspaceId: 'ws-owner', title: 'perf-A', cwd: wt,
      line: `claude --resume ${UUID} --dangerously-skip-permissions`, permissionMode: 'bypassPermissions',
    });
    expect(r.typeLine).not.toHaveBeenCalled();
    const rec = store.get(TASK);
    expect(rec).toMatchObject({ state: 'resumed', paneWorkspaceId: 'ws-new' });
    expect(rec?.sessions.map((s) => s.sessionId)).toEqual(['daemon-2']);
  });

  it('refuses when the worktree is gone, when an agent already runs in it, and when the pane cannot be opened', async () => {
    const store = await reclaimed('completed');
    const gone = resumeRig(store, { folderExists: () => false });
    expect(await resumeWorker(gone.ports, TASK, { kind: 'owner' })).toMatchObject({ ok: false, code: 'worktree_gone' });
    expect(gone.respawn).not.toHaveBeenCalled();
    fs.rmSync(wt, { recursive: true, force: true });
    const removed = resumeRig(store);
    expect(await resumeWorker(removed.ports, TASK, { kind: 'owner' })).toMatchObject({ ok: false, code: 'worktree_gone' });
    fs.mkdirSync(wt);
    const busy = resumeRig(store, { listSessions: async () => [session({ id: 'daemon-9', agentProcessAlive: true })] });
    expect(await resumeWorker(busy.ports, TASK, { kind: 'owner' })).toMatchObject({ ok: false, code: 'already_running' });
    expect(busy.respawn).not.toHaveBeenCalled();
    const failed = resumeRig(store, { respawn: vi.fn(async () => ({ ok: false as const, message: 'guard refused' })) });
    expect(await resumeWorker(failed.ports, TASK, { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_reopened' });
    expect(store.get(TASK)).toMatchObject({ state: 'stopped' });
    expect(store.get(TASK)?.paneWorkspaceId).toBeUndefined();
  });

  it('keeps the in-pane resume while the pane still exists', async () => {
    const store = await reclaimed('completed');
    const r = resumeRig(store, { listSessions: async () => [session()] });
    expect(await resumeWorker(r.ports, TASK, { kind: 'owner' })).toMatchObject({ ok: true, sessionId: 'daemon-1', workspaceId: 'ws-task' });
    expect(r.typeLine).toHaveBeenCalledTimes(1);
    expect(r.respawn).not.toHaveBeenCalled();
  });
});

describe('FanOutService.spawnBotTaskPane', () => {
  it('spawns on the bot worker path: guarded create, lineage stamp with the bot origin, worker permission mode', async () => {
    const guards = new FanOutGuards({ dir, countLiveTasks: () => 0, ledgerTaskOwner: () => null });
    setFanOutGuardsForTests(guards);
    let duringSpawn: ReturnType<typeof botWorkerForCreate> = null;
    const spawn = vi.fn(async (p: { cwd: string; fanoutTaskOf?: string }) => {
      duringSpawn = botWorkerForCreate({ workspaceId: 'ws-new', cwd: p.cwd, fanoutTaskOf: p.fanoutTaskOf }, { dir, isBotTaskWorkspace: () => false });
      return { workspaceId: 'ws-new', ptyId: 'daemon-2' };
    });
    const svc = new FanOutService({
      daemon: { rpc: vi.fn(async () => ({ ok: true })) },
      renderer: { spawnWorkspace: spawn },
      worktrees: {} as unknown as TaskWorktreeManager,
    });
    const r = await svc.spawnBotTaskPane({
      ownerWorkspaceId: 'ws-owner', botId: BOT, taskId: TASK, title: 'perf-A', cwd: wt,
      command: `claude --resume ${UUID}`, workerPermissionMode: 'manual', tainted: true,
    });
    expect(r).toEqual({ workspaceId: 'ws-new', ptyId: 'daemon-2' });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      cwd: wt,
      initialCommand: `claude --resume ${UUID}`,
      // As on the first launch: a resumed worker skips claude's folder-trust dialog (#2261).
      env: { CLAUDE_CODE_SANDBOXED: '1' },
      fanoutTaskOf: 'ws-owner',
      fanoutOrigin: { kind: 'bot', botId: BOT, tainted: true },
      workerPermissionMode: 'manual',
    }));
    expect(spawn.mock.calls[0][0]).not.toHaveProperty('secretGrant');
    // pty:create saw a bot worker's fan-out launch (strict: guarded or not run).
    expect(duringSpawn).toMatchObject({ strict: true, spawns: [{ botId: BOT, taskId: TASK }] });
    // The in-flight mark is released after the spawn.
    expect(botWorkerForCreate({ workspaceId: 'ws-x', cwd: wt, fanoutTaskOf: 'ws-owner' }, { dir, isBotTaskWorkspace: () => false })).toBeNull();
    expect(guards.lineageFor(['ws-new'])['ws-new']).toMatchObject({ owner: 'ws-owner', origin: { kind: 'bot', botId: BOT } });

    const refused = new FanOutService({
      daemon: { rpc: vi.fn(async () => ({ ok: true })) },
      renderer: { spawnWorkspace: vi.fn(async () => ({ error: 'PTY create failed' })) },
      worktrees: {} as unknown as TaskWorktreeManager,
    });
    expect(await refused.spawnBotTaskPane({
      ownerWorkspaceId: 'ws-owner', botId: BOT, taskId: TASK, title: 'perf-A', cwd: wt,
      command: 'claude', workerPermissionMode: 'manual', tainted: true,
    })).toEqual({ error: 'PTY create failed' });
  });
});

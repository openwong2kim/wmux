// A bot worker whose task ended stops (its agent only, the pane stays) and
// can resume the same conversation; nothing else is ever reclaimed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import {
  ReclaimedWorkers,
  createWorkerClear,
  installWorkerReclaim,
  isReclaimableEnd,
  isReclaimableReport,
  isReclaimedSince,
  isWslWorkerPane,
  isTaskOwnWorkerPane,
  clearVerdict,
  endedTaskAgentRuns,
  lifecycleCardTask,
  paneTurnEnded,
  noteWorkerAgentExit,
  reclaimWorker,
  reclaimedSessionOf,
  reclaimedWorkerState,
  resumeLineFor,
  resumeWorker,
  stopResumedWorker,
  stopResumedWorkers,
  RECLAIMED_WORKERS_MAX,
  STOPPING_SETTLE_MS,
  type ReclaimedWorker,
  type WorkerReclaimPorts,
  type WorkerResumePorts,
  type WorkerSessionInfo,
} from '../workerReclaim';
import { STOPPED_BY_OWNER } from '../factoryStop';
import { WORKER_SLOTS_FILENAME, WorkerSlots } from '../workerSlots';
import { taskFolderFromMissions } from '../verifyPreset';
import { RESEARCH_PRESET } from '../../../shared/ledger';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { holdsUnsettledRunningClaim } from '../../notification/turnSettle';
import { deliberateSleep } from '../../../test-utils/waitFor';

// The status funnel main keeps per pane (metadata.handler.ts), in memory: the
// real module pulls in electron.
const paneStatus = vi.hoisted(() => ({ status: new Map<string, string>(), claims: new Set<string>() }));
vi.mock('../../ipc/handlers/metadata.handler', () => ({
  getLastBroadcastAgentStatus: (id: string) => paneStatus.status.get(id),
  hasOutstandingRunningClaim: (id: string) => paneStatus.claims.has(id),
  broadcastMetadataUpdate: () => undefined,
}));

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

let dir: string;
let wt: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-reclaim-'));
  wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
});
afterEach(() => {
  // A record write a test did not wait for may still land while the folder
  // goes (ENOTEMPTY): retried.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function session(over: Partial<WorkerSessionInfo> = {}): WorkerSessionInfo {
  return { id: 'daemon-1', pid: 10, spawnCwd: wt, agentProcessAlive: true, resumeBinding: { agent: 'claude', sessionId: UUID, cwd: wt, permissionMode: 'bypassPermissions' }, ...over };
}

function reclaimPorts(store: ReclaimedWorkers, sessions: WorkerSessionInfo[], over: Partial<WorkerReclaimPorts> = {}) {
  const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
  const note = vi.fn();
  let listener: ((t: { entry: LedgerEntry; from: string | null; to: string }) => void) | null = null;
  const ports: WorkerReclaimPorts = {
    onTransition: (fn) => { listener = fn; return () => { listener = null; }; },
    store,
    worktreeOf: async () => wt,
    listSessions: async () => sessions,
    stopAgent,
    note,
    now: () => 5_000,
    log: () => undefined,
    ...over,
  };
  return { ports, stopAgent, note, fire: (entry: LedgerEntry, to: string) => listener?.({ entry, from: 'review_requested', to }) };
}

describe('isReclaimableEnd', () => {
  it('only a bot task that completed, failed or was cancelled, never one the owner stopped', () => {
    expect(isReclaimableEnd(row('completed'), 'completed')).toBe(true);
    expect(isReclaimableEnd(row('cancelled'), 'cancelled')).toBe(true);
    expect(isReclaimableEnd(row('failed'), 'failed')).toBe(true);
    for (const open of ['working', 'input_required', 'review_requested']) expect(isReclaimableEnd(row('working'), open)).toBe(false);
    expect(isReclaimableEnd(row('completed', { dispatch: { origin: { kind: 'pane' } } }), 'completed')).toBe(false);
    expect(isReclaimableEnd(row('cancelled', { summary: STOPPED_BY_OWNER, updatedBy: { kind: 'system', workspaceId: 'ws-daemon' } }), 'cancelled')).toBe(false);
  });
});

describe('lifecycleCardTask', () => {
  it('names a task by its title, else by its short id', () => {
    expect(lifecycleCardTask('Review PR #12', 'wtask-mvb2yimk-nj7z9ddg')).toBe('Review PR #12');
    expect(lifecycleCardTask('  ', 'wtask-mvb2yimk-nj7z9ddg')).toBe('nj7z9ddg');
    expect(lifecycleCardTask(undefined, 'wtask-mvb2yimk-nj7z9ddg')).toBe('nj7z9ddg');
  });
});

describe('reclaimWorker', () => {
  it('stops the agent of every pane started in the worktree and records its conversation', async () => {
    const store = ReclaimedWorkers.at(dir);
    const other = session({ id: 'daemon-2', spawnCwd: path.join(dir, 'elsewhere') });
    const { ports, stopAgent, note } = reclaimPorts(store, [session(), other]);
    const rec = await reclaimWorker(ports, row('completed'), 'completed');
    expect(stopAgent).toHaveBeenCalledTimes(1);
    expect(stopAgent).toHaveBeenCalledWith('daemon-1');
    expect(rec?.sessions).toEqual([{ sessionId: 'daemon-1', cwd: wt, resumeSessionId: UUID, permissionMode: 'bypassPermissions' }]);
    expect(rec?.state).toBe('stopped');
    expect(reclaimedWorkerState(store.get(rec!.taskId))).toBe('resumable');
    // The card names its task, so cards for tasks that ended together differ.
    expect(note.mock.calls[0][2]).toBe('Worker done (resumable): perf-A');
    expect(note.mock.calls[0][4]).toEqual({ code: 'worker.doneResumable', args: { status: 'completed', title: 'perf-A' } });
  });

  it('a task the bot cancelled says its worker stopped because the task ended, not to free memory', async () => {
    const store = ReclaimedWorkers.at(dir);
    const { ports, note } = reclaimPorts(store, [session()]);
    // The bot's own ledger_update: cancelled, with its reason as the summary.
    await reclaimWorker(ports, row('cancelled', { summary: 'PR merged meanwhile; cancelled to free the slot.' }), 'cancelled');
    const body = String(note.mock.calls[0][3]);
    expect(body).toBe('Task cancelled: its Claude stopped because the task ended. Its pane closes. The worktree and the conversation are kept; Resume continues the same conversation.');
    expect(body).not.toContain('free memory');
    expect(note.mock.calls[0][4]).toEqual({ code: 'worker.doneResumable', args: { status: 'cancelled', title: 'perf-A' } });
    // With no conversation recorded, the same cause.
    const bare = reclaimPorts(ReclaimedWorkers.at(path.join(dir, 'bare')), [session({ resumeBinding: undefined })]);
    await reclaimWorker(bare.ports, row('cancelled'), 'cancelled');
    expect(bare.note.mock.calls[0][3]).toBe('Task cancelled: its Claude stopped because the task ended. Its pane closes. The worktree is kept; no conversation was recorded to resume.');
  });

  it('records nothing (and the worker keeps running) without a worktree or when every stop is refused; no pane left is recorded as nothing to stop', async () => {
    const store = ReclaimedWorkers.at(dir);
    expect(await reclaimWorker(reclaimPorts(store, [session()], { worktreeOf: async () => null }).ports, row('completed'), 'completed')).toBeNull();
    const none = ReclaimedWorkers.at(path.join(dir, 'none'));
    const empty = reclaimPorts(none, []);
    expect(await reclaimWorker(empty.ports, row('failed'), 'failed')).toMatchObject({ ended: 'failed', sessions: [] });
    expect(empty.stopAgent).not.toHaveBeenCalled();
    expect(reclaimedWorkerState(none.get('wtask-abc-12345678'))).toBe('stopped');
    const refused = reclaimPorts(store, [session()], { stopAgent: async () => ({ ok: false, code: 'unsupported' }) });
    expect(await reclaimWorker(refused.ports, row('completed'), 'completed')).toBeNull();
    expect(store.all()).toEqual([]);
  });

  it('a conversation no hook gave a mode (only SessionStart) resumes in the mode its launch line started it in', async () => {
    const store = ReclaimedWorkers.at(dir);
    const noMode = session({ agentProcessAlive: false, resumeBinding: { agent: 'claude', sessionId: UUID, cwd: wt } });
    const launchedConversation = vi.fn((id: string) => (id === 'daemon-1' ? { sessionId: UUID, permissionMode: 'bypassPermissions' as const } : null));
    const rec = await reclaimWorker(reclaimPorts(store, [noMode], { launchedConversation }).ports, row('completed'), 'completed');
    expect(rec?.sessions[0]).toMatchObject({ resumeSessionId: UUID, permissionMode: 'bypassPermissions' });
    const typeLine = vi.fn(() => true);
    const r = await resumeWorker({ store, listSessions: async () => [noMode], typeLine, now: () => 9_000 }, 'wtask-abc-12345678', { kind: 'owner' });
    expect(r).toMatchObject({ ok: true });
    expect(typeLine).toHaveBeenCalledWith('daemon-1', `claude --resume ${UUID} --dangerously-skip-permissions`);
  });

  it('fills no mode for another conversation or a pane wmux did not launch, and keeps a mode a hook recorded', async () => {
    const OTHER = '3fdb815c-c5dd-4354-92e7-78b232462903';
    const noMode = session({ resumeBinding: { agent: 'claude', sessionId: UUID, cwd: wt } });
    const cases: Array<[string, WorkerReclaimPorts['launchedConversation'], WorkerSessionInfo, string | undefined]> = [
      // The pane's launch pinned another conversation (a later `claude` typed in it).
      ['other', () => ({ sessionId: OTHER, permissionMode: 'bypassPermissions' }), noMode, undefined],
      // No bot worker record for the pane (one the owner opened in the worktree).
      ['owner', () => null, noMode, undefined],
      // The launch line carried no mode flag.
      ['flagless', () => ({ sessionId: UUID }), noMode, undefined],
      // A hook recorded the mode: it is kept.
      ['hook', () => ({ sessionId: UUID, permissionMode: 'bypassPermissions' }), session({ resumeBinding: { agent: 'claude', sessionId: UUID, cwd: wt, permissionMode: 'acceptEdits' } }), 'acceptEdits'],
    ];
    for (const [name, launchedConversation, pane, want] of cases) {
      const store = ReclaimedWorkers.at(path.join(dir, name));
      const rec = await reclaimWorker(reclaimPorts(store, [pane], { launchedConversation }).ports, row('completed'), 'completed');
      expect(rec?.sessions[0].permissionMode, name).toBe(want);
    }
  });

  it('persists the record across a reload', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('cancelled'), 'cancelled');
    const again = ReclaimedWorkers.at(dir);
    again.load();
    expect(again.get('wtask-abc-12345678')?.ended).toBe('cancelled');
  });
});

describe('installWorkerReclaim', () => {
  it('reclaims on completion, never on a move to an open status, and catches up on a recent end at install', async () => {
    const store = ReclaimedWorkers.at(dir);
    const { ports, stopAgent, fire } = reclaimPorts(store, [session()], {
      allRows: () => [row('completed', { id: 'wtask-old-00000001', updatedAt: 4_000 }), row('completed', { id: 'wtask-ancient-0001', updatedAt: -1e9 })],
    });
    const off = installWorkerReclaim(ports);
    await vi.waitFor(() => expect(store.get('wtask-old-00000001')).not.toBeNull(), { timeout: 10_000 });
    expect(store.get('wtask-ancient-0001')).toBeNull();
    stopAgent.mockClear();
    fire(row('review_requested'), 'review_requested');
    fire(row('input_required'), 'input_required');
    fire(row('working'), 'working');
    await deliberateSleep(10, 'negative: non-final states stop nothing');
    expect(stopAgent).not.toHaveBeenCalled();
    fire(row('completed'), 'completed');
    await vi.waitFor(() => expect(stopAgent).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    off();
  });
});

/** Wait for the store's queued writes (they run in order) before its folder goes. */
async function settled(store: ReclaimedWorkers): Promise<void> {
  const any = store.all()[0];
  if (any) await store.put(any);
}

describe('a WSL worker (#2254): the daemon cannot stop its Linux agent', () => {
  const unsupported = () => vi.fn(async () => ({ ok: false, code: 'unsupported' }));
  const WSL = { distribution: 'Ubuntu-24.04', user: 'me' };
  // Its launch line runs (OSC 133); its Linux agent was never attributed.
  const wslWorker = (over: Partial<WorkerSessionInfo> = {}) => session({ agentProcessAlive: undefined, commandRunning: true, wslTarget: WSL, ...over });

  it('isWslWorkerPane: a WSL pane running its launch line, never a plain WSL shell, an exec unit or a Windows pane', () => {
    expect(isWslWorkerPane(wslWorker())).toBe(true);
    expect(isWslWorkerPane(wslWorker({ commandRunning: false }))).toBe(false);
    expect(isWslWorkerPane(wslWorker({ commandRunning: undefined }))).toBe(false);
    expect(isWslWorkerPane(wslWorker({ agentProcessAlive: false }))).toBe(false);
    expect(isWslWorkerPane(wslWorker({ exec: { command: 'claude' } }))).toBe(false);
    expect(isWslWorkerPane(session({ commandRunning: true }))).toBe(false);
  });

  // The task's own workspace holds daemon-1; the owner's pane daemon-2,
  // opened in the same folder from another workspace, runs vim there.
  const ownPanes = (ws: string) => (ws === 'ws-task' ? ['daemon-1'] : ['daemon-2']);
  // daemon-1 is the pane the task's own fan-out launch created (its bot
  // worker session record names the task, #2266).
  const TASK = 'wtask-abc-12345678';
  const launchedBy = (ids: Record<string, string>) => (id: string) => (ids[id] ? { taskId: ids[id] } : null);
  const sessionRecordOf = launchedBy({ 'daemon-1': TASK });

  it('a completed or cancelled task\'s WSL worker is stopped by closing its pane, as its card says; the owner\'s WSL pane in the same folder stays', async () => {
    for (const ended of ['completed', 'cancelled'] as const) {
      const store = ReclaimedWorkers.at(fs.mkdtempSync(path.join(dir, 'e-')));
      const closePane = vi.fn(async () => undefined);
      const { ports, note } = reclaimPorts(store, [wslWorker(), wslWorker({ id: 'daemon-2' })], { stopAgent: unsupported(), closePane, workspacePanes: ownPanes, sessionRecordOf });
      const rec = await reclaimWorker(ports, row(ended), ended);
      expect(closePane.mock.calls).toEqual([['daemon-1']]);
      expect(rec?.sessions.map((x) => x.sessionId)).toEqual(['daemon-1']);
      expect(note.mock.calls[0][3]).toContain('Its pane closes.');
    }
  });

  it('a resumed WSL worker whose pane a resume opened in a new workspace is closed there when its task ends', async () => {
    const store = ReclaimedWorkers.at(dir);
    await store.put({ taskId: 'wtask-abc-12345678', botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', paneWorkspaceId: 'ws-pane', title: 't', threadId: 'task:x' as never, ended: 'completed', sessions: [{ sessionId: 'daemon-1', cwd: wt }], state: 'resumed', at: 1 });
    const closePane = vi.fn(async () => undefined);
    const { ports } = reclaimPorts(store, [wslWorker()], { stopAgent: unsupported(), closePane, workspacePanes: (ws) => (ws === 'ws-pane' ? ['daemon-1'] : []) });
    await reclaimWorker(ports, row('completed', { rev: 5 }), 'completed');
    expect(closePane).toHaveBeenCalledWith('daemon-1');
    await settled(store);
  });

  it('with the workspace tree unknown (or not given), no WSL pane is closed', async () => {
    for (const workspacePanes of [() => null, undefined]) {
      const store = ReclaimedWorkers.at(fs.mkdtempSync(path.join(dir, 'u-')));
      const closePane = vi.fn(async () => undefined);
      const { ports } = reclaimPorts(store, [wslWorker()], { stopAgent: unsupported(), closePane, workspacePanes });
      expect(await reclaimWorker(ports, row('completed'), 'completed')).toBeNull();
      expect(closePane).not.toHaveBeenCalled();
    }
  });

  it('a WSL pane in the same folder but outside the task\'s workspace is never closed', async () => {
    for (const workspacePanes of [(ws: string) => (ws === 'ws-other' ? ['daemon-1'] : []), undefined]) {
      const store = ReclaimedWorkers.at(fs.mkdtempSync(path.join(dir, 'o-')));
      const closePane = vi.fn(async () => undefined);
      const { ports } = reclaimPorts(store, [wslWorker()], { stopAgent: unsupported(), closePane, ...(workspacePanes ? { workspacePanes } : {}) });
      await reclaimWorker(ports, row('completed'), 'completed');
      expect(closePane).not.toHaveBeenCalled();
    }
  });

  it('an exec unit or a plain WSL shell in the worktree is never closed', async () => {
    for (const pane of [session({ exec: { command: 'claude' } }), wslWorker({ commandRunning: false })]) {
      const store = ReclaimedWorkers.at(fs.mkdtempSync(path.join(dir, 's-')));
      const closePane = vi.fn(async () => undefined);
      const { ports } = reclaimPorts(store, [pane], { stopAgent: unsupported(), closePane, workspacePanes: ownPanes, sessionRecordOf });
      expect(await reclaimWorker(ports, row('completed'), 'completed')).toBeNull();
      expect(closePane).not.toHaveBeenCalled();
    }
  });

  it('an idle reported (still open) or failed task keeps its WSL worker\'s pane: nothing is closed, no card says it paused', async () => {
    for (const ended of ['reported', 'failed'] as const) {
      const store = ReclaimedWorkers.at(fs.mkdtempSync(path.join(dir, 'r-')));
      const current = row(ended === 'reported' ? 'review_requested' : 'failed', { updatedAt: 1_000 });
      const closePane = vi.fn(async () => undefined);
      const { ports, note } = reclaimPorts(store, [wslWorker()], { row: () => current, turnEnded: () => true, stopAgent: unsupported(), closePane, workspacePanes: ownPanes, sessionRecordOf });
      expect(await reclaimWorker(ports, current, ended)).toBeNull();
      expect(closePane).not.toHaveBeenCalled();
      expect(note).not.toHaveBeenCalled();
      expect(store.all()).toEqual([]);
    }
  });

  it('the stop of a resumed WSL worker closes its pane and counts it; a plain WSL shell and a pane outside its workspace stay', async () => {
    const put = async (store: ReclaimedWorkers) => store.put({ taskId: 'wtask-abc-12345678', botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 't', threadId: 'task:x' as never, ended: 'completed', sessions: [{ sessionId: 'daemon-1', cwd: wt }], state: 'resumed', at: 1 });
    const store = ReclaimedWorkers.at(dir);
    await put(store);
    const closePane = vi.fn(async () => undefined);
    const p: WorkerResumePorts = { store, listSessions: async () => [wslWorker()], typeLine: () => false, stopAgent: unsupported(), closePane, workspacePanes: ownPanes };
    expect(await stopResumedWorkers(p, BOT)).toEqual({ stopped: 1, failed: 0, taskIds: ['wtask-abc-12345678'] });
    expect(closePane).toHaveBeenCalledWith('daemon-1');
    expect(store.get('wtask-abc-12345678')?.state).toBe('stopped');

    const shellStore = ReclaimedWorkers.at(path.join(dir, 'shell'));
    await put(shellStore);
    const keep = vi.fn(async () => undefined);
    const shell: WorkerResumePorts = { store: shellStore, listSessions: async () => [wslWorker({ commandRunning: false })], typeLine: () => false, stopAgent: unsupported(), closePane: keep, workspacePanes: ownPanes };
    expect(await stopResumedWorkers(shell, BOT)).toEqual({ stopped: 0, failed: 1, taskIds: [] });
    expect(keep).not.toHaveBeenCalled();

    const otherStore = ReclaimedWorkers.at(path.join(dir, 'other'));
    await put(otherStore);
    const other: WorkerResumePorts = { store: otherStore, listSessions: async () => [wslWorker()], typeLine: () => false, stopAgent: unsupported(), closePane: keep, workspacePanes: () => ['daemon-2'] };
    expect(await stopResumedWorkers(other, BOT)).toEqual({ stopped: 0, failed: 1, taskIds: [] });
    expect(keep).not.toHaveBeenCalled();
  });

  it('the resume of a WSL worker is refused while a WSL agent still runs in its folder', async () => {
    const store = ReclaimedWorkers.at(dir);
    await store.put({ taskId: 'wtask-abc-12345678', botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 't', threadId: 'task:x' as never, ended: 'completed', sessions: [{ sessionId: 'daemon-1', cwd: '/mnt/c/Users/me/wt', resumeSessionId: UUID, permissionMode: 'bypassPermissions' }], state: 'stopped', at: 1 });
    const respawn = vi.fn(async () => ({ ok: true as const, workspaceId: 'ws-new', sessionId: 'daemon-9' }));
    const other = wslWorker({ id: 'daemon-7', spawnCwd: '/mnt/c/Users/me/wt', cwd: '/mnt/c/Users/me/wt' });
    // daemon-7: a pane the task's own resume launch opened (its session
    // record names the task).
    const r = await resumeWorker({ store, listSessions: async () => [other], typeLine: () => false, respawn, folderExists: () => true, platform: 'win32', now: () => 9_000, sessionRecordOf: launchedBy({ 'daemon-7': TASK }) }, 'wtask-abc-12345678', { kind: 'owner' });
    expect(r).toMatchObject({ ok: false, code: 'already_running' });
    expect(respawn).not.toHaveBeenCalled();
  });

  it('isTaskOwnWorkerPane: a pane the reclaim record lists, or whose session record names the task; nothing else', () => {
    expect(isTaskOwnWorkerPane({ id: 'daemon-1' }, TASK, ['daemon-1'], undefined)).toBe(true);
    expect(isTaskOwnWorkerPane({ id: 'daemon-1' }, TASK, [], sessionRecordOf)).toBe(true);
    expect(isTaskOwnWorkerPane({ id: 'daemon-2' }, TASK, ['daemon-1'], sessionRecordOf)).toBe(false);
    expect(isTaskOwnWorkerPane({ id: 'daemon-1' }, TASK, [], launchedBy({ 'daemon-1': 'wtask-other-87654321' }))).toBe(false);
    expect(isTaskOwnWorkerPane({ id: 'daemon-1' }, TASK, [], () => ({}))).toBe(false);
    expect(isTaskOwnWorkerPane({ id: 'daemon-1' }, TASK, [], () => { throw new Error('unreadable'); })).toBe(false);
  });

  describe('the owner\'s WSL terminal in the task\'s own workspace (#2266)', () => {
    // daemon-1: the worker; daemon-3: the owner's WSL terminal split into the
    // task workspace, cd'd into the task folder, running vim (no record, no
    // task in a session record).
    const both = (ws: string) => (ws === 'ws-task' ? ['daemon-1', 'daemon-3'] : []);
    const owners = () => wslWorker({ id: 'daemon-3', resumeBinding: undefined });

    it('the task ends: the worker\'s pane closes, the owner\'s pane is neither closed nor stopped, and the worker is recorded stopped', async () => {
      for (const ended of ['completed', 'cancelled'] as const) {
        const store = ReclaimedWorkers.at(fs.mkdtempSync(path.join(dir, 'ow-')));
        const closePane = vi.fn(async () => undefined);
        const stopAgent = unsupported();
        const { ports, note } = reclaimPorts(store, [wslWorker(), owners()], { stopAgent, closePane, workspacePanes: both, sessionRecordOf });
        const rec = await reclaimWorker(ports, row(ended), ended);
        expect(closePane.mock.calls).toEqual([['daemon-1']]);
        expect(stopAgent.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['daemon-1']);
        expect(rec?.sessions.map((x) => x.sessionId)).toEqual(['daemon-1']);
        expect(rec?.state).toBe('stopped');
        expect(note.mock.calls[0][3]).toContain('Its pane closes.');
      }
    });

    it('the worker identified by its reclaim record alone (a resumed worker) is still closed; the owner\'s pane stays', async () => {
      const store = ReclaimedWorkers.at(dir);
      await store.put({ taskId: TASK, botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 't', threadId: 'task:x' as never, ended: 'completed', sessions: [{ sessionId: 'daemon-1', cwd: wt }], state: 'resumed', at: 1 });
      const closePane = vi.fn(async () => undefined);
      const { ports } = reclaimPorts(store, [wslWorker(), owners()], { stopAgent: unsupported(), closePane, workspacePanes: both });
      const rec = await reclaimWorker(ports, row('completed', { rev: 5 }), 'completed');
      expect(closePane.mock.calls).toEqual([['daemon-1']]);
      expect(rec?.sessions.map((x) => x.sessionId)).toEqual(['daemon-1']);
      expect(rec?.state).toBe('stopped');
      await settled(store);
    });

    it('a WSL pane whose session record names another task is not this task\'s worker: never closed', async () => {
      const store = ReclaimedWorkers.at(dir);
      const closePane = vi.fn(async () => undefined);
      const { ports } = reclaimPorts(store, [wslWorker()], { stopAgent: unsupported(), closePane, workspacePanes: ownPanes, sessionRecordOf: launchedBy({ 'daemon-1': 'wtask-other-87654321' }) });
      const rec = await reclaimWorker(ports, row('completed'), 'completed');
      expect(closePane).not.toHaveBeenCalled();
      expect(rec?.sessions).toEqual([]);
      await settled(store);
    });

    it('a WSL agent the daemon attributed is stopped in the distro like a Windows pane\'s, its pane kept', async () => {
      const store = ReclaimedWorkers.at(dir);
      const closePane = vi.fn(async () => undefined);
      const { ports, stopAgent } = reclaimPorts(store, [wslWorker({ id: 'daemon-3', agentProcessAlive: true })], { closePane, workspacePanes: both });
      const rec = await reclaimWorker(ports, row('completed'), 'completed');
      expect(stopAgent).toHaveBeenCalledWith('daemon-3');
      expect(closePane).not.toHaveBeenCalled();
      expect(rec?.state).toBe('stopped');
      await settled(store);
    });

    it('Resume is not refused because of the owner\'s pane (or a pane of another task) running a command in the folder', async () => {
      for (const sessionRecord of [undefined, launchedBy({ 'daemon-7': 'wtask-other-87654321' })]) {
        const store = ReclaimedWorkers.at(fs.mkdtempSync(path.join(dir, 'rs-')));
        await store.put({ taskId: TASK, botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 't', threadId: 'task:x' as never, ended: 'completed', sessions: [{ sessionId: 'daemon-1', cwd: '/mnt/c/Users/me/wt', resumeSessionId: UUID, permissionMode: 'bypassPermissions' }], state: 'stopped', at: 1 });
        const respawn = vi.fn(async () => ({ ok: true as const, workspaceId: 'ws-new', sessionId: 'daemon-9' }));
        const owner = wslWorker({ id: 'daemon-7', spawnCwd: '/mnt/c/Users/me', cwd: '/mnt/c/Users/me/wt', resumeBinding: undefined });
        const r = await resumeWorker({ store, listSessions: async () => [owner], typeLine: () => false, respawn, folderExists: () => true, platform: 'win32', now: () => 9_000, ...(sessionRecord ? { sessionRecordOf: sessionRecord } : {}) }, TASK, { kind: 'owner' });
        expect(r).toMatchObject({ ok: true, sessionId: 'daemon-9' });
        expect(respawn).toHaveBeenCalledTimes(1);
        await settled(store);
      }
    });
  });

  it('the resume of a WSL worker whose pane closed opens the recorded Linux folder as its Windows folder', async () => {
    const store = ReclaimedWorkers.at(dir);
    await store.put({ taskId: 'wtask-abc-12345678', botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 't', threadId: 'task:x' as never, ended: 'completed', sessions: [{ sessionId: 'daemon-1', cwd: '/mnt/c/Users/me/wt', resumeSessionId: UUID, permissionMode: 'bypassPermissions' }], state: 'stopped', at: 1 });
    const folderExists = vi.fn((d: string) => d === 'C:\\Users\\me\\wt');
    const respawn = vi.fn(async () => ({ ok: true as const, workspaceId: 'ws-new', sessionId: 'daemon-9' }));
    const r = await resumeWorker({ store, listSessions: async () => [], typeLine: () => false, respawn, folderExists, platform: 'win32', now: () => 9_000 }, 'wtask-abc-12345678', { kind: 'owner' });
    expect(r).toMatchObject({ ok: true, sessionId: 'daemon-9' });
    expect(respawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: 'C:\\Users\\me\\wt' }));
    await settled(store);
  });
});

describe('a reported task whose worker sat idle (refused or failed gate)', () => {
  it('paneTurnEnded: a reported end outweighs an outstanding claim; a running turn or a prompt does not', () => {
    expect(paneTurnEnded('complete', false, false)).toBe(true);
    expect(paneTurnEnded('waiting', false, false)).toBe(true);
    expect(paneTurnEnded('running', false, false)).toBe(false);
    expect(paneTurnEnded('awaiting_input', false, false)).toBe(false);
    expect(paneTurnEnded('idle', true, false)).toBe(false);
    expect(paneTurnEnded(undefined, false, false)).toBe(false);
    expect(paneTurnEnded(undefined, false, true)).toBe(true);
  });

  it('a worker whose last hook status is complete, with its running claim still outstanding, is stopped after the 5-minute window', async () => {
    // The Stop hook's `complete` carries no settle, so the claim the turn's
    // 'running' made stays outstanding.
    paneStatus.status.set('daemon-1', 'complete');
    paneStatus.claims.add('daemon-1');
    try {
      const store = ReclaimedWorkers.at(dir);
      const current = row('review_requested', { updatedAt: 1_000 });
      const turnEnded = () => ['daemon-1'].every((id) => paneTurnEnded(paneStatus.status.get(id), holdsUnsettledRunningClaim(id), false));
      const { ports, stopAgent } = reclaimPorts(store, [session()], { allRows: () => [current], row: () => current, turnEnded });
      // Inside the window: nothing yet.
      let off = installWorkerReclaim({ ...ports, now: () => 1_000 + 4 * 60_000 });
      await deliberateSleep(10, 'negative: nothing is stopped inside the window');
      expect(stopAgent).not.toHaveBeenCalled();
      off();
      off = installWorkerReclaim({ ...ports, now: () => 1_000 + 5 * 60_000 + 1 });
      await vi.waitFor(() => expect(store.get(current.id)?.state).toBe('stopped'), { timeout: 10_000 });
      off();
      expect(stopAgent).toHaveBeenCalledWith('daemon-1', { ifTurnClosed: true });
      // The same claim while the turn still runs keeps the worker.
      paneStatus.status.set('daemon-1', 'running');
      expect(turnEnded()).toBe(false);
      await settled(store);
    } finally {
      paneStatus.status.clear();
      paneStatus.claims.clear();
    }
  });

  const reported = (over: Partial<LedgerEntry> = {}) => row('review_requested', { updatedAt: 1_000, ...over });

  it('isReclaimableReport: a bot task in review_requested, never a verify task or a pane task', () => {
    expect(isReclaimableReport(reported())).toBe(true);
    expect(isReclaimableReport(row('working'))).toBe(false);
    expect(isReclaimableReport(reported({ dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'verify' } }))).toBe(false);
    expect(isReclaimableReport(reported({ dispatch: { origin: { kind: 'pane' } } }))).toBe(false);
  });

  it('stops the idle worker once it sat long enough, keeps the task open and its pane, and is resumable', async () => {
    const store = ReclaimedWorkers.at(dir);
    let current = reported();
    let ended = true;
    const live = [session()];
    const { ports, stopAgent, note } = reclaimPorts(store, live, {
      allRows: () => [current],
      row: () => current,
      turnEnded: () => ended,
      reportedIdleMs: 3_000,
      now: () => 5_000,
    });
    // A turn still runs: nothing is stopped.
    ended = false;
    let off = installWorkerReclaim(ports);
    await deliberateSleep(10, 'negative: nothing is stopped while a turn runs');
    expect(stopAgent).not.toHaveBeenCalled();
    off();
    // Not idle long enough: nothing either.
    ended = true;
    off = installWorkerReclaim({ ...ports, reportedIdleMs: 10_000 });
    await deliberateSleep(10, 'negative: nothing is stopped before the idle bound');
    expect(stopAgent).not.toHaveBeenCalled();
    off();
    off = installWorkerReclaim(ports);
    await vi.waitFor(() => expect(store.get(current.id)?.state).toBe('stopped'), { timeout: 10_000 });
    off();
    expect(stopAgent).toHaveBeenCalledWith('daemon-1', { ifTurnClosed: true });
    const rec = store.get(current.id);
    if (!rec) throw new Error('not recorded');
    expect(rec).toMatchObject({ ended: 'reported', endRev: 3 });
    expect(reclaimedWorkerState(rec)).toBe('resumable');
    expect(note.mock.calls.map((c) => c[2])).toEqual(['Worker paused (resumable): perf-A']);
    // Its stable code (worded in the reader's language) and the task its Resume acts on.
    expect(note.mock.calls[0].slice(4)).toEqual([{ code: 'worker.pausedResumable', args: { title: 'perf-A' } }, 'wtask-abc-12345678']);
    // Its workspace stays open (closing it would cancel the task).
    expect(clearVerdict(rec, true, 'ws-elsewhere')).toBe('keep');
    // The task completes later: the record follows the end, with no second stop and no second card.
    live[0] = session({ agentProcessAlive: false, resumeBinding: undefined });
    stopAgent.mockClear();
    current = row('completed', { rev: 5, updatedAt: 4_500 });
    const after = await reclaimWorker(ports, current, 'completed');
    expect(after).toMatchObject({ ended: 'completed', endRev: 5, state: 'stopped', sessions: rec.sessions });
    expect(stopAgent).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledTimes(1);
    await settled(store);
  });

  it('stops only the panes of the task\'s own workspace, never another pane opened in its folder; an unknown tree stops nothing', async () => {
    const store = ReclaimedWorkers.at(dir);
    const owners = session({ id: 'daemon-2' }); // the owner's pane in another workspace, same folder
    const { ports, stopAgent } = reclaimPorts(store, [session(), owners], { row: () => row('review_requested'), turnEnded: () => true, workspacePanes: (ws) => (ws === 'ws-task' ? ['daemon-1'] : []) });
    expect(await reclaimWorker(ports, row('review_requested'), 'reported')).toMatchObject({ ended: 'reported', sessions: [{ sessionId: 'daemon-1' }] });
    expect(stopAgent.mock.calls).toEqual([['daemon-1', { ifTurnClosed: true }]]);
    const unknown = reclaimPorts(ReclaimedWorkers.at(path.join(dir, 'u')), [session()], { row: () => row('review_requested'), turnEnded: () => true, workspacePanes: () => null });
    expect(await reclaimWorker(unknown.ports, row('review_requested'), 'reported')).toBeNull();
    expect(unknown.stopAgent).not.toHaveBeenCalled();
    await settled(store);
  });

  it('a report that moved on (sent back, a newer rev) before the stop has nothing stopped', async () => {
    const store = ReclaimedWorkers.at(dir);
    const { ports, stopAgent } = reclaimPorts(store, [session()], { row: () => row('working', { rev: 4 }), turnEnded: () => true });
    expect(await reclaimWorker(ports, row('review_requested'), 'reported')).toBeNull();
    expect(stopAgent).not.toHaveBeenCalled();
    expect(store.all()).toEqual([]);
  });
});

describe('a research task (scratch folder, no worktree)', () => {
  it('its stopped worker resumes through worker_resume, in its pane or in a new pane in the scratch folder', async () => {
    const store = ReclaimedWorkers.at(dir);
    const research = row('completed', { dispatch: { origin: { kind: 'bot', botId: BOT }, preset: RESEARCH_PRESET } });
    // The mission names the scratch folder as its outputDir; there is no worktreePath.
    const rpc = async () => ({ ok: true, tasks: [{ id: research.id, outputDir: wt }] });
    const { ports, note } = reclaimPorts(store, [session()], { worktreeOf: (entry) => taskFolderFromMissions(rpc, entry) });
    expect(await reclaimWorker(ports, research, 'completed')).toMatchObject({ state: 'stopped', sessions: [{ cwd: wt, resumeSessionId: UUID }] });
    // Its card speaks of a task folder, not a worktree, and says so in its code.
    expect(note.mock.calls[0][3]).toContain('The task folder and the conversation are kept');
    expect(note.mock.calls[0][3]).not.toContain('worktree');
    expect(note.mock.calls[0][4]).toEqual({ code: 'worker.doneResumable', args: { status: 'completed', title: 'perf-A', kind: 'research' } });

    // In its own pane.
    const typeLine = vi.fn(() => true);
    const inPane = await resumeWorker({ store, listSessions: async () => [session({ agentProcessAlive: false, commandRunning: false })], typeLine, now: () => 9_000 }, research.id, { kind: 'bot', botId: BOT });
    expect(inPane).toMatchObject({ ok: true, sessionId: 'daemon-1', resumeSessionId: UUID });
    expect(typeLine).toHaveBeenCalledWith('daemon-1', `claude --resume ${UUID} --dangerously-skip-permissions`);

    // Its pane closed since: a new pane opens in the scratch folder.
    noteWorkerAgentExit(store, 'daemon-1', 10_000);
    const respawn = vi.fn(async () => ({ ok: true as const, workspaceId: 'ws-new', sessionId: 'daemon-9' }));
    const fresh = await resumeWorker({ store, listSessions: async () => [], typeLine, respawn, now: () => 11_000 }, research.id, { kind: 'owner' });
    expect(fresh).toMatchObject({ ok: true, sessionId: 'daemon-9', workspaceId: 'ws-new' });
    expect(respawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: wt, line: `claude --resume ${UUID} --dangerously-skip-permissions` }));
    await settled(store);
  });

  it('a bot does not start the worker of a task the owner stopped again; the owner can', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()], { row: () => row('review_requested'), turnEnded: () => true }).ports, row('review_requested'), 'reported');
    const typeLine = vi.fn(() => true);
    const ports: WorkerResumePorts = { store, listSessions: async () => [session({ agentProcessAlive: false, commandRunning: false })], typeLine, now: () => 9_000, stoppedByOwner: () => true };
    expect(await resumeWorker(ports, 'wtask-abc-12345678', { kind: 'bot', botId: BOT })).toMatchObject({ ok: false, code: 'not_now' });
    expect(typeLine).not.toHaveBeenCalled();
    expect(await resumeWorker(ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: true });
    await settled(store);
  });
});

describe('resumeWorker', () => {
  async function reclaimed(): Promise<ReclaimedWorkers> {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    return store;
  }
  function resumePorts(store: ReclaimedWorkers, live: WorkerSessionInfo[], over: Partial<WorkerResumePorts> = {}) {
    const typeLine = vi.fn(() => true);
    const ports: WorkerResumePorts = { store, listSessions: async () => live, typeLine, now: () => 9_000, ...over };
    return { ports, typeLine };
  }

  it('types the exact resume line into the recorded pane and marks the worker resumed', async () => {
    const store = await reclaimed();
    const note = vi.fn();
    const { ports, typeLine } = resumePorts(store, [session({ agentProcessAlive: false })], { note });
    const r = await resumeWorker(ports, 'wtask-abc-12345678', { kind: 'owner' });
    expect(r).toMatchObject({ ok: true, sessionId: 'daemon-1', resumeSessionId: UUID });
    // Its card names the task it resumed.
    expect(note.mock.calls[0][2]).toBe('Worker resumed: perf-A');
    expect(note.mock.calls[0][4]).toEqual({ code: 'worker.resumed', args: { by: 'owner', where: expect.any(String), title: 'perf-A' } });
    expect(typeLine).toHaveBeenCalledWith('daemon-1', `claude --resume ${UUID} --dangerously-skip-permissions`);
    expect(store.get('wtask-abc-12345678')?.state).toBe('resumed');
    // Its agent exiting makes it resumable again.
    expect(noteWorkerAgentExit(store, 'daemon-1', 10_000)).toBe(true);
    expect(reclaimedWorkerState(store.get('wtask-abc-12345678'))).toBe('resumable');
  });

  it('a resume in the pane is the task\'s next launch generation, recorded before the line is typed (#2393)', async () => {
    const store = await reclaimed();
    const launches = new WorkerSlots(path.join(dir, 'factory', WORKER_SLOTS_FILENAME), () => [], () => undefined);
    launches.load();
    launches.beginLaunch({ taskId: 'wtask-abc-12345678', origin: 'bot', botId: BOT, ownerWorkspaceId: 'ws-owner' });
    const { ports } = resumePorts(store, [session({ agentProcessAlive: false })], { launches });
    expect(await resumeWorker(ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: true });
    expect(launches.launchOf('wtask-abc-12345678')).toMatchObject({ gen: 2, state: 'launched' });
    expect(launches.paneOf('daemon-1')).toMatchObject({ taskId: 'wtask-abc-12345678', gen: 2 });
    // Not recorded, not typed.
    const store2 = await reclaimed();
    const refusing = resumePorts(store2, [session({ agentProcessAlive: false })], {
      launches: { beginLaunch: () => { throw new Error('the task\'s launch could not be recorded: disk full'); }, launched: () => true, released: () => true },
    });
    expect(await resumeWorker(refusing.ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_typed' });
    expect(refusing.typeLine).not.toHaveBeenCalled();
  });

  it('refuses another bot, a closed or moved pane, a running agent, and a line the guard did not type', async () => {
    const store = await reclaimed();
    const dead = session({ agentProcessAlive: false });
    expect(await resumeWorker(resumePorts(store, [dead]).ports, 'wtask-abc-12345678', { kind: 'bot', botId: 'bot-0000000b' })).toMatchObject({ ok: false, code: 'not_yours' });
    expect(await resumeWorker(resumePorts(store, []).ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'pane_gone' });
    expect(await resumeWorker(resumePorts(store, [{ ...dead, spawnCwd: dir }]).ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'moved' });
    expect(await resumeWorker(resumePorts(store, [session()]).ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'already_running' });
    const thrown = resumePorts(store, [dead], { typeLine: () => { throw new Error('guard refused'); } });
    expect(await resumeWorker(thrown.ports, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_typed' });
    expect(await resumeWorker(resumePorts(store, [dead]).ports, 'wtask-none-0000000', { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_reclaimed' });
    expect(store.get('wtask-abc-12345678')?.state).toBe('stopped');
  });

  it('delivers a bot\'s message once the relaunched agent is up', async () => {
    const store = await reclaimed();
    let alive = false;
    const submit = vi.fn(async () => true);
    const { ports } = resumePorts(store, [session({ agentProcessAlive: false })], {
      agentAlive: async () => alive,
      submit,
      sleep: async () => { alive = true; },
    });
    const r = await resumeWorker(ports, 'wtask-abc-12345678', { kind: 'bot', botId: BOT }, '  run npm test again  ');
    expect(r).toMatchObject({ ok: true, messageDelivered: true });
    expect(submit).toHaveBeenCalledWith('daemon-1', 'run npm test again');
  });

  it('a pane without a recorded conversation has no resume line', () => {
    expect(resumeLineFor({ sessionId: 'd', cwd: wt })).toBeNull();
    expect(resumeLineFor({ sessionId: 'd', cwd: wt, resumeSessionId: 'not-a-uuid' })).toBeNull();
    expect(resumeLineFor({ sessionId: 'd', cwd: wt, resumeSessionId: UUID })).toBe(`claude --resume ${UUID}`);
  });
});

describe('installWorkerReclaim retries', () => {
  it('an end the daemon could not serve yet is tried again, at most three times', async () => {
    vi.useFakeTimers();
    try {
      const store = ReclaimedWorkers.at(dir);
      let connected = false;
      const listSessions = vi.fn(async () => {
        if (!connected) throw new Error('the daemon is not connected');
        return [session()];
      });
      const { ports } = reclaimPorts(store, [], { listSessions, retryMs: 1_000, allRows: () => [row('completed', { updatedAt: 4_000 })] });
      const off = installWorkerReclaim(ports);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get('wtask-abc-12345678')).toBeNull();
      connected = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.get('wtask-abc-12345678')).not.toBeNull();
      off();

      const never = ReclaimedWorkers.at(path.join(dir, 'never'));
      const failing = vi.fn(async () => { throw new Error('down'); });
      const offNever = installWorkerReclaim(reclaimPorts(never, [], { listSessions: failing, retryMs: 1_000, allRows: () => [row('completed', { updatedAt: 4_000 })] }).ports);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(failing).toHaveBeenCalledTimes(3);
      offNever();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resume safety (review fixes)', () => {
  async function reclaimedStore(): Promise<ReclaimedWorkers> {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    return store;
  }
  const dead = (over: Partial<WorkerSessionInfo> = {}) => session({ agentProcessAlive: false, ...over });
  const ports = (store: ReclaimedWorkers, live: WorkerSessionInfo[], over: Partial<WorkerResumePorts> = {}): WorkerResumePorts =>
    ({ store, listSessions: async () => live, typeLine: vi.fn(() => true), ...over });

  it('refuses a pane whose shell moved out of the task folder, or whose state cannot be told', async () => {
    const store = await reclaimedStore();
    expect(await resumeWorker(ports(store, [dead({ cwd: dir })]), 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'moved' });
    expect(await resumeWorker(ports(store, [dead({ commandRunning: true })]), 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'already_running' });
    expect(await resumeWorker(ports(store, [session({ agentProcessAlive: undefined })]), 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'unknown_state' });
    // A shell at its prompt (OSC 133) with no agent ever seen is known idle.
    expect(await resumeWorker(ports(store, [session({ agentProcessAlive: undefined, commandRunning: false, cwd: wt })]), 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: true });
  });

  it('types once for two concurrent resumes and refuses a second resume of a resumed worker', async () => {
    const store = await reclaimedStore();
    const typeLine = vi.fn(() => true);
    const p = ports(store, [dead()], { typeLine });
    const [a, b] = await Promise.all([resumeWorker(p, 'wtask-abc-12345678', { kind: 'owner' }), resumeWorker(p, 'wtask-abc-12345678', { kind: 'owner' })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(typeLine).toHaveBeenCalledTimes(1);
    expect(await resumeWorker(p, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: false, code: 'already_running' });
  });

  it('the owner\'s stop reaches a resumed worker; a launch slot hands over once the line is typed', async () => {
    const store = await reclaimedStore();
    const onLaunched = vi.fn();
    const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
    const p = ports(store, [dead()], { stopAgent });
    await resumeWorker(p, 'wtask-abc-12345678', { kind: 'bot', botId: BOT }, undefined, onLaunched);
    expect(onLaunched).toHaveBeenCalledTimes(1);
    expect(await stopResumedWorkers(p, 'bot-0000000b')).toEqual({ stopped: 0, failed: 0, taskIds: [] });
    expect(await stopResumedWorkers(p, BOT)).toEqual({ stopped: 1, failed: 0, taskIds: ['wtask-abc-12345678'] });
    expect(stopAgent).toHaveBeenCalledWith('daemon-1');
    expect(store.get('wtask-abc-12345678')?.state).toBe('stopped');
  });

  it('a resume that launches tells the folder cleanup the task\'s folder is in use again', async () => {
    const store = await reclaimedStore();
    const folderResumed = vi.fn();
    expect(await resumeWorker(ports(store, [dead()], { folderResumed }), 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: true });
    expect(folderResumed).toHaveBeenCalledWith('wtask-abc-12345678');
  });

  it('one task\'s stop (Stop worker) reaches only that task\'s resumed worker and marks its record stopped', async () => {
    const store = await reclaimedStore();
    const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
    const p = ports(store, [dead()], { stopAgent });
    expect(await resumeWorker(p, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: true });
    expect(await stopResumedWorker(p, 'wtask-other-0000001')).toEqual({ stopped: 0, failed: 0, taskIds: [] });
    expect(stopAgent).not.toHaveBeenCalled();
    expect(store.get('wtask-abc-12345678')?.state).toBe('resumed');
    expect(await stopResumedWorker(p, 'wtask-abc-12345678')).toEqual({ stopped: 1, failed: 0, taskIds: ['wtask-abc-12345678'] });
    expect(stopAgent).toHaveBeenCalledWith('daemon-1');
    expect(store.get('wtask-abc-12345678')?.state).toBe('stopped');
  });

  it('a resumed worker whose pane or agent was already gone is marked stopped, not counted, and is no failure', async () => {
    for (const answer of [{ ok: false, code: 'no_session' }, { ok: true, stopped: false }]) {
      const store = await reclaimedStore();
      const p = ports(store, [dead()], { stopAgent: vi.fn(async () => answer) });
      expect(await resumeWorker(p, 'wtask-abc-12345678', { kind: 'owner' })).toMatchObject({ ok: true });
      expect(await stopResumedWorkers(p, BOT)).toEqual({ stopped: 0, failed: 0, taskIds: [] });
      expect(store.get('wtask-abc-12345678')?.state).toBe('stopped');
    }
  });

  it('a record that cannot be written stops nothing', async () => {
    const store = ReclaimedWorkers.at(dir);
    vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('disk full'));
    const { ports: p, stopAgent } = reclaimPorts(store, [session()]);
    expect(await reclaimWorker(p, row('completed'), 'completed')).toBeNull();
    expect(stopAgent).not.toHaveBeenCalled();
  });

  it('never evicts a resumed worker to stay under the record cap', async () => {
    const store = ReclaimedWorkers.at(dir);
    const rec = (i: number, state: 'stopped' | 'resumed') => ({ taskId: `wtask-n-${i}`, botId: BOT, ownerWorkspaceId: 'o', taskWorkspaceId: 't', title: 't', threadId: 'task:x' as never, ended: 'completed' as const, sessions: [], state, at: i });
    await store.put(rec(0, 'resumed'));
    for (let i = 1; i <= RECLAIMED_WORKERS_MAX; i++) await store.put(rec(i, 'stopped'));
    expect(store.get('wtask-n-0')).not.toBeNull();
    expect(store.get('wtask-n-1')).toBeNull();
    expect(store.all()).toHaveLength(RECLAIMED_WORKERS_MAX);
  });
});

describe('reclaim state and reopen (review fixes, PR #2164)', () => {
  const ID = 'wtask-abc-12345678';
  const dead = (over: Partial<WorkerSessionInfo> = {}) => session({ agentProcessAlive: false, ...over });

  it('a partly failed stop stays stopping (live, not resumable, counted) and a later look finishes it', async () => {
    const store = ReclaimedWorkers.at(dir);
    const two = [session(), session({ id: 'daemon-2' })];
    let refuse = true;
    const stopAgent = vi.fn(async (id: string) => (refuse && id === 'daemon-2' ? { ok: false, code: 'still_running' } : { ok: true, stopped: true }));
    const { ports, note } = reclaimPorts(store, two, { stopAgent });
    const rec = await reclaimWorker(ports, row('completed'), 'completed');
    expect(rec?.state).toBe('stopping');
    expect(note).not.toHaveBeenCalled();
    expect(reclaimedWorkerState(store.get(ID))).toBeNull();
    expect(await resumeWorker({ store, listSessions: async () => [dead()], typeLine: vi.fn(() => true) }, ID, { kind: 'owner' })).toMatchObject({ ok: false, code: 'busy' });
    // The second look: a stopped agent no longer shows its binding; the
    // recorded conversation is kept.
    refuse = false;
    const again = reclaimPorts(store, [session({ resumeBinding: undefined }), session({ id: 'daemon-2', resumeBinding: undefined })], { stopAgent });
    const done = await reclaimWorker(again.ports, row('completed'), 'completed');
    expect(done?.state).toBe('stopped');
    expect(done?.sessions.find((s) => s.sessionId === 'daemon-1')?.resumeSessionId).toBe(UUID);
  });

  it('a task that reopened while the reclaim waited has nothing stopped and nothing recorded', async () => {
    const store = ReclaimedWorkers.at(dir);
    const { ports, stopAgent } = reclaimPorts(store, [session()], { row: () => row('working', { rev: 4 }) });
    expect(await reclaimWorker(ports, row('failed'), 'failed')).toBeNull();
    expect(stopAgent).not.toHaveBeenCalled();
    expect(store.get(ID)).toBeNull();
  });

  it('a record covers only the end it was made for: a task that reopened and ended again is reclaimed again', async () => {
    const store = ReclaimedWorkers.at(dir);
    const { ports, stopAgent, fire } = reclaimPorts(store, [session()]);
    const off = installWorkerReclaim(ports);
    fire(row('failed', { updatedAt: 1_000 }), 'failed');
    await vi.waitFor(() => expect(store.get(ID)?.state).toBe('stopped'), { timeout: 10_000 });
    fire(row('failed', { updatedAt: 1_000 }), 'failed');
    await deliberateSleep(10, 'negative: a repeated end stops once');
    expect(stopAgent).toHaveBeenCalledTimes(1);
    fire(row('completed', { rev: 7, updatedAt: 6_000 }), 'completed');
    await vi.waitFor(() => expect(stopAgent).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    off();
  });

  it('a stop that ran while a resume was under way: the resume types nothing', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    let release: () => void = () => undefined;
    const typeLine = vi.fn(() => true);
    const ports: WorkerResumePorts = {
      store,
      typeLine,
      stopAgent: vi.fn(async () => ({ ok: true, stopped: true })),
      listSessions: () => new Promise((resolve) => { release = () => resolve([dead()]); }),
    };
    const pending = resumeWorker(ports, ID, { kind: 'bot', botId: BOT });
    await new Promise((r) => setTimeout(r, 0));
    await stopResumedWorkers(ports, BOT);
    release();
    expect(await pending).toMatchObject({ ok: false, code: 'not_now' });
    expect(typeLine).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe('stopped');
  });

  it('one task\'s stop ends that task\'s resume under way, and only that task\'s', async () => {
    for (const [stopId, ok] of [[ID, false], ['wtask-other-0000001', true]] as const) {
      const store = ReclaimedWorkers.at(path.join(dir, ok ? 'other' : 'same'));
      await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
      let release: () => void = () => undefined;
      const typeLine = vi.fn(() => true);
      const ports: WorkerResumePorts = {
        store,
        typeLine,
        stopAgent: vi.fn(async () => ({ ok: true, stopped: true })),
        listSessions: () => new Promise((resolve) => { release = () => resolve([dead()]); }),
      };
      const pending = resumeWorker(ports, ID, { kind: 'owner' });
      await new Promise((r) => setTimeout(r, 0));
      await stopResumedWorker(ports, stopId);
      release();
      expect((await pending).ok).toBe(ok);
      expect(typeLine).toHaveBeenCalledTimes(ok ? 1 : 0);
    }
  });

  it('a pane that reopened after the stop ran has its agent stopped once it is up', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
    const p: WorkerResumePorts = {
      store,
      typeLine: vi.fn(() => true),
      stopAgent,
      listSessions: async () => [],
      folderExists: () => true,
      agentAlive: async () => true,
      respawn: async () => {
        await stopResumedWorkers(p, BOT);
        return { ok: true, workspaceId: 'ws-new', sessionId: 'daemon-9' };
      },
    };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_now' });
    expect(stopAgent).toHaveBeenCalledWith('daemon-9');
    expect(store.get(ID)?.state).toBe('stopped');
  });

  it('a resumed worker the stop could not stop is reported as failed and stays resumed', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const p: WorkerResumePorts = { store, typeLine: vi.fn(() => true), listSessions: async () => [dead()], stopAgent: vi.fn(async () => ({ ok: false, code: 'still_running' })) };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: true });
    expect(await stopResumedWorkers(p)).toEqual({ stopped: 0, failed: 1, taskIds: [] });
    expect(store.get(ID)?.state).toBe('resumed');
  });

  it('a bot\'s message from a wake that carried outside text goes only to a task started from outside text', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const base = { store, listSessions: async () => [dead()], typeLine: vi.fn(() => true) };
    const clean = { ...base, taskTainted: () => false, senderTainted: () => true };
    expect(await resumeWorker(clean, ID, { kind: 'bot', botId: BOT }, 'do it')).toMatchObject({ ok: false, code: 'not_now' });
    expect(base.typeLine).not.toHaveBeenCalled();
    // Unknown sender taint counts as outside text.
    expect(await resumeWorker({ ...base, taskTainted: () => false }, ID, { kind: 'bot', botId: BOT }, 'do it')).toMatchObject({ ok: false, code: 'not_now' });
    // The bot's worker budget applies to its resume.
    expect(await resumeWorker({ ...base, botWorkerRefusal: () => 'concurrent_workers' }, ID, { kind: 'bot', botId: BOT })).toMatchObject({ ok: false, code: 'not_now' });
    // Without a message there is no outside text to pass on.
    expect(await resumeWorker(clean, ID, { kind: 'bot', botId: BOT })).toMatchObject({ ok: true });
  });

  it('records no conversation that was started in another folder than the pane', () => {
    expect(reclaimedSessionOf(session({ resumeBinding: { agent: 'claude', sessionId: UUID, cwd: path.join(wt, 'sub') } }))?.resumeSessionId).toBeUndefined();
    expect(reclaimedSessionOf(session())?.resumeSessionId).toBe(UUID);
  });

  it('never closes the workspace of a task that reopened', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const closeWorkspace = vi.fn(async () => true);
    const clearPorts = {
      store,
      openWorkspaces: () => new Set(['ws-task']),
      viewedWorkspace: () => 'ws-other',
      workspacePtys: () => [],
      listSessions: async () => [],
      isTaskWorkspace: () => true,
      closeWorkspace,
    };
    expect(await createWorkerClear({ ...clearPorts, taskOpen: () => true }).reconcile()).toBe(0);
    expect(closeWorkspace).not.toHaveBeenCalled();
    expect(await createWorkerClear({ ...clearPorts, taskOpen: () => false }).reconcile()).toBe(1);
  });
});

describe('reclaim and resume races (review fixes, second pass)', () => {
  const ID = 'wtask-abc-12345678';
  const dead = (over: Partial<WorkerSessionInfo> = {}) => session({ agentProcessAlive: false, ...over });

  it('a task that reopens while the clear reads the sessions keeps its workspace', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    let open = false;
    const closeWorkspace = vi.fn(async () => true);
    const clear = createWorkerClear({
      store,
      openWorkspaces: () => new Set(['ws-task']),
      viewedWorkspace: () => 'ws-other',
      workspacePtys: () => [],
      listSessions: async () => { open = true; return []; },
      isTaskWorkspace: () => true,
      taskOpen: () => open,
      closeWorkspace,
    });
    expect(await clear.reconcile()).toBe(0);
    expect(closeWorkspace).not.toHaveBeenCalled();
  });

  it('two resumes of one bot at once are both held to its worker budget', async () => {
    const a = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(a, [session()]).ports, row('completed'), 'completed');
    await reclaimWorker(reclaimPorts(a, [session({ id: 'daemon-2' })]).ports, row('completed', { id: 'wtask-def-12345678' }), 'completed');
    const releases: Array<() => void> = [];
    const ports: WorkerResumePorts = {
      store: a,
      typeLine: vi.fn(() => true),
      listSessions: () => new Promise((resolve) => { releases.push(() => resolve([dead(), dead({ id: 'daemon-2' })])); }),
      // A budget of one worker: the other resume under way counts.
      botWorkerRefusal: (_botId, starting) => (starting >= 1 ? 'concurrent_workers' : null),
    };
    const first = resumeWorker(ports, ID, { kind: 'bot', botId: BOT });
    const second = await resumeWorker(ports, 'wtask-def-12345678', { kind: 'bot', botId: BOT });
    expect(second).toMatchObject({ ok: false, code: 'not_now' });
    for (const r of releases) r();
    expect(await first).toMatchObject({ ok: true });
    // Once counted as resumed, the booking is gone.
    const third = await resumeWorker({ ...ports, listSessions: async () => [dead({ id: 'daemon-2' })] }, 'wtask-def-12345678', { kind: 'bot', botId: BOT });
    expect(third).toMatchObject({ ok: true });
  });

  it('a record covers the end it was made for by rev: a later end of the same task is not covered', async () => {
    const store = ReclaimedWorkers.at(dir);
    const rec = await reclaimWorker(reclaimPorts(store, [session()]).ports, row('failed', { rev: 3 }), 'failed');
    expect(rec?.endRev).toBe(3);
    expect(isReclaimedSince(store.get(ID), row('failed', { rev: 3, updatedAt: 99_999 }))).toBe(true);
    expect(isReclaimedSince(store.get(ID), row('failed', { rev: 5, updatedAt: 1 }))).toBe(false);
  });

  it('a relaunch the stop did not find running stays resumed (live) rather than stopped', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    let t = 0;
    const p: WorkerResumePorts = {
      store,
      typeLine: vi.fn(() => true),
      stopAgent: vi.fn(async () => ({ ok: true, stopped: false })),
      listSessions: async () => [],
      folderExists: () => true,
      agentAlive: async () => false,
      now: () => t,
      sleep: async (ms) => { t += ms; },
      agentWaitMs: 3_000,
      respawn: async () => {
        await stopResumedWorkers(p, BOT);
        return { ok: true, workspaceId: 'ws-new', sessionId: 'daemon-9' };
      },
    };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_now' });
    expect(store.get(ID)?.state).toBe('resumed');
  });

  async function ledgerWithEndedTask(): Promise<TaskLedger> {
    fs.mkdirSync(path.join(dir, 'ledger'));
    const ledger = new TaskLedger({ dir: path.join(dir, 'ledger') });
    await ledger.register({ id: ID, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'perf-A', dispatch: { origin: { kind: 'bot', botId: BOT } } });
    await ledger.update({ id: ID, status: 'failed', actor: { kind: 'system', workspaceId: 'daemon' }, expectedRev: 1 });
    return ledger;
  }
  const rebindOn = (ledger: TaskLedger) => vi.fn(async (taskId: string, workspaceId: string) => {
    const from = ledger.get(taskId)?.rev ?? 0;
    const r = await ledger.rebindTaskWorkspace({ id: taskId, taskWorkspaceId: workspaceId, actor: { kind: 'system', workspaceId: 'daemon' }, expectedRev: from });
    return r.ok ? { from, to: r.entry.rev } : null;
  });

  it('a worker resumed in a new workspace owns its ledger row there, and the reclaim does not take the move for a new end', async () => {
    const store = ReclaimedWorkers.at(dir);
    const ledger = await ledgerWithEndedTask();
    await reclaimWorker(reclaimPorts(store, [session()]).ports, ledger.get(ID) as LedgerEntry, 'failed');
    const rebindTask = rebindOn(ledger);
    const p: WorkerResumePorts = {
      store,
      typeLine: vi.fn(() => true),
      listSessions: async () => [],
      folderExists: () => true,
      respawn: async () => ({ ok: true, workspaceId: 'ws-new', sessionId: 'daemon-9' }),
      rebindTask,
    };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: true, workspaceId: 'ws-new' });
    expect(rebindTask).toHaveBeenCalledWith(ID, 'ws-new');
    expect(ledger.findByTaskWorkspace('ws-new')?.id).toBe(ID);
    expect(isReclaimedSince(store.get(ID), ledger.get(ID) as LedgerEntry)).toBe(true);
    // The reclaim's catch-up leaves the resumed worker running.
    const { ports, stopAgent } = reclaimPorts(store, [session({ id: 'daemon-9' })], { allRows: () => ledger.list({}), row: (id) => ledger.get(id) });
    const off = installWorkerReclaim(ports);
    await deliberateSleep(10, 'negative: the catch-up leaves a resumed worker running');
    off();
    expect(stopAgent).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe('resumed');
    const rev = ledger.get(ID)?.rev ?? 0;
    expect(await ledger.update({ id: ID, status: 'working', actor: { kind: 'worker', workspaceId: 'ws-new' }, expectedRev: rev })).toMatchObject({ ok: true });
  });

  it('a task that could not be moved to the new pane runs no worker there; the next resume moves it', async () => {
    const store = ReclaimedWorkers.at(dir);
    const ledger = await ledgerWithEndedTask();
    await reclaimWorker(reclaimPorts(store, [session()]).ports, ledger.get(ID) as LedgerEntry, 'failed');
    const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
    const typeLine = vi.fn(() => true);
    const failing: WorkerResumePorts = {
      store,
      typeLine,
      stopAgent,
      agentAlive: async () => true,
      listSessions: async () => [],
      folderExists: () => true,
      respawn: async () => ({ ok: true, workspaceId: 'ws-new', sessionId: 'daemon-9' }),
      rebindTask: async () => null,
    };
    expect(await resumeWorker(failing, ID, { kind: 'owner' })).toMatchObject({ ok: false, code: 'not_reopened' });
    expect(stopAgent).toHaveBeenCalledWith('daemon-9');
    expect(store.get(ID)?.state).toBe('stopped');
    expect(ledger.get(ID)?.taskWorkspaceId).toBe('ws-task');
    // The pane stays; the next resume types into it and moves the task first.
    const live = { ...failing, listSessions: async () => [session({ id: 'daemon-9', agentProcessAlive: false, commandRunning: false })], rebindTask: rebindOn(ledger) };
    expect(await resumeWorker(live, ID, { kind: 'owner' })).toMatchObject({ ok: true, workspaceId: 'ws-new' });
    expect(ledger.get(ID)?.taskWorkspaceId).toBe('ws-new');
    expect(typeLine).toHaveBeenCalledWith('daemon-9', expect.any(String));
  });

  it('a record replaced while its worker was resumed tells the budget it ended', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const p: WorkerResumePorts = { store, typeLine: vi.fn(() => true), listSessions: async () => [dead()] };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: true });
    const seen: string[] = [];
    store.onStateChange = (_rec, from, to) => seen.push(`${from}->${to}`);
    await store.put({ ...(store.get(ID) as NonNullable<ReturnType<typeof store.get>>), state: 'stopping', at: 9_000 });
    expect(seen).toEqual(['resumed->stopping']);
  });

  it('the budget hears a resumed worker start and end', async () => {
    const store = ReclaimedWorkers.at(dir);
    await reclaimWorker(reclaimPorts(store, [session()]).ports, row('completed'), 'completed');
    const seen: string[] = [];
    store.onStateChange = (rec, from, to) => seen.push(`${rec.botId}:${rec.taskId}:${from}->${to}`);
    const p: WorkerResumePorts = { store, typeLine: vi.fn(() => true), listSessions: async () => [dead()] };
    expect(await resumeWorker(p, ID, { kind: 'owner' })).toMatchObject({ ok: true });
    expect(noteWorkerAgentExit(store, 'daemon-1')).toBe(true);
    expect(seen).toEqual([`${BOT}:${ID}:stopped->resumed`, `${BOT}:${ID}:resumed->stopped`]);
  });
});

describe('reclaimWorker records only the task\'s own panes', () => {
  it('an owner shell started in the task folder is neither recorded nor stopped', async () => {
    const store = ReclaimedWorkers.at(fs.mkdtempSync(path.join(dir, 'own-')));
    // daemon-1 is the task's worker (its session record names the task);
    // daemon-2 is a shell the owner opened in the task folder, running claude.
    const owner = session({ id: 'daemon-2', resumeBinding: { agent: 'claude', sessionId: '3fca904b-b4cc-4243-81d3-67a121351893', cwd: wt } });
    const { ports, stopAgent } = reclaimPorts(store, [session(), owner], {
      sessionRecordOf: (id) => (id === 'daemon-1' ? { taskId: 'wtask-abc-12345678' } : null),
    });
    const rec = await reclaimWorker(ports, row('failed'), 'failed');
    expect(rec?.sessions.map((s) => s.sessionId)).toEqual(['daemon-1']);
    expect(stopAgent).toHaveBeenCalledTimes(1);
    expect(stopAgent).toHaveBeenCalledWith('daemon-1');
  });

  it('a paused worker whose pane closed keeps its conversation when its task ends', async () => {
    const store = ReclaimedWorkers.at(fs.mkdtempSync(path.join(dir, 'gone-')));
    await store.put({
      taskId: 'wtask-abc-12345678', botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 'perf-A', threadId: 'task:x' as never,
      ended: 'reported', state: 'stopped', at: 1, endRev: 2,
      sessions: [{ sessionId: 'closed-pty', cwd: wt, resumeSessionId: UUID, permissionMode: 'acceptEdits' }],
    });
    // The pane is closed: no session, and its session record is gone too.
    const { ports } = reclaimPorts(store, [], { sessionRecordOf: () => null });
    const rec = await reclaimWorker(ports, row('cancelled'), 'cancelled');
    expect(rec?.sessions).toEqual([{ sessionId: 'closed-pty', cwd: wt, resumeSessionId: UUID, permissionMode: 'acceptEdits' }]);
  });

  it('a record an older version wrote with an owner shell drops it at the next attempt', async () => {
    const store = ReclaimedWorkers.at(fs.mkdtempSync(path.join(dir, 'old-')));
    await store.put({
      taskId: 'wtask-abc-12345678', botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 'perf-A', threadId: 'task:x' as never,
      ended: 'failed', state: 'stopping', at: 1, endRev: 3,
      sessions: [{ sessionId: 'daemon-1', cwd: wt, resumeSessionId: UUID }, { sessionId: 'daemon-2', cwd: wt }],
    });
    const { ports } = reclaimPorts(store, [session(), session({ id: 'daemon-2', resumeBinding: undefined })], {
      sessionRecordOf: (id) => (id === 'daemon-1' ? { taskId: 'wtask-abc-12345678' } : null),
    });
    const rec = await reclaimWorker(ports, row('failed'), 'failed');
    expect(rec?.sessions.map((s) => s.sessionId)).toEqual(['daemon-1']);
  });
});

describe('the fan-out slot of an ended task, and a record left stopping (F25)', () => {
  const TASK = 'wtask-abc-12345678';
  const stopping = (over: Partial<ReclaimedWorker> = {}): ReclaimedWorker => ({
    taskId: TASK, botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 'perf-A', threadId: 'task:x' as never,
    ended: 'completed', sessions: [{ sessionId: 'daemon-1', cwd: wt, resumeSessionId: UUID }], state: 'stopping', at: 1_000, endRev: 3, ...over,
  });
  const ownerStopped = () => row('cancelled', { summary: STOPPED_BY_OWNER, updatedBy: { kind: 'system', workspaceId: 'ws-daemon' }, rev: 4 });

  it('endedTaskAgentRuns: an agent seen alive in any pane, or a command in the task\'s own pane; never a shell at its prompt or another\'s command', () => {
    const byId = (...s: WorkerSessionInfo[]) => new Map(s.map((x) => [x.id, x]));
    const own = (id: string) => (id === 'daemon-1' ? { taskId: TASK } : null);
    // The worker marked its row completed and its agent keeps running.
    expect(endedTaskAgentRuns(['daemon-1'], TASK, [], byId(session()), own)).toBe(true);
    // An agent the daemon sees in a pane the task did not launch is an agent all the same.
    expect(endedTaskAgentRuns(['daemon-2'], TASK, [], byId(session({ id: 'daemon-2' })), own)).toBe(true);
    // The owner's stop destroyed the sessions; the tabs stay.
    expect(endedTaskAgentRuns(['daemon-1'], TASK, [], byId(), own)).toBe(false);
    // A plain shell at its prompt, an agent seen to exit, a dead session.
    expect(endedTaskAgentRuns(['daemon-1'], TASK, [], byId(session({ agentProcessAlive: undefined, commandRunning: false })), own)).toBe(false);
    expect(endedTaskAgentRuns(['daemon-1'], TASK, [], byId(session({ agentProcessAlive: false, commandRunning: true })), own)).toBe(false);
    expect(endedTaskAgentRuns(['daemon-1'], TASK, [], byId({ ...session(), state: 'dead' } as WorkerSessionInfo), own)).toBe(false);
    // A WSL worker's launch line in its own pane runs; the same in the owner's terminal does not hold the slot.
    const wsl = (id: string) => session({ id, agentProcessAlive: undefined, commandRunning: true, wslTarget: { distribution: 'Ubuntu' } });
    expect(endedTaskAgentRuns(['daemon-1'], TASK, [], byId(wsl('daemon-1')), own)).toBe(true);
    expect(endedTaskAgentRuns(['daemon-3'], TASK, [], byId(wsl('daemon-3')), own)).toBe(false);
    expect(endedTaskAgentRuns(['daemon-3'], TASK, ['daemon-3'], byId(wsl('daemon-3')), own)).toBe(true);
    // Nothing known of the task's own pane: it counts (fail closed); of another's pane, it does not.
    const silent = (id: string) => session({ id, agentProcessAlive: undefined, commandRunning: undefined });
    expect(endedTaskAgentRuns(['daemon-1'], TASK, [], byId(silent('daemon-1')), own)).toBe(true);
    expect(endedTaskAgentRuns(['daemon-3'], TASK, [], byId(silent('daemon-3')), own)).toBe(false);
    // Only what is seen running, when asked for that.
    expect(endedTaskAgentRuns(['daemon-1'], TASK, [], byId(silent('daemon-1')), own, false)).toBe(false);
    expect(endedTaskAgentRuns(['daemon-1'], TASK, [], byId(wsl('daemon-1')), own, false)).toBe(true);
    // A shell the daemon respawned at its restart with nothing run in it since.
    expect(endedTaskAgentRuns(['daemon-1'], TASK, [], byId(session({ agentProcessAlive: undefined, recoveredAgentUnconfirmed: true })), own)).toBe(false);
  });

  it('a record left stopping by an earlier run, with no session left, is marked stopped at install', async () => {
    const store = ReclaimedWorkers.at(dir);
    await store.put(stopping());
    const changed = vi.fn();
    const { ports, stopAgent } = reclaimPorts(store, [], { row: () => ownerStopped(), allRows: () => [ownerStopped()], changed });
    const off = installWorkerReclaim({ ...ports, now: () => 5_000 });
    await vi.waitFor(() => expect(store.get(TASK)?.state).toBe('stopped'), { timeout: 10_000 });
    expect(stopAgent).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    off();
    await settled(store);
  });

  it('one left stopping in this run is looked at only past the bound, then marked stopped', async () => {
    vi.useFakeTimers();
    try {
      const store = ReclaimedWorkers.at(dir);
      let now = 10_000;
      await store.put(stopping({ at: 10_000 }));
      const { ports } = reclaimPorts(store, [], { row: () => ownerStopped(), allRows: () => [ownerStopped()], retryMs: 60_000, now: () => now });
      const off = installWorkerReclaim(ports);
      now = 10_000 + 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.get(TASK)?.state).toBe('stopping');
      now = 10_000 + STOPPING_SETTLE_MS;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.get(TASK)?.state).toBe('stopped');
      off();
      await settled(store);
    } finally {
      vi.useRealTimers();
    }
  });

  it('one whose agent still runs keeps counting, and its stop is tried once more', async () => {
    const store = ReclaimedWorkers.at(dir);
    await store.put(stopping());
    // The daemon keeps refusing the stop: the agent runs on.
    const stopAgent = vi.fn(async () => ({ ok: false, code: 'refused' }));
    const failedRow = row('failed', { rev: 5 });
    let now = 5_000;
    const { ports } = reclaimPorts(store, [session()], { row: () => failedRow, allRows: () => [], stopAgent, retryMs: 1, now: () => now });
    const off = installWorkerReclaim(ports);
    await vi.waitFor(() => expect(stopAgent).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    // Stale again past the bound: once per end, not on every look.
    now += 2 * STOPPING_SETTLE_MS;
    await deliberateSleep(30, 'negative: stopped once per end, not on every look');
    off();
    expect(stopAgent).toHaveBeenCalledTimes(1);
    expect(store.get(TASK)?.state).toBe('stopping');
    // A reported task still in review whose worker runs is left to the reported stop.
    const inReview = ReclaimedWorkers.at(path.join(dir, 'review'));
    await inReview.put(stopping({ ended: 'reported' }));
    const review = reclaimPorts(inReview, [session()], { row: () => row('review_requested'), allRows: () => [] });
    const offReview = installWorkerReclaim({ ...review.ports, now: () => 5_000 });
    await deliberateSleep(30, 'negative: a task in review is not stopped');
    offReview();
    expect(review.stopAgent).not.toHaveBeenCalled();
    expect(inReview.get(TASK)?.state).toBe('stopping');
    await settled(store);
    await settled(inReview);
  });

  it('an agent in another pane of its workspace, or a tree not known, keeps it stopping', async () => {
    const store = ReclaimedWorkers.at(dir);
    // A reported stop held back; its recorded pane is gone since.
    await store.put(stopping({ ended: 'reported' }));
    let panes: readonly string[] | null = ['daemon-1', 'daemon-2'];
    const { ports, stopAgent } = reclaimPorts(store, [session({ id: 'daemon-2', spawnCwd: path.join(dir, 'elsewhere') })], {
      row: () => row('review_requested'), allRows: () => [], workspacePanes: () => panes,
    });
    let off = installWorkerReclaim({ ...ports, now: () => 5_000 });
    await deliberateSleep(30, 'negative: the record stays stopping');
    off();
    expect(store.get(TASK)?.state).toBe('stopping');
    panes = null;
    off = installWorkerReclaim({ ...ports, listSessions: async () => [], now: () => 5_000 });
    await deliberateSleep(30, 'negative: the record stays stopping');
    off();
    expect(store.get(TASK)?.state).toBe('stopping');
    panes = ['daemon-1'];
    off = installWorkerReclaim({ ...ports, listSessions: async () => [], now: () => 5_000 });
    await vi.waitFor(() => expect(store.get(TASK)?.state).toBe('stopped'), { timeout: 10_000 });
    off();
    expect(stopAgent).not.toHaveBeenCalled();
    await settled(store);
  });

  it('a stop answered no_session (the pane went since the read) is no failed stop', async () => {
    const store = ReclaimedWorkers.at(dir);
    const { ports } = reclaimPorts(store, [session()], { stopAgent: async () => ({ ok: false, code: 'no_session' }) });
    const rec = await reclaimWorker(ports, row('completed'), 'completed');
    expect(rec?.state).toBe('stopped');
  });
});

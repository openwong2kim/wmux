// A bot worker sitting idle is stopped (it resumes later) by one test for
// both stops: a reported task's worker and a resumed worker of an ended task.
// Idle counts from each pane's own last turn edge and input, never from the
// ledger row, and never while the owner views the worker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import {
  REPORTED_IDLE_MS,
  RESUMED_IDLE_MS,
  ReclaimedWorkers,
  VIEWED_ATTENTION_MS,
  createResumedIdleSweep,
  createViewAttention,
  installWorkerReclaim,
  resumedAgentAlive,
  viewProtects,
  workerPanesIdle,
  type PaneActivity,
  type ResumedIdlePorts,
  type WorkerSessionInfo,
} from '../workerReclaim';
import { deliberateSleep } from '../../../test-utils/waitFor';

const BOT = 'bot-0000000a';
const TASK = 'wtask-abc-12345678';
const UUID = '2eca904b-b4cc-4243-81d3-67a121351892';
const MIN = 60_000;

function row(status: LedgerEntry['status'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: TASK, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'perf-A',
    status, rev: 3, updatedAt: 1_000, updatedBy: { kind: 'brain', workspaceId: 'ws-owner' },
    dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default' },
    ...over,
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-idle-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

describe('workerPanesIdle', () => {
  const ended = (over: Partial<PaneActivity> = {}): PaneActivity => ({ status: 'complete', turnStartAt: 0, turnEndAt: 0, ...over });

  it('counts from the pane\'s own last turn end and input, never before the floor', () => {
    expect(workerPanesIdle([ended()], 0, REPORTED_IDLE_MS, REPORTED_IDLE_MS)).toBe(true);
    // The report (the floor) is recent: not idle, however quiet the pane.
    expect(workerPanesIdle([ended()], MIN, REPORTED_IDLE_MS, REPORTED_IDLE_MS)).toBe(false);
    // A turn that ended a minute ago, or input a minute ago, restarts the count.
    expect(workerPanesIdle([ended({ turnStartAt: 8 * MIN, turnEndAt: 9 * MIN })], 0, 10 * MIN, REPORTED_IDLE_MS)).toBe(false);
    expect(workerPanesIdle([ended({ inputAt: 9 * MIN })], 0, 10 * MIN, REPORTED_IDLE_MS)).toBe(false);
    // A turn running or a prompt waiting: never idle.
    expect(workerPanesIdle([ended({ status: 'running' })], 0, 60 * MIN, REPORTED_IDLE_MS)).toBe(false);
    expect(workerPanesIdle([ended({ status: 'awaiting_input' })], 0, 60 * MIN, REPORTED_IDLE_MS)).toBe(false);
    expect(workerPanesIdle([], 0, 60 * MIN, REPORTED_IDLE_MS)).toBe(false);
  });

  it('needs an affirmative turn end: a silent 40-minute tool whose latch expired into idle is not idle', () => {
    // A turn starts at 0 and runs one tool for 40 minutes with no hook signal;
    // at 30 the turn latch expires and settles the pane to a synthetic idle.
    const silentTool: PaneActivity = { status: 'idle', turnStartAt: 0, turnEndAt: -MIN };
    for (const at of [31, 35, 40, 60]) expect(workerPanesIdle([silentTool], 0, at * MIN, RESUMED_IDLE_MS)).toBe(false);
  });

  it('a pane main knows nothing of (after a restart) is never idle, however old', () => {
    expect(workerPanesIdle([{}], 0, 24 * 60 * MIN, RESUMED_IDLE_MS)).toBe(false);
    expect(workerPanesIdle([{ status: 'idle' }], 0, 24 * 60 * MIN, RESUMED_IDLE_MS)).toBe(false);
    // The daemon's boot settle (no turn since the agent started) is an end.
    expect(workerPanesIdle([{ status: 'idle', turnEndAt: MIN }], 0, 6 * MIN, RESUMED_IDLE_MS)).toBe(true);
  });
});

describe('resumedAgentAlive', () => {
  it('counts a live WSL worker (agent not attributed, its launch line running) as alive', () => {
    const rec = { sessions: [{ sessionId: 'daemon-1', cwd: '/mnt/c/x' }] };
    expect(resumedAgentAlive(rec, [{ id: 'daemon-1', wslTarget: { distribution: 'Ubuntu' }, commandRunning: true }])).toBe(true);
    expect(resumedAgentAlive(rec, [{ id: 'daemon-1', agentProcessAlive: true }])).toBe(true);
    // A WSL shell back at its prompt, a dead agent, a gone pane: not alive.
    expect(resumedAgentAlive(rec, [{ id: 'daemon-1', wslTarget: { distribution: 'Ubuntu' }, commandRunning: false }])).toBe(false);
    expect(resumedAgentAlive(rec, [{ id: 'daemon-1', agentProcessAlive: false }])).toBe(false);
    expect(resumedAgentAlive(rec, [])).toBe(false);
  });
});

describe('the reported-task stop counts idle from the pane, not the row', () => {
  it('report at T, the owner\'s turn ends at T+6:30: no stop at T+7, a stop after T+11:30', async () => {
    const T = 1_000;
    let at = T;
    const pane: PaneActivity = { status: 'complete', turnStartAt: T - MIN, turnEndAt: T };
    let viewing = false;
    const current = row('review_requested', { updatedAt: T });
    const store = ReclaimedWorkers.at(dir);
    const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
    const sessions: WorkerSessionInfo[] = [{ id: 'daemon-1', spawnCwd: dir, agentProcessAlive: true, resumeBinding: { agent: 'claude', sessionId: UUID, cwd: dir } }];
    const install = () => installWorkerReclaim({
      onTransition: () => () => undefined,
      allRows: () => [current],
      row: () => current,
      store,
      worktreeOf: async () => dir,
      listSessions: async () => sessions,
      stopAgent,
      now: () => at,
      log: () => undefined,
      // As the lifecycle host words it.
      turnEnded: (e) => !viewing && workerPanesIdle([pane], e.updatedAt, at, REPORTED_IDLE_MS),
    });
    const look = async (t: number): Promise<void> => {
      at = t;
      const off = install();
      await deliberateSleep(10, 'negative: one bounded look; callers assert what it did not stop');
      off();
    };
    // The owner prompts the reported worker at T+6; its answer ends at T+6:30.
    pane.status = 'running';
    pane.turnStartAt = T + 6 * MIN;
    await look(T + 6 * MIN + 10_000);
    pane.status = 'complete';
    pane.turnEndAt = T + 6.5 * MIN;
    await look(T + 7 * MIN);
    await look(T + 11 * MIN);
    expect(stopAgent).not.toHaveBeenCalled();
    // The owner is viewing it: never stopped as idle.
    viewing = true;
    await look(T + 12 * MIN);
    expect(stopAgent).not.toHaveBeenCalled();
    viewing = false;
    at = T + 11.5 * MIN + 1;
    const off = install();
    await vi.waitFor(() => expect(store.get(TASK)?.state).toBe('stopped'), { timeout: 10_000 });
    off();
    expect(stopAgent).toHaveBeenCalledWith('daemon-1', { ifTurnClosed: true });
  });
});

describe('the idle stop of resumed workers', () => {
  let store: ReclaimedWorkers;
  beforeEach(async () => {
    store = ReclaimedWorkers.at(dir);
    await store.put({
      taskId: TASK, botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 'perf-A', threadId: `task:${TASK}` as never,
      ended: 'completed', state: 'resumed', at: 0, endRev: 3, sessions: [{ sessionId: 'daemon-1', cwd: dir, resumeSessionId: UUID }],
    });
  });

  function rig(over: Partial<ResumedIdlePorts> = {}) {
    let at = MIN;
    // The resumed agent booted and settled at its prompt a minute in.
    const pane: PaneActivity = { status: 'idle', turnEndAt: MIN };
    let viewing = false;
    const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
    const note = vi.fn();
    const changed = vi.fn();
    const sweep = createResumedIdleSweep({
      store,
      row: () => row('completed'),
      stopAgent,
      note,
      changed,
      now: () => at,
      paneActivity: () => ({ ...pane }),
      viewed: (ws) => viewing && ws === 'ws-task',
      log: () => undefined,
      ...over,
    });
    const live: WorkerSessionInfo[] = [{ id: 'daemon-1', spawnCwd: dir, agentProcessAlive: true, commandRunning: true }];
    return {
      sweep: (t: number, sessions: WorkerSessionInfo[] = live) => { at = t; return sweep.sweep(sessions); },
      pane, stopAgent, note, changed,
      view: (v: boolean) => { viewing = v; },
    };
  }

  it('stops a resumed worker idle for the window; the record is resumable again with a card', async () => {
    const r = rig();
    expect(await r.sweep(MIN + RESUMED_IDLE_MS - 1)).toEqual([]);
    expect(r.stopAgent).not.toHaveBeenCalled();
    expect(await r.sweep(MIN + RESUMED_IDLE_MS)).toEqual([TASK]);
    expect(r.stopAgent).toHaveBeenCalledWith('daemon-1');
    const rec = store.get(TASK)!;
    expect(rec.state).toBe('stopped');
    expect(rec.sessions[0].resumeSessionId).toBe(UUID);
    expect(r.note).toHaveBeenCalledWith('ws-owner', `task:${TASK}`, 'Worker paused (resumable): perf-A', expect.stringContaining('sat idle'), { code: 'worker.idlePausedResumable', args: { title: 'perf-A' } }, TASK);
    expect(r.changed).toHaveBeenCalled();
  });

  it('never stops a busy worker: a turn running (a command the agent runs), input typed, or the owner viewing it', async () => {
    const r = rig();
    r.pane.status = 'running';
    r.pane.turnStartAt = 20 * MIN;
    expect(await r.sweep(30 * MIN)).toEqual([]);
    // Its turn ended a minute ago: the count starts there.
    r.pane.status = 'complete';
    r.pane.turnEndAt = 30 * MIN;
    expect(await r.sweep(31 * MIN)).toEqual([]);
    r.pane.inputAt = 34 * MIN;
    expect(await r.sweep(36 * MIN)).toEqual([]);
    // The owner reading it (the active workspace, or the Bots worker panel).
    r.view(true);
    expect(await r.sweep(60 * MIN)).toEqual([]);
    expect(r.stopAgent).not.toHaveBeenCalled();
    expect(store.get(TASK)?.state).toBe('resumed');
    r.view(false);
    expect(await r.sweep(60 * MIN)).toEqual([TASK]);
  });

  it('leaves a worker whose task reopened, and one with no live agent (the exit sweep\'s)', async () => {
    const reopened = rig({ row: () => row('working', { rev: 5 }) });
    expect(await reopened.sweep(30 * MIN)).toEqual([]);
    const gone = rig();
    const dead: WorkerSessionInfo[] = [{ id: 'daemon-1', spawnCwd: dir, agentProcessAlive: false, commandRunning: false }];
    expect(await gone.sweep(30 * MIN, dead)).toEqual([]);
    expect(reopened.stopAgent).not.toHaveBeenCalled();
    expect(gone.stopAgent).not.toHaveBeenCalled();
  });

  it('keeps the worker resumed (counted live) when the daemon refused the stop, and tries again', async () => {
    const stopAgent = vi.fn(async () => ({ ok: false, code: 'not_verified' }));
    const r = rig({ stopAgent });
    expect(await r.sweep(30 * MIN)).toEqual([]);
    expect(store.get(TASK)?.state).toBe('resumed');
    await r.sweep(31 * MIN);
    expect(stopAgent).toHaveBeenCalledTimes(2);
  });
});

describe('a shown worker is protected only for 30 minutes after the owner\'s last input or focus', () => {
  it('viewProtects: focused or typed into within the window; shown alone is not', () => {
    expect(VIEWED_ATTENTION_MS).toBe(30 * MIN);
    expect(viewProtects(undefined, [], 0)).toBe(false);
    expect(viewProtects(undefined, [undefined], 0)).toBe(false);
    expect(viewProtects(0, [], 29 * MIN)).toBe(true);
    expect(viewProtects(0, [], 31 * MIN)).toBe(false);
    expect(viewProtects(0, [undefined, 21 * MIN], 31 * MIN)).toBe(true);
    expect(viewProtects(undefined, [21 * MIN], 31 * MIN)).toBe(true);
  });

  it('createViewAttention: becoming the active workspace, a pane focus or the Bots panel opening restarts the clock; closing the panel does not', () => {
    const a = createViewAttention();
    a.observe({ workspaceId: 'ws-task', paneId: 'p1' }, null, 0);
    a.observe({ workspaceId: 'ws-task', paneId: 'p1' }, null, 10 * MIN);
    expect(a.focusedAt('ws-task')).toBe(0);
    a.observe({ workspaceId: 'ws-task', paneId: 'p2' }, null, 20 * MIN);
    expect(a.focusedAt('ws-task')).toBe(20 * MIN);
    // The panel opens on the active workspace (a focus), then closes (none).
    a.observe({ workspaceId: 'ws-task', paneId: 'p2' }, 'ws-task', 22 * MIN);
    expect(a.focusedAt('ws-task')).toBe(22 * MIN);
    a.observe({ workspaceId: 'ws-task', paneId: 'p2' }, null, 24 * MIN);
    expect(a.focusedAt('ws-task')).toBe(22 * MIN);
    // Opened again while another workspace becomes active: a focus, which
    // stands while it stays in the panel.
    a.observe({ workspaceId: 'ws-other', paneId: 'p9' }, 'ws-task', 25 * MIN);
    expect(a.focusedAt('ws-task')).toBe(25 * MIN);
    a.observe({ workspaceId: 'ws-other', paneId: 'p8' }, 'ws-task', 40 * MIN);
    expect(a.focusedAt('ws-task')).toBe(25 * MIN);
    // Closed: no longer shown, forgotten. Opened again: a focus.
    a.observe({ workspaceId: 'ws-other', paneId: 'p9' }, null, 41 * MIN);
    expect(a.focusedAt('ws-task')).toBeUndefined();
    a.observe({ workspaceId: 'ws-other', paneId: 'p9' }, 'ws-task', 45 * MIN);
    expect(a.focusedAt('ws-task')).toBe(45 * MIN);
  });

  describe('the idle stop of a resumed worker shown in the Bots panel', () => {
    let store: ReclaimedWorkers;
    beforeEach(async () => {
      store = ReclaimedWorkers.at(dir);
      await store.put({
        taskId: TASK, botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 'perf-A', threadId: `task:${TASK}` as never,
        ended: 'completed', state: 'resumed', at: 0, endRev: 3, sessions: [{ sessionId: 'daemon-1', cwd: dir, resumeSessionId: UUID }],
      });
    });

    /** Opened in the Bots panel at 0 (a focus) while another workspace is
     *  active; its turn ended a minute in. */
    function rig() {
      let at = 0;
      const pane: PaneActivity = { status: 'idle', turnEndAt: MIN };
      const attention = createViewAttention();
      attention.observe({ workspaceId: 'ws-owner', paneId: 'p0' }, 'ws-task', 0);
      const stopAgent = vi.fn(async () => ({ ok: true, stopped: true }));
      // As the lifecycle host words it.
      const sweep = createResumedIdleSweep({
        store,
        row: () => row('completed'),
        stopAgent,
        now: () => at,
        paneActivity: () => ({ ...pane }),
        viewed: (ws) => viewProtects(attention.focusedAt(ws), [pane.inputAt], at),
        log: () => undefined,
      });
      const live: WorkerSessionInfo[] = [{ id: 'daemon-1', spawnCwd: dir, agentProcessAlive: true }];
      return { pane, stopAgent, attention, sweep: (t: number) => { at = t; return sweep.sweep(live); } };
    }

    it('closing the panel grants no more time; opening it again restarts the 30 minutes', async () => {
      const r = rig();
      // Closed at 20 and the workspace made active at once: protected until 30
      // by that focus, never past it by the close.
      r.attention.observe({ workspaceId: 'ws-task', paneId: 'p1' }, 'ws-task', 0);
      r.attention.observe({ workspaceId: 'ws-task', paneId: 'p1' }, null, 20 * MIN);
      expect(await r.sweep(29 * MIN)).toEqual([]);
      expect(await r.sweep(31 * MIN)).toEqual([TASK]);
    });

    it('opened again in the panel after 31 minutes: protected for 30 more', async () => {
      const r = rig();
      r.attention.observe({ workspaceId: 'ws-owner', paneId: 'p0' }, null, 25 * MIN);
      r.attention.observe({ workspaceId: 'ws-owner', paneId: 'p0' }, 'ws-task', 26 * MIN);
      expect(await r.sweep(31 * MIN)).toEqual([]);
      expect(await r.sweep(55 * MIN)).toEqual([]);
      expect(await r.sweep(57 * MIN)).toEqual([TASK]);
    });

    it('shown 29 minutes with no input: not stopped; 31 minutes, idle: stopped', async () => {
      const r = rig();
      expect(await r.sweep(29 * MIN)).toEqual([]);
      expect(r.stopAgent).not.toHaveBeenCalled();
      expect(await r.sweep(31 * MIN)).toEqual([TASK]);
      expect(store.get(TASK)?.state).toBe('stopped');
    });

    it('input 10 minutes ago keeps it, and focusing it again restores the protection', async () => {
      const r = rig();
      r.pane.inputAt = 21 * MIN;
      expect(await r.sweep(31 * MIN)).toEqual([]);
      // 30 minutes after that input, idle 5 minutes since: stopped, unless
      // the owner focused it again.
      r.attention.observe({ workspaceId: 'ws-task', paneId: 'p1' }, 'ws-task', 50 * MIN);
      expect(await r.sweep(52 * MIN)).toEqual([]);
      expect(await r.sweep(81 * MIN)).toEqual([TASK]);
    });

    it('a live turn or a prompt waiting is never stopped, whatever its view time', async () => {
      const r = rig();
      r.pane.status = 'running';
      r.pane.turnStartAt = 2 * MIN;
      expect(await r.sweep(120 * MIN)).toEqual([]);
      r.pane.status = 'awaiting_input';
      expect(await r.sweep(240 * MIN)).toEqual([]);
      expect(r.stopAgent).not.toHaveBeenCalled();
    });
  });
});

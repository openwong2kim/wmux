import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import type { WorkspaceListEntry } from '../../../shared/workspaceMirror';
import { AGENT_GONE_FILENAME, AGENT_GONE_MAX, AgentGoneFacts, LAUNCH_SETTLE_MS, noteSessionAgentLaunched, noteSessionInput, noteTaskPanesStopped, noteTaskWorkerLaunched, setAgentGoneFacts } from '../agentGoneFacts';
import { createTaskWorkspaceLiveness, parseSessionRead, type TaskWorkspaceLivenessPorts } from '../taskWorkspaceLiveness';
import { computeHolders, holderCounts, setHolderSource, type HolderSnapshot } from '../workerHolders';
import { WORKER_SLOTS_FILENAME, WorkerSlots } from '../workerSlots';
import type { ReclaimedWorker, WorkerSessionInfo } from '../workerReclaim';
import { FanOutGuards, refreshDormantTaskWorkspaces, setDormantRefresh, setFanOutGuardsForTests } from '../../worktask/fanoutGuards';

const REFRESH_MS = 10_000;

type Task = { id: string; status: LedgerEntry['status']; pty: string };

const tmpDir = (): string => fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wmux-task-liveness-'));

/** A world of task workspaces (`tasks`, by workspace id), the mirror's view
 *  of them (null: not pushed yet), the daemon's sessions and whether it has
 *  finished restoring them, and the durable facts under `dir`. */
function world(tasks: Record<string, Task>, opts: { dir?: string; closed?: Record<string, Task> } = {}) {
  const t = { now: 1_000_000 };
  const dir = opts.dir ?? tmpDir();
  const closed = opts.closed ?? {};
  const state: {
    entries: WorkspaceListEntry[] | null;
    sessions: WorkerSessionInfo[] | 'down' | 'hang';
    recoveryDone: boolean;
    records: ReclaimedWorker[];
    /** The task a session's worker record names. */
    ownerOf: Record<string, string>;
    /** The task a pane's launch record names (factory/workerSlots.ts). */
    paneTasks: Record<string, string>;
    /** The task a workspace's launch record names. */
    workspaceTasks: Record<string, string>;
  } = { entries: null, sessions: [], recoveryDone: true, records: [], ownerOf: {}, paneTasks: {}, workspaceTasks: {} };
  const open = (): void => {
    state.entries = Object.entries(tasks).map(([ws, task]) => ({ id: ws, name: ws, ptyIds: [task.pty] }) as WorkspaceListEntry);
  };
  const reads = vi.fn();
  const rowOf = (ws: string, task: Task | undefined): LedgerEntry | null => (task ? ({ id: task.id, status: task.status, taskWorkspaceId: ws, updatedAt: t.now } as LedgerEntry) : null);
  const facts = new AgentGoneFacts(nodePath.join(dir, 'factory', AGENT_GONE_FILENAME), () => undefined, () => t.now);
  facts.load();
  const ports: TaskWorkspaceLivenessPorts = {
    entries: () => (state.entries ? [...state.entries] : null),
    readSessions: async () => {
      reads();
      if (state.sessions === 'down') throw new Error('the daemon is not connected');
      if (state.sessions === 'hang') return new Promise<never>(() => undefined);
      const answer = { sessions: state.sessions, recoveryDone: state.recoveryDone };
      // A daemon round-trip: answered on a later turn of the event loop.
      await new Promise((r) => setTimeout(r, 0));
      return answer;
    },
    workspaceRow: (ws) => rowOf(ws, tasks[ws] ?? closed[ws]),
    row: (taskId) => {
      const hit = Object.entries({ ...tasks, ...closed }).find(([, x]) => x.id === taskId);
      return hit ? rowOf(hit[0], hit[1]) : null;
    },
    endedRows: () => Object.entries(closed).map(([ws, x]) => rowOf(ws, x) as LedgerEntry),
    records: () => state.records,
    recordedSessions: () => [],
    sessionRecordOf: (id) => (state.ownerOf[id] ? { taskId: state.ownerOf[id] } : null),
    paneTask: (id) => (state.paneTasks[id] ? { taskId: state.paneTasks[id], botId: 'bot-0000000a' } : null),
    workspaceTask: (ws) => state.workspaceTasks[ws] ?? null,
    facts,
    refreshMs: REFRESH_MS,
    now: () => t.now,
  };
  const liveness = createTaskWorkspaceLiveness(ports);
  const guards = new FanOutGuards({
    dir: tmpDir(),
    now: () => t.now,
    openWorkspaceIds: () => Object.keys(tasks),
    ledgerTaskOwner: () => null,
  });
  for (const ws of Object.keys(tasks)) guards.markTask(ws, 'ws-owner');
  // What the worker lifecycle host installs: the holder set every live cap
  // reads (workerHolders.ts), over this reader and these rows.
  const snapshot = (): HolderSnapshot => {
    const open = Object.keys(tasks);
    const rows = Object.entries({ ...tasks, ...closed }).map(([ws, x]) => ({ ...(rowOf(ws, x) as LedgerEntry), ownerWorkspaceId: 'ws-owner', title: x.id }));
    return {
      now: t.now, rows, reclaimable: new Set(), catchupMs: 86_400_000,
      workspaces: new Set(open),
      ptys: new Map(open.map((ws) => [ws, state.entries?.find((e) => e.id === ws)?.ptyIds ?? [tasks[ws].pty]])),
      stamps: new Map(open.map((ws) => [ws, { owner: 'ws-owner' }])),
      read: liveness.readState(), readAt: liveness.lastReadAt(), idle: liveness.idle.get(), busy: liveness.busyWorkspaces(),
      agentSeen: liveness.agentSeen(), agentTasks: liveness.agentSeenTasks(), gone: liveness.goneTasks(),
      records: state.records, verdicted: new Set(), reservations: guards.reservedTasks(), grants: [], heldWorkspaces: [],
      taskOfWorkspace: () => null, taskOfPane: () => null, launchAt: () => undefined, launchOf: () => null,
    };
  };
  setFanOutGuardsForTests(guards);
  setHolderSource(snapshot);
  setDormantRefresh(liveness.refresh);
  /** The task workspaces that hold a live slot now (the holder set). */
  const live = (): string[] => computeHolders(snapshot()).filter((h) => h.state !== 'free' && h.workspaceId).map((h) => h.workspaceId as string).sort();
  return { t, dir, state, open, reads, facts, liveness, guards, live };
}

const exited = (pty: string): WorkerSessionInfo => ({ id: pty, agentProcessAlive: false });
const running = (pty: string): WorkerSessionInfo => ({ id: pty, agentProcessAlive: true });

afterEach(() => {
  setHolderSource(null);
  setFanOutGuardsForTests(null);
  setDormantRefresh(null);
  vi.useRealTimers();
});

describe('task workspace liveness (#2387)', () => {
  it('a read before the workspace list is pushed is not kept: the previous values stay and the next read is not held off', async () => {
    const w = world({
      'ws-a': { id: 't-a', status: 'completed', pty: 'p-a' },
      'ws-b': { id: 't-b', status: 'cancelled', pty: 'p-b' },
    });
    w.state.sessions = [exited('p-a'), exited('p-b')];
    // Cold start: the renderer has not pushed its tree yet.
    await w.liveness.refresh();
    // Pushed now, at the same instant: a read is made, not answered from the
    // failed one as if it were fresh.
    w.open();
    await w.liveness.refresh();
    expect(w.reads).toHaveBeenCalledTimes(1);
    expect([...w.liveness.goneTasks()].sort()).toEqual(['t-a', 't-b']);
    expect([...w.liveness.idle.get()].sort()).toEqual(['ws-a', 'ws-b']);
    expect(w.guards.liveTaskCount()).toBe(0);

    // A later read that finds no tree keeps the last good values.
    w.t.now += REFRESH_MS + 1;
    w.state.entries = null;
    await w.liveness.refresh();
    expect([...w.liveness.goneTasks()].sort()).toEqual(['t-a', 't-b']);
    expect([...w.liveness.idle.get()].sort()).toEqual(['ws-a', 'ws-b']);
  });

  it('a live-cap check after refreshDormantTaskWorkspaces counts on the fresh read', async () => {
    const w = world({
      'ws-a': { id: 't-a', status: 'completed', pty: 'p-a' },
      'ws-b': { id: 't-b', status: 'failed', pty: 'p-b' },
    });
    w.open();
    // The last read saw both agents still running after their tasks ended.
    w.state.sessions = [running('p-a'), running('p-b')];
    await w.liveness.refresh();
    expect(w.guards.liveTaskCount()).toBe(2);
    // Both agents exit; the snapshot is stale.
    w.state.sessions = [exited('p-a'), exited('p-b')];
    w.t.now += REFRESH_MS + 1;
    expect(w.guards.liveTaskCount()).toBe(2);
    await refreshDormantTaskWorkspaces();
    expect(w.guards.liveTaskCount()).toBe(0);
  });

  it('an ended task an agent was last seen in keeps its slot while the daemon cannot be read', async () => {
    const w = world({
      'ws-agent': { id: 't-agent', status: 'completed', pty: 'p-agent' },
      'ws-gone': { id: 't-gone', status: 'completed', pty: 'p-gone' },
    });
    // The first read comes before the tree; the next one sees an agent in ws-agent.
    w.state.sessions = [running('p-agent'), exited('p-gone')];
    await w.liveness.refresh();
    w.open();
    await w.liveness.refresh();
    // Then the daemon drops.
    w.state.sessions = 'down';
    w.t.now += REFRESH_MS + 1;
    await refreshDormantTaskWorkspaces();
    expect(w.live()).toEqual(['ws-agent']);
  });

  it('an empty workspace list is not kept: the restored tree is read at once', async () => {
    const w = world({
      'ws-agent': { id: 't-agent', status: 'completed', pty: 'p-agent' },
      'ws-gone': { id: 't-gone', status: 'completed', pty: 'p-gone' },
    });
    // Pushed empty first, then the restored tree at the same instant: a read is made.
    w.state.entries = [];
    w.state.sessions = [running('p-agent'), exited('p-gone')];
    await w.liveness.refresh();
    expect(w.reads).not.toHaveBeenCalled();
    w.open();
    await w.liveness.refresh();
    expect(w.reads).toHaveBeenCalledTimes(1);
    expect(w.live()).toEqual(['ws-agent']);
  });

  it('a task that ends after the last good read holds its slot while reads fail: nothing says its agent is gone', async () => {
    const tasks: Record<string, Task> = { 'ws-x': { id: 't-x', status: 'working', pty: 'p-x' } };
    const w = world(tasks);
    w.open();
    // The last good read: the task is still working, its agent has exited
    // (an open task whose panes run no agent holds nothing, workerHolders.ts).
    w.state.sessions = [exited('p-x')];
    await w.liveness.refresh();
    expect(w.live()).toEqual([]);
    // The task completes, then the daemon cannot be read.
    tasks['ws-x'].status = 'completed';
    w.state.sessions = 'down';
    w.t.now += REFRESH_MS + 1;
    await refreshDormantTaskWorkspaces();
    expect(w.live()).toEqual(['ws-x']);
    // The next good read sees it gone (after the read the check above set off).
    await w.liveness.refresh();
    w.state.sessions = [exited('p-x')];
    w.t.now += REFRESH_MS + 1;
    await refreshDormantTaskWorkspaces();
    expect(w.live()).toEqual([]);
  });

  it('a fresh read that never answers holds the check for 2 s at most, then the facts decide (second layer)', async () => {
    const dir = tmpDir();
    const first = world({ 'ws-done': { id: 't-done', status: 'completed', pty: 'p-done' } }, { dir });
    first.open();
    first.state.sessions = [exited('p-done')];
    await first.liveness.refresh();
    await first.facts.written();
    const w = world({
      'ws-done': { id: 't-done', status: 'completed', pty: 'p-done' },
      'ws-run': { id: 't-run', status: 'working', pty: 'p-run' },
    }, { dir });
    w.open();
    w.state.sessions = 'hang';
    vi.useFakeTimers();
    let settled = false;
    void refreshDormantTaskWorkspaces().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(w.live()).toEqual(['ws-run']);
  });
});

describe('durable "agent seen gone" facts (#2393)', () => {
  it('a cold start whose daemon cannot answer counts an ended task seen gone before the restart as dormant, and one never seen gone as live', async () => {
    const dir = tmpDir();
    const tasks: Record<string, Task> = {
      'ws-done': { id: 't-done', status: 'completed', pty: 'p-done' },
      'ws-cancel': { id: 't-cancel', status: 'cancelled', pty: 'p-cancel' },
      'ws-held': { id: 't-held', status: 'completed', pty: 'p-held' },
    };
    const before = world(tasks, { dir });
    before.open();
    // Before the restart: two agents seen gone, one still running at shutdown.
    before.state.sessions = [exited('p-done'), exited('p-cancel'), running('p-held')];
    await before.liveness.refresh();
    await before.facts.written();

    const after = world(tasks, { dir });
    after.open();
    after.state.sessions = 'down';
    await refreshDormantTaskWorkspaces();
    expect(after.live()).toEqual(['ws-held']);
    expect([...after.liveness.goneTasks()].sort()).toEqual(['t-cancel', 't-done']);
    expect(after.guards.reserve('k', 7)).toEqual({ ok: true });
  });

  it('a read while the daemon still restores its sessions writes nothing and keeps nothing; once it is done, an empty list frees the slots', async () => {
    const dir = tmpDir();
    const w = world({
      'ws-a': { id: 't-a', status: 'completed', pty: 'p-a' },
      'ws-b': { id: 't-b', status: 'failed', pty: 'p-b' },
    }, { dir });
    w.open();
    // A WSL pane still waiting for its distribution reads as suspended.
    w.state.sessions = [{ id: 'p-a', state: 'suspended' } as WorkerSessionInfo];
    w.state.recoveryDone = false;
    await w.liveness.refresh();
    expect(w.reads).toHaveBeenCalledTimes(1);
    expect(w.live()).toEqual(['ws-a', 'ws-b']);
    expect(w.facts.all()).toEqual([]);
    expect(w.liveness.goneTasks().size).toBe(0);
    // Not cached as fresh, and not asked again for 2 s: a cap check looks
    // often while the daemon is busiest.
    await w.liveness.refresh();
    expect(w.reads).toHaveBeenCalledTimes(1);
    w.t.now += 2_000;
    await w.liveness.refresh();
    expect(w.reads).toHaveBeenCalledTimes(2);

    // Recovery done, nothing came back: the agents are gone.
    w.state.sessions = [];
    w.state.recoveryDone = true;
    w.t.now += 2_000;
    await w.liveness.refresh();
    expect(w.live()).toEqual([]);
    await w.facts.written();
    expect(w.facts.all().map((f) => [f.taskId, f.taskWorkspaceId, f.sessions])).toEqual([['t-a', 'ws-a', ['p-a']], ['t-b', 'ws-b', ['p-b']]]);
    const onDisk = JSON.parse(fs.readFileSync(nodePath.join(dir, 'factory', AGENT_GONE_FILENAME), 'utf8')) as { version: number; facts: unknown[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.facts).toHaveLength(2);
  });

  it('a failed read never removes a fact; an agent seen running again clears it, for good', async () => {
    const dir = tmpDir();
    const tasks: Record<string, Task> = { 'ws-x': { id: 't-x', status: 'completed', pty: 'p-x' } };
    const w = world(tasks, { dir });
    w.open();
    w.state.sessions = [exited('p-x')];
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).not.toBeNull();
    w.state.sessions = 'down';
    w.t.now += REFRESH_MS + 1;
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).not.toBeNull();
    expect(w.live()).toEqual([]);
    // The owner started an agent in the ended task's pane (read after the
    // read the check above set off).
    await w.liveness.refresh();
    w.state.sessions = [running('p-x')];
    w.t.now += REFRESH_MS + 1;
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).toBeNull();
    expect(w.live()).toEqual(['ws-x']);
    await w.facts.written();
    // Running at the next shutdown: after the restart it holds its slot.
    const after = world(tasks, { dir });
    after.open();
    after.state.sessions = 'down';
    await refreshDormantTaskWorkspaces();
    expect(after.live()).toEqual(['ws-x']);
  });

  it('a fact does not hold for a reopened row, a resumed worker, or a pane it does not name', async () => {
    const tasks: Record<string, Task> = {
      'ws-open': { id: 't-open', status: 'completed', pty: 'p-open' },
      'ws-resumed': { id: 't-resumed', status: 'completed', pty: 'p-resumed' },
      'ws-split': { id: 't-split', status: 'completed', pty: 'p-split' },
    };
    const w = world(tasks);
    w.open();
    w.state.sessions = [exited('p-open'), exited('p-resumed'), exited('p-split')];
    await w.liveness.refresh();
    expect(w.liveness.goneTasks().size).toBe(3);
    w.state.sessions = 'down';
    w.t.now += REFRESH_MS + 1;
    await w.liveness.refresh();
    tasks['ws-open'].status = 'working';
    w.state.records = [{ taskId: 't-resumed', state: 'resumed', taskWorkspaceId: 'ws-resumed', sessions: [] } as unknown as ReclaimedWorker];
    w.state.entries = (w.state.entries ?? []).map((e) => (e.id === 'ws-split' ? { ...e, ptyIds: ['p-split', 'p-new'] } : e));
    // No fact holds any more. The reopened row is an open task again, and
    // its panes read idle: the open-task rule frees it (workerHolders.ts).
    expect(w.liveness.goneTasks().size).toBe(0);
    expect(w.live()).toEqual(['ws-resumed', 'ws-split']);
  });

  it('an ended task whose workspace is closed is recorded gone: its panes are gone', async () => {
    const w = world({ 'ws-open': { id: 't-open', status: 'working', pty: 'p-open' } }, {
      closed: { 'ws-closed': { id: 't-closed', status: 'completed', pty: 'p-closed' } },
    });
    w.open();
    w.state.sessions = [running('p-open')];
    await w.liveness.refresh();
    expect(w.facts.get('t-closed')).toMatchObject({ taskWorkspaceId: 'ws-closed', sessions: [] });
    expect([...w.liveness.goneTasks()]).toEqual(['t-closed']);
  });

  it('a task\'s worker pane seen running in another workspace clears its fact', async () => {
    const w = world({ 'ws-other': { id: 't-other', status: 'working', pty: 'p-other' } }, {
      closed: { 'ws-closed': { id: 't-closed', status: 'completed', pty: 'p-closed' } },
    });
    w.open();
    w.state.sessions = [exited('p-other')];
    await w.liveness.refresh();
    expect(w.facts.get('t-closed')).not.toBeNull();
    // The owner adopted the task's worker pane into ws-other and resumed it.
    w.state.entries = (w.state.entries ?? []).map((e) => ({ ...e, ptyIds: ['p-other', 'p-closed'] }));
    w.state.ownerOf = { 'p-closed': 't-closed' };
    w.state.sessions = [exited('p-other'), running('p-closed')];
    w.t.now += REFRESH_MS + 1;
    await w.liveness.refresh();
    expect(w.facts.get('t-closed')).toBeNull();
    expect(w.liveness.goneTasks().size).toBe(0);
  });

  it('a closed workspace is no proof while a session outside the tree is at work, or while the task\'s own pane runs', async () => {
    const w = world({ 'ws-open': { id: 't-open', status: 'working', pty: 'p-open' } }, {
      closed: { 'ws-closed': { id: 't-closed', status: 'completed', pty: 'p-closed' } },
    });
    w.open();
    // The tree came back without the task's workspace; its pane still runs.
    w.state.sessions = [running('p-open'), running('p-closed')];
    await w.liveness.refresh();
    expect(w.facts.get('t-closed')).toBeNull();
    expect(w.liveness.goneTasks().size).toBe(0);
  });

  it('a read that started before an agent launch in the pane adds no fact, and the launch clears the one held', async () => {
    const w = world({ 'ws-x': { id: 't-x', status: 'completed', pty: 'p-x' } });
    w.open();
    w.state.sessions = [exited('p-x')];
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).not.toBeNull();
    // The owner resumes the agent in the same pane (pty:write-launch).
    w.facts.sessionLaunched('p-x');
    expect(w.facts.get('t-x')).toBeNull();
    // A read that started before the launch answers after it.
    w.t.now += REFRESH_MS + 1;
    const before = w.t.now;
    const reading = w.liveness.refresh();
    w.facts.sessionLaunched('p-x', before);
    await reading;
    expect(w.facts.get('t-x')).toBeNull();
    expect(w.live()).toEqual(['ws-x']);
  });

  it('after a launch in the pane, a read that still says its old agent exited adds no fact until the new one is seen or the launch settles', async () => {
    const w = world({ 'ws-x': { id: 't-x', status: 'completed', pty: 'p-x' } });
    w.open();
    w.facts.sessionLaunched('p-x');
    w.t.now += 1;
    // The daemon still reports the previous agent's exit.
    w.state.sessions = [{ id: 'p-x', agentProcessAlive: false, commandRunning: true }];
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).toBeNull();
    // The new agent is seen, then exits: that exit is a real one.
    w.t.now += REFRESH_MS + 1;
    w.state.sessions = [running('p-x')];
    await w.liveness.refresh();
    w.t.now += REFRESH_MS + 1;
    w.state.sessions = [exited('p-x')];
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).not.toBeNull();
    // A launch that never shows an agent settles after LAUNCH_SETTLE_MS.
    w.facts.sessionLaunched('p-x');
    w.t.now += REFRESH_MS + 1;
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).toBeNull();
    w.t.now += LAUNCH_SETTLE_MS;
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).not.toBeNull();
  });

  it('a read that saw the old agent running before a launch does not settle that launch', async () => {
    const w = world({ 'ws-x': { id: 't-x', status: 'completed', pty: 'p-x' } });
    w.open();
    w.state.sessions = [running('p-x')];
    const reading = w.liveness.refresh();
    w.t.now += 1;
    w.facts.sessionLaunched('p-x');
    await reading;
    // The daemon still reports the previous agent's exit.
    w.t.now += REFRESH_MS + 1;
    w.state.sessions = [exited('p-x')];
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).toBeNull();
  });

  it('an open workspace that lists no pane is no proof while the task\'s recorded worker still runs', async () => {
    const w = world({ 'ws-x': { id: 't-x', status: 'completed', pty: 'p-x' } });
    w.open();
    w.state.entries = (w.state.entries ?? []).map((e) => ({ ...e, ptyIds: [] }));
    w.state.records = [{ taskId: 't-x', state: 'stopping', taskWorkspaceId: 'ws-x', sessions: [{ sessionId: 'p-x', cwd: '/w' }] } as unknown as ReclaimedWorker];
    w.state.sessions = [running('p-x')];
    await w.liveness.refresh();
    expect(w.facts.get('t-x')).toBeNull();
    expect(w.liveness.goneTasks().size).toBe(0);
  });

  it('a read that saw the agent running before a close stopped the panes leaves the close\'s fact', async () => {
    const w = world({ 'ws-x': { id: 't-x', status: 'completed', pty: 'p-x' } });
    w.open();
    w.state.sessions = [running('p-x')];
    const reading = w.liveness.refresh();
    // The close lands while the read is answered.
    w.t.now += 1;
    w.facts.note({ taskId: 't-x', taskWorkspaceId: 'ws-x', sessions: ['p-x'], at: w.t.now });
    await reading;
    expect(w.facts.get('t-x')).not.toBeNull();
    expect(w.live()).toEqual([]);
  });

  it('a close that stopped only some of the workspace\'s panes does not outweigh a sighting of the agent', async () => {
    const w = world({ 'ws-x': { id: 't-x', status: 'completed', pty: 'p-x' } });
    w.open();
    w.state.entries = (w.state.entries ?? []).map((e) => ({ ...e, ptyIds: ['p-x', 'p-split'] }));
    w.state.sessions = [exited('p-x'), running('p-split')];
    await w.liveness.refresh();
    w.t.now += 1;
    w.facts.note({ taskId: 't-x', taskWorkspaceId: 'ws-x', sessions: ['p-x'], at: w.t.now });
    w.state.sessions = 'down';
    expect(w.live()).toEqual(['ws-x']);
    expect(w.liveness.goneTasks().size).toBe(0);
  });

  it('a close that stopped the panes after the last read outweighs that read\'s sighting of the agent', async () => {
    const w = world({ 'ws-x': { id: 't-x', status: 'completed', pty: 'p-x' } });
    w.open();
    w.state.sessions = [running('p-x')];
    await w.liveness.refresh();
    expect(w.live()).toEqual(['ws-x']);
    w.t.now += 1;
    w.facts.note({ taskId: 't-x', taskWorkspaceId: 'ws-x', sessions: ['p-x'], at: w.t.now });
    w.state.sessions = 'down';
    expect(w.live()).toEqual([]);
    expect([...w.liveness.goneTasks()]).toEqual(['t-x']);
  });
});

describe('agent-gone facts file', () => {
  it('a file a newer version wrote means no facts and is never written over', async () => {
    const dir = tmpDir();
    const file = nodePath.join(dir, 'factory', AGENT_GONE_FILENAME);
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const foreign = JSON.stringify({ version: 2, facts: [{ taskId: 't-a', taskWorkspaceId: 'ws-a', sessions: [], at: 1 }] });
    fs.writeFileSync(file, foreign);
    const warn = vi.fn();
    const facts = new AgentGoneFacts(file, warn);
    expect(() => facts.load()).not.toThrow();
    expect(facts.all()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    facts.note({ taskId: 't-b', taskWorkspaceId: 'ws-b', sessions: ['p-b'], at: 2 });
    await facts.written();
    expect(facts.get('t-b')).not.toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(foreign);
  });

  it('a broken file whose backup a newer version wrote is refused like the newer file itself', async () => {
    const dir = tmpDir();
    const file = nodePath.join(dir, 'factory', AGENT_GONE_FILENAME);
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const newer = JSON.stringify({ version: 2, facts: [] });
    fs.writeFileSync(file, '{not json');
    fs.writeFileSync(`${file}.bak`, newer);
    const facts = new AgentGoneFacts(file, () => undefined, () => 7);
    facts.load();
    facts.note({ taskId: 't-b', taskWorkspaceId: 'ws-b', sessions: ['p-b'], at: 2 });
    facts.note({ taskId: 't-c', taskWorkspaceId: 'ws-c', sessions: ['p-c'], at: 3 });
    await facts.written();
    expect(fs.existsSync(`${file}.unreadable-7`)).toBe(false);
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(newer);
  });

  it('a file no version can read is moved aside, and facts are kept on disk again', async () => {
    const dir = tmpDir();
    const file = nodePath.join(dir, 'factory', AGENT_GONE_FILENAME);
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const broken = new AgentGoneFacts(file, () => undefined, () => 7);
    expect(() => broken.load()).not.toThrow();
    expect(broken.all()).toEqual([]);
    expect(fs.readFileSync(`${file}.unreadable-7`, 'utf8')).toBe('{not json');
    broken.note({ taskId: 't-b', taskWorkspaceId: 'ws-b', sessions: ['p-b'], at: 2 });
    await broken.written();
    const again = new AgentGoneFacts(file, () => undefined);
    again.load();
    expect(again.get('t-b')).not.toBeNull();
  });

  it('a respawned worker gets the launch window: a read before its agent is seen adds no fact', () => {
    let now = 1_000;
    const facts = new AgentGoneFacts(nodePath.join(tmpDir(), 'factory', AGENT_GONE_FILENAME), () => undefined, () => now);
    facts.load();
    setAgentGoneFacts(facts);
    try {
      noteTaskWorkerLaunched('t-a');
      // A read that started after the launch, while the new agent is still starting.
      now += 1;
      facts.note({ taskId: 't-a', taskWorkspaceId: 'ws-a', sessions: ['p-a'], at: now });
      expect(facts.get('t-a')).toBeNull();
      // Seen running, then seen gone: the fact is written.
      facts.seenRunning('t-a', now + 1);
      now += 2;
      facts.note({ taskId: 't-a', taskWorkspaceId: 'ws-a', sessions: ['p-a'], at: now });
      expect(facts.get('t-a')).not.toBeNull();
    } finally {
      setAgentGoneFacts(null);
    }
  });

  it('a close that stopped the task\'s panes adds a fact; a new worker session for the task clears it', () => {
    const facts = new AgentGoneFacts(nodePath.join(tmpDir(), 'factory', AGENT_GONE_FILENAME), () => undefined);
    facts.load();
    setAgentGoneFacts(facts);
    try {
      noteTaskPanesStopped('t-a', 'ws-a', ['p-a'], 5);
      expect(facts.get('t-a')).toEqual({ taskId: 't-a', taskWorkspaceId: 'ws-a', sessions: ['p-a'], at: 5 });
      noteTaskWorkerLaunched('t-a');
      expect(facts.get('t-a')).toBeNull();
    } finally {
      setAgentGoneFacts(null);
    }
  });

  it('a launch line staged for the owner\'s Enter clears the fact, and that Enter starts the launch window again', () => {
    let now = 1_000;
    const facts = new AgentGoneFacts(nodePath.join(tmpDir(), 'factory', AGENT_GONE_FILENAME), () => undefined, () => now);
    facts.load();
    setAgentGoneFacts(facts);
    try {
      facts.note({ taskId: 't-a', taskWorkspaceId: 'ws-a', sessions: ['p-a'], at: now });
      noteSessionAgentLaunched('p-a', false);
      expect(facts.get('t-a')).toBeNull();
      // The owner presses Enter much later.
      now += LAUNCH_SETTLE_MS + 10;
      noteSessionInput('p-a', 'x');
      noteSessionInput('p-a', '\r');
      now += 1;
      facts.note({ taskId: 't-a', taskWorkspaceId: 'ws-a', sessions: ['p-a'], at: now });
      expect(facts.get('t-a')).toBeNull();
      now += LAUNCH_SETTLE_MS;
      facts.note({ taskId: 't-a', taskWorkspaceId: 'ws-a', sessions: ['p-a'], at: now });
      expect(facts.get('t-a')).not.toBeNull();
    } finally {
      setAgentGoneFacts(null);
    }
  });

  it('keeps at most AGENT_GONE_MAX facts, the oldest dropped first', () => {
    const facts = new AgentGoneFacts(nodePath.join(tmpDir(), 'factory', AGENT_GONE_FILENAME), () => undefined);
    facts.load();
    for (let i = 0; i <= AGENT_GONE_MAX; i++) facts.note({ taskId: `t-${i}`, taskWorkspaceId: `ws-${i}`, sessions: [], at: i });
    expect(facts.all()).toHaveLength(AGENT_GONE_MAX);
    expect(facts.get('t-0')).toBeNull();
    expect(facts.get(`t-${AGENT_GONE_MAX}`)).not.toBeNull();
  });
});

describe('parseSessionRead', () => {
  it('a bare list (an older daemon) is a recovered read; the flag is read when present; anything else fails', () => {
    expect(parseSessionRead([{ id: 'p' }])).toEqual({ sessions: [{ id: 'p' }], recoveryDone: true });
    expect(parseSessionRead({ sessions: [], recoveryDone: false })).toEqual({ sessions: [], recoveryDone: false });
    expect(parseSessionRead({ sessions: [] })).toEqual({ sessions: [], recoveryDone: true });
    expect(() => parseSessionRead(null)).toThrow();
    expect(() => parseSessionRead({ ok: false })).toThrow();
  });
});

describe('sightings by task (#2393 holder set)', () => {
  // Holder-set review rounds R8 (an adopted worker counted against two tasks)
  // and R9 (its pane still marked the other task busy and not gone).
  it('R8/R9: a worker pane adopted into another task\'s workspace is its own task\'s sighting, not that workspace\'s', async () => {
    const w = world({ 'ws-a': { id: 't-a', status: 'working', pty: 'p-other' }, 'ws-b': { id: 't-b', status: 'completed', pty: 'p-a' } });
    w.open();
    // Which task the pane is comes from its launch record.
    w.state.paneTasks = { 'p-a': 't-a' };
    w.state.sessions = [running('p-a'), exited('p-other')];
    await w.liveness.refresh();
    expect([...w.liveness.agentSeenTasks().keys()]).toEqual(['t-a']);
    expect(w.liveness.agentSeen().has('ws-b')).toBe(false);
    expect(w.liveness.agentSeen().has('ws-a')).toBe(true);
    // Nor is it work of the ended task's: its workspace runs no agent of its
    // own, so the task is seen gone.
    expect(w.liveness.busyWorkspaces().has('ws-b')).toBe(false);
    expect(w.liveness.idle.get().has('ws-b')).toBe(true);
    expect(w.liveness.goneTasks().has('t-b')).toBe(true);
    // One running worker, one holder on every cap.
    const rows = [
      { id: 't-a', status: 'working', taskWorkspaceId: 'ws-a', ownerWorkspaceId: 'ws-owner', title: 'a', rev: 3, updatedAt: 0, dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' } } },
      { id: 't-b', status: 'completed', taskWorkspaceId: 'ws-b', ownerWorkspaceId: 'ws-owner', title: 'b', rev: 3, updatedAt: 0, dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' } } },
    ] as LedgerEntry[];
    const holders = computeHolders({
      now: w.t.now, rows, reclaimable: new Set(['t-b']), catchupMs: 86_400_000,
      workspaces: new Set(['ws-a', 'ws-b']), ptys: new Map([['ws-a', ['p-other']], ['ws-b', ['p-a']]]), stamps: new Map(),
      read: w.liveness.readState(), readAt: w.liveness.lastReadAt(), idle: w.liveness.idle.get(), busy: w.liveness.busyWorkspaces(),
      agentSeen: w.liveness.agentSeen(), agentTasks: w.liveness.agentSeenTasks(), gone: w.liveness.goneTasks(),
      records: [], verdicted: new Set(), reservations: [], grants: [], heldWorkspaces: [],
      taskOfWorkspace: () => null, taskOfPane: (id) => w.state.paneTasks[id] ?? null, launchAt: () => undefined, launchOf: () => null,
    });
    expect(holderCounts(holders, 'bot-0000000a')).toMatchObject({ live: 1, workers: 1, agents: 1, bot: 1 });
  });

  it('C1.2: a worker pane adopted into a workspace no row names is not that workspace\'s agent when its launch record names another task', async () => {
    const w = world({ 'ws-a': { id: 't-a', status: 'working', pty: 'p-a-own' } });
    // ws-x: task x's workspace (its register failed, no row), now holding b's pane.
    w.state.entries = [{ id: 'ws-x', name: 'ws-x', ptyIds: ['p-b'] } as WorkspaceListEntry];
    w.state.paneTasks = { 'p-b': 't-b' };
    w.state.workspaceTasks = { 'ws-x': 'x' };
    w.state.sessions = [running('p-b')];
    await w.liveness.refresh();
    expect([...w.liveness.agentSeenTasks().keys()]).toEqual(['t-b']);
    expect(w.liveness.agentSeen().has('ws-x')).toBe(false);
    expect(w.liveness.busyWorkspaces().has('ws-x')).toBe(false);
  });

  it('C2.2: an owner worker\'s WSL pane no process attributes, moved out of its workspace, is its task\'s sighting by its launch record', async () => {
    const w = world({ 'ws-t': { id: 't', status: 'working', pty: 'p-shell' } });
    w.state.entries = [
      { id: 'ws-t', name: 'ws-t', ptyIds: ['p-shell'] } as WorkspaceListEntry,
      { id: 'ws-owner', name: 'ws-owner', ptyIds: ['p-wsl'] } as WorkspaceListEntry,
    ];
    // No reclaim or bot session record names it (an owner fan-out).
    w.state.paneTasks = { 'p-wsl': 't' };
    w.state.sessions = [{ id: 'p-wsl', commandRunning: true }, exited('p-shell')];
    await w.liveness.refresh();
    expect([...w.liveness.agentSeenTasks().keys()]).toEqual(['t']);
    expect(w.liveness.agentSeen().has('ws-t')).toBe(true);
  });

  it('C3.1: an ended task whose silent pane its launch record names runs outside its workspace is not seen gone', async () => {
    const w = world({ 'ws-owner': { id: 'other', status: 'working', pty: 'p-wsl' } }, { closed: { 'ws-t': { id: 't', status: 'completed', pty: 'p-old' } } });
    w.open();
    w.state.paneTasks = { 'p-wsl': 't' };
    // Neither attributed nor reported as running a command.
    w.state.sessions = [{ id: 'p-wsl' }];
    await w.liveness.refresh();
    expect(w.liveness.goneTasks().has('t')).toBe(false);
  });

  it('C5.1/C5.2: an adopted pane resumed in another task\'s workspace: that workspace stays its task\'s, the sighting is the pane\'s task\'s', async () => {
    const slots = new WorkerSlots(nodePath.join(tmpDir(), 'factory', WORKER_SLOTS_FILENAME), () => [], () => undefined);
    slots.load();
    for (const [task, ws, pane] of [['t-a', 'ws-w', 'p-a'], ['t-b', 'ws-b', 'p-b']]) {
      const { gen } = slots.beginLaunch({ taskId: task, origin: 'bot', botId: 'bot-0000000a', ownerWorkspaceId: 'ws-owner' });
      slots.launched(task, gen, ws, pane);
    }
    const { gen } = slots.beginLaunch({ taskId: 't-b', origin: 'bot', botId: 'bot-0000000a', ownerWorkspaceId: 'ws-owner', pane: { sessionId: 'p-b', workspaceId: 'ws-w' } });
    slots.launched('t-b', gen, 'ws-w', 'p-b');
    const w = world({ 'ws-w': { id: 't-a', status: 'completed', pty: 'p-b' }, 'ws-b': { id: 't-b', status: 'working', pty: 'p-gone' } });
    w.open();
    for (const id of ['p-a', 'p-b']) w.state.paneTasks[id] = slots.paneOf(id)?.taskId ?? '';
    for (const ws of ['ws-w', 'ws-b']) w.state.workspaceTasks[ws] = slots.workspaceOf(ws)?.taskId ?? '';
    expect(w.state.workspaceTasks['ws-w']).toBe('t-a');
    w.state.sessions = [running('p-b'), exited('p-gone')];
    await w.liveness.refresh();
    expect([...w.liveness.agentSeenTasks().keys()]).toEqual(['t-b']);
    expect(w.liveness.agentSeen().has('ws-b')).toBe(true);
    expect(w.liveness.agentSeen().has('ws-w')).toBe(false);
    // a's workspace runs no agent of a's: a is seen gone.
    expect(w.liveness.goneTasks().has('t-a')).toBe(true);
  });

  it('GLM C2: a fact older than the task\'s last launch is replaced by the same observation made after it', () => {
    const clock = { now: 1_000, launchedAt: undefined as number | undefined };
    const facts = new AgentGoneFacts(nodePath.join(tmpDir(), 'factory', AGENT_GONE_FILENAME), () => undefined, () => clock.now, () => clock.launchedAt);
    facts.load();
    facts.note({ taskId: 't', taskWorkspaceId: 'ws-t', sessions: ['p-t'], at: 1_000 });
    // Relaunched (recorded at 2000), then seen gone again with the same panes.
    clock.launchedAt = 2_000;
    clock.now = 10_000;
    facts.note({ taskId: 't', taskWorkspaceId: 'ws-t', sessions: ['p-t'], at: 10_000 });
    expect(facts.get('t')?.at).toBe(10_000);
    // The same observation again, after that, keeps the fact as it is.
    facts.note({ taskId: 't', taskWorkspaceId: 'ws-t', sessions: ['p-t'], at: 12_000 });
    expect(facts.get('t')?.at).toBe(10_000);
  });
});

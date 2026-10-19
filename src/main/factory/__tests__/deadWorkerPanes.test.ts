// Dead shells in a bot task's own workspace: an ended task's are closed, an
// open task's worker is recorded for Resume, and nothing else is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { permissionFlagFor } from '../../../shared/agentResume';
import { STOPPED_BY_OWNER } from '../factoryStop';
import { ReclaimedWorkers, isReclaimableEnd, reclaimedWorkerState, resumeWorker, type WorkerResumePorts } from '../workerReclaim';
import { createDeadPaneSweep, typedSince, type DeadPaneSession, type DeadPaneSweepPorts, type PaneKeyInput } from '../deadWorkerPanes';

const BOT = 'bot-0000000a';
const UUID = '2eca904b-b4cc-4243-81d3-67a121351892';
const NOW = 100_000_000;

let dir: string;
let wt: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-deadpanes-'));
  wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function row(status: LedgerEntry['status'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: 'wtask-abc-12345678', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'perf-A',
    status, rev: 3, updatedAt: NOW - 3_600_000, updatedBy: { kind: 'brain', workspaceId: 'ws-owner' },
    dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default' },
    ...over,
  };
}

/** A shell the daemon respawned at its restart. */
function respawned(over: Partial<DeadPaneSession> = {}): DeadPaneSession {
  return {
    id: 'daemon-1', pid: 10, spawnCwd: wt, recoveredAgentUnconfirmed: true,
    resumeBinding: { agent: 'claude', sessionId: UUID, cwd: wt, permissionMode: 'acceptEdits' },
    ...over,
  };
}

interface Rig {
  ports: DeadPaneSweepPorts;
  store: ReclaimedWorkers;
  closeWorkspace: Mock<(ws: string) => Promise<boolean>>;
  closePane: Mock<(id: string) => Promise<boolean>>;
  sessions: DeadPaneSession[];
  ptys: Map<string, string[]>;
  input: Map<string, PaneKeyInput | null>;
  /** pty → layout pane (default: a pane of its own). */
  panes: Map<string, string>;
  /** layout pane → its tabs with no local session (remote terminal, browser). */
  extraTabs: Map<string, number>;
  destroySession: Mock<(id: string) => Promise<void>>;
  clock: { now: number };
}

async function rig(rows: LedgerEntry[], sessions: DeadPaneSession[], over: Partial<DeadPaneSweepPorts> = {}, opts: { reclaimed?: boolean } = {}): Promise<Rig> {
  const store = new ReclaimedWorkers(path.join(dir, 'reclaimed.json'));
  // An ended task the reclaim already recorded (its worker stopped at the end).
  for (const x of rows) {
    if (opts.reclaimed === false || !isReclaimableEnd(x, x.status)) continue;
    await store.put({
      taskId: x.id, botId: BOT, ownerWorkspaceId: x.ownerWorkspaceId, taskWorkspaceId: x.taskWorkspaceId, title: x.title,
      threadId: `task:${x.id}` as never, ended: x.status as 'completed', state: 'stopped', at: x.updatedAt, endRev: x.rev,
      sessions: [{ sessionId: 'daemon-1', cwd: wt, resumeSessionId: UUID, permissionMode: 'acceptEdits' }],
    });
  }
  const ptys = new Map<string, string[]>([['ws-task', sessions.map((s) => s.id)]]);
  const input = new Map<string, PaneKeyInput | null>();
  const panes = new Map<string, string>();
  const extraTabs = new Map<string, number>();
  const clock = { now: NOW };
  const paneOf = (id: string): string => panes.get(id) ?? `pane-${id}`;
  const r: Rig = {
    store, sessions, ptys, input, panes, extraTabs, clock,
    destroySession: vi.fn(async (id: string) => {
      const i = r.sessions.findIndex((s) => s.id === id);
      if (i >= 0) r.sessions.splice(i, 1);
    }),
    closeWorkspace: vi.fn(async (ws: string) => {
      for (const id of ptys.get(ws) ?? []) {
        const i = r.sessions.findIndex((s) => s.id === id);
        if (i >= 0) r.sessions.splice(i, 1);
      }
      ptys.delete(ws);
      return true;
    }),
    closePane: vi.fn(async (pane: string) => {
      for (let i = r.sessions.length - 1; i >= 0; i--) if (paneOf(r.sessions[i].id) === pane) r.sessions.splice(i, 1);
      for (const [ws, list] of ptys) ptys.set(ws, list.filter((x) => paneOf(x) !== pane));
      return true;
    }),
    ports: null as unknown as DeadPaneSweepPorts,
  };
  r.ports = {
    rows: () => rows,
    store,
    ready: () => true,
    listSessions: async () => [...r.sessions],
    keyInput: async (id) => (input.has(id) ? input.get(id) ?? null : { keyInputRevision: 0, keyInputIdleMs: NOW }),
    workspacePtys: (ws) => ptys.get(ws) ?? [],
    isTaskWorkspace: (rec, ws) => ws !== rec.ownerWorkspaceId && rows.some((x) => x.id === rec.taskId && x.taskWorkspaceId === ws),
    viewedWorkspace: () => 'ws-owner',
    viewed: (ws) => ws === 'ws-owner',
    sessionRecordOf: (id) => (id === 'daemon-1' || id === 'daemon-3' ? { taskId: 'wtask-abc-12345678' } : null),
    closeWorkspace: (ws) => r.closeWorkspace(ws),
    paneSurfaces: async (ws) => {
      const byPane = new Map<string, string[]>();
      for (const id of ptys.get(ws) ?? []) byPane.set(paneOf(id), [...(byPane.get(paneOf(id)) ?? []), id]);
      return [...byPane].map(([id, list]) => ({ id, surfacePtyIds: list, surfaceCount: list.length + (extraTabs.get(id) ?? 0) }));
    },
    closePane: (pane) => r.closePane(pane),
    inAnyWorkspace: (id) => [...ptys.values()].some((list) => list.includes(id)),
    destroySession: (id) => r.destroySession(id),
    now: () => clock.now,
    sleep: async () => undefined,
    confirmMs: 0,
    log: () => undefined,
    ...over,
  };
  return r;
}

describe('ended bot tasks', () => {
  it('closes an ended task\'s respawned pane with its workspace', async () => {
    const r = await rig([row('completed')], [respawned()]);
    expect(await createDeadPaneSweep(r.ports).pass()).toEqual({ closed: 1, recorded: 0 });
    expect(r.closeWorkspace).toHaveBeenCalledWith('ws-task');
  });

  it('closes a pane the owner stopped and leaves its folder alone', async () => {
    const stopped = row('cancelled', { summary: STOPPED_BY_OWNER, updatedBy: { kind: 'system', workspaceId: 'ws-daemon' } });
    const r = await rig([stopped], [respawned()]);
    const changed = vi.fn();
    expect(await createDeadPaneSweep({ ...r.ports, changed }).pass()).toEqual({ closed: 1, recorded: 0 });
    expect(r.closeWorkspace).toHaveBeenCalledWith('ws-task');
    expect(fs.existsSync(wt)).toBe(true);
    expect(r.store.get(stopped.id)).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('closes an owner-stopped workspace whose sessions the stop destroyed', async () => {
    const stopped = row('cancelled', { summary: STOPPED_BY_OWNER, updatedBy: { kind: 'system', workspaceId: 'ws-daemon' } });
    const r = await rig([stopped], []);
    r.ptys.set('ws-task', ['daemon-1']);
    expect(await createDeadPaneSweep(r.ports).pass()).toEqual({ closed: 1, recorded: 0 });
    expect(r.closeWorkspace).toHaveBeenCalledWith('ws-task');
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('closes a failed task\'s idle shell with no restart in between', async () => {
    const shell: DeadPaneSession = { id: 'daemon-1', pid: 10, spawnCwd: wt, agentProcessAlive: false, commandRunning: false };
    const r = await rig([row('failed')], [shell]);
    // The launch line was typed long before the task failed.
    r.input.set('daemon-1', { keyInputRevision: 4, keyInputIdleMs: 5 * 3_600_000 });
    expect(await createDeadPaneSweep(r.ports).pass()).toEqual({ closed: 1, recorded: 0 });
    expect(r.closeWorkspace).toHaveBeenCalledWith('ws-task');
  });

  it('never closes a pane the task did not create, however idle, nor its workspace', async () => {
    // The owner split an idle PowerShell pane into the task's workspace long before.
    const owners: DeadPaneSession = { id: 'daemon-732a7d07', pid: 20, spawnCwd: wt, agentProcessAlive: false, commandRunning: false };
    const r = await rig([row('completed')], [respawned(), owners]);
    expect(await createDeadPaneSweep(r.ports).pass()).toEqual({ closed: 1, recorded: 0 });
    expect(r.closeWorkspace).not.toHaveBeenCalled();
    expect(r.closePane).toHaveBeenCalledWith('pane-daemon-1');
    expect(r.closePane).not.toHaveBeenCalledWith('pane-daemon-732a7d07');
    expect(r.sessions.map((x) => x.id)).toEqual(['daemon-732a7d07']);
  });

  it('never closes an owner shell an older reclaim record lists', async () => {
    const owners: DeadPaneSession = { id: 'daemon-732a7d07', pid: 20, spawnCwd: wt, agentProcessAlive: false, commandRunning: false };
    const r = await rig([row('failed')], [owners]);
    const rec = r.store.get('wtask-abc-12345678');
    if (!rec) throw new Error('no record');
    await r.store.put({ ...rec, sessions: [...rec.sessions, { sessionId: 'daemon-732a7d07', cwd: wt }] });
    expect((await createDeadPaneSweep(r.ports).pass()).closed).toBe(0);
    expect(r.closeWorkspace).not.toHaveBeenCalled();
    expect(r.closePane).not.toHaveBeenCalled();
  });

  it('counts a close only once it shows, and does not retry it at once', async () => {
    const r = await rig([row('completed')], [respawned()]);
    const lines: string[] = [];
    r.closeWorkspace.mockImplementation(async () => true); // answered, nothing closed
    const sweep = createDeadPaneSweep({ ...r.ports, log: (m) => lines.push(m) });
    expect(await sweep.pass()).toEqual({ closed: 0, recorded: 0 });
    expect(lines.some((l) => l.includes('did not take effect'))).toBe(true);
    expect(lines.some((l) => l.includes('closed daemon-1'))).toBe(false);
    expect(await sweep.pass()).toEqual({ closed: 0, recorded: 0 });
    expect(r.closeWorkspace).toHaveBeenCalledTimes(1);
  });

  it('never closes a layout pane that also holds a remote terminal or browser tab, nor its workspace', async () => {
    const r = await rig([row('completed')], [respawned()]);
    r.extraTabs.set('pane-daemon-1', 1);
    expect((await createDeadPaneSweep(r.ports).pass()).closed).toBe(0);
    expect(r.closeWorkspace).not.toHaveBeenCalled();
    expect(r.closePane).not.toHaveBeenCalled();
  });

  it('destroys a session a close left behind once its pane is gone, after the backoff', async () => {
    const r = await rig([row('completed')], [respawned()]);
    // The renderer drops the workspace but its session's disposal fails.
    r.closeWorkspace.mockImplementation(async (ws: string) => {
      r.ptys.delete(ws);
      return true;
    });
    const sweep = createDeadPaneSweep(r.ports);
    expect((await sweep.pass()).closed).toBe(0);
    expect(r.destroySession).not.toHaveBeenCalled();
    r.clock.now += 5 * 60_000;
    expect((await sweep.pass()).closed).toBe(0);
    expect(r.destroySession).not.toHaveBeenCalled();
    r.clock.now += 6 * 60_000;
    expect((await sweep.pass()).closed).toBe(1);
    expect(r.destroySession).toHaveBeenCalledWith('daemon-1');
    expect(r.sessions).toEqual([]);
    expect(await sweep.pass()).toEqual({ closed: 0, recorded: 0 });
    expect(r.destroySession).toHaveBeenCalledTimes(1);
  });

  it('does not count a close that left the daemon session behind', async () => {
    const r = await rig([row('completed')], [respawned()]);
    r.closeWorkspace.mockImplementation(async (ws: string) => {
      r.ptys.delete(ws);
      r.sessions[0] = { ...r.sessions[0], state: 'dead' };
      return true;
    });
    expect((await createDeadPaneSweep(r.ports).pass()).closed).toBe(0);
  });

  it('closes only the dead pane when the owner typed into another one', async () => {
    const r = await rig([row('completed')], [respawned(), respawned({ id: 'daemon-2', resumeBinding: undefined })]);
    r.input.set('daemon-2', { keyInputRevision: 1, keyInputIdleMs: 1_000 });
    expect(await createDeadPaneSweep(r.ports).pass()).toEqual({ closed: 1, recorded: 0 });
    expect(r.closeWorkspace).not.toHaveBeenCalled();
    expect(r.closePane).toHaveBeenCalledWith('pane-daemon-1');
    expect(r.closePane).toHaveBeenCalledTimes(1);
  });

  it('never closes a pane whose other tab is in use', async () => {
    const r = await rig([row('completed')], [respawned(), respawned({ id: 'daemon-2', resumeBinding: undefined, commandRunning: true }), respawned({ id: 'daemon-3', resumeBinding: undefined })]);
    r.panes.set('daemon-1', 'pane-a');
    r.panes.set('daemon-2', 'pane-a');
    expect(await createDeadPaneSweep(r.ports).pass()).toEqual({ closed: 1, recorded: 0 });
    expect(r.closePane).toHaveBeenCalledWith('pane-daemon-3');
    expect(r.closePane).not.toHaveBeenCalledWith('pane-a');
  });

  it('keeps the workspace of a task that reopened while its panes were read', async () => {
    const rows = [row('failed')];
    const r = await rig(rows, [respawned()], {
      keyInput: async () => {
        rows[0] = { ...rows[0], status: 'working', rev: 4 };
        return { keyInputRevision: 0 };
      },
    });
    expect((await createDeadPaneSweep(r.ports).pass()).closed).toBe(0);
    expect(r.closeWorkspace).not.toHaveBeenCalled();
  });

  it('keeps the workspace when a terminal opened there while its panes were read', async () => {
    const r = await rig([row('completed')], [respawned()], {
      keyInput: async () => {
        r.ptys.set('ws-task', ['daemon-1', 'daemon-new']);
        r.sessions.push({ id: 'daemon-new', pid: 12, spawnCwd: wt, commandRunning: true });
        return { keyInputRevision: 0 };
      },
    });
    expect((await createDeadPaneSweep(r.ports).pass()).closed).toBe(1);
    expect(r.closeWorkspace).not.toHaveBeenCalled();
    expect(r.closePane).toHaveBeenCalledWith('pane-daemon-1');
  });

  it('waits for the reclaim to record an end before closing its pane', async () => {
    const r = await rig([row('completed', { updatedAt: NOW - 60_000 })], [respawned()], {}, { reclaimed: false });
    expect((await createDeadPaneSweep(r.ports).pass()).closed).toBe(0);
    expect(r.closeWorkspace).not.toHaveBeenCalled();
  });

  it('a second pass closes nothing more', async () => {
    const r = await rig([row('completed')], [respawned()]);
    const sweep = createDeadPaneSweep(r.ports);
    expect((await sweep.pass()).closed).toBe(1);
    expect(await sweep.pass()).toEqual({ closed: 0, recorded: 0 });
    expect(r.closeWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe('panes that stay', () => {
  it.each<[string, Partial<DeadPaneSession>, PaneKeyInput | null]>([
    ['a running command', { commandRunning: true }, null],
    ['a live agent', { recoveredAgentUnconfirmed: undefined, agentProcessAlive: true }, null],
    ['input typed since the restart', {}, { keyInputRevision: 2, keyInputIdleMs: 60_000 }],
    ['key input that cannot be read', {}, null],
  ])('keeps a pane with %s', async (_why, over, input) => {
    const r = await rig([row('completed')], [respawned(over)]);
    if (input !== null || _why.includes('cannot')) r.input.set('daemon-1', input);
    expect(await createDeadPaneSweep(r.ports).pass()).toEqual({ closed: 0, recorded: 0 });
    expect(r.closeWorkspace).not.toHaveBeenCalled();
    expect(r.closePane).not.toHaveBeenCalled();
  });

  it('keeps a pane the owner views, or when what they view is not known', async () => {
    const viewedTask = await rig([row('completed')], [respawned()], { viewedWorkspace: () => 'ws-task', viewed: (ws) => ws === 'ws-task' });
    expect((await createDeadPaneSweep(viewedTask.ports).pass()).closed).toBe(0);
    const panel = await rig([row('completed')], [respawned()], { viewed: (ws) => ws === 'ws-task' });
    expect((await createDeadPaneSweep(panel.ports).pass()).closed).toBe(0);
    const unknown = await rig([row('completed')], [respawned()], { viewedWorkspace: () => null });
    expect((await createDeadPaneSweep(unknown.ports).pass()).closed).toBe(0);
  });

  it('keeps a shell typed into after the task ended', async () => {
    const shell: DeadPaneSession = { id: 'daemon-1', pid: 10, spawnCwd: wt, agentProcessAlive: false, commandRunning: false };
    const r = await rig([row('failed')], [shell]);
    r.input.set('daemon-1', { keyInputRevision: 9, keyInputIdleMs: 60_000 });
    expect((await createDeadPaneSweep(r.ports).pass()).closed).toBe(0);
  });

  it('never touches a workspace that is not a bot task\'s own', async () => {
    const fanout = await rig([row('completed', { dispatch: { origin: { kind: 'owner' }, preset: 'default' } })], [respawned()]);
    expect((await createDeadPaneSweep(fanout.ports).pass()).closed).toBe(0);
    const handMade = await rig([row('completed', { dispatch: undefined })], [respawned()]);
    expect((await createDeadPaneSweep(handMade.ports).pass()).closed).toBe(0);
    const foreign = await rig([row('completed')], [respawned()], { isTaskWorkspace: () => false });
    expect((await createDeadPaneSweep(foreign.ports).pass()).closed).toBe(0);
    for (const r of [fanout, handMade, foreign]) expect(r.closeWorkspace).not.toHaveBeenCalled();
  });
});

describe('open bot tasks', () => {
  function resumePorts(store: ReclaimedWorkers, sessions: DeadPaneSession[], over: Partial<WorkerResumePorts> = {}): WorkerResumePorts {
    return { store, listSessions: async () => sessions, typeLine: vi.fn(() => true), folderExists: () => true, ...over };
  }

  it('records a review task\'s respawned worker, keeps its pane, and Resume relaunches it in its mode', async () => {
    // A fresh respawned shell has reported no prompt yet (commandRunning unknown).
    const r = await rig([row('review_requested')], [respawned()]);
    const sweep = createDeadPaneSweep(r.ports);
    expect(await sweep.pass()).toEqual({ closed: 0, recorded: 1 });
    expect(r.closeWorkspace).not.toHaveBeenCalled();
    expect(r.closePane).not.toHaveBeenCalled();
    const rec = r.store.get('wtask-abc-12345678');
    expect(rec).toMatchObject({ state: 'stopped', ended: 'reported', endRev: 3, sessions: [{ sessionId: 'daemon-1', cwd: wt, resumeSessionId: UUID, permissionMode: 'acceptEdits' }] });
    expect(reclaimedWorkerState(rec)).toBe('resumable');
    // Idempotent: the record covers this rev.
    expect(await sweep.pass()).toEqual({ closed: 0, recorded: 0 });

    const ports = resumePorts(r.store, r.sessions);
    const res = await resumeWorker(ports, 'wtask-abc-12345678', { kind: 'owner' });
    expect(res.ok).toBe(true);
    expect(ports.typeLine).toHaveBeenCalledWith('daemon-1', `claude --resume ${UUID} ${permissionFlagFor('acceptEdits')}`);
  });

  it('Resume reopens a pane in the recorded mode once the pane is gone', async () => {
    const r = await rig([row('working')], [respawned()]);
    expect((await createDeadPaneSweep(r.ports).pass()).recorded).toBe(1);
    const respawn = vi.fn(async () => ({ ok: true as const, workspaceId: 'ws-new', sessionId: 'daemon-9' }));
    const res = await resumeWorker(resumePorts(r.store, [], { respawn }), 'wtask-abc-12345678', { kind: 'owner' });
    expect(res.ok).toBe(true);
    expect(respawn).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'acceptEdits', line: `claude --resume ${UUID} ${permissionFlagFor('acceptEdits')}` }));
  });

  it('does not overwrite a worker resumed while its panes were read', async () => {
    const rows = [row('review_requested')];
    const r = await rig(rows, [respawned()], {
      keyInput: async () => {
        await r.store.put({
          taskId: rows[0].id, botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 'perf-A', threadId: 'task:x' as never,
          ended: 'reported', state: 'resumed', at: NOW, endRev: 3, sessions: [{ sessionId: 'daemon-1', cwd: wt, resumeSessionId: UUID }],
        });
        return { keyInputRevision: 0 };
      },
    });
    expect((await createDeadPaneSweep(r.ports).pass()).recorded).toBe(0);
    expect(r.store.get(rows[0].id)?.state).toBe('resumed');
  });

  it('records nothing while an agent runs in the workspace, or for a pane the task did not launch', async () => {
    const live = await rig([row('review_requested')], [respawned(), { id: 'daemon-2', pid: 11, spawnCwd: wt, agentProcessAlive: true }]);
    expect((await createDeadPaneSweep(live.ports).pass()).recorded).toBe(0);
    const notOwn = await rig([row('review_requested')], [respawned()], { sessionRecordOf: () => null });
    expect((await createDeadPaneSweep(notOwn.ports).pass()).recorded).toBe(0);
    const typed = await rig([row('review_requested')], [respawned()]);
    typed.input.set('daemon-1', { keyInputRevision: 1, keyInputIdleMs: 10 });
    expect((await createDeadPaneSweep(typed.ports).pass()).recorded).toBe(0);
    for (const r of [live, notOwn, typed]) expect(r.store.get('wtask-abc-12345678')).toBeNull();
  });
});

describe('typedSince', () => {
  it('reads key input against the floor', () => {
    expect(typedSince(null, 0, NOW, false)).toBe(true);
    expect(typedSince({ keyInputRevision: 0 }, 0, NOW, true)).toBe(false);
    expect(typedSince({ keyInputRevision: 1, keyInputIdleMs: 10 }, 0, NOW, true)).toBe(true);
    expect(typedSince({ keyInputRevision: 3, keyInputIdleMs: 1_000 }, NOW - 500, NOW, false)).toBe(false);
    expect(typedSince({ keyInputRevision: 3, keyInputIdleMs: 100 }, NOW - 500, NOW, false)).toBe(true);
  });
});

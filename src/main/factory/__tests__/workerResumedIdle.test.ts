// A resumed worker of an ended task that sits idle is stopped again (it
// resumes later), so resumed workers never pile up past the agent cap.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { RESUMED_IDLE_MS, ReclaimedWorkers, createResumedIdleSweep, type ResumedIdlePorts, type WorkerSessionInfo } from '../workerReclaim';

const BOT = 'bot-0000000a';
const TASK = 'wtask-abc-12345678';
const UUID = '2eca904b-b4cc-4243-81d3-67a121351892';

function row(status: LedgerEntry['status'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: TASK, taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'perf-A',
    status, rev: 3, updatedAt: 1_000, updatedBy: { kind: 'brain', workspaceId: 'ws-owner' },
    dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default' },
    ...over,
  };
}

let dir: string;
let store: ReclaimedWorkers;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumed-idle-'));
  store = ReclaimedWorkers.at(dir);
  await store.put({
    taskId: TASK, botId: BOT, ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', title: 'perf-A', threadId: `task:${TASK}` as never,
    ended: 'completed', state: 'resumed', at: 0, endRev: 3, sessions: [{ sessionId: 'daemon-1', cwd: dir, resumeSessionId: UUID }],
  });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function rig(over: Partial<ResumedIdlePorts> = {}) {
  let at = 60_000;
  const turnEnded = new Map<string, boolean>([['daemon-1', true]]);
  const typed = new Set<string>();
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
    paneTurnEnded: (id) => turnEnded.get(id) === true,
    recentInput: (id) => typed.has(id),
    log: () => undefined,
    ...over,
  });
  const live: WorkerSessionInfo[] = [{ id: 'daemon-1', spawnCwd: dir, agentProcessAlive: true, commandRunning: true }];
  return {
    sweep: (sessions: WorkerSessionInfo[] = live) => sweep.sweep(sessions),
    advance: (ms: number) => { at += ms; },
    turnEnded, typed, stopAgent, note, changed,
  };
}

describe('the idle stop of resumed workers', () => {
  it('stops a resumed worker idle for the window; the record is resumable again with a card', async () => {
    const r = rig();
    // First idle look starts the window; nothing is stopped before it ends.
    expect(await r.sweep()).toEqual([]);
    r.advance(RESUMED_IDLE_MS - 1);
    expect(await r.sweep()).toEqual([]);
    expect(r.stopAgent).not.toHaveBeenCalled();
    r.advance(1);
    expect(await r.sweep()).toEqual([TASK]);
    expect(r.stopAgent).toHaveBeenCalledWith('daemon-1');
    const rec = store.get(TASK)!;
    expect(rec.state).toBe('stopped');
    expect(rec.sessions[0].resumeSessionId).toBe(UUID);
    expect(r.note).toHaveBeenCalledWith('ws-owner', `task:${TASK}`, 'Worker paused (resumable)', expect.stringContaining('sat idle'), { code: 'worker.idlePausedResumable' }, TASK);
    expect(r.changed).toHaveBeenCalled();
  });

  it('never stops a busy worker: a turn running (a command the agent runs) or input typed restarts the window', async () => {
    const r = rig();
    await r.sweep();
    r.advance(RESUMED_IDLE_MS - 1000);
    r.turnEnded.set('daemon-1', false);
    await r.sweep();
    r.turnEnded.set('daemon-1', true);
    r.advance(2000);
    // The window restarted at the busy look: not idle long enough yet.
    expect(await r.sweep()).toEqual([]);
    r.advance(RESUMED_IDLE_MS - 1000);
    r.typed.add('daemon-1');
    expect(await r.sweep()).toEqual([]);
    r.advance(RESUMED_IDLE_MS);
    expect(await r.sweep()).toEqual([]);
    expect(r.stopAgent).not.toHaveBeenCalled();
    expect(store.get(TASK)?.state).toBe('resumed');
  });

  it('leaves a worker whose task reopened, and one with no live agent (the exit sweep\'s)', async () => {
    const reopened = rig({ row: () => row('working', { rev: 5 }) });
    await reopened.sweep();
    reopened.advance(RESUMED_IDLE_MS);
    expect(await reopened.sweep()).toEqual([]);
    const gone = rig();
    const dead: WorkerSessionInfo[] = [{ id: 'daemon-1', spawnCwd: dir, agentProcessAlive: false, commandRunning: false }];
    await gone.sweep(dead);
    gone.advance(RESUMED_IDLE_MS);
    expect(await gone.sweep(dead)).toEqual([]);
    expect(reopened.stopAgent).not.toHaveBeenCalled();
    expect(gone.stopAgent).not.toHaveBeenCalled();
  });

  it('keeps the worker resumed (counted live) when the daemon refused the stop, and tries again', async () => {
    const stopAgent = vi.fn(async () => ({ ok: false, code: 'not_verified' }));
    const r = rig({ stopAgent });
    await r.sweep();
    r.advance(RESUMED_IDLE_MS);
    expect(await r.sweep()).toEqual([]);
    expect(store.get(TASK)?.state).toBe('resumed');
    r.advance(60_000);
    await r.sweep();
    expect(stopAgent).toHaveBeenCalledTimes(2);
  });
});

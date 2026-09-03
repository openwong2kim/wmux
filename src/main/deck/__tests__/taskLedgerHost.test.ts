import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import {
  routeWorkerEventToOwner,
  takeOrphanBacklog,
  createWorkTaskReconciler,
  getMissionChannelId,
  setTaskLedgerForTests,
} from '../taskLedgerHost';
import type { CoalescerInput } from '../CommanderEventCoalescer';

let dir: string;
let ledger: TaskLedger;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ledger-host-'));
  ledger = new TaskLedger({ dir });
  setTaskLedgerForTests(ledger);
  await ledger.register({ id: 'wtask-1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-parent', title: 'lane' });
});
afterEach(() => {
  setTaskLedgerForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function ev(over: Partial<CoalescerInput> = {}): CoalescerInput {
  return { workspaceId: 'ws-task', ptyId: 'pty-1', kind: 'agent.stop', source: 'hook', agent: 'claude', seq: 5, ts: 0, ...over };
}

describe('routeWorkerEventToOwner', () => {
  it('copies a task-workspace event to the owner, tagged, when the owner has a brain', () => {
    const pushed: CoalescerInput[] = [];
    routeWorkerEventToOwner(ev(), { hasBrain: () => true, push: (e) => pushed.push(e) });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].workspaceId).toBe('ws-parent');
    expect(pushed[0].task).toEqual({ taskId: 'wtask-1', taskWorkspaceId: 'ws-task' });
    expect(pushed[0].ptyId).toBe('pty-1');
  });

  it('leaves a non-task workspace event alone', () => {
    const pushed: CoalescerInput[] = [];
    routeWorkerEventToOwner(ev({ workspaceId: 'ws-human' }), { hasBrain: () => true, push: (e) => pushed.push(e) });
    expect(pushed).toHaveLength(0);
  });

  it('parks the event as an orphan backlog when the owner has no brain, drained later', async () => {
    const pushed: CoalescerInput[] = [];
    routeWorkerEventToOwner(ev(), { hasBrain: () => false, push: (e) => pushed.push(e) });
    await ledger.flush();
    expect(pushed).toHaveLength(0);
    const backlog = takeOrphanBacklog('ws-parent');
    expect(backlog).toHaveLength(1);
    expect(backlog[0].task?.taskId).toBe('wtask-1');
    expect(takeOrphanBacklog('ws-parent')).toHaveLength(0);
  });

  it('reconciles once for an unknown workspace and delivers if the task appears', async () => {
    const pushed: CoalescerInput[] = [];
    const reconcile = async () => {
      await ledger.register({ id: 'wtask-2', taskWorkspaceId: 'ws-task-2', ownerWorkspaceId: 'ws-parent', title: 'late' });
    };
    routeWorkerEventToOwner(ev({ workspaceId: 'ws-task-2' }), { hasBrain: () => true, push: (e) => pushed.push(e), reconcile });
    for (let i = 0; i < 50 && pushed.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(pushed).toHaveLength(1);
    expect(pushed[0].task?.taskId).toBe('wtask-2');
  });
});

describe('createWorkTaskReconciler', () => {
  it('registers open materialized tasks, cancels closed ones, remembers channels, and throttles', async () => {
    let calls = 0;
    let clock = 0;
    const tasks = [
      { id: 'wtask-1', title: 'lane', status: 'closed', owner: { verifiedWorkspaceId: 'ws-parent' }, paneGroupId: 'ws-task', missionChannelId: 'ch-1' },
      { id: 'wtask-3', title: 'new', status: 'open', owner: { verifiedWorkspaceId: 'ws-parent' }, paneGroupId: 'ws-task-3', missionChannelId: 'ch-3' },
      { id: 'wtask-4', title: 'unmaterialized', status: 'open', owner: { verifiedWorkspaceId: 'ws-parent' } },
    ];
    const reconcile = createWorkTaskReconciler({
      candidateOwners: () => ['ws-parent', 'ws-parent', 'ws-other'],
      listTasks: async (owner) => {
        calls += 1;
        if (owner === 'ws-other') throw new Error('daemon down');
        return { ok: true, tasks };
      },
      now: () => clock,
      minIntervalMs: 1_000,
    });
    await reconcile();
    expect(calls).toBe(2);
    expect(ledger.get('wtask-1')?.status).toBe('cancelled');
    expect(ledger.get('wtask-3')?.status).toBe('working');
    expect(ledger.get('wtask-3')?.ownerWorkspaceId).toBe('ws-parent');
    expect(ledger.get('wtask-4')).toBeNull();
    expect(getMissionChannelId('wtask-3')).toBe('ch-3');
    await reconcile();
    expect(calls).toBe(2);
    clock = 2_000;
    await reconcile();
    expect(calls).toBe(4);
  });
});

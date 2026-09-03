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
  rememberMissionChannel,
  readLedgerGateInput,
  formatLedgerTransition,
  installLedgerChannelEmitter,
  setTaskLedgerForTests,
} from '../taskLedgerHost';
import { overrideLedgerGateForTests } from '../deckLedgerGateStore';
import { raiseDecision } from '../deckDecisionStore';
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
  overrideLedgerGateForTests(null);
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

describe('readLedgerGateInput (step 4)', () => {
  it('reports disabled with no read while the flag is off', () => {
    overrideLedgerGateForTests(false);
    expect(readLedgerGateInput('ws-parent')).toEqual({ enabled: false, openTasks: null });
  });

  it('lists only this owner\'s open tasks when on, and null when the ledger throws', async () => {
    overrideLedgerGateForTests(true);
    await ledger.register({ id: 'wtask-2', taskWorkspaceId: 'ws-t2', ownerWorkspaceId: 'ws-other', title: 'not mine' });
    await ledger.update({ id: 'wtask-1', status: 'input_required', actor: { kind: 'worker', workspaceId: 'ws-task' }, expectedRev: 1 });
    expect(readLedgerGateInput('ws-parent')).toEqual({
      enabled: true,
      openTasks: [{ id: 'wtask-1', title: 'lane', status: 'input_required' }],
    });
    const broken = { list: () => { throw new Error('disk'); } } as unknown as TaskLedger;
    expect(readLedgerGateInput('ws-parent', broken)).toEqual({ enabled: true, openTasks: null });
  });

  it('deck_ask_decision context is prefixed with the open-task list while the gate is on', async () => {
    overrideLedgerGateForTests(true);
    const d = await raiseDecision('ws-parent', { question: 'merge?', context: 'details' }, dir);
    expect(d?.context).toBe('[open tasks in the ledger: wtask-1 "lane" (working)]\ndetails');
    expect(d?.question).toBe('merge?');
    overrideLedgerGateForTests(false);
    const off = await raiseDecision('ws-parent', { question: 'merge?', context: 'details' }, dir);
    expect(off?.context).toBe('details');
  });
});

describe('ledger → mission channel emitter (step 5)', () => {
  it('formats one line per transition and posts it to the task\'s mission channel as the owner', async () => {
    const posts: Array<{ channelId: string; ownerWorkspaceId: string; text: string; clientMsgId: string }> = [];
    const dispose = installLedgerChannelEmitter({ post: async (p) => { posts.push(p); return { ok: true }; } });
    rememberMissionChannel('wtask-1', 'ch-1');
    await ledger.update({ id: 'wtask-1', status: 'review_requested', actor: { kind: 'worker', workspaceId: 'ws-task' }, expectedRev: 1, summary: 'gate  green\nall tests' });
    // No channel known for this task → skipped, not thrown.
    await ledger.register({ id: 'wtask-5', taskWorkspaceId: 'ws-t5', ownerWorkspaceId: 'ws-parent', title: 'quiet' });
    dispose();
    await ledger.update({ id: 'wtask-1', status: 'working', actor: { kind: 'brain', workspaceId: 'ws-parent' }, expectedRev: 2 });
    expect(posts).toEqual([{
      channelId: 'ch-1',
      ownerWorkspaceId: 'ws-parent',
      text: '[ledger] wtask-1 working→review_requested worker@ws-task gate green all tests',
      clientMsgId: 'ledger:wtask-1:2',
    }]);
  });

  it('formatLedgerTransition renders a first registration as new→working', () => {
    const line = formatLedgerTransition({
      entry: { id: 'wtask-9', rev: 1 } as never,
      from: null,
      to: 'working',
      by: { kind: 'system', workspaceId: 'daemon' },
    });
    expect(line).toBe('[ledger] wtask-9 new→working system@daemon');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import {
  routeWorkerEventToOwner,
  parkDelegatedEvents,
  peekOrphanBacklog,
  ackOrphanBacklog,
  noteWorkTaskClosed,
  createWorkTaskReconciler,
  getMissionChannelId,
  rememberMissionChannel,
  readLedgerGateInput,
  formatLedgerTransition,
  installLedgerChannelEmitter,
  setTaskLedgerForTests,
} from '../taskLedgerHost';
import { overrideLedgerGateForTests } from '../deckLedgerGateStore';
import { raiseDecision, composeDecisionContext, DECISION_LEDGER_PREFIX_MAX_CHARS, DECISION_LIMITS } from '../deckDecisionStore';
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

  it('parks the event as an orphan backlog when the owner has no brain; peek is non-destructive, ack releases', async () => {
    const pushed: CoalescerInput[] = [];
    routeWorkerEventToOwner(ev(), { hasBrain: () => false, push: (e) => pushed.push(e) });
    await ledger.flush();
    expect(pushed).toHaveLength(0);
    const backlog = peekOrphanBacklog('ws-parent');
    expect(backlog).toHaveLength(1);
    expect(backlog[0].task?.taskId).toBe('wtask-1');
    expect(peekOrphanBacklog('ws-parent')).toHaveLength(1);
    await ackOrphanBacklog('ws-parent', 5);
    expect(peekOrphanBacklog('ws-parent')).toHaveLength(0);
  });

  it('does not route events from a finished task workspace (completed/cancelled entries stop waking the brain)', async () => {
    await ledger.closeTask('wtask-1');
    const pushed: CoalescerInput[] = [];
    let reconciled = 0;
    routeWorkerEventToOwner(ev(), { hasBrain: () => true, push: (e) => pushed.push(e), reconcile: async () => { reconciled += 1; } });
    await new Promise((r) => setTimeout(r, 20));
    expect(pushed).toHaveLength(0);
    expect(reconciled).toBe(0);
    expect(peekOrphanBacklog('ws-parent')).toHaveLength(0);
  });

  it('noteWorkTaskClosed cancels the entry immediately and drops its channel mapping', async () => {
    rememberMissionChannel('wtask-1', 'ch-1');
    await noteWorkTaskClosed('wtask-1');
    expect(ledger.get('wtask-1')?.status).toBe('cancelled');
    expect(getMissionChannelId('wtask-1')).toBeNull();
    await noteWorkTaskClosed('wtask-unknown');
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
    // A long open-task list gets its own budget and never evicts the brain's context.
    const longPrefix = `[open tasks in the ledger: ${'wtask-x "very long title" (working), '.repeat(40)}]\n`;
    const composed = composeDecisionContext(longPrefix, 'the question context');
    expect(composed.length).toBeLessThanOrEqual(DECISION_LIMITS.MAX_CONTEXT_CHARS);
    expect(composed.endsWith('the question context')).toBe(true);
    expect(composed.indexOf('the question context')).toBeLessThanOrEqual(DECISION_LEDGER_PREFIX_MAX_CHARS);
    expect(composeDecisionContext('', 'x'.repeat(2000)).length).toBe(DECISION_LIMITS.MAX_CONTEXT_CHARS);
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
      text: '[ledger] wtask-1 working→review_requested worker@ws-task worker: "gate green all tests"',
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
    const quoted = formatLedgerTransition({
      entry: { id: 'wtask-9', rev: 2 } as never,
      from: 'working',
      to: 'input_required',
      by: { kind: 'worker', workspaceId: 'ws-t' },
      summary: 'need the "API key"',
    });
    expect(quoted).toBe('[ledger] wtask-9 working→input_required worker@ws-t worker: "need the ”API key”"');
  });
});

// Wave 3, finding 12 — the events a PENDING DECISION blocks go to the same
// durable backlog a brain-less owner's do. Durable is the whole point: the
// decision that shut the gate is precisely the thing that survives a restart,
// so an in-memory hold would lose exactly the events the operator came back for.
describe('parkDelegatedEvents', () => {
  const blocked = (seq: number): CoalescerInput =>
    ev({ workspaceId: 'ws-parent', seq, task: { taskId: 'wtask-1', taskWorkspaceId: 'ws-task' } });

  it('parks to disk: a FRESH ledger over the same dir replays the event', async () => {
    parkDelegatedEvents('ws-parent', [blocked(7)]);
    await ledger.flush();
    const reopened = new TaskLedger({ dir });
    const parked = reopened.peekOrphanedEvents('ws-parent');
    expect(parked).toHaveLength(1);
    expect(parked[0].seq).toBe(7);
    expect((parked[0].payload as CoalescerInput).task?.taskId).toBe('wtask-1');
  });

  it('is readable through the same peek the brain-boot replay uses', async () => {
    parkDelegatedEvents('ws-parent', [blocked(7), blocked(8)]);
    await ledger.flush();
    expect(peekOrphanBacklog('ws-parent').map((e) => e.seq)).toEqual([7, 8]);
    await ackOrphanBacklog('ws-parent', 8);
    expect(peekOrphanBacklog('ws-parent')).toHaveLength(0);
  });

  it('does not duplicate a seq already parked (a human send re-parks the replay)', async () => {
    parkDelegatedEvents('ws-parent', [blocked(7)]);
    await ledger.flush();
    parkDelegatedEvents('ws-parent', [blocked(7), blocked(9)]);
    await ledger.flush();
    expect(peekOrphanBacklog('ws-parent').map((e) => e.seq)).toEqual([7, 9]);
  });

  it('never throws when the ledger is unusable', () => {
    setTaskLedgerForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => parkDelegatedEvents('ws-parent', [blocked(7)])).not.toThrow();
  });
});

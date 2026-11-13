import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import {
  BOT_TASK_WAKE_RECOVER_MS,
  installBotFanoutWake,
  installFanoutCallerLedgerNotify,
  notifyFanoutCaller,
  shouldNotifyCaller,
  type FanoutCallerEvent,
} from '../fanoutCallerNotify';
import type { FanoutOrigin } from '../../../shared/fanoutOrigin';
import { buildFanoutCallerNudge, isFanoutCallerNudge, moreSevereKind } from '../../../shared/fanoutCallerNudge';
import { isCallerNudge } from '../../../shared/prOwnerNudge';

const PANE: FanoutOrigin = { kind: 'pane', paneId: 'pane-a', surfaceId: 'surf-a', label: 'w1 · caller' };

function run(
  stamps: Record<string, { owner: string; origin?: FanoutOrigin }>,
  kind = 'agent.stop',
  windowUp = true,
): { sent: FanoutCallerEvent[]; ok: boolean } {
  const sent: FanoutCallerEvent[] = [];
  const ok = notifyFanoutCaller('ws-parent', 'ws-task', 'wtask-1', kind, 7, {
    lineageOf: (ws) => stamps[ws],
    send: (ev) => {
      if (!windowUp) return false;
      sent.push(ev);
      return true;
    },
  });
  return { sent, ok };
}

const STAMPED = { 'ws-task': { owner: 'ws-parent', origin: PANE } };

describe('notifyFanoutCaller for a task another PC runs', () => {
  const REMOTE_WS = 'remote:sp-0f6c1d2e-3a4b-4c5d-8e9f-000000000001';
  const call = (origin: { owner: string; paneId: string } | undefined, stamps: Record<string, { owner: string; origin?: FanoutOrigin }> = {}) => {
    const sent: FanoutCallerEvent[] = [];
    const ok = notifyFanoutCaller('ws-parent', REMOTE_WS, 'wtask-r1', 'ledger.failed', 3, {
      lineageOf: (ws) => stamps[ws],
      remoteOriginOf: () => origin,
      send: (ev) => { sent.push(ev); return true; },
    });
    return { ok, sent };
  };

  it('is addressed to the pane on its row, with no lineage stamp', () => {
    const { ok, sent } = call({ owner: 'ws-parent', paneId: 'pane-a' });
    expect(ok).toBe(true);
    expect(sent).toEqual([{ ownerWorkspaceId: 'ws-parent', taskWorkspaceId: REMOTE_WS, taskId: 'wtask-r1', kind: 'ledger.failed', seq: 3, origin: { paneId: 'pane-a' } }]);
  });

  it('sends nothing for another owner, a row without its pane, or a nested owner', () => {
    expect(call({ owner: 'ws-other', paneId: 'pane-a' }).sent).toEqual([]);
    expect(call(undefined).sent).toEqual([]);
    expect(call({ owner: 'ws-parent', paneId: 'pane-a' }, { 'ws-parent': { owner: 'ws-grand' } }).sent).toEqual([]);
  });
});

describe('notifyFanoutCaller', () => {
  it('sends the pane origin ids and the task pointer only', () => {
    const { sent, ok } = run(STAMPED);
    expect(ok).toBe(true);
    expect(sent).toEqual([
      {
        ownerWorkspaceId: 'ws-parent',
        taskWorkspaceId: 'ws-task',
        taskId: 'wtask-1',
        kind: 'agent.stop',
        seq: 7,
        origin: { paneId: 'pane-a', surfaceId: 'surf-a' },
      },
    ]);
  });

  it('includes stop_failure and the ledger moves, not a worker awaiting input', () => {
    for (const kind of ['agent.stop_failure', 'ledger.failed', 'ledger.review_requested']) {
      expect(run(STAMPED, kind).sent).toHaveLength(1);
    }
    expect(run(STAMPED, 'agent.awaiting_input').sent).toHaveLength(0);
  });

  it('sends nothing without a pane origin, when the stamp names another owner, or to a nested owner', () => {
    expect(run({}).sent).toHaveLength(0);
    expect(run({ 'ws-task': { owner: 'ws-parent' } }).sent).toHaveLength(0);
    expect(run({ 'ws-task': { owner: 'ws-parent', origin: { kind: 'gui' } } }).sent).toHaveLength(0);
    expect(run({ 'ws-task': { owner: 'ws-parent', origin: { kind: 'orchestrator' } } }).sent).toHaveLength(0);
    expect(run({ 'ws-task': { owner: 'ws-other', origin: PANE } }).sent).toHaveLength(0);
    expect(run({ ...STAMPED, 'ws-parent': { owner: 'ws-root', origin: PANE } }).sent).toHaveLength(0);
  });

  it('reports false with no window (headless) and never throws', () => {
    expect(run(STAMPED, 'agent.stop', false).ok).toBe(false);
    expect(
      notifyFanoutCaller('ws-parent', 'ws-task', 'wtask-1', 'agent.stop', 1, {
        lineageOf: () => { throw new Error('torn'); },
        send: () => true,
      }),
    ).toBe(false);
  });
});

describe('shouldNotifyCaller', () => {
  it('only a first report of an agent turn end nudges', () => {
    expect(shouldNotifyCaller({ source: 'hook', decision: 'emit' })).toBe(true);
    expect(shouldNotifyCaller({ source: 'detector', decision: 'emit' })).toBe(true);
    expect(shouldNotifyCaller({ source: 'hook', decision: 'dedup' })).toBe(false);
    expect(shouldNotifyCaller({ source: 'osc133', decision: 'emit' })).toBe(false);
    expect(shouldNotifyCaller({ source: 'hook', decision: 'internal' })).toBe(false);
  });
});

describe('installFanoutCallerLedgerNotify', () => {
  let dir: string;
  let ledger: TaskLedger;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-caller-ledger-'));
    ledger = new TaskLedger({ dir });
    await ledger.register({ id: 'wtask-1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-parent', title: 'lane' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('tells the caller when a worker records failed or review_requested, with the rev as seq', async () => {
    const calls: unknown[][] = [];
    installFanoutCallerLedgerNotify(() => false, (...a) => { calls.push(a); }, ledger);
    await ledger.update({ id: 'wtask-1', status: 'review_requested', actor: { kind: 'worker', workspaceId: 'ws-task' }, expectedRev: 1 });
    await ledger.update({ id: 'wtask-1', status: 'failed', actor: { kind: 'worker', workspaceId: 'ws-task' }, expectedRev: 2 });
    expect(calls).toEqual([
      ['ws-parent', 'ws-task', 'wtask-1', 'ledger.review_requested', 2],
      ['ws-parent', 'ws-task', 'wtask-1', 'ledger.failed', 3],
    ]);
  });

  it('stays quiet for other actors, other statuses, and an owner with a brain', async () => {
    const calls: unknown[][] = [];
    let brain = false;
    installFanoutCallerLedgerNotify(() => brain, (...a) => { calls.push(a); }, ledger);
    await ledger.update({ id: 'wtask-1', status: 'input_required', actor: { kind: 'worker', workspaceId: 'ws-task' }, expectedRev: 1 });
    brain = true;
    await ledger.update({ id: 'wtask-1', status: 'review_requested', actor: { kind: 'worker', workspaceId: 'ws-task' }, expectedRev: 2 });
    brain = false;
    await ledger.update({ id: 'wtask-1', status: 'failed', actor: { kind: 'brain', workspaceId: 'ws-parent' }, expectedRev: 3 });
    expect(calls).toEqual([]);
  });

  it('tells the caller when wmux itself moves the row to input_required (#1919: the agent never started)', async () => {
    const calls: unknown[][] = [];
    installFanoutCallerLedgerNotify(() => false, (...a) => { calls.push(a); }, ledger);
    await ledger.update({
      id: 'wtask-1',
      status: 'input_required',
      actor: { kind: 'system', workspaceId: 'ws-parent' },
      expectedRev: 1,
      summary: 'launch failed',
    });
    // A system move to anything else is not a caller event.
    await ledger.update({ id: 'wtask-1', status: 'working', actor: { kind: 'system', workspaceId: 'ws-parent' }, expectedRev: 2 });
    expect(calls).toEqual([['ws-parent', 'ws-task', 'wtask-1', 'ledger.input_required', 2]]);
  });
});

describe('installFanoutCallerLedgerNotify for a task another PC runs', () => {
  const SPAWN = 'sp-0f6c1d2e-3a4b-4c5d-8e9f-000000000001';
  let dir: string;
  let ledger: TaskLedger;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-caller-ledger-remote-'));
    ledger = new TaskLedger({ dir });
    const remote = { hostId: '0f1e2d3c-4b5a-4968-8776-655443322110', pc: 'box', spawnId: SPAWN, root: 'repo', state: 'started' as const, from: { paneId: 'pane-a' } };
    await ledger.register({ id: 'wtask-r1', taskWorkspaceId: `remote:${SPAWN}`, ownerWorkspaceId: 'ws-parent', title: 'remote', remote });
    await ledger.register({ id: 'wtask-r2', taskWorkspaceId: `remote:${SPAWN.replace(/1$/, '2')}`, ownerWorkspaceId: 'ws-parent', title: 'remote', remote: { ...remote, spawnId: SPAWN.replace(/1$/, '2') } });
    await ledger.register({ id: 'wtask-1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-parent', title: 'lane' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('tells its failure as wmux records it; not its report, and not a local system failure', async () => {
    const calls: unknown[][] = [];
    installFanoutCallerLedgerNotify(() => false, (...a) => { calls.push(a); }, ledger);
    const sys = { kind: 'system' as const, workspaceId: 'main' };
    await ledger.update({ id: 'wtask-r1', status: 'failed', actor: sys, expectedRev: 1, summary: 'the agent on box is gone' });
    await ledger.update({ id: 'wtask-r2', status: 'review_requested', actor: sys, expectedRev: 1 });
    await ledger.update({ id: 'wtask-1', status: 'failed', actor: sys, expectedRev: 1 });
    expect(calls).toEqual([['ws-parent', `remote:${SPAWN}`, 'wtask-r1', 'ledger.failed', 2]]);
  });
});

describe('the input_required kind (#1919)', () => {
  it('is a caller kind whose nudge line passes the shared validators', () => {
    expect(run(STAMPED, 'ledger.input_required').sent).toHaveLength(1);
    const line = buildFanoutCallerNudge([{ taskId: 'wtask-muyap1aa-evshoujp', kind: 'ledger.input_required' }]);
    expect(line).toBe('[wmux] fan-out task evshoujp needs input — channel_mission_list');
    expect(isFanoutCallerNudge(line)).toBe(true);
    expect(isCallerNudge(line)).toBe(true);
    // Ranked between a hard failure and a review request.
    expect(moreSevereKind('ledger.input_required', 'ledger.review_requested')).toBe('ledger.input_required');
    expect(moreSevereKind('ledger.input_required', 'ledger.failed')).toBe('ledger.failed');
  });
});

describe('installBotFanoutWake recovery at install (review fixes, PR #2164)', () => {
  let dir: string;
  let now = 10 * BOT_TASK_WAKE_RECOVER_MS;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bot-wake-recover-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function botTask(ledger: TaskLedger, id: string, to: 'failed' | 'input_required' | 'working' | 'stopped'): Promise<void> {
    await ledger.register({ id, taskWorkspaceId: `${id}-ws`, ownerWorkspaceId: 'ws-1', title: id, dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' }, preset: 'default' } });
    if (to === 'working') return;
    const rev = ledger.get(id)?.rev ?? 0;
    const r = to === 'stopped'
      ? await ledger.update({ id, status: 'cancelled', actor: { kind: 'system', workspaceId: 'ws-daemon' }, expectedRev: rev, summary: 'stopped by owner' })
      : await ledger.update({ id, status: to, actor: { kind: 'worker', workspaceId: `${id}-ws` }, expectedRev: rev });
    if (!r.ok) throw new Error(r.message);
  }

  it('wakes the bot again for a recent move whose wake may have been lost, never for an old one, an open task or the owner\'s stop', async () => {
    const ledger = new TaskLedger({ dir, now: () => now });
    await botTask(ledger, 'wtask-old', 'failed');
    now += BOT_TASK_WAKE_RECOVER_MS + 1;
    await botTask(ledger, 'wtask-new', 'failed');
    await botTask(ledger, 'wtask-ask', 'input_required');
    await botTask(ledger, 'wtask-run', 'working');
    await botTask(ledger, 'wtask-stop', 'stopped');
    const enqueue = vi.fn();
    const off = installBotFanoutWake({ enqueue, now: () => now }, ledger);
    const ids = enqueue.mock.calls.map((c) => c[0].reason.factIds[0]).sort();
    expect(ids).toEqual([`task.failed:wtask-new@${ledger.get('wtask-new')?.rev}`, `task.input_required:wtask-ask@${ledger.get('wtask-ask')?.rev}`].sort());
    off();
  });
});

describe('installBotFanoutWake recovery and the queue (review fixes, second pass)', () => {
  it('never offers again a wake the queue already holds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bot-wake-known-'));
    try {
      const ledger = new TaskLedger({ dir });
      await ledger.register({ id: 'wtask-k', taskWorkspaceId: 'wtask-k-ws', ownerWorkspaceId: 'ws-1', title: 'k', dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' }, preset: 'default' } });
      const r = await ledger.update({ id: 'wtask-k', status: 'failed', actor: { kind: 'worker', workspaceId: 'wtask-k-ws' }, expectedRev: ledger.get('wtask-k')?.rev ?? 0 });
      if (!r.ok) throw new Error(r.message);
      const enqueue = vi.fn();
      const wakeKnown = vi.fn(() => true);
      installBotFanoutWake({ enqueue, wakeKnown }, ledger)();
      expect(wakeKnown).toHaveBeenCalledWith('bot-0000000a', `task.failed:wtask-k@${ledger.get('wtask-k')?.rev}`);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('bot worker accounting and owner wake isolation', () => {
  it('still wakes a failed worker’s owner when accounting throws; retry gets its own wake', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bot-accounting-'));
    const ledger = new TaskLedger({ dir });
    const enqueue = vi.fn();
    const onWorkerEnded = vi.fn(() => { throw new Error('worker hours unavailable'); });
    const off = installBotFanoutWake({ enqueue, onWorkerEnded }, ledger);
    try {
      await ledger.register({ id: 'task-a', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'retryable task', dispatch: { origin: { kind: 'bot', botId: 'bot-0000000a' }, preset: 'default' } });
      const update = async (status: string, kind: 'worker' | 'brain', workspaceId: string) => {
        const result = await ledger.update({ id: 'task-a', status, actor: { kind, workspaceId }, expectedRev: ledger.get('task-a')?.rev ?? 0 });
        expect(result.ok).toBe(true);
      };
      await update('failed', 'worker', 'ws-task');
      expect(enqueue).toHaveBeenCalledTimes(1);
      await update('working', 'brain', 'ws-owner');
      await update('failed', 'worker', 'ws-task');
      expect(onWorkerEnded).toHaveBeenCalledTimes(2);
      expect(enqueue.mock.calls.map(([input]) => input.reason.factIds)).toEqual([
        ['task.failed:task-a@2'], ['task.failed:task-a@4'],
      ]);
    } finally {
      off();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

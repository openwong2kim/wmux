import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import {
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

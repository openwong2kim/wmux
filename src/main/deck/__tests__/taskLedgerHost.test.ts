import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import {
  noteWorkTaskClosed,
  createWorkTaskReconciler,
  getMissionChannelId,
  rememberMissionChannel,
  formatLedgerTransition,
  installLedgerChannelEmitter,
  setTaskLedgerForTests,
} from '../taskLedgerHost';
import { raiseDecision, composeDecisionContext, DECISION_LEDGER_PREFIX_MAX_CHARS, DECISION_LIMITS } from '../deckDecisionStore';

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

  it('a mirrored row carries the lineage stamp\'s origin, and the fan-out\'s own register replaces it (#2393)', async () => {
    const tasks = [
      { id: 'wtask-bot', title: 'recovered', status: 'open', owner: { verifiedWorkspaceId: 'ws-parent' }, paneGroupId: 'ws-bot' },
      { id: 'wtask-plain', title: 'unstamped', status: 'open', owner: { verifiedWorkspaceId: 'ws-parent' }, paneGroupId: 'ws-plain' },
    ];
    const reconcile = createWorkTaskReconciler({
      candidateOwners: () => ['ws-parent'],
      listTasks: async () => ({ ok: true, tasks }),
      originOf: (ws) => (ws === 'ws-bot' ? { kind: 'bot', botId: 'bot-a' } : null),
    });
    await reconcile();
    // A running recovered bot worker counts on its bot's slots again.
    expect(ledger.get('wtask-bot')?.dispatch).toEqual({ origin: { kind: 'bot', botId: 'bot-a' }, reconciled: true });
    expect(ledger.get('wtask-plain')?.dispatch).toBeUndefined();
    // The fan-out's register landing after the reconciler still records its
    // full dispatch, which is never replaced after that.
    await ledger.register({
      id: 'wtask-bot', taskWorkspaceId: 'ws-bot', ownerWorkspaceId: 'ws-parent', title: 'recovered',
      dispatch: { origin: { kind: 'bot', botId: 'bot-a', tainted: false }, preset: 'code', repoKey: 'github.com/o/r' },
    });
    expect(ledger.get('wtask-bot')?.dispatch).toEqual({ origin: { kind: 'bot', botId: 'bot-a', tainted: false }, preset: 'code', repoKey: 'github.com/o/r' });
    await ledger.register({
      id: 'wtask-bot', taskWorkspaceId: 'ws-bot', ownerWorkspaceId: 'ws-parent', title: 'recovered',
      dispatch: { origin: { kind: 'bot', botId: 'bot-b' } },
    });
    expect(ledger.get('wtask-bot')?.dispatch?.origin.botId).toBe('bot-a');
  });
});

describe('decision context', () => {
  it('a raised decision carries its own context, capped to the limit', async () => {
    const d = await raiseDecision('ws-parent', { question: 'merge?', context: 'details' }, dir);
    expect(d?.context).toBe('details');
    expect(d?.question).toBe('merge?');
    // A long prefix gets its own budget and never evicts the context.
    const longPrefix = `[open tasks in the ledger: ${'wtask-x "very long title" (working), '.repeat(40)}]\n`;
    const composed = composeDecisionContext(longPrefix, 'the question context');
    expect(composed.length).toBeLessThanOrEqual(DECISION_LIMITS.MAX_CONTEXT_CHARS);
    expect(composed.endsWith('the question context')).toBe(true);
    expect(composed.indexOf('the question context')).toBeLessThanOrEqual(DECISION_LEDGER_PREFIX_MAX_CHARS);
    expect(composeDecisionContext('', 'x'.repeat(2000)).length).toBe(DECISION_LIMITS.MAX_CONTEXT_CHARS);
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

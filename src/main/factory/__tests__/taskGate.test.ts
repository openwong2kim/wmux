// The system gate on a bot task's report: main gates every non-verify bot
// task that reports review_requested, completes it on a pass (as its owner,
// unforced: the ledger itself checks the system gate), leaves it open
// otherwise, and wakes the bot that started it once either way.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../shared/bot';
import type { LedgerEntry, LedgerGateResult } from '../../../shared/ledger';
import type { GateRunInput, GateRunResult } from '../../worktask/TaskGateRunner';
import { completeCheckedTask, completeResearchTask, describeTaskGate, gateCardNoted, installTaskGate, isTaskGateReport, reportWasGated, type TaskGatePorts } from '../taskGate';
import type { RoomCard } from '../../../shared/room';
import { RoomWriter } from '../roomWriter';
import { verifyGateFactId } from '../verifyPreset';
import { countOpenBotWorkers } from '../../pipe/handlers/fanout.rpc';

const BOT = 'bot-0000000a';
const HEAD = 'c'.repeat(40);

const lead: BotProfile = {
  version: 1, id: BOT, workspaceId: 'ws-lead', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { ...DEFAULT_BOT_BUDGETS.lead }, repo: { repoKey: 'github.com/acme/app', repoPath: '/repo' }, enabled: true, createdAt: 1, updatedAt: 1,
};

let dir = '';
let ledger: TaskLedger;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-lifecycle-gate-'));
  ledger = new TaskLedger({ dir });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Let the gate's ledger writes (file appends) and wakes land. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 5));
};

async function register(id = 'task-1', preset = 'default', origin: { kind: string; botId?: string } = { kind: 'bot', botId: BOT }): Promise<void> {
  await ledger.register({ id, taskWorkspaceId: `${id}-ws`, ownerWorkspaceId: 'ws-lead', title: `task ${id}`, dispatch: { origin, preset } });
}

async function report(id = 'task-1', status = 'review_requested'): Promise<LedgerEntry> {
  const row = ledger.get(id) as LedgerEntry;
  const r = await ledger.update({ id, status, actor: { kind: 'worker', workspaceId: `${id}-ws` }, expectedRev: row.rev, summary: 'done' });
  if (!r.ok) throw new Error(r.message);
  return r.entry;
}

const PASS: LedgerGateResult = { exitCode: 0, tail: 'ok', at: 5, command: 'npm run lint', headSha: HEAD };

/** A runner that records `gate` the way TaskGateRunner does (null: records nothing). */
function recordingRunner(gate: LedgerGateResult | null, result?: (input: GateRunInput) => GateRunResult) {
  return vi.fn(async (input: GateRunInput): Promise<GateRunResult> => {
    let recorded = false;
    if (gate) {
      const row = ledger.get(input.taskId);
      if (row) recorded = (await ledger.recordGate(input.taskId, gate, { kind: 'system', workspaceId: input.systemWorkspaceId }, row.rev)).ok;
    }
    if (result) return result(input);
    return gate?.skipped
      ? { ok: true, status: 'skipped', taskId: input.taskId, skipped: 'no_gate_command', detail: 'no gate declared', recorded }
      : { ok: true, status: 'completed', taskId: input.taskId, result: { ...(gate as LedgerGateResult), recordedBy: 'system' }, recorded };
  });
}

function rig(over: Partial<TaskGatePorts> = {}, runGate: ReturnType<typeof vi.fn<TaskGatePorts['runGate']>> = recordingRunner(PASS)) {
  const wake = vi.fn();
  const note = vi.fn();
  const off = installTaskGate({
    onTransition: (fn) => ledger.onTransition(fn),
    ledgerRow: (id) => ledger.get(id),
    openRows: () => ledger.list({ openOnly: true }),
    bot: (id) => (id === BOT ? lead : null),
    worktreeOf: async () => '/wt/task',
    baseRef: async () => 'origin/main',
    runGate,
    complete: (id) => completeCheckedTask(ledger, id),
    completeResearch: (id) => completeResearchTask(ledger, id),
    wake,
    note,
    ...over,
  });
  return { wake, note, off, runGate };
}

describe('the system gate on a bot task report', () => {
  it('pass: gates with the base branch\'s gate, completes the task as its owner (unforced), one card and one wake', async () => {
    await register();
    const r = rig();
    await report();
    await flush();
    expect(r.runGate).toHaveBeenCalledTimes(1);
    expect(r.runGate).toHaveBeenCalledWith({ taskId: 'task-1', worktreePath: '/wt/task', systemWorkspaceId: 'ws-daemon', projectRoot: '/repo', gateBaseRef: 'origin/main' });
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(row.updatedBy).toEqual({ kind: 'brain', workspaceId: 'ws-lead' });
    expect(row.summary).toBe('done'); // no [forced: …]
    expect(r.note).toHaveBeenCalledTimes(1);
    expect(r.note.mock.calls[0][2]).toBe('Task checked: gate passed, task completed');
    // A completed task holds no worker slot.
    expect(countOpenBotWorkers(ledger.list({ openOnly: true }), BOT, () => new Set())).toEqual({ bot: 0, factory: 0 });
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake).toHaveBeenCalledWith({
      botId: BOT, workspaceId: 'ws-lead', priority: 1, threadId: 'task:task-1',
      reason: { kind: 'facts', factIds: [verifyGateFactId('task-1', row.rev)], trigger: { kind: 'task.done' } },
    });
  });

  it('fail: the task stays open (review_requested), a card with the exit code, one wake', async () => {
    await register();
    const r = rig({}, recordingRunner({ ...PASS, exitCode: 1 }));
    await report();
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('review_requested');
    expect(row.gate?.exitCode).toBe(1);
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Gate failed (exit 1): task left open']);
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', row.rev)]);
  });

  it('skipped: a recorded "no gate declared" is not a check; an unrecorded skip and a refusal leave it open too', async () => {
    await register('a');
    await register('b');
    await register('c');
    const runs: Record<string, TaskGatePorts['runGate']> = {
      a: recordingRunner({ ...PASS, command: 'none', skipped: 'no_gate_command' }),
      b: recordingRunner(null, (i) => ({ ok: true, status: 'skipped', taskId: i.taskId, skipped: 'deps_missing', detail: 'node_modules is missing' })),
      c: recordingRunner(null, (i) => ({ ok: false, status: 'refused', taskId: i.taskId, error: 'the worktree scripts differ from the base' })),
    };
    const r = rig({}, vi.fn((input: GateRunInput) => runs[input.taskId](input)));
    await report('a');
    await report('b');
    await report('c');
    await flush();
    for (const id of ['a', 'b', 'c']) expect(ledger.get(id)?.status).toBe('review_requested');
    expect(r.note.mock.calls.map((c) => c[2]).sort()).toEqual([
      'Gate refused: task left open',
      'Gate skipped (deps_missing): task left open',
      'Gate skipped (no_gate_command): task left open',
    ]);
    expect(r.wake).toHaveBeenCalledTimes(3);
  });

  it('no worktree or no base branch: nothing runs, the task stays open, one wake', async () => {
    await register();
    const r = rig({ baseRef: async () => null });
    await report();
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r.note.mock.calls[0][2]).toBe('Gate not run: task left open');
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('only non-verify bot tasks reporting review_requested', async () => {
    await register('v', 'verify');
    await register('p', 'default', { kind: 'pane' });
    await register('w');
    const r = rig();
    await report('v');
    await report('p');
    await report('w', 'input_required');
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
    expect(isTaskGateReport(ledger.get('v') as LedgerEntry, 'review_requested')).toBe(false);
  });

  it('double report: a same-status resubmit is no second gate; a report that lands while the gate runs is gated again and only that run settles it', async () => {
    await register();
    let release: (() => void) | null = null;
    const first = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const pass = recordingRunner(PASS);
    const runGate = vi.fn(async (input: GateRunInput) => {
      calls++;
      if (calls === 1) await first;
      return pass(input);
    });
    const r = rig({}, runGate);
    await report();
    await flush();
    // Same status again: a no-op in the ledger, no transition.
    const row = ledger.get('task-1') as LedgerEntry;
    const again = await ledger.update({ id: 'task-1', status: 'review_requested', actor: { kind: 'worker', workspaceId: 'task-1-ws' }, expectedRev: row.rev });
    expect(again.ok && again.noop).toBe(true);
    // Sent back and reported again while the first gate still runs.
    const back = await ledger.update({ id: 'task-1', status: 'input_required', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: row.rev });
    if (!back.ok) throw new Error(back.message);
    await report();
    (release as unknown as () => void)();
    await flush();
    expect(runGate).toHaveBeenCalledTimes(2);
    expect(ledger.get('task-1')?.status).toBe('completed');
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.note).toHaveBeenCalledTimes(1);
  });

  it('a task that moved while its gate ran (cancelled, sent back) gets no card, no wake and is not completed', async () => {
    await register();
    const runGate = vi.fn(async (input: GateRunInput): Promise<GateRunResult> => {
      const row = ledger.get(input.taskId) as LedgerEntry;
      await ledger.update({ id: input.taskId, status: 'cancelled', actor: { kind: 'system', workspaceId: 'ws-daemon' }, expectedRev: row.rev, summary: 'stopped by owner' });
      return { ok: true, status: 'completed', taskId: input.taskId, recorded: true, result: { ...PASS, exitCode: null } };
    });
    const r = rig({}, runGate);
    await report();
    await flush();
    expect(ledger.get('task-1')?.status).toBe('cancelled');
    expect(r.note).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
  });

  it('restart: a report with no gate after it, or with a recorded pass (it may be an older report\'s), is gated at install; a recorded fail wakes again without a second card', async () => {
    await register('ungated');
    await report('ungated');
    await register('passed');
    await report('passed');
    await ledger.recordGate('passed', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    await register('failed');
    await report('failed');
    await ledger.recordGate('failed', { ...PASS, exitCode: 2 }, { kind: 'system', workspaceId: 'ws-daemon' });
    // A gate recorded BEFORE the report is not this report's gate.
    await register('stale');
    await ledger.recordGate('stale', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    await report('stale');

    const r = rig();
    await flush();
    expect(r.runGate.mock.calls.map((c) => c[0].taskId).sort()).toEqual(['passed', 'stale', 'ungated']);
    expect(ledger.get('passed')?.status).toBe('completed');
    expect(ledger.get('ungated')?.status).toBe('completed');
    expect(ledger.get('failed')?.status).toBe('review_requested');
    const failedRev = (ledger.get('failed') as LedgerEntry).rev;
    expect(r.wake.mock.calls.map((c) => c[0].reason.factIds[0])).toContain(verifyGateFactId('failed', failedRev));
    expect(r.note.mock.calls.filter((c) => String(c[2]).startsWith('Gate failed'))).toHaveLength(0);
    // One wake per task: the queue dedupes a second install's identical ids.
    expect(r.wake).toHaveBeenCalledTimes(4);
  });

  it('restart: a refused report whose rev was already carded is not gated or carded again, only woken; one that was not carded is gated', async () => {
    const refuse = recordingRunner(null, (i) => ({ ok: false, status: 'refused', taskId: i.taskId, error: 'the worktree scripts differ from the base' }));
    await register('carded');
    await register('uncarded');
    // Before the restart: both reports were refused, and one card each was written.
    const cards = new Set<string>();
    const first = rig({ note: (_ws, _t, _title, _body, key) => { cards.add(key); } }, refuse);
    await report('carded');
    await flush();
    first.off();
    expect(cards).toEqual(new Set([verifyGateFactId('carded', (ledger.get('carded') as LedgerEntry).rev)]));
    await report('uncarded');

    const r = rig({ noted: (_ws, _t, key) => cards.has(key) }, refuse);
    await flush();
    expect(refuse.mock.calls.map((c) => c[0].taskId)).toEqual(['carded', 'uncarded']); // 'carded' only before the restart
    expect(r.note.mock.calls.map((c) => c[4])).toEqual([verifyGateFactId('uncarded', (ledger.get('uncarded') as LedgerEntry).rev)]);
    expect(r.wake.mock.calls.map((c) => c[0].reason.factIds[0]).sort()).toEqual([
      verifyGateFactId('carded', (ledger.get('carded') as LedgerEntry).rev),
      verifyGateFactId('uncarded', (ledger.get('uncarded') as LedgerEntry).rev),
    ].sort());
    expect(ledger.get('carded')?.status).toBe('review_requested');
  });

  it('restart: a carded pass whose completion did not land is gated again, not only woken', async () => {
    await register('passed');
    await report('passed');
    await ledger.recordGate('passed', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    const r = rig({ noted: () => true });
    await flush();
    expect(r.runGate.mock.calls.map((c) => c[0].taskId)).toEqual(['passed']);
    expect(ledger.get('passed')?.status).toBe('completed');
  });

  it('restart: the catch-up waits while the room cannot be read, and runs as before when it never can', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await register();
      await report();
      let readable = false;
      const r = rig({ noted: () => (readable ? true : null), notedWaitMs: 1_000 });
      await vi.advanceTimersByTimeAsync(500);
      expect(r.runGate).not.toHaveBeenCalled();
      expect(r.wake).not.toHaveBeenCalled();
      readable = true;
      await vi.advanceTimersByTimeAsync(300);
      expect(r.runGate).not.toHaveBeenCalled();
      expect(r.wake).toHaveBeenCalledTimes(1);
      r.off();

      const never = rig({ noted: () => null, notedWaitMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(never.runGate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a gate card\'s key survives a restart of the room (written, then read back from disk)', () => {
    const rooms = path.join(dir, 'rooms');
    const key = verifyGateFactId('wtask-a1b2c3d4-0123456789abcdef', 123456);
    const thread = 'task:wtask-a1b2c3d4-0123456789abcdef' as RoomCard['threadId'];
    const before = new RoomWriter({ dir: rooms, log: () => undefined });
    expect(before.append({ workspaceId: 'ws-lead', threadId: thread, kind: 'fact', actor: { kind: 'system' }, title: 'Gate refused: task left open' }, { clientPostId: key })).not.toBeNull();
    const after = new RoomWriter({ dir: rooms, log: () => undefined });
    expect(gateCardNoted((ws, m) => after.find(ws, m), 'ws-lead', thread, key)).toBe(true);
    expect(gateCardNoted((ws, m) => after.find(ws, m), 'ws-lead', thread, verifyGateFactId('wtask-a1b2c3d4-0123456789abcdef', 123457))).toBe(false);
  });

  it('gateCardNoted: only a system card in the task thread with the key counts', () => {
    const card = (over: Partial<RoomCard>): RoomCard => ({
      version: 1, id: 'c', seq: 1, workspaceId: 'ws-lead', threadId: 'task:t' as RoomCard['threadId'], kind: 'fact', at: 1, actor: { kind: 'system' }, title: 't', clientPostId: 'k', ...over,
    });
    const findIn = (cards: RoomCard[]) => (_ws: string, m: (c: RoomCard) => boolean) => cards.find(m) ?? null;
    const thread = 'task:t' as RoomCard['threadId'];
    expect(gateCardNoted(null, 'ws-lead', thread, 'k')).toBeNull();
    expect(gateCardNoted(findIn([card({})]), 'ws-lead', thread, 'k')).toBe(true);
    expect(gateCardNoted(findIn([card({ actor: { kind: 'bot', botId: BOT } as RoomCard['actor'] })]), 'ws-lead', thread, 'k')).toBe(false);
    expect(gateCardNoted(findIn([card({ threadId: 'general' as RoomCard['threadId'] })]), 'ws-lead', thread, 'k')).toBe(false);
    expect(gateCardNoted(findIn([card({ clientPostId: 'other' })]), 'ws-lead', thread, 'k')).toBe(false);
  });

  it('restart: a task the system completed in the last day wakes its bot again with the same id; older ones and other completions do not', async () => {
    await register('done');
    await report('done');
    await ledger.recordGate('done', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    await completeCheckedTask(ledger, 'done');
    await register('skip');
    await report('skip');
    await ledger.recordGate('skip', { ...PASS, skipped: 'no_gate_command' }, { kind: 'system', workspaceId: 'ws-daemon' });
    const skipRow = ledger.get('skip') as LedgerEntry;
    await ledger.update({ id: 'skip', status: 'completed', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: skipRow.rev });
    const done = ledger.get('done') as LedgerEntry;
    const r = rig({ allRows: () => ledger.list({}), now: () => done.updatedAt + 1000 });
    await flush();
    expect(r.wake.mock.calls.map((c) => c[0].reason.factIds[0])).toEqual([verifyGateFactId('done', done.rev)]);
    const later = rig({ allRows: () => ledger.list({}), now: () => done.updatedAt + 2 * 24 * 3_600_000 });
    await flush();
    expect(later.wake).not.toHaveBeenCalled();
  });

  it('a task stopped while its worktree was being looked up gets no gate', async () => {
    await register();
    let resolveLookup: ((v: string) => void) | null = null;
    const r = rig({ worktreeOf: () => new Promise<string>((res) => { resolveLookup = res; }) });
    await report();
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    await ledger.update({ id: 'task-1', status: 'cancelled', actor: { kind: 'system', workspaceId: 'ws-daemon' }, expectedRev: row.rev, summary: 'stopped by owner' });
    (resolveLookup as unknown as (v: string) => void)('/wt/task');
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.note).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
  });

  it('unsubscribes', async () => {
    await register();
    const r = rig();
    r.off();
    await report();
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
  });
});

describe('a research task (no repository, no code)', () => {
  it('its report completes it without a gate, as its owner and unforced, even for a bot with no repository; one card, one wake', async () => {
    await register('task-1', 'research');
    const r = rig({ bot: (id) => (id === BOT ? { ...lead, repo: undefined } : null), worktreeOf: async () => null });
    await report();
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(row.updatedBy).toEqual({ kind: 'brain', workspaceId: 'ws-lead' });
    expect(row.summary).toBe('done'); // no [forced: …]
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Research reported: task completed']);
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', row.rev)]);
  });

  it('the ledger completes only a bot\'s research row without a gate: a pane task named "research" still needs one', async () => {
    await register('task-1', 'research');
    await register('task-2', 'research', { kind: 'pane' });
    await register('task-3', 'default');
    for (const id of ['task-1', 'task-2', 'task-3']) await report(id);
    expect((await completeResearchTask(ledger, 'task-1')).entry?.status).toBe('completed');
    expect(await completeResearchTask(ledger, 'task-3')).toMatchObject({ entry: null, why: 'the task is not a research task' });
    const pane = ledger.get('task-2') as LedgerEntry;
    const forced = await ledger.update({ id: 'task-2', status: 'completed', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: pane.rev });
    expect(forced).toMatchObject({ ok: false, error: 'gate_required' });
  });
});

describe('completeCheckedTask', () => {
  it('completes only when a passing system gate is the newest write on a reported task', async () => {
    await register('ok');
    await report('ok');
    await ledger.recordGate('ok', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    expect((await completeCheckedTask(ledger, 'ok')).entry?.status).toBe('completed');

    await register('skip');
    await report('skip');
    await ledger.recordGate('skip', { ...PASS, command: 'none', skipped: 'no_gate_command' }, { kind: 'system', workspaceId: 'ws-daemon' });
    expect((await completeCheckedTask(ledger, 'skip')).entry).toBeNull();

    await register('red');
    await report('red');
    await ledger.recordGate('red', { ...PASS, exitCode: 1 }, { kind: 'system', workspaceId: 'ws-daemon' });
    expect((await completeCheckedTask(ledger, 'red')).entry).toBeNull();

    await register('old');
    await ledger.recordGate('old', PASS, { kind: 'system', workspaceId: 'ws-daemon' });
    const reported = await report('old');
    expect(reportWasGated(reported)).toBe(false);
    expect((await completeCheckedTask(ledger, 'old')).entry).toBeNull();
    expect(ledger.get('old')?.status).toBe('review_requested');

    expect((await completeCheckedTask(ledger, 'missing')).entry).toBeNull();
  });
});

describe('describeTaskGate', () => {
  it('a base with no gate script yet says what the owner can do', () => {
    const d = describeTaskGate({ ok: false, status: 'refused', taskId: 't', code: 'no_base_gate', error: 'origin/main has no npm test script yet and the task worktree adds one' });
    expect(d.title).toBe('No gate on the default branch yet: task left open');
    expect(d.body).toContain('origin/main has no npm test script yet');
    expect(d.body).toContain('merge a test script into the default branch first');
    expect(d.body).toContain('cancel it');
    expect(describeTaskGate({ ok: false, status: 'refused', taskId: 't', error: 'x' }).title).toBe('Gate refused: task left open');
  });

  it('names a killed gate and an unrecorded receipt', () => {
    const killed = describeTaskGate({ ok: true, status: 'completed', taskId: 't', recorded: false, result: { exitCode: null, tail: '', at: 1, command: 'npm test' } });
    expect(killed.title).toBe('Gate was killed: task left open');
    expect(killed.body).toContain('NOT recorded');
    expect(describeTaskGate({ ok: false, status: 'busy', taskId: 't' }).title).toBe('Gate already running: task left open');
  });
});

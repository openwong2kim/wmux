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
import { MERGE_ANSWER_TTL_MS, MERGE_BACKOFF_MAX_MS, MERGE_SWEEP_MAX, completeCheckedTask, completeMergedTask, completeResearchTask, describeTaskGate, gateCardNoted, installTaskGate, isMergeCompletion, isTaskGateReport, mergeBackoffMs, mergedMark, noChangesDetail, recordNoChangesGate, reportWasGated, worktreeHeadMerged, type BranchPr, type TaskGatePorts } from '../taskGate';
import { factDedupeKey, type Fact } from '../../../shared/facts';
import type { RoomCard } from '../../../shared/room';
import { RoomWriter } from '../roomWriter';
import { taskBaseFromStamp, verifyGateFactId } from '../verifyPreset';
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

  it('carries a stable code and the values its words need, the evidence left in the body', () => {
    const failed = describeTaskGate({ ok: true, status: 'completed', taskId: 't', recorded: true, result: { exitCode: 2, tail: '', at: 1, command: 'npm test' } });
    expect(failed.notice).toEqual({ code: 'gate.failed', args: { exit: 2 } });
    expect(describeTaskGate({ ok: false, status: 'refused', taskId: 't', code: 'no_base_gate', error: 'no script' }).notice).toEqual({ code: 'gate.noBase', args: { detail: 'no script' } });
    expect(describeTaskGate({ ok: false, status: 'busy', taskId: 't' }).notice).toEqual({ code: 'gate.busy' });
    expect(describeTaskGate({ ok: false, status: 'refused', taskId: 't', error: 'x' }).notice).toEqual({ code: 'gate.refused' });
  });
});

// Several of these run on real timers (the sweep): generous bounds, so a
// loaded machine does not fail them.
describe('a merged pull request ends its task', { timeout: 30_000 }, () => {
  const REPO = 'github.com/acme/app';
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const SHA_C = 'c'.repeat(40);
  /** A merged PR as GitHub lists it (the prsOfBranch port's answer). */
  const pr = (n: number, o: { base?: string; sha?: string; cross?: boolean } = {}): BranchPr => ({ pr: n, base: o.base ?? 'main', headSha: o.sha ?? SHA_A, cross: o.cross ?? false });
  let seq = 0;
  /** A repo-watch fact (only a trigger now, never evidence). */
  const fact = (kind: 'pr.merged' | 'pr.closed', n: number, repoKey = REPO): Fact => {
    seq++;
    const draft = { kind, at: seq, repoKey, ref: { pr: n }, payload: {} };
    return { ...draft, id: `f${seq}`, seq, dedupeKey: factDedupeKey(draft) as string };
  };
  /** No gate runs (refused): the report gets its card and stays open. */
  const refused = vi.fn(async (i: GateRunInput): Promise<GateRunResult> => ({ ok: false, status: 'refused', taskId: i.taskId, error: 'no gate in this test' }));
  const NO_GATE: Partial<TaskGatePorts> = { runGate: refused };

  /** A bot code task with its repository recorded at dispatch (null: none recorded). */
  async function registerTask(id = 'task-1', o: { preset?: string; repoKey?: string | null } = {}): Promise<void> {
    const repoKey = o.repoKey === undefined ? REPO : o.repoKey;
    await ledger.register({ id, taskWorkspaceId: `${id}-ws`, ownerWorkspaceId: 'ws-lead', title: `task ${id}`, dispatch: { origin: { kind: 'bot', botId: BOT }, preset: o.preset ?? 'default', ...(repoKey ? { repoKey } : {}) } });
  }

  const HEAD = 'd'.repeat(40);
  /**
   * A rig whose GitHub lists `merged[`<repoKey> <branch>`]` as the merged PRs
   * of a branch (a function: what it lists now; it may throw or wait), whose
   * repositories' default branch is main, whose task branches are `branches`
   * (undefined: not readable), whose task worktrees are at `heads[taskId]`
   * (default HEAD) and held by the commits `holds[taskId]` lists (default:
   * SHA_A), and whose clock is `clock.now`.
   */
  function mergeRig(merged: Record<string, BranchPr[] | (() => BranchPr[] | Promise<BranchPr[]>)>, branches: Record<string, string | null | undefined>, over: Partial<TaskGatePorts> = {}, runGate?: ReturnType<typeof vi.fn<TaskGatePorts['runGate']>>, holds: Record<string, string[]> = {}) {
    const subs = new Set<(f: Fact) => void>();
    const clock = { now: 1_000_000 };
    const heads: Record<string, string | null> = {};
    const branchOf = vi.fn(async (e: LedgerEntry) => branches[e.id]);
    const prsOfBranch = vi.fn(async (repoKey: string, branch: string): Promise<readonly BranchPr[]> => {
      const v = merged[`${repoKey} ${branch}`] ?? [];
      return typeof v === 'function' ? v() : v;
    });
    const defaultBranchOf = vi.fn(async () => 'main');
    const headOf = vi.fn(async (wt: string) => {
      const id = wt.slice('/wt/'.length);
      return id in heads ? heads[id] : HEAD;
    });
    const headMerged = vi.fn(async (wt: string, sha: string) => (holds[wt.slice('/wt/'.length)] ?? [SHA_A]).includes(sha));
    const completeMerged = vi.fn((id: string, n: number, rev: number) => completeMergedTask(ledger, id, n, rev));
    const r = rig({
      worktreeOf: async (e) => `/wt/${e.id}`,
      onFact: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      prsOfBranch,
      defaultBranchOf,
      branchOf,
      headOf,
      headMerged,
      completeMerged,
      now: () => clock.now,
      ...over,
    }, runGate);
    const emit = (f: Fact): void => {
      for (const fn of subs) fn(f);
    };
    return { ...r, emit, subs, clock, heads, branchOf, prsOfBranch, defaultBranchOf, headOf, headMerged, completeMerged };
  }
  const B1 = `${REPO} wmux/task-1`;

  it('no gate in the repository: the skip leaves the task open, the merge of its PR completes it as its owner, one more card and wake', async () => {
    await registerTask();
    const listed: BranchPr[] = [];
    const r = mergeRig({ [B1]: () => listed }, { 'task-1': 'wmux/task-1' }, {}, recordingRunner({ ...PASS, command: 'none', skipped: 'no_gate_command' }));
    await report();
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Gate skipped (no_gate_command): task left open']);
    const moves: string[] = [];
    ledger.onTransition((t) => moves.push(`${t.to}:${t.by.kind}`));
    listed.push(pr(2));
    r.emit(fact('pr.merged', 2));
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(row.updatedBy).toEqual({ kind: 'brain', workspaceId: 'ws-lead' });
    // The recorded skip needs no force: the merge is the row's completion.
    expect(row.completion).toEqual({ source: 'merge', pr: 2 });
    expect(row.summary).toBe('[merged: PR #2] done');
    expect(isMergeCompletion(row)).toBe(true);
    // The owner's completion a gate pass writes: the transition the worker
    // reclaim keys off.
    expect(moves).toEqual(['completed:brain']);
    expect(r.note).toHaveBeenCalledTimes(2);
    expect(r.note.mock.calls[1][2]).toBe('PR #2 merged: task completed');
    expect(r.note.mock.calls[1][4]).toBe(verifyGateFactId('task-1', row.rev));
    expect(r.note.mock.calls[1][5]).toEqual({ code: 'task.merged', args: { pr: 2 } });
    expect(r.wake).toHaveBeenCalledTimes(2);
    expect(r.wake.mock.calls[1][0]).toEqual({
      botId: BOT, workspaceId: 'ws-lead', priority: 1, threadId: 'task:task-1',
      reason: { kind: 'facts', factIds: [verifyGateFactId('task-1', row.rev)], trigger: { kind: 'task.done' } },
    });
    expect(countOpenBotWorkers(ledger.list({ openOnly: true }), BOT, () => new Set())).toEqual({ bot: 0, factory: 0 });
    // The fact again ends nothing more, and reads nothing for an ended task.
    const reads = r.prsOfBranch.mock.calls.length;
    r.emit(fact('pr.merged', 2));
    await flush();
    expect(r.prsOfBranch).toHaveBeenCalledTimes(reads);
    expect(r.note).toHaveBeenCalledTimes(2);
    expect(r.wake).toHaveBeenCalledTimes(2);
  });

  it('no recorded gate at all: the merge completes it forced, with "merged" as the reason the ledger records', async () => {
    await registerTask();
    const listed: BranchPr[] = [];
    const r = mergeRig({ [B1]: () => listed }, { 'task-1': 'wmux/task-1' }, NO_GATE);
    const reasons: Array<string | undefined> = [];
    ledger.onTransition((t) => {
      if (t.to === 'completed') reasons.push(t.forcedReason);
    });
    await report();
    await flush();
    expect(ledger.get('task-1')?.gate).toBeUndefined();
    listed.push(pr(2));
    r.emit(fact('pr.merged', 2));
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(reasons).toEqual(['merged']);
    expect(row.summary).toBe('[merged: PR #2] done [forced: merged]');
    expect(row.completion).toEqual({ source: 'merge', pr: 2 });
  });

  it('after a recorded gate failure: the merge completes it, forced', async () => {
    await registerTask();
    const listed: BranchPr[] = [];
    const r = mergeRig({ [B1]: () => listed }, { 'task-1': 'wmux/task-1' }, {}, recordingRunner({ ...PASS, exitCode: 1 }));
    await report();
    await flush();
    expect(ledger.get('task-1')?.gate?.exitCode).toBe(1);
    listed.push(pr(2));
    r.emit(fact('pr.merged', 2));
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(row.summary).toBe('[merged: PR #2] done [forced: merged]');
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Gate failed (exit 1): task left open', 'PR #2 merged: task completed']);
  });

  it('a gated repository merged while its gate runs: the merge completes it; the gate\'s later result writes nothing on the ended row and settles nothing', async () => {
    await registerTask();
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // The late result is a failure: it must not end up on the completed row.
    const late = recordingRunner({ ...PASS, exitCode: 1 });
    const runGate = vi.fn(async (input: GateRunInput) => {
      await held;
      return late(input);
    });
    const complete = vi.fn((id: string) => completeCheckedTask(ledger, id));
    const listed: BranchPr[] = [];
    const r = mergeRig({ [B1]: () => listed }, { 'task-1': 'wmux/task-1' }, { complete }, runGate);
    await report();
    await flush();
    expect(runGate).toHaveBeenCalledTimes(1);
    listed.push(pr(7));
    r.emit(fact('pr.merged', 7));
    await flush();
    const ended = ledger.get('task-1') as LedgerEntry;
    expect(ended.status).toBe('completed');
    (release as unknown as () => void)();
    await flush();
    expect(late).toHaveBeenCalledTimes(1);
    // Rev, gate and writer as the merge left them.
    expect(ledger.get('task-1')).toEqual(ended);
    expect(ended.gate).toBeUndefined();
    expect(ended.updatedBy).toEqual({ kind: 'brain', workspaceId: 'ws-lead' });
    expect(complete).not.toHaveBeenCalled();
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['PR #7 merged: task completed']);
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('a gate pass that lands first completes it; the merge after it reads and writes nothing', async () => {
    await registerTask();
    const listed: BranchPr[] = [];
    const r = mergeRig({ [B1]: () => listed }, { 'task-1': 'wmux/task-1' });
    await report();
    await flush();
    const checked = ledger.get('task-1') as LedgerEntry;
    expect(checked.status).toBe('completed');
    listed.push(pr(7));
    r.emit(fact('pr.merged', 7));
    await flush();
    expect(ledger.get('task-1')).toEqual(checked);
    expect(r.prsOfBranch).toHaveBeenCalledTimes(1); // the report's check only
    expect(r.completeMerged).not.toHaveBeenCalled();
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Task checked: gate passed, task completed']);
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('a PR merged before the report: the report ends the task at once, with no gate run and one read', async () => {
    await registerTask();
    const r = mergeRig({ [B1]: [pr(2)] }, { 'task-1': 'wmux/task-1' });
    await report();
    await flush();
    expect(ledger.get('task-1')?.status).toBe('completed');
    expect(r.prsOfBranch).toHaveBeenCalledTimes(1);
    expect(r.prsOfBranch).toHaveBeenCalledWith(REPO, 'wmux/task-1', 'main');
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['PR #2 merged: task completed']);
    expect(r.wake).toHaveBeenCalledTimes(1);
  });

  it('a reused branch: a merge into another base and a merge that does not hold the task\'s HEAD end nothing; a later merge that holds it ends it with its own number', async () => {
    await registerTask();
    // The task's HEAD is in SHA_C only (the work after SHA_B).
    const listed: BranchPr[] = [pr(4, { sha: SHA_B }), pr(3, { base: 'scratch', sha: SHA_C })];
    const r = mergeRig({ [B1]: () => listed }, { 'task-1': 'wmux/task-1' }, NO_GATE, undefined, { 'task-1': [SHA_C] });
    await report();
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    // The scratch merge holds it but is not the default branch: never asked.
    expect(r.headMerged.mock.calls).toEqual([['/wt/task-1', SHA_B]]);
    listed.unshift(pr(5, { sha: SHA_C }));
    r.emit(fact('pr.merged', 5));
    await flush();
    expect(ledger.get('task-1')?.completion).toEqual({ source: 'merge', pr: 5 });
  });

  it('a fork\'s PR from a branch of the same name, or a merge when GitHub\'s default branch cannot be read, ends nothing', async () => {
    await registerTask();
    const r = mergeRig({ [B1]: [pr(6, { cross: true })] }, { 'task-1': 'wmux/task-1' }, NO_GATE);
    await report();
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r.headMerged).not.toHaveBeenCalled();
    r.off();
    const r2 = mergeRig({ [B1]: [pr(7)] }, { 'task-1': 'wmux/task-1' }, { ...NO_GATE, defaultBranchOf: async () => { throw new Error('gh: exit 1'); } });
    r2.emit(fact('pr.merged', 7));
    await flush();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r2.completeMerged).not.toHaveBeenCalled();
  });

  it('a task is asked about on its own recorded repository, never its bot\'s current one; a task with none is never asked', async () => {
    await registerTask('old', { repoKey: 'github.com/acme/old' });
    await registerTask('none', { repoKey: null });
    // The bot's profile names acme/app now, where the branch did merge.
    const r = mergeRig({ [`${REPO} wmux/task-1`]: [pr(6)] }, { old: 'wmux/task-1', none: 'wmux/task-1' }, NO_GATE);
    await report('old');
    await report('none');
    await flush();
    expect(r.prsOfBranch.mock.calls).toEqual([['github.com/acme/old', 'wmux/task-1', 'main']]);
    r.emit(fact('pr.merged', 6));
    await flush();
    expect(ledger.get('old')?.status).toBe('review_requested');
    expect(ledger.get('none')?.status).toBe('review_requested');
    expect(r.completeMerged).not.toHaveBeenCalled();
  });

  it('a pr.closed fact, or a pr.merged on another repository, checks nothing', async () => {
    await registerTask();
    const r = mergeRig({}, { 'task-1': 'wmux/task-1' }, NO_GATE);
    await report();
    await flush();
    const reads = r.prsOfBranch.mock.calls.length;
    r.emit(fact('pr.closed', 2));
    r.emit(fact('pr.merged', 2, 'github.com/acme/elsewhere'));
    await flush();
    expect(r.prsOfBranch).toHaveBeenCalledTimes(reads);
    expect(r.wake).toHaveBeenCalledTimes(1); // the gate's own
  });

  it('a task already ended, still working, or another kind of task is untouched', async () => {
    for (const id of ['done', 'gone', 'busy']) await registerTask(id);
    await registerTask('v', { preset: 'verify' });
    await registerTask('res', { preset: 'research' });
    const branches: Record<string, string> = { done: 'b/done', gone: 'b/gone', busy: 'b/busy', v: 'b/v', res: 'b/res' };
    const merged: Record<string, BranchPr[]> = {};
    const r = mergeRig(merged, branches, { ...NO_GATE, completeResearch: async () => ({ entry: null, why: 'held open for the test' }) });
    for (const id of ['done', 'gone', 'v', 'res']) await report(id);
    await flush();
    const d = ledger.get('done') as LedgerEntry;
    expect((await ledger.update({ id: 'done', status: 'completed', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: d.rev, force: true, reason: 'by hand' })).ok).toBe(true);
    const g = ledger.get('gone') as LedgerEntry;
    expect((await ledger.update({ id: 'gone', status: 'cancelled', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: g.rev })).ok).toBe(true);
    const before = Object.fromEntries(Object.keys(branches).map((id) => [id, ledger.get(id)?.rev]));
    const wakes = r.wake.mock.calls.length;
    const reads = r.prsOfBranch.mock.calls.length;
    Object.values(branches).forEach((b, i) => { merged[`${REPO} ${b}`] = [pr(10 + i)]; });
    r.emit(fact('pr.merged', 10));
    await flush();
    for (const id of Object.keys(branches)) expect(ledger.get(id)?.rev).toBe(before[id]);
    expect(ledger.get('busy')?.status).toBe('working');
    expect(ledger.get('v')?.status).toBe('review_requested');
    expect(ledger.get('res')?.status).toBe('review_requested');
    expect(r.prsOfBranch).toHaveBeenCalledTimes(reads);
    expect(r.completeMerged).not.toHaveBeenCalled();
    expect(r.wake.mock.calls.length).toBe(wakes);
  });

  describe('at install (repo-watch never started)', () => {
    /** A report gated before a restart (a recorded skip, its card up): the
     *  install wakes it again, unless its merge ends it. */
    async function reportedBeforeRestart(): Promise<LedgerEntry> {
      await registerTask();
      await report();
      const g = await ledger.recordGate('task-1', { ...PASS, command: 'none', skipped: 'no_gate_command' }, { kind: 'system', workspaceId: 'ws-daemon' });
      if (!g.ok) throw new Error(g.message);
      return g.entry;
    }

    it('its branch merged into main with HEAD behind the merged head: one ledger write with the merge as its completion, and one wake', async () => {
      await reportedBeforeRestart();
      const writes: string[] = [];
      ledger.onTransition((t) => writes.push(`${t.to}:${t.entry.completion?.source ?? ''}`));
      const r = mergeRig({ [B1]: [pr(2, { sha: SHA_B })] }, { 'task-1': 'wmux/task-1' }, { noted: () => true }, undefined, { 'task-1': [SHA_B] });
      await flush();
      const row = ledger.get('task-1') as LedgerEntry;
      expect(writes).toEqual(['completed:merge']);
      expect(row.completion).toEqual({ source: 'merge', pr: 2 });
      expect(r.prsOfBranch).toHaveBeenCalledTimes(1);
      expect(r.runGate).not.toHaveBeenCalled();
      expect(r.note.mock.calls.map((c) => c[2])).toEqual(['PR #2 merged: task completed']);
      expect(r.wake).toHaveBeenCalledTimes(1);
      expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', row.rev)]);
    });

    it('not merged: woken again once, on its own rev', async () => {
      const before = await reportedBeforeRestart();
      const r = mergeRig({}, { 'task-1': 'wmux/task-1' }, { noted: () => true });
      await flush();
      expect(r.prsOfBranch).toHaveBeenCalledTimes(1);
      expect(ledger.get('task-1')?.status).toBe('review_requested');
      expect(r.wake).toHaveBeenCalledTimes(1);
      expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', before.rev)]);
    });

    for (const merged of [true, false]) {
      it(`the read fails: no wake then; the next sweep's read ${merged ? 'finds the merge: one completion and one wake' : 'finds none: one wake on its own rev'}`, async () => {
        const before = await reportedBeforeRestart();
        let fail = true;
        const r = mergeRig({ [B1]: () => {
          if (fail) throw new Error('gh: exit 1');
          return merged ? [pr(2)] : [];
        } }, { 'task-1': 'wmux/task-1' }, { noted: () => true, mergeSweepMs: 20 });
        await flush();
        expect(r.wake).not.toHaveBeenCalled();
        expect(ledger.get('task-1')?.status).toBe('review_requested');
        // Backing off: the sweep reads nothing until its time is up.
        const reads = r.prsOfBranch.mock.calls.length;
        await new Promise((res) => setTimeout(res, 60));
        expect(r.prsOfBranch).toHaveBeenCalledTimes(reads);
        fail = false;
        r.clock.now += mergeBackoffMs(1);
        await vi.waitFor(() => expect(r.wake).toHaveBeenCalledTimes(1), { interval: 2, timeout: 15_000 });
        await new Promise((res) => setTimeout(res, 60));
        expect(r.wake).toHaveBeenCalledTimes(1);
        const row = ledger.get('task-1') as LedgerEntry;
        if (merged) {
          expect(row.completion).toEqual({ source: 'merge', pr: 2 });
          expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', row.rev)]);
        } else {
          expect(row.status).toBe('review_requested');
          expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', before.rev)]);
        }
        r.off();
      });
    }
  });

  it('restart: a task its merge completed in the last day wakes its bot again; a summary that only reads like one does not', async () => {
    await registerTask();
    await report();
    const done = await completeMergedTask(ledger, 'task-1', 2);
    if (!done.entry) throw new Error(done.why);
    // A worker's summary with the merge words, completed by hand.
    await registerTask('task-2');
    await report('task-2');
    const row = ledger.get('task-2') as LedgerEntry;
    const fake = await ledger.update({ id: 'task-2', status: 'completed', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: row.rev, summary: '[merged: PR #999] done', force: true, reason: 'by hand' });
    if (!fake.ok) throw new Error(fake.message);
    expect(isMergeCompletion(fake.entry)).toBe(false);
    const r = rig({ allRows: () => ledger.list({}) });
    await flush();
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', done.entry.rev)]);
  });

  it('a failing repository backs off, doubling up to its cap; one read answering clears it', async () => {
    expect([1, 2, 3, 6, 7, 40].map(mergeBackoffMs)).toEqual([60_000, 120_000, 240_000, 1_920_000, 1_800_000, 1_800_000].map((ms) => Math.min(ms, MERGE_BACKOFF_MAX_MS)));
    await registerTask();
    let fail = true;
    const r = mergeRig({ [B1]: () => {
      if (fail) throw new Error('gh: exit 1');
      return [];
    } }, { 'task-1': 'wmux/task-1' }, NO_GATE);
    await report();
    await flush();
    expect(r.prsOfBranch).toHaveBeenCalledTimes(1);
    const check = async (): Promise<void> => {
      r.emit(fact('pr.merged', 99));
      await flush();
    };
    await check(); // within 1 min: not read
    expect(r.prsOfBranch).toHaveBeenCalledTimes(1);
    r.clock.now += mergeBackoffMs(1);
    await check(); // read, fails again: 2 min now
    expect(r.prsOfBranch).toHaveBeenCalledTimes(2);
    r.clock.now += mergeBackoffMs(1);
    await check();
    expect(r.prsOfBranch).toHaveBeenCalledTimes(2);
    r.clock.now += mergeBackoffMs(1);
    fail = false;
    await check(); // read, answers: no wait after it
    await check();
    expect(r.prsOfBranch).toHaveBeenCalledTimes(4);
  });

  it('a sweep tick reads at most MERGE_SWEEP_MAX tasks, the ones not read for longest first', async () => {
    const ids = Array.from({ length: MERGE_SWEEP_MAX + 5 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    for (const id of ids) {
      await registerTask(id);
      await report(id);
      await ledger.recordGate(id, { ...PASS, exitCode: 1 }, { kind: 'system', workspaceId: 'ws-daemon' });
    }
    const branches = Object.fromEntries(ids.map((id) => [id, `b/${id}`]));
    const r = mergeRig({}, branches, { noted: () => true, mergeSweepMs: 400 });
    await flush();
    // The install: one read per open report.
    expect(r.prsOfBranch).toHaveBeenCalledTimes(ids.length);
    // Past the kept answers: each tick reads what it checks.
    r.clock.now += MERGE_ANSWER_TTL_MS;
    await vi.waitFor(() => expect(r.prsOfBranch.mock.calls.length).toBeGreaterThan(ids.length), { interval: 5, timeout: 15_000 });
    await flush();
    const first = r.prsOfBranch.mock.calls.slice(ids.length).map((c) => c[1]);
    expect(first).toHaveLength(MERGE_SWEEP_MAX);
    await vi.waitFor(() => expect(r.prsOfBranch.mock.calls.length).toBeGreaterThan(ids.length + MERGE_SWEEP_MAX), { interval: 5, timeout: 15_000 });
    await flush();
    // The five the first tick left out come first; the rest of that tick's
    // twenty were answered within MERGE_ANSWER_TTL_MS, so are not read again.
    const second = r.prsOfBranch.mock.calls.slice(ids.length + MERGE_SWEEP_MAX).map((c) => c[1]);
    const left = ids.map((id) => `b/${id}`).filter((b) => !first.includes(b));
    expect(left).toHaveLength(5);
    expect(second.slice(0, 5).sort()).toEqual(left.sort());
    r.off();
  });

  it('a repository backing off holds no sweep slot: the others\' reports are checked', async () => {
    const OTHER = 'github.com/acme/other';
    const failing = Array.from({ length: MERGE_SWEEP_MAX + 1 }, (_, i) => `a${String(i).padStart(2, '0')}`);
    for (const id of failing) {
      await registerTask(id);
      await report(id);
      await ledger.recordGate(id, { ...PASS, exitCode: 1 }, { kind: 'system', workspaceId: 'ws-daemon' });
    }
    await registerTask('b00', { repoKey: OTHER });
    await report('b00');
    await ledger.recordGate('b00', { ...PASS, exitCode: 1 }, { kind: 'system', workspaceId: 'ws-daemon' });
    const branches = Object.fromEntries([...failing, 'b00'].map((id) => [id, `b/${id}`]));
    const listings = Object.fromEntries(failing.map((id) => [`${REPO} b/${id}`, () => { throw new Error('gh: exit 1'); }]));
    const r = mergeRig(listings, branches, { noted: () => true, mergeSweepMs: 50 });
    await flush();
    // The install read each report once; acme/app failed and backs off.
    const failed = r.prsOfBranch.mock.calls.filter((c) => c[0] === REPO).length;
    expect(failed).toBe(failing.length);
    expect(r.wake).toHaveBeenCalledTimes(1); // b00's own
    // Ticks skip acme/app's reports (waiting for their wake as they are):
    // the other repository's report is checked, none of acme/app's is read.
    const before = r.branchOf.mock.calls.filter((c) => c[0].id === 'b00').length;
    await vi.waitFor(() => expect(r.branchOf.mock.calls.filter((c) => c[0].id === 'b00').length).toBeGreaterThan(before + 1), { interval: 5, timeout: 15_000 });
    expect(r.prsOfBranch.mock.calls.filter((c) => c[0] === REPO)).toHaveLength(failed);
    expect(r.branchOf.mock.calls.filter((c) => c[0].id !== 'b00').length).toBe(failing.length);
    r.off();
  });

  it('twenty triggers while a check is under way make one read; a sweep within MERGE_ANSWER_TTL_MS reads nothing, one after it reads once', async () => {
    await registerTask();
    let release: ((v: BranchPr[]) => void) | null = null;
    let wait = false;
    const r = mergeRig({ [B1]: () => (wait ? new Promise<BranchPr[]>((resolve) => { release = resolve; }) : []) }, { 'task-1': 'wmux/task-1' }, { ...NO_GATE, mergeSweepMs: 30 });
    await report();
    await flush();
    const reads = r.prsOfBranch.mock.calls.length;
    wait = true;
    for (let i = 0; i < 20; i++) r.emit(fact('pr.merged', 100 + i));
    await vi.waitFor(() => expect(release).not.toBeNull(), { interval: 2, timeout: 15_000 });
    (release as unknown as (v: BranchPr[]) => void)([]);
    await flush();
    expect(r.prsOfBranch).toHaveBeenCalledTimes(reads + 1);
    wait = false;
    await new Promise((res) => setTimeout(res, 100));
    expect(r.prsOfBranch).toHaveBeenCalledTimes(reads + 1);
    r.clock.now += MERGE_ANSWER_TTL_MS;
    await vi.waitFor(() => expect(r.prsOfBranch).toHaveBeenCalledTimes(reads + 2), { interval: 2, timeout: 15_000 });
    r.off();
  });

  it('an answer for an older rev is not written to a newer report', async () => {
    await registerTask();
    let release: ((v: BranchPr[]) => void) | null = null;
    let wait = false;
    const r = mergeRig({ [B1]: () => (wait ? new Promise<BranchPr[]>((resolve) => { release = resolve; }) : []) }, { 'task-1': 'wmux/task-1' }, NO_GATE);
    await report();
    await flush();
    const checked = (ledger.get('task-1') as LedgerEntry).rev;
    wait = true;
    r.emit(fact('pr.merged', 2));
    await vi.waitFor(() => expect(release).not.toBeNull(), { interval: 2, timeout: 15_000 });
    // Sent back and reported again while that check waits on GitHub.
    const back = await ledger.update({ id: 'task-1', status: 'input_required', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: checked });
    if (!back.ok) throw new Error(back.message);
    await report();
    (release as unknown as (v: BranchPr[]) => void)([pr(2)]);
    await flush();
    expect(r.completeMerged).toHaveBeenCalledWith('task-1', 2, checked);
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('review_requested');
    expect(row.completion).toBeUndefined();
  });

  it('a HEAD that moved while the merge was checked is not completed on that answer', async () => {
    await registerTask();
    const r = mergeRig({ [B1]: [pr(2)] }, { 'task-1': 'wmux/task-1' }, NO_GATE);
    let reads = 0;
    r.headOf.mockImplementation(async () => (++reads === 1 ? HEAD : 'e'.repeat(40)));
    await report();
    await flush();
    expect(r.completeMerged).not.toHaveBeenCalled();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
  });

  it('the default branch is GitHub\'s: a repository on develop is not ended by a merge into main', async () => {
    await registerTask();
    const r = mergeRig({ [B1]: [pr(2, { base: 'main' })] }, { 'task-1': 'wmux/task-1' }, NO_GATE);
    r.defaultBranchOf.mockImplementation(async () => 'develop');
    await report();
    await flush();
    expect(r.prsOfBranch).toHaveBeenCalledWith(REPO, 'wmux/task-1', 'develop');
    expect(r.completeMerged).not.toHaveBeenCalled();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    // Read once a repository, kept.
    r.emit(fact('pr.merged', 3));
    await flush();
    expect(r.defaultBranchOf).toHaveBeenCalledTimes(1);
  });

  it('at install, a report whose worktree or default branch cannot be read is not woken; the sweep wakes it once a check answers', async () => {
    await registerTask();
    await report();
    const g = await ledger.recordGate('task-1', { ...PASS, command: 'none', skipped: 'no_gate_command' }, { kind: 'system', workspaceId: 'ws-daemon' });
    if (!g.ok) throw new Error(g.message);
    let worktree: string | null = null;
    const r = mergeRig({}, { 'task-1': 'wmux/task-1' }, { noted: () => true, mergeSweepMs: 20, worktreeOf: async () => worktree });
    await flush();
    expect(r.wake).not.toHaveBeenCalled();
    worktree = '/wt/task-1';
    await vi.waitFor(() => expect(r.wake).toHaveBeenCalledTimes(1), { interval: 2, timeout: 15_000 });
    await new Promise((res) => setTimeout(res, 60));
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', g.entry.rev)]);
    r.off();
  });

  it('reports deferred at install that stay unanswerable take at most half a tick: the other reports are still checked', async () => {
    const stuck = Array.from({ length: 25 }, (_, i) => `d${String(i).padStart(2, '0')}`);
    const normal = Array.from({ length: 5 }, (_, i) => `z${i}`);
    for (const id of [...stuck, ...normal]) {
      await registerTask(id);
      await report(id);
      await ledger.recordGate(id, { ...PASS, exitCode: 1 }, { kind: 'system', workspaceId: 'ws-daemon' });
    }
    const branches = Object.fromEntries([...stuck, ...normal].map((id) => [id, `b/${id}`]));
    // The stuck ones' worktrees never read: their checks stay 'unknown'.
    const r = mergeRig({}, branches, { noted: () => true, mergeSweepMs: 400, worktreeOf: async (e) => (e.id.startsWith('d') ? null : `/wt/${e.id}`) });
    await flush();
    // The install woke the normal reports, and deferred the stuck ones.
    expect(r.wake).toHaveBeenCalledTimes(normal.length);
    const checks = (id: string): number => r.branchOf.mock.calls.filter((c) => c[0].id === id).length;
    expect(normal.map(checks)).toEqual([1, 1, 1, 1, 1]);
    await vi.waitFor(() => expect(normal.map(checks).every((n) => n > 1)).toBe(true), { interval: 5, timeout: 15_000 });
    expect(r.wake).toHaveBeenCalledTimes(normal.length);
    r.off();
  });

  for (const merged of [false, true]) {
    it(`at install, a report not gated yet whose check cannot answer is neither gated nor woken; once it answers, ${merged ? 'its merge ends it' : 'it is gated'}: one wake`, async () => {
      await registerTask();
      await report();
      let worktree: string | null = null;
      const r = mergeRig({ [B1]: merged ? [pr(2)] : [] }, { 'task-1': 'wmux/task-1' }, { mergeSweepMs: 20, worktreeOf: async () => worktree });
      await flush();
      expect(r.runGate).not.toHaveBeenCalled();
      expect(r.note).not.toHaveBeenCalled();
      expect(r.wake).not.toHaveBeenCalled();
      worktree = '/wt/task-1';
      await vi.waitFor(() => expect(r.wake).toHaveBeenCalledTimes(1), { interval: 2, timeout: 15_000 });
      await new Promise((res) => setTimeout(res, 80));
      expect(r.wake).toHaveBeenCalledTimes(1);
      const row = ledger.get('task-1') as LedgerEntry;
      expect(row.status).toBe('completed');
      if (merged) {
        expect(row.completion).toEqual({ source: 'merge', pr: 2 });
        expect(r.runGate).not.toHaveBeenCalled();
        expect(r.note.mock.calls.map((c) => c[2])).toEqual(['PR #2 merged: task completed']);
      } else {
        expect(r.runGate).toHaveBeenCalledTimes(1);
        expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Task checked: gate passed, task completed']);
      }
      r.off();
    });
  }

  it('at install, a deferred report with no commits that the sweep later gates gets the no_changes skip, not a gate run', async () => {
    const BASE = 'b'.repeat(40);
    await registerTask();
    await report();
    let worktree: string | null = null;
    const r = mergeRig({}, { 'task-1': 'wmux/task-1' }, {
      mergeSweepMs: 20,
      worktreeOf: async () => worktree,
      taskBase: async () => BASE,
      recordNoChanges: (id, detail) => recordNoChangesGate(ledger, id, detail),
    }, undefined, { 'task-1': [BASE] });
    await flush();
    // Deferred: the check could not answer, so nothing ran and nobody was woken.
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.note).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
    worktree = '/wt/task-1';
    await vi.waitFor(() => expect(r.wake).toHaveBeenCalledTimes(1), { interval: 2, timeout: 15_000 });
    await new Promise((res) => setTimeout(res, 80));
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.runGate).not.toHaveBeenCalled();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('review_requested');
    expect(row.gate).toMatchObject({ exitCode: 0, command: 'none', skipped: 'no_changes', recordedBy: 'system' });
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Gate skipped (the task made no changes): task left open']);
    r.off();
  });

  it('nothing after the unsubscribe: no sweep, no live fact, and a check under way writes nothing', async () => {
    // A report whose gate failed before a restart: the install's merge check
    // (the PR is merged) waits on the branch read.
    await registerTask();
    await report();
    await ledger.recordGate('task-1', { ...PASS, exitCode: 1 }, { kind: 'system', workspaceId: 'ws-daemon' });
    let answer: ((b: string) => void) | null = null;
    const branchOf = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
    const r = mergeRig({ [B1]: [pr(2)] }, {}, { branchOf, noted: () => true, mergeSweepMs: 10 });
    await vi.waitFor(() => expect(answer).not.toBeNull(), { interval: 2, timeout: 15_000 });
    await new Promise((res) => setTimeout(res, 30));
    r.off();
    expect(r.subs.size).toBe(0);
    (answer as unknown as (b: string) => void)('wmux/task-1');
    const calls = branchOf.mock.calls.length;
    r.emit(fact('pr.merged', 3));
    await new Promise((res) => setTimeout(res, 60));
    expect(branchOf.mock.calls.length).toBe(calls);
    expect(r.completeMerged).not.toHaveBeenCalled();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
  });
});

describe('worktreeHeadMerged', () => {
  const SHA = 'e'.repeat(40);
  const fakeGit = (head: string | null, ancestor: boolean) => vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return head ? { stdout: `${head}\n`, code: 0 } : { stdout: '', code: 1 };
    return { stdout: '', code: ancestor ? 0 : 1 };
  });
  it('the merged head itself, or a HEAD behind it; not a HEAD with work after it, nor a sha that is not a commit id', async () => {
    expect(await worktreeHeadMerged(fakeGit(SHA, false), '/wt', SHA)).toBe(true);
    const behind = fakeGit('f'.repeat(40), true);
    expect(await worktreeHeadMerged(behind, '/wt', SHA)).toBe(true);
    expect(behind).toHaveBeenLastCalledWith(['merge-base', '--is-ancestor', 'HEAD', SHA], '/wt');
    expect(await worktreeHeadMerged(fakeGit('f'.repeat(40), false), '/wt', SHA)).toBe(false);
    expect(await worktreeHeadMerged(fakeGit(null, true), '/wt', SHA)).toBe(false);
    const never = fakeGit(SHA, true);
    expect(await worktreeHeadMerged(never, '/wt', '--output=x')).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });
});

describe('completeMergedTask', () => {
  it('completes only a reported bot code task, as its owner, with the merge as its completion', async () => {
    await register('a');
    expect(await completeMergedTask(ledger, 'a', 3)).toEqual({ entry: null, why: 'the task moved to working' });
    await report('a');
    const done = await completeMergedTask(ledger, 'a', 3);
    expect(done.entry?.status).toBe('completed');
    expect(done.entry?.updatedBy).toEqual({ kind: 'brain', workspaceId: 'ws-lead' });
    expect(done.entry?.completion).toEqual({ source: 'merge', pr: 3 });
    expect(done.entry?.summary?.startsWith(mergedMark(3))).toBe(true);
    await register('v', 'verify');
    await report('v');
    expect((await completeMergedTask(ledger, 'v', 3)).entry).toBeNull();
    expect((await completeMergedTask(ledger, 'missing', 3)).entry).toBeNull();
  });

  it('retries once on a stale rev, then gives up', async () => {
    await register('a');
    await report('a');
    const real = ledger;
    let stale = 1;
    const flaky = {
      get: (id: string) => real.get(id),
      update: vi.fn(async (input: Parameters<TaskLedger['update']>[0]) => (stale-- > 0
        ? { ok: false as const, error: 'stale_rev' as const, message: 'moved' }
        : real.update(input))),
    };
    expect((await completeMergedTask(flaky, 'a', 3)).entry?.status).toBe('completed');
    expect(flaky.update).toHaveBeenCalledTimes(2);
    await register('b');
    await report('b');
    const always = { get: (id: string) => real.get(id), update: vi.fn(async () => ({ ok: false as const, error: 'stale_rev' as const, message: 'moved' })) };
    expect(await completeMergedTask(always, 'b', 3)).toEqual({ entry: null, why: 'the task kept changing' });
    expect(always.update).toHaveBeenCalledTimes(2);
    expect(real.get('b')?.status).toBe('review_requested');
  });
});

// A task with no commits beyond the commit it started from (an operational
// task: call an API, read a log) is not gated: a gate there grades the base,
// and a pass completed tasks whose own report said they failed.
describe('a task with no commits beyond its base', () => {
  const BASE = 'b'.repeat(40);
  /** The rig with the no-changes ports: `ahead` says whether the worktree's
   *  HEAD has commits beyond the base (headMerged answers the opposite). */
  function noChangeRig(opts: { base?: string | null; ahead?: boolean; headMerged?: TaskGatePorts['headMerged'] } = {}, runGate = recordingRunner(PASS)) {
    const taskBase = vi.fn<NonNullable<TaskGatePorts['taskBase']>>(async () => (opts.base === undefined ? BASE : opts.base));
    const headMerged = vi.fn<NonNullable<TaskGatePorts['headMerged']>>(opts.headMerged ?? (async () => !(opts.ahead ?? false)));
    const recordNoChanges = vi.fn((taskId: string, detail: string) => recordNoChangesGate(ledger, taskId, detail, () => 7));
    const r = rig({ taskBase, headMerged, recordNoChanges }, runGate);
    return { ...r, taskBase, headMerged, recordNoChanges };
  }

  it('no commits, a passing gate command: the gate never runs, the task is not completed, a no_changes skip is recorded, one card and one wake', async () => {
    await register();
    const r = noChangeRig();
    await report();
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.taskBase).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }), '/wt/task');
    expect(r.headMerged).toHaveBeenCalledWith('/wt/task', BASE);
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('review_requested');
    expect(row.gate).toEqual({ exitCode: 0, tail: noChangesDetail(BASE), at: 7, command: 'none', skipped: 'no_changes', recordedBy: 'system' });
    expect(row.updatedBy.kind).toBe('system');
    expect(r.note).toHaveBeenCalledTimes(1);
    const [, , title, body, key, notice] = r.note.mock.calls[0];
    expect(title).toBe('Gate skipped (the task made no changes): task left open');
    expect(body).toBe(noChangesDetail(BASE));
    expect(key).toBe(verifyGateFactId('task-1', row.rev));
    expect(notice).toEqual({ code: 'gate.skipped', args: { reason: 'no_changes' } });
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(r.wake.mock.calls[0][0].reason.factIds).toEqual([verifyGateFactId('task-1', row.rev)]);
  });

  it('the bot then settles it failed from the report', async () => {
    await register();
    noChangeRig();
    await report();
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    const r = await ledger.update({ id: 'task-1', status: 'failed', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: row.rev, summary: 'the API call failed (WebException)' });
    expect(r.ok).toBe(true);
    expect(ledger.get('task-1')?.status).toBe('failed');
  });

  it('or settles it completed, unforced (a bot cannot force), on the recorded skip', async () => {
    await register();
    noChangeRig();
    await report();
    await flush();
    const row = ledger.get('task-1') as LedgerEntry;
    const r = await ledger.update({ id: 'task-1', status: 'completed', actor: { kind: 'brain', workspaceId: 'ws-lead' }, expectedRev: row.rev });
    expect(r.ok).toBe(true);
    const done = ledger.get('task-1') as LedgerEntry;
    expect(done.status).toBe('completed');
    expect(done.summary).toBe('done'); // no [forced: …]
    expect(done.gate?.skipped).toBe('no_changes');
  });

  it('a task with commits beyond its base is gated and completed on a pass, as before', async () => {
    await register();
    const r = noChangeRig({ ahead: true });
    await report();
    await flush();
    expect(r.headMerged).toHaveBeenCalledWith('/wt/task', BASE);
    expect(r.runGate).toHaveBeenCalledTimes(1);
    expect(r.recordNoChanges).not.toHaveBeenCalled();
    const row = ledger.get('task-1') as LedgerEntry;
    expect(row.status).toBe('completed');
    expect(row.gate?.skipped).toBeUndefined();
    expect(r.note.mock.calls.map((c) => c[2])).toEqual(['Task checked: gate passed, task completed']);
  });

  it('base unknown (no recorded base, or the comparison fails): the gate runs as before', async () => {
    await register('a');
    await register('b');
    const r = noChangeRig({ base: null });
    await report('a');
    await flush();
    expect(r.headMerged).not.toHaveBeenCalled();
    expect(r.runGate).toHaveBeenCalledTimes(1);
    expect(ledger.get('a')?.status).toBe('completed');
    r.off();
    const thrown = noChangeRig({ headMerged: async () => { throw new Error('git is gone'); } });
    await report('b');
    await flush();
    expect(thrown.runGate).toHaveBeenCalledTimes(1);
    expect(thrown.recordNoChanges).not.toHaveBeenCalled();
    expect(ledger.get('b')?.status).toBe('completed');
  });

  it('without the no-changes ports every report is gated, as before', async () => {
    await register();
    const r = rig({ headMerged: async () => true });
    await report();
    await flush();
    expect(r.runGate).toHaveBeenCalledTimes(1);
    expect(ledger.get('task-1')?.status).toBe('completed');
  });

  it('restart: a recorded no_changes skip is not gated again, only woken', async () => {
    await register();
    const first = noChangeRig();
    await report();
    await flush();
    first.off();
    const r = noChangeRig();
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.recordNoChanges).not.toHaveBeenCalled();
    expect(r.wake).toHaveBeenCalledTimes(1);
    expect(ledger.get('task-1')?.status).toBe('review_requested');
  });

  it('a skip that did not land in the ledger says so; the task stays open', async () => {
    await register();
    const r = rig({ taskBase: async () => BASE, headMerged: async () => true, recordNoChanges: async () => false });
    await report();
    await flush();
    expect(r.runGate).not.toHaveBeenCalled();
    expect(ledger.get('task-1')?.status).toBe('review_requested');
    expect(ledger.get('task-1')?.gate).toBeUndefined();
    expect(r.note.mock.calls[0][3]).toContain('NOT recorded');
  });

  it('recordNoChangesGate records only on a reported row', async () => {
    await register();
    expect(await recordNoChangesGate(ledger, 'task-1', 'x')).toBe(false);
    expect(await recordNoChangesGate(ledger, 'missing', 'x')).toBe(false);
    expect(ledger.get('task-1')?.gate).toBeUndefined();
  });
});

describe('taskBaseFromStamp', () => {
  const row = (checkout?: boolean): LedgerEntry => ({
    id: 't', dispatch: { origin: { kind: 'bot', botId: BOT }, ...(checkout ? { checkout: { sha: 'a'.repeat(40), detached: true as const } } : {}) },
  } as LedgerEntry);
  it('reads the base fan-out stamped beside the worktree; null when absent, malformed, or a detached checkout', async () => {
    const worktree = path.join(dir, 'wt', 'task');
    const meta = path.join(dir, 'wt', '.meta', 'task');
    fs.mkdirSync(meta, { recursive: true });
    expect(await taskBaseFromStamp(row(), worktree)).toBeNull();
    fs.writeFileSync(path.join(meta, 'task.json'), JSON.stringify({ taskId: 't', title: 't', createdAt: 1, baseOid: 'd'.repeat(40) }));
    expect(await taskBaseFromStamp(row(), worktree)).toBe('d'.repeat(40));
    expect(await taskBaseFromStamp(row(true), worktree)).toBeNull();
    fs.writeFileSync(path.join(meta, 'task.json'), JSON.stringify({ taskId: 't', title: 't', createdAt: 1, baseOid: 'HEAD' }));
    expect(await taskBaseFromStamp(row(), worktree)).toBeNull();
    fs.writeFileSync(path.join(meta, 'task.json'), 'not json');
    expect(await taskBaseFromStamp(row(), worktree)).toBeNull();
  });
});

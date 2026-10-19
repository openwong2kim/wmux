// The factory wiring: the trigger cursor (replay after a crash, no history on
// a first start), task facts kept from the trigger engine (one wake per bot
// task transition, none for a task no bot started), runtime hooks as facts,
// interrupted turns held for the rooms module, the running wake as the rooms
// read it, trust, and the phone's message to the HQ bot.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotProfile, BotRole } from '../../../shared/bot';
import type { Fact } from '../../../shared/facts';
import type { LedgerEntry, LedgerStatus } from '../../../shared/ledger';
import type { LedgerTransition } from '../../../daemon/ledger/TaskLedger';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { DEFAULT_FACTORY_SETTINGS, type FactorySettings } from '../../../shared/factorySettings';
import { WAKE_LIMITS } from '../../../shared/wake';
import {
  TriggerCursor,
  botTaskStoppedWaiting,
  bufferedBotHooks,
  factFromBotHook,
  factoryPhoneMessage,
  factoryPhoneMessageSaved,
  factoryTrust,
  isBotOwnedTaskFact,
  isTaskLifecycleFact,
  ownerLoginTarget,
  resolveFactsFrom,
  routedFactLog,
  runningWakeOf,
  stopTaskWorker,
  taskWakeHandoff,
  threadTail,
  WorkerStopPendingError,
  wakeImagesOf,
} from '../factoryWiring';
import { RoomAttachmentStore } from '../roomAttachments';
import { setWorkerResumePorts } from '../workerReclaim';
import { createFactLog, type FactLog } from '../factLog';
import { WAKE_RECORD_RETAIN_MS, WakeQueue, latestOwnerWakeThread, setWakeQueue, wakeQueuePath } from '../wakeQueue';
import { TriggerEngine } from '../triggerEngine';
import { humanRunId, postHumanMessage } from '../humanMessage';
import { __resetRedactedSecretsForTesting, setRedactedSecrets } from '../secretRedaction';
import { typedApprovalSourceAllowed } from '../approvals';
import { defaultTriggers } from '../roleDefaults';
import { RoomWriter, writeFactCards } from '../roomWriter';
import { startFactIngest } from '../factIngest';
import { installBotFanoutWake } from '../../deck/fanoutCallerNotify';
import { installVerifyGate, isVerifyReport } from '../verifyPreset';
import { __resetBotHooksForTesting, emitBotHook, onBotHook, type BotHookEvent } from '../botHooks';

let dir = '';
let log: FactLog;
const queues: WakeQueue[] = [];
const newQueue = (): WakeQueue => {
  const q = new WakeQueue(wakeQueuePath(dir), { isBotEnabled: () => true });
  queues.push(q);
  return q;
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp3a-wiring-'));
  log = createFactLog(path.join(dir, 'factory'), { log: () => undefined });
  log.start();
  __resetBotHooksForTesting();
});
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.flush().catch(() => undefined)));
  log.dispose();
  setWakeQueue(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function bot(id: string, role: BotRole, over: Partial<BotProfile> = {}): BotProfile {
  return {
    version: 1, id, workspaceId: 'ws-1', role, name: role, engine: { kind: 'claude-sdk' }, triggers: defaultTriggers(role),
    budget: { maxTurnsPerHour: 9, maxTurnsPerDay: 9, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
    repo: { repoKey: 'github.com/o/r', repoPath: '/repo' }, enabled: true, createdAt: 0, updatedAt: 0, ...over,
  };
}
const dirOf = (bots: BotProfile[]) => ({ listEnabled: () => bots.filter((b) => b.enabled), get: (id: string) => bots.find((b) => b.id === id) ?? null });
const taskDone = (taskId: string, ws = 'ws-1') => ({ kind: 'task.done' as const, at: Date.now(), workspaceId: ws, ref: { taskId }, payload: {} });

describe('trigger cursor', () => {
  // The cursor's own mechanics, apart from which kinds the engine is handed
  // (task facts are not: see below).
  const everyFact = (): boolean => true;

  it('a first start routes no history; later facts move the cursor, and a restart replays only what came after it', () => {
    log.append(taskDone('old'));
    const cursor = new TriggerCursor(path.join(dir, 'factory', 'trigger-cursor.json'), 60_000);
    const seen: string[] = [];
    const off = routedFactLog(log, cursor, everyFact).subscribe((f) => seen.push(f.ref?.taskId ?? ''));
    expect(seen).toEqual([]);
    log.append(taskDone('live'));
    expect(seen).toEqual(['live']);
    off();
    cursor.flush();
    // Appended while nothing routed (the app was down / crashed).
    log.append(taskDone('missed-1'));
    log.append(taskDone('missed-2'));
    const again: string[] = [];
    const off2 = routedFactLog(log, new TriggerCursor(path.join(dir, 'factory', 'trigger-cursor.json')), everyFact).subscribe((f) => again.push(f.ref?.taskId ?? ''));
    expect(again).toEqual(['missed-1', 'missed-2']);
    log.append(taskDone('next'));
    expect(again).toEqual(['missed-1', 'missed-2', 'next']);
    off2();
  });

  it('an idle first start keeps its baseline: facts appended before the next start are routed then', () => {
    log.append(taskDone('history'));
    const file = path.join(dir, 'factory', 'trigger-cursor.json');
    const off = routedFactLog(log, new TriggerCursor(file, 60_000), everyFact).subscribe(() => undefined);
    off();
    log.append(taskDone('while-down'));
    const seen: string[] = [];
    routedFactLog(log, new TriggerCursor(file), everyFact).subscribe((f) => seen.push(f.ref?.taskId ?? ''));
    expect(seen).toEqual(['while-down']);
  });

  it('a cursor ahead of the log (another data dir) starts at the newest fact', () => {
    log.append(taskDone('a'));
    const seen: string[] = [];
    routedFactLog(log, { load: () => 999, mark: () => undefined }, everyFact).subscribe((f) => seen.push(f.ref?.taskId ?? ''));
    expect(seen).toEqual([]);
  });

  it('an unreadable cursor file counts as none', () => {
    const file = path.join(dir, 'factory', 'trigger-cursor.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":2,"seq":"x"}');
    expect(new TriggerCursor(file).load()).toBeNull();
  });

  it('no task fact is handed to the trigger engine, the owner\'s or a bot\'s, but each moves the cursor', () => {
    const marks: number[] = [];
    const seen: Fact[] = [];
    routedFactLog(log, { load: () => null, mark: (s) => marks.push(s) }).subscribe((f) => seen.push(f));
    const owned = log.append({ ...taskDone('t-bot'), ref: { taskId: 't-bot', botId: 'bot-0000000a' } });
    const human = log.append(taskDone('t-human'));
    const asks = log.append({ kind: 'task.input_required', at: Date.now(), workspaceId: 'ws-1', ref: { taskId: 't-human-2' }, payload: {} });
    // Other kinds still pass.
    const refused = log.append({ kind: 'merge.refused', at: Date.now(), workspaceId: 'ws-1', repoKey: 'github.com/o/r', ref: { pr: 3, headSha: 'a'.repeat(40) }, payload: {} });
    expect(seen.map((f) => f.id)).toEqual([refused?.id]);
    expect(marks).toEqual([owned?.seq, human?.seq, asks?.seq, refused?.seq]);
    expect(isBotOwnedTaskFact(owned as Fact)).toBe(true);
    expect(isBotOwnedTaskFact(human as Fact)).toBe(false);
    expect(isTaskLifecycleFact(human as Fact)).toBe(true);
    expect(isTaskLifecycleFact(refused as Fact)).toBe(false);
    expect(isBotOwnedTaskFact({ ...(human as Fact), kind: 'verdict.recorded', ref: { botId: 'bot-0000000a' } })).toBe(false);
  });

  it('a restart replays no task fact either: only the other kinds appended while down reach the engine', () => {
    const file = path.join(dir, 'factory', 'trigger-cursor.json');
    const cursor = new TriggerCursor(file, 60_000);
    routedFactLog(log, cursor).subscribe(() => undefined)();
    cursor.flush();
    // Appended while nothing routed (the app was down).
    log.append(taskDone('t-human'));
    log.append({ ...taskDone('t-bot'), ref: { taskId: 't-bot', botId: 'bot-0000000a' } });
    const refused = log.append({ kind: 'merge.refused', at: Date.now(), workspaceId: 'ws-1', repoKey: 'github.com/o/r', ref: { pr: 4, headSha: 'b'.repeat(40) }, payload: {} });
    const marks: number[] = [];
    const seen: Fact[] = [];
    routedFactLog(log, { load: () => new TriggerCursor(file).load(), mark: (s) => marks.push(s) }).subscribe((f) => seen.push(f));
    expect(seen.map((f) => f.id)).toEqual([refused?.id]);
    expect(marks.at(-1)).toBe(refused?.seq);
  });
});

describe('gap 4: one wake per bot task transition', () => {
  function ledger() {
    const fns = new Set<(t: LedgerTransition) => void>();
    return {
      instance: { onTransition: (fn: (t: LedgerTransition) => void) => { fns.add(fn); return () => fns.delete(fn); } } as unknown as TaskLedger,
      sub: (fn: (t: LedgerTransition) => void) => { fns.add(fn); return () => { fns.delete(fn); }; },
      fire: (t: LedgerTransition) => { for (const fn of [...fns]) fn(t); },
    };
  }
  const entry = (status: LedgerStatus, rev: number, botId: string | null): LedgerEntry => ({
    schemaVersion: 1, id: 'wtask-9', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-1', title: 'verify #3', status, rev,
    updatedAt: Date.now(), updatedBy: { kind: 'worker', workspaceId: 'ws-task' },
    ...(botId ? { dispatch: { origin: { kind: 'bot', botId }, preset: 'verify' } } : {}),
  });

  it('the fan-out path wakes the bot that started the task once, in the task thread; the lead in the same workspace does not wake', () => {
    const verifier = bot('bot-0000000v', 'verifier');
    // The lead's default triggers include task.done / task.failed / task.input_required.
    const lead = bot('bot-0000000l', 'lead');
    const bots = dirOf([verifier, lead]);
    const queue = newQueue();
    const engine = new TriggerEngine({ factLog: routedFactLog(log, { load: () => null, mark: () => undefined }), wakes: queue, bots });
    engine.start();
    const l = ledger();
    const ingest = startFactIngest(log, { onLedgerTransition: l.sub });
    const offWake = installBotFanoutWake({ enqueue: (input) => queue.enqueue(input) }, l.instance);

    l.fire({ entry: entry('review_requested', 3, verifier.id), from: 'working', to: 'review_requested', by: { kind: 'worker', workspaceId: 'ws-task' } });
    const live = queue.list({ states: ['queued'] });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ botId: verifier.id, threadId: 'task:wtask-9', priority: 1 });
    // The fact is still written (rooms show it), naming the bot.
    const facts = log.readSince('0').facts;
    expect(facts.map((f) => [f.kind, f.ref?.botId])).toEqual([['task.done', verifier.id]]);

    // The bot ran that wake. A bounce and a second done wakes it once more.
    queue.start(live[0].id);
    queue.finish(live[0].id);
    l.fire({ entry: entry('working', 4, verifier.id), from: 'review_requested', to: 'working', by: { kind: 'brain', workspaceId: 'ws-1' } });
    l.fire({ entry: entry('review_requested', 5, verifier.id), from: 'working', to: 'review_requested', by: { kind: 'worker', workspaceId: 'ws-task' } });
    expect(queue.list({ states: ['queued'] }).filter((i) => i.botId === verifier.id)).toHaveLength(1);
    expect(queue.list().filter((i) => i.botId === verifier.id && i.state !== 'dropped')).toHaveLength(2);
    expect(queue.list({ states: ['queued'] }).filter((i) => i.botId === lead.id)).toHaveLength(0);

    // A task no bot started is the owner's: it wakes no bot, the lead's
    // task.* triggers included.
    const human = { ...entry('failed', 1, null), id: 'wtask-h' };
    l.fire({ entry: human, from: 'working', to: 'failed', by: { kind: 'worker', workspaceId: 'ws-task' } });
    expect(queue.list({ states: ['queued'] }).filter((i) => i.botId === lead.id)).toEqual([]);

    offWake();
    ingest.dispose();
    engine.dispose();
  });
});

describe('a task\'s facts wake only the bot that started it', () => {
  // Two leads in one workspace: each carries the lead's task.* triggers.
  const botA = (): BotProfile => bot('bot-0000000a', 'lead');
  const botB = (): BotProfile => bot('bot-0000000b', 'lead');
  const row = (id: string, status: LedgerStatus, rev: number, origin: { kind: string; botId?: string }): LedgerEntry => ({
    schemaVersion: 1, id, taskWorkspaceId: `ws-${id}`, ownerWorkspaceId: 'ws-1', title: `g: ${id}`, status, rev,
    updatedAt: Date.now(), updatedBy: { kind: 'system', workspaceId: 'ws-1' }, dispatch: { origin },
  });
  function wired(bots: BotProfile[]) {
    const fns = new Set<(t: LedgerTransition) => void>();
    const instance = { onTransition: (fn: (t: LedgerTransition) => void) => { fns.add(fn); return () => fns.delete(fn); }, list: () => [] } as unknown as TaskLedger;
    const queue = newQueue();
    const directory = dirOf(bots);
    const engine = new TriggerEngine({ factLog: routedFactLog(log, { load: () => null, mark: () => undefined }), wakes: queue, bots: directory });
    engine.start();
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    const offCards = log.subscribe((f) => { writeFactCards(writer, f, directory); });
    const ingest = startFactIngest(log, { onLedgerTransition: (fn) => { fns.add(fn); return () => { fns.delete(fn); }; } });
    const offWake = installBotFanoutWake({ enqueue: (input) => queue.enqueue(input) }, instance);
    return {
      queue, writer, directory,
      fire: (t: LedgerTransition): void => { for (const fn of [...fns]) fn(t); },
      live: () => queue.list().filter((i) => i.state !== 'dropped'),
      dispose: () => { offWake(); ingest.dispose(); offCards(); engine.dispose(); },
    };
  }

  it('the owner\'s GUI fan-out: a task that needs input wakes no bot; its card still shows in the task thread', () => {
    const w = wired([botA(), botB()]);
    for (const id of ['wtask-g1', 'wtask-g2', 'wtask-g3']) {
      w.fire({ entry: row(id, 'input_required', 3, { kind: 'gui' }), from: 'working', to: 'input_required', by: { kind: 'system', workspaceId: 'ws-1' } });
    }
    expect(log.readSince('0').facts.map((f) => [f.kind, f.ref?.botId])).toEqual([
      ['task.input_required', undefined], ['task.input_required', undefined], ['task.input_required', undefined],
    ]);
    expect(w.live()).toEqual([]);
    expect(w.writer.read('ws-1').cards.map((c) => [c.kind, c.threadId])).toEqual([
      ['fact', 'task:wtask-g1'], ['fact', 'task:wtask-g2'], ['fact', 'task:wtask-g3'],
    ]);
    // Its end, too.
    w.fire({ entry: row('wtask-g1', 'failed', 4, { kind: 'gui' }), from: 'input_required', to: 'failed', by: { kind: 'system', workspaceId: 'ws-1' } });
    expect(w.live()).toEqual([]);
    w.dispose();
  });

  it('bot A\'s task wakes A, in the task thread; bot B of the same workspace does not wake', () => {
    const a = botA();
    const b = botB();
    const w = wired([a, b]);
    w.fire({ entry: row('wtask-a1', 'input_required', 3, { kind: 'bot', botId: a.id }), from: 'working', to: 'input_required', by: { kind: 'system', workspaceId: 'ws-1' } });
    expect(w.live()).toMatchObject([{ botId: a.id, threadId: 'task:wtask-a1', reason: { kind: 'facts', factIds: ['task.input_required:wtask-a1@3'] } }]);
    w.fire({ entry: row('wtask-a1', 'failed', 4, { kind: 'bot', botId: a.id }), from: 'input_required', to: 'failed', by: { kind: 'worker', workspaceId: 'ws-wtask-a1' } });
    expect(w.live().every((i) => i.botId === a.id)).toBe(true);
    expect(w.live().flatMap((i) => (i.reason.kind === 'facts' ? i.reason.factIds : []))).toEqual(['task.input_required:wtask-a1@3', 'task.failed:wtask-a1@4']);
    expect(w.live().filter((i) => i.botId === b.id)).toEqual([]);
    w.dispose();
  });

  it('the owner mentioning a bot in an owner task\'s thread still wakes that bot, and only it', () => {
    const a = botA();
    const b = botB();
    const w = wired([a, b]);
    w.fire({ entry: row('wtask-g1', 'input_required', 3, { kind: 'gui' }), from: 'working', to: 'input_required', by: { kind: 'system', workspaceId: 'ws-1' } });
    expect(w.live()).toEqual([]);
    const r = postHumanMessage(w.writer, { factLog: log, wakes: w.queue, bots: w.directory }, {
      workspaceId: 'ws-1', threadId: 'task:wtask-g1', title: 'Restart g1', mentions: [b.id], clientPostId: 'cp-g1', source: 'desktop',
    });
    expect(r).toMatchObject({ ok: true, addressee: { botId: b.id } });
    expect(w.live()).toMatchObject([{ botId: b.id, threadId: 'task:wtask-g1', reason: { kind: 'human' } }]);
    w.dispose();
  });
});

describe('a bot task reports in the thread of the wake that started it', () => {
  const row = (status: LedgerStatus, rev: number, dispatch: LedgerEntry['dispatch']): LedgerEntry => ({
    schemaVersion: 1, id: 'wtask-r', taskWorkspaceId: 'ws-r', ownerWorkspaceId: 'ws-1', title: 'repro #21', status, rev,
    updatedAt: Date.now(), updatedBy: { kind: 'worker', workspaceId: 'ws-r' }, ...(dispatch ? { dispatch } : {}),
  });

  it('a task\'s moves wake the bot in the recorded thread, its card lands there and does not close it; no thread → task:<id>', () => {
    const fns = new Set<(t: LedgerTransition) => void>();
    const instance = { onTransition: (fn: (t: LedgerTransition) => void) => { fns.add(fn); return () => fns.delete(fn); } } as unknown as TaskLedger;
    const fire = (t: LedgerTransition): void => { for (const fn of [...fns]) fn(t); };
    const queue = newQueue();
    const triage = bot('bot-0000000t', 'triage');
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    const offCards = log.subscribe((f) => { writeFactCards(writer, f, dirOf([triage])); });
    const ingest = startFactIngest(log, { onLedgerTransition: (fn) => { fns.add(fn); return () => { fns.delete(fn); }; } });
    const offWake = installBotFanoutWake({ enqueue: (input) => queue.enqueue(input) }, instance);

    const issue = 'issue:github.com/o/r#21';
    fire({ entry: row('review_requested', 2, { origin: { kind: 'bot', botId: triage.id }, preset: 'repro', threadId: issue }), from: 'working', to: 'review_requested', by: { kind: 'worker', workspaceId: 'ws-r' } });
    // The report itself wakes the bot from the system gate (taskGate.ts), not here.
    expect(queue.list({ states: ['queued'] })).toEqual([]);
    const cards = writer.read('ws-1').cards;
    expect(cards).toMatchObject([{ threadId: issue, kind: 'fact' }]);
    expect(cards[0].closes).toBeUndefined();
    fire({ entry: row('input_required', 3, { origin: { kind: 'bot', botId: triage.id }, preset: 'repro', threadId: issue }), from: 'review_requested', to: 'input_required', by: { kind: 'brain', workspaceId: 'ws-1' } });
    expect(queue.list({ states: ['queued'] })).toMatchObject([{ botId: triage.id, threadId: issue, reason: { factIds: ['task.input_required:wtask-r@3'] } }]);

    // A row persisted before the thread was recorded falls back to the task's own thread.
    const old = { ...row('failed', 3, { origin: { kind: 'bot', botId: triage.id }, preset: 'repro' }), id: 'wtask-o' };
    fire({ entry: old, from: 'working', to: 'failed', by: { kind: 'worker', workspaceId: 'ws-r' } });
    expect(queue.list({ states: ['queued'] }).map((i) => i.threadId)).toEqual([issue, 'task:wtask-o']);
    expect(writer.read('ws-1').cards.map((c) => c.threadId)).toEqual([issue, issue, 'task:wtask-o']);

    offWake();
    ingest.dispose();
    offCards();
  });

  it('the verify gate wakes the verifier and writes its gate card in the PR thread, live and on the restart catch-up', async () => {
    const fns = new Set<(t: LedgerTransition) => void>();
    const queue = newQueue();
    const verifierBot = bot('bot-0000000v', 'verifier');
    const notes: string[] = [];
    const pr = 'pr:github.com/o/r#7';
    const dispatch = { origin: { kind: 'bot', botId: verifierBot.id }, preset: 'verify', checkout: { sha: 'a'.repeat(40), detached: true as const }, threadId: pr };
    const gated = { ...row('review_requested', 4, dispatch), id: 'wtask-g', gate: { exitCode: 0, tail: '', at: 1, command: 'npm test', recordedBy: 'system' as const } };
    const offGate = installVerifyGate({
      onTransition: (fn) => { fns.add(fn as (t: LedgerTransition) => void); return () => fns.delete(fn as (t: LedgerTransition) => void); },
      ledgerRow: () => null,
      openRows: () => [gated],
      bot: () => verifierBot,
      worktreeOf: async () => '/wt',
      baseRef: async () => 'origin/main',
      runGate: async (input) => ({ ok: true, status: 'completed', taskId: input.taskId, recorded: true, result: { exitCode: 0, tail: '', at: 1, command: 'npm test', recordedBy: 'system' } }),
      wake: (input) => queue.enqueue(input),
      note: (_ws, threadId) => { notes.push(threadId); },
    });
    // Restart catch-up: a gated verify task re-queues its verifier wake in the PR thread.
    expect(queue.list({ states: ['queued'] })).toMatchObject([{ threadId: pr, reason: { factIds: ['task.gated:wtask-g@4'] } }]);
    for (const fn of [...fns]) fn({ entry: row('review_requested', 2, dispatch), from: 'working', to: 'review_requested', by: { kind: 'worker', workspaceId: 'ws-r' } });
    await vi.waitFor(() => expect(notes).toEqual([pr]), { timeout: 10_000 });
    // Both gates' wakes are for one verifier in one thread: still queued, they
    // ride one wake there.
    expect(queue.list({ states: ['queued'] })).toMatchObject([{ threadId: pr, reason: { factIds: ['task.gated:wtask-g@4', 'task.gated:wtask-r@2'] } }]);
    offGate();
  });
});

describe('gap 4: a verify task report wakes its verifier once, from the verify gate', () => {
  it('the fan-out path stands aside for a verify report; the gate wakes once after the gate is recorded', async () => {
    const fns = new Set<(t: LedgerTransition) => void>();
    const instance = { onTransition: (fn: (t: LedgerTransition) => void) => { fns.add(fn); return () => fns.delete(fn); } } as unknown as TaskLedger;
    const queue = newQueue();
    const verifierBot = bot('bot-0000000v', 'verifier');
    const offWake = installBotFanoutWake({ enqueue: (input) => queue.enqueue(input), wokenElsewhere: (t) => isVerifyReport(t.entry, t.to) }, instance);
    const offGate = installVerifyGate({
      onTransition: (fn) => { fns.add(fn as (t: LedgerTransition) => void); return () => fns.delete(fn as (t: LedgerTransition) => void); },
      ledgerRow: () => null,
      bot: () => verifierBot,
      worktreeOf: async () => '/wt',
      baseRef: async () => 'origin/main',
      runGate: async (input) => ({ ok: true, status: 'completed', taskId: input.taskId, recorded: true, result: { exitCode: 0, tail: '', at: 1, command: 'npm test', recordedBy: 'system' } }),
      wake: (input) => queue.enqueue(input),
    });
    const entry: LedgerEntry = {
      schemaVersion: 1, id: 'wtask-v', taskWorkspaceId: 'ws-v', ownerWorkspaceId: 'ws-1', title: 'verify', status: 'review_requested', rev: 2,
      updatedAt: Date.now(), updatedBy: { kind: 'worker', workspaceId: 'ws-v' },
      dispatch: { origin: { kind: 'bot', botId: verifierBot.id }, preset: 'verify', checkout: { sha: 'a'.repeat(40), detached: true } },
    };
    for (const fn of [...fns]) fn({ entry, from: 'working', to: 'review_requested', by: { kind: 'worker', workspaceId: 'ws-v' } });
    await vi.waitFor(() => expect(queue.list({ states: ['queued'] })).toHaveLength(1), { timeout: 10_000 });
    await new Promise((r) => setImmediate(r));
    expect(queue.list({ states: ['queued'] })).toMatchObject([{ botId: verifierBot.id, threadId: 'task:wtask-v', reason: { factIds: ['task.gated:wtask-v@2'] } }]);
    // A verify task that fails (not a report) still wakes through the fan-out path.
    for (const fn of [...fns]) fn({ entry: { ...entry, status: 'failed', rev: 3 }, from: 'working', to: 'failed', by: { kind: 'worker', workspaceId: 'ws-v' } });
    expect(queue.list({ states: ['queued'] }).map((i) => i.reason.kind === 'facts' ? i.reason.factIds : [])).toEqual([['task.gated:wtask-v@2'], ['task.failed:wtask-v@3']]);
    offWake();
    offGate();
  });
});

describe('runtime hooks', () => {
  it('budget refusals and parked bots become facts with the bot as actor; an interrupted turn does not', () => {
    const at = 5_000_000;
    expect(factFromBotHook({ type: 'bot.budget_exhausted', botId: 'bot-1', workspaceId: 'ws-1', reason: 'turns_hour', wakeId: 'w-1', at }))
      .toMatchObject({ kind: 'bot.budget_exhausted', workspaceId: 'ws-1', ref: { botId: 'bot-1' }, actor: { kind: 'bot', id: 'bot-1' }, payload: { reason: 'turns_hour', wakeId: 'w-1' } });
    expect(factFromBotHook({ type: 'bot.budget_exhausted', botId: 'bot-1', workspaceId: 'ws-1', reason: 'turns_hour', until: at + 60_000, at })?.payload)
      .toEqual({ reason: 'turns_hour', until: at + 60_000 });
    // A park carries when it began: its dedupe key is per park.
    expect(factFromBotHook({ type: 'bot.budget_exhausted', botId: 'bot-1', workspaceId: 'ws-1', reason: 'turns_hour', parkedAt: at, at })?.payload)
      .toEqual({ reason: 'turns_hour', parkedAt: at });
    expect(factFromBotHook({ type: 'bot.error', botId: 'bot-1', workspaceId: 'ws-1', message: 'x'.repeat(900), at })?.payload.message).toHaveLength(500);
    expect(factFromBotHook({ type: 'wake.interrupted', botId: 'bot-1', workspaceId: 'ws-1', wakeId: 'w-1', at })).toBeNull();
    expect(log.append(factFromBotHook({ type: 'bot.error', botId: 'bot-1', workspaceId: 'ws-1', message: 'boom', at }) as never)).not.toBeNull();
  });

  it('turns interrupted before the rooms module subscribes are replayed to it once, then live events flow', () => {
    const hooks = bufferedBotHooks(onBotHook);
    const interrupted: BotHookEvent = { type: 'wake.interrupted', botId: 'bot-1', workspaceId: 'ws-1', wakeId: 'w-1', at: 1 };
    emitBotHook(interrupted);
    emitBotHook({ type: 'bot.error', botId: 'bot-1', workspaceId: 'ws-1', message: 'x', at: 2 });
    const got: string[] = [];
    hooks.subscribe((ev) => got.push(ev.type));
    expect(got).toEqual(['wake.interrupted']);
    emitBotHook(interrupted);
    expect(got).toEqual(['wake.interrupted', 'wake.interrupted']);
    const late: string[] = [];
    hooks.subscribe((ev) => late.push(ev.type));
    expect(late).toEqual([]);
    hooks.dispose();
  });
});

describe('lookups the runtime and rooms read', () => {
  it('facts by id, and a thread tail with its truncated flag', () => {
    const a = log.append(taskDone('a'));
    log.append(taskDone('b'));
    expect(resolveFactsFrom(log, [a?.id ?? '', 'missing']).map((f) => f.id)).toEqual([a?.id]);
    expect(resolveFactsFrom(null, ['x'])).toEqual([]);
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    for (let i = 0; i < 5; i++) writer.append({ workspaceId: 'ws-1', threadId: 'task:t', kind: 'fact', actor: { kind: 'system' }, title: `c${i}` });
    writer.append({ workspaceId: 'ws-1', kind: 'fact', actor: { kind: 'system' }, title: 'general' });
    const tail = threadTail(writer, 'ws-1', 'task:t', 3);
    expect(tail?.cards.map((c) => c.title)).toEqual(['c2', 'c3', 'c4']);
    expect(tail?.truncated).toBe(true);
    expect(threadTail(writer, 'ws-1', 'task:t', 12)?.truncated).toBe(false);
    expect(threadTail(null, 'ws-1', 'task:t', 3)).toBeNull();
  });

  it('the running wake: id, a 1-based attempt that is the same for the whole turn, and its handoff', () => {
    const queue = newQueue();
    setWakeQueue(queue);
    const item = queue.enqueue({ botId: 'bot-1', workspaceId: 'ws-1', reason: { kind: 'handoff', handoffId: 'h-1' }, priority: 1 });
    expect(runningWakeOf('bot-1')).toBeNull();
    queue.start(item?.id ?? '');
    expect(runningWakeOf('bot-1')).toEqual({ wakeId: item?.id, attempt: 1, handoffId: 'h-1', reasonKind: 'handoff' });
    expect(runningWakeOf('bot-1')).toEqual({ wakeId: item?.id, attempt: 1, handoffId: 'h-1', reasonKind: 'handoff' });
    queue.retry(item?.id ?? '');
    queue.start(item?.id ?? '');
    expect(runningWakeOf('bot-1')?.attempt).toBe(2);
    // A mention carries its handoff; an owner message its run.
    const mention = queue.enqueue({ botId: 'bot-2', workspaceId: 'ws-1', reason: { kind: 'mention', cardId: 'c-1', handoffId: 'h-2', fromBotId: 'bot-0000000a' }, priority: 1 });
    queue.start(mention?.id ?? '');
    expect(runningWakeOf('bot-2')).toEqual({ wakeId: mention?.id, attempt: 1, handoffId: 'h-2', reasonKind: 'mention' });
    const human = queue.enqueue({ botId: 'bot-3', workspaceId: 'ws-1', reason: { kind: 'human', text: 'Hi', source: 'desktop', runId: 'run-c-1', room: true }, priority: 0 });
    queue.start(human?.id ?? '');
    // An owner-message wake names the owner card its run was started from.
    expect(runningWakeOf('bot-3')).toEqual({ wakeId: human?.id, attempt: 1, runId: 'run-c-1', reasonKind: 'human', ownerCardId: 'c-1' });
    // A wake about one task names it (a question asked in it is about it).
    const task = queue.enqueue({ botId: 'bot-4', workspaceId: 'ws-1', reason: { kind: 'facts', factIds: ['task.input_required:wtask-7@2'], trigger: { kind: 'task.input_required' } }, priority: 1 });
    queue.start(task?.id ?? '');
    expect(runningWakeOf('bot-4')).toEqual({ wakeId: task?.id, attempt: 1, reasonKind: 'facts', taskId: 'wtask-7' });
    const two = queue.enqueue({ botId: 'bot-5', workspaceId: 'ws-1', reason: { kind: 'facts', factIds: ['task.done:wtask-1@2', 'task.done:wtask-2@2'], trigger: { kind: 'task.done' } }, priority: 1 });
    queue.start(two?.id ?? '');
    expect(runningWakeOf('bot-5')?.taskId).toBeUndefined();
  });

  it('a task wake answers the handoff all its tasks were started for; mixed or missing ones answer none', () => {
    const rows: Record<string, { dispatch?: { origin: { kind: string }; handoffId?: string } }> = {
      'wtask-1': { dispatch: { origin: { kind: 'bot' }, handoffId: 'h-a' } },
      'wtask-2': { dispatch: { origin: { kind: 'bot' }, handoffId: 'h-a' } },
      'wtask-3': { dispatch: { origin: { kind: 'bot' }, handoffId: 'h-b' } },
      'wtask-4': { dispatch: { origin: { kind: 'bot' } } },
    };
    const row = (id: string) => (rows[id] ?? null) as never;
    const facts = (...ids: string[]) => ({ kind: 'facts' as const, factIds: ids, trigger: { kind: 'task.done' as const } });
    expect(taskWakeHandoff(facts('task.done:wtask-1@2'), row)).toBe('h-a');
    expect(taskWakeHandoff(facts('task.done:wtask-1@2', 'task.done:wtask-2@3', 'f-other'), row)).toBe('h-a');
    expect(taskWakeHandoff(facts('task.done:wtask-1@2', 'task.done:wtask-3@2'), row)).toBeNull();
    expect(taskWakeHandoff(facts('task.done:wtask-1@2', 'task.done:wtask-4@2'), row)).toBeNull();
    expect(taskWakeHandoff(facts('task.done:wtask-gone@2'), row)).toBeNull();
    expect(taskWakeHandoff(facts('f-1'), row)).toBeNull();
    expect(taskWakeHandoff({ kind: 'handoff', handoffId: 'h-a' }, row)).toBeNull();
    expect(taskWakeHandoff(facts('task.done:wtask-1@2'), () => { throw new Error('x'); })).toBeNull();
  });

  it('the thread of the owner\'s latest words to a bot: its newest owner-message wake that was not dropped', () => {
    let t = 1;
    const queue = new WakeQueue(path.join(dir, 'wq-owner.json'), { now: () => t });
    queues.push(queue);
    setWakeQueue(queue);
    expect(latestOwnerWakeThread('bot-1')).toBeNull();
    queue.enqueue({ botId: 'bot-1', workspaceId: 'ws-1', reason: { kind: 'human', text: 'a', source: 'desktop', clientMessageId: 'm1' }, priority: 0, threadId: 'pr:github.com/o/r#1' });
    t = 2;
    queue.enqueue({ botId: 'bot-1', workspaceId: 'ws-1', reason: { kind: 'human', text: 'b', source: 'desktop', clientMessageId: 'm2' }, priority: 0 });
    t = 3;
    queue.enqueue({ botId: 'bot-1', workspaceId: 'ws-1', reason: { kind: 'handoff', handoffId: 'h-1' }, priority: 1, threadId: 'task:x' });
    expect(latestOwnerWakeThread('bot-1')).toBe('general');
    expect(latestOwnerWakeThread('bot-2')).toBeNull();
  });
});

describe('trust', () => {
  const settings = (over: Partial<FactorySettings> = {}) => () => ({ ...DEFAULT_FACTORY_SETTINGS, trustedAuthors: ['alice'], ...over });
  it('the owner login counts unless the Verifier is off for the owner\'s PRs', () => {
    expect(factoryTrust(settings(), () => 'me').ownerLogin()).toBe('me');
    expect(factoryTrust(settings({ verifierOnOwnerPrs: false }), () => 'me').ownerLogin()).toBeNull();
    expect(factoryTrust(settings(), () => null).trustedAuthors()).toEqual(['alice']);
  });
  it('gh is asked on the host of a bot repo, in that repo', () => {
    expect(ownerLoginTarget([{ repo: { repoKey: 'ghe.example.com/o/r', repoPath: '/w/r' } }])).toEqual({ host: 'ghe.example.com', cwd: '/w/r' });
    expect(ownerLoginTarget([]).host).toBe('github.com');
  });
});

describe('phone → HQ bot', () => {
  const moa = bot('bot-000000aa', 'moa', { workspaceId: 'ws-hq', repo: undefined });
  function deps(over: { enabled?: boolean; bots?: BotProfile[] } = {}) {
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    const queue = newQueue();
    return {
      writer,
      queue,
      d: {
        settings: () => ({ ...DEFAULT_FACTORY_SETTINGS, enabled: over.enabled ?? true, hqWorkspaceId: 'ws-hq' }),
        writer: () => writer,
        ports: () => ({ factLog: log, wakes: queue, bots: dirOf(over.bots ?? [moa]) }),
      },
    };
  }
  const payload = { clientMessageId: 'm-1', text: 'What is blocked today?', actor: 'device:abc' };

  it('a queue that takes no wake is a retryable busy; the retry of the same message queues its wake once', () => {
    const { d, writer, queue } = deps();
    let full = true;
    const wakes = { enqueue: (input: Parameters<typeof queue.enqueue>[0]) => (full ? null : queue.enqueue(input)) };
    const dd = { ...d, ports: () => ({ ...d.ports(), wakes }) };
    expect(factoryPhoneMessage(payload, dd)).toEqual({ ok: false, code: 'busy' });
    // Still full: still busy, never a duplicate (nothing was queued).
    expect(factoryPhoneMessage(payload, dd)).toEqual({ ok: false, code: 'busy' });
    expect(writer.read('ws-hq').cards).toHaveLength(1);
    full = false;
    expect(factoryPhoneMessage(payload, dd)).toEqual({ ok: true, accepted: true, queued: true });
    // A later retry answers the same queued wake; none is added.
    expect(factoryPhoneMessage(payload, dd)).toEqual({ ok: true, accepted: true, queued: true });
    expect(queue.list({ states: ['queued'] })).toHaveLength(1);
    expect(writer.read('ws-hq').cards).toHaveLength(1);
  });

  it('a message to an HQ bot whose queue is at the cap is still queued (bounded over-cap reserve)', () => {
    const { d, queue } = deps();
    for (let i = 0; i < WAKE_LIMITS.PER_BOT_QUEUE_CAP; i++) queue.enqueue({ botId: moa.id, workspaceId: 'ws-hq', reason: { kind: 'manual', by: 'human' }, priority: 1 });
    expect(factoryPhoneMessage(payload, d)).toEqual({ ok: true, accepted: true, queued: true });
    expect(queue.list({ states: ['queued'] }).filter((i) => i.reason.kind === 'human')).toHaveLength(1);
  });

  it('off: null (the daemon takes the Moa path)', () => {
    expect(factoryPhoneMessage(payload, deps({ enabled: false }).d)).toBeNull();
  });

  it('rooms or the wake queue not started yet: a retryable busy', () => {
    const { d } = deps();
    expect(factoryPhoneMessage(payload, { ...d, writer: () => null })).toEqual({ ok: false, code: 'busy' });
  });

  it('no enabled HQ bot: hq_missing', () => {
    expect(factoryPhoneMessage(payload, deps({ bots: [] }).d)).toEqual({ ok: false, code: 'hq_missing' });
  });

  it('on: a human card in the HQ bot\'s 1:1 thread, a directed fact and one priority-0 phone wake pinned there; a retry queues nothing more', () => {
    const { d, writer, queue } = deps();
    expect(factoryPhoneMessage(payload, d)).toEqual({ ok: true, accepted: true, queued: true });
    const cards = writer.read('ws-hq').cards;
    expect(cards).toMatchObject([{ kind: 'human', threadId: `dm:${moa.id}`, title: 'What is blocked today?', refs: { botId: moa.id } }]);
    expect(queue.list({ states: ['queued'] })).toMatchObject([{ botId: moa.id, priority: 0, threadId: `dm:${moa.id}`, reason: { kind: 'human', source: 'phone' } }]);
    expect(log.readSince('0').facts).toMatchObject([{ kind: 'human.message', ref: { botId: moa.id }, payload: { source: 'phone' } }]);
    // A retry is the same queued wake, not a second one.
    expect(factoryPhoneMessage(payload, d)).toEqual({ ok: true, accepted: true, queued: true });
    expect(queue.list({ states: ['queued'] })).toHaveLength(1);
    // Another caller with the same message id is its own message.
    expect(factoryPhoneMessage({ ...payload, actor: 'device:other' }, d)).toMatchObject({ ok: true, queued: true });
  });

  it('a phone message longer than a card wakes the bot with the whole message, on a first send and on a retry', () => {
    const long = `${'x'.repeat(8192)} Do not merge or push.`;
    const { d, writer, queue } = deps();
    expect(factoryPhoneMessage({ ...payload, text: long }, d)).toEqual({ ok: true, accepted: true, queued: true });
    expect(writer.read('ws-hq').cards[0].body).toHaveLength(8192);
    expect(queue.list({ states: ['queued'] }).map((i) => (i.reason as { text: string }).text)).toEqual([long]);

    const r = deps();
    let full = true;
    const wakes = { enqueue: (input: Parameters<typeof r.queue.enqueue>[0]) => (full ? null : r.queue.enqueue(input)) };
    const dd = { ...r.d, ports: () => ({ ...r.d.ports(), wakes }) };
    const msg = { ...payload, clientMessageId: 'm-long', text: long };
    expect(factoryPhoneMessage(msg, dd)).toEqual({ ok: false, code: 'busy' });
    full = false;
    expect(factoryPhoneMessage(msg, dd)).toEqual({ ok: true, accepted: true, queued: true });
    expect(r.queue.list({ states: ['queued'] }).map((i) => (i.reason as { text: string }).text)).toEqual([long]);
  });

  it('a long phone message is processed whole and shortened last: card, fact and wake, on a first send and on its retry', () => {
    const VALUE = 'zQ9vT2mW8rL4nX6pB1cY3hJ5kD7fG0sE9uA2wR4t';
    setRedactedSecrets([{ name: 'K', value: VALUE }]);
    try {
      // VALUE across the title cap (200), the fact's text cap (3000) and the body cap (8192).
      const at = [180, 2980, 8170];
      let text = '';
      for (const i of at) text += 'a'.repeat(i - text.length) + VALUE;
      text += 'b'.repeat(100);
      const { d, writer, queue } = deps();
      const msg = { ...payload, clientMessageId: 'm-whole', text };
      expect(factoryPhoneMessage(msg, d)).toEqual({ ok: true, accepted: true, queued: true });
      const [card] = writer.read('ws-hq').cards;
      expect(card.title).toBe('a'.repeat(180) + '[secret:K]' + 'a'.repeat(10));
      expect(card.body?.split('[secret:K]')).toHaveLength(4);
      // The same message again is its retry, not a reused id.
      expect(factoryPhoneMessage(msg, d)).toEqual({ ok: true, accepted: true, queued: true });
      const seen = JSON.stringify([card, log.readSince('0').facts, queue.list({})])
        + (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
      expect(seen).not.toContain(VALUE.slice(0, 20));
      expect(seen).not.toContain(VALUE.slice(20));
    } finally {
      __resetRedactedSecretsForTesting();
    }
  });

  it('the card a phone message leaves tells typed approval the operator from a paired device', () => {
    const { d, writer } = deps();
    factoryPhoneMessage(payload, d);
    factoryPhoneMessage({ ...payload, clientMessageId: 'm-2', actor: 'operator' }, d);
    const [device, operator] = writer.read('ws-hq').cards;
    expect(typedApprovalSourceAllowed(device)).toBe(false);
    expect(typedApprovalSourceAllowed(operator)).toBe(true);
  });

  it('answers once the wake is on disk; a failed write is a retryable busy and the retry wakes the bot once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { d, writer, queue } = deps();
    let failing = true;
    const flush = vi.fn(async () => {
      if (failing) throw new Error('disk full');
      await queue.flush();
    });
    const wakes = { enqueue: (input: Parameters<typeof queue.enqueue>[0]) => queue.enqueue(input), flush };
    const dd = { ...d, ports: () => ({ ...d.ports(), wakes }) };
    expect(await factoryPhoneMessageSaved(payload, dd)).toEqual({ ok: false, code: 'busy' });
    failing = false;
    expect(await factoryPhoneMessageSaved(payload, dd)).toEqual({ ok: true, accepted: true, queued: true });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(queue.list({ states: ['queued'] })).toHaveLength(1);
    expect(writer.read('ws-hq').cards).toHaveLength(1);
    // A refusal never waits on the disk.
    expect(await factoryPhoneMessageSaved(payload, deps({ bots: [] }).d)).toEqual({ ok: false, code: 'hq_missing' });
  });
});

describe('phone → one conversation (workspaceId + threadId)', () => {
  const lead = bot('bot-000000bb', 'lead');
  const triage = bot('bot-000000cc', 'triage', { createdAt: 1 });
  const off = bot('bot-000000dd', 'verifier', { enabled: false, createdAt: 2 });
  const group = { id: 'grp-0000abcd', workspaceId: 'ws-1', name: 'Crew', memberIds: [lead.id, triage.id], threadId: 'group:grp-0000abcd' as const, createdAt: 0, updatedAt: 0 };
  const idle = { id: 'grp-0000dead', workspaceId: 'ws-1', name: 'Idle', memberIds: [off.id], threadId: 'group:grp-0000dead' as const, createdAt: 0, updatedAt: 0 };
  function deps() {
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    const queue = newQueue();
    const groups = [group, idle];
    return {
      writer,
      queue,
      d: {
        settings: () => ({ ...DEFAULT_FACTORY_SETTINGS, enabled: true }),
        writer: () => writer,
        ports: () => ({
          factLog: log, wakes: queue, bots: dirOf([lead, triage, off]),
          groups: { byThread: (ws: string, t: string | null | undefined) => groups.find((g) => g.workspaceId === ws && g.threadId === t) ?? null },
        }),
      },
    };
  }
  const msg = (threadId: string, over: Record<string, unknown> = {}) => ({ clientMessageId: 'm-1', text: 'Ship it?', actor: 'device:abc', mode: 'factory' as const, workspaceId: 'ws-1', threadId, ...over });

  it('a 1:1: a human card in that bot\'s thread and one wake for it alone', () => {
    const { d, writer, queue } = deps();
    expect(factoryPhoneMessage(msg(`dm:${triage.id}`), d)).toEqual({ ok: true, accepted: true, queued: true });
    expect(writer.read('ws-1').cards).toMatchObject([{ kind: 'human', threadId: `dm:${triage.id}`, refs: { botId: triage.id }, clientPostId: expect.stringMatching(/^phone:[0-9a-f]{16}:m-1$/) }]);
    expect(queue.list({ states: ['queued'] }).map((i) => [i.botId, i.threadId])).toEqual([[triage.id, `dm:${triage.id}`]]);
  });

  it('a group: one card in its thread and a wake for each enabled member', () => {
    const { d, writer, queue } = deps();
    expect(factoryPhoneMessage(msg(group.threadId), d)).toEqual({ ok: true, accepted: true, queued: true });
    expect(writer.read('ws-1').cards).toMatchObject([{ threadId: group.threadId, refs: { botIds: [lead.id, triage.id] } }]);
    expect(queue.list({ states: ['queued'] }).map((i) => i.botId).sort()).toEqual([lead.id, triage.id]);
  });

  it('an id whose card is up but whose wake a full queue refused is bound to that card: other text or another thread is a reused id', () => {
    const { d, writer, queue } = deps();
    let full = true;
    const wakes = { enqueue: (input: Parameters<typeof queue.enqueue>[0]) => (full ? null : queue.enqueue(input)) };
    const dd = { ...d, ports: () => ({ ...d.ports(), wakes }) };
    expect(factoryPhoneMessage(msg(`dm:${triage.id}`), dd)).toEqual({ ok: false, code: 'busy' });
    full = false;
    expect(factoryPhoneMessage(msg(`dm:${triage.id}`, { text: 'Something else' }), dd)).toEqual({ ok: false, code: 'id_reused' });
    expect(factoryPhoneMessage(msg(group.threadId), dd)).toEqual({ ok: false, code: 'id_reused' });
    expect(queue.list({ states: ['queued'] })).toEqual([]);
    // Its own retry still queues the wake, once.
    expect(factoryPhoneMessage(msg(`dm:${triage.id}`), dd)).toEqual({ ok: true, accepted: true, queued: true });
    expect(queue.list({ states: ['queued'] }).map((i) => i.botId)).toEqual([triage.id]);
    expect(writer.read('ws-1').cards).toHaveLength(1);
  });

  it('refuses before posting: a missing or switched-off bot, a missing group, a group with no bot on', () => {
    const { d, writer, queue } = deps();
    expect(factoryPhoneMessage(msg(`dm:${off.id}`), d)).toEqual({ ok: false, code: 'bot_off' });
    expect(factoryPhoneMessage(msg('dm:bot-0000ffff'), d)).toEqual({ ok: false, code: 'bot_missing' });
    // A bot of another workspace is no 1:1 of this room.
    expect(factoryPhoneMessage(msg(`dm:${lead.id}`, { workspaceId: 'ws-2' }), d)).toEqual({ ok: false, code: 'bot_missing' });
    expect(factoryPhoneMessage(msg('group:grp-00000000'), d)).toEqual({ ok: false, code: 'group_missing' });
    expect(factoryPhoneMessage(msg('general'), d)).toEqual({ ok: false, code: 'group_missing' });
    expect(factoryPhoneMessage(msg(idle.threadId), d)).toEqual({ ok: false, code: 'group_off' });
    expect(writer.read('ws-1').cards).toEqual([]);
    expect(queue.list({ states: ['queued'] })).toEqual([]);
  });
});

describe('owner message → exactly one turn', () => {
  const lead = (): BotProfile => bot('bot-0000000l', 'lead', { triggers: [...defaultTriggers('lead'), { kind: 'human.message' }] });

  it('a bot with a human.message trigger gets the direct wake only, not a second facts wake', () => {
    const l = lead();
    const queue = newQueue();
    const bots = dirOf([l]);
    const engine = new TriggerEngine({ factLog: routedFactLog(log, { load: () => null, mark: () => undefined }), wakes: queue, bots });
    engine.start();
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    const r = postHumanMessage(writer, { factLog: log, wakes: queue, bots }, { workspaceId: 'ws-1', title: 'Look at #5', clientPostId: 'cp-1', source: 'desktop' });
    expect(r).toMatchObject({ ok: true, addressee: { botId: l.id } });
    expect(log.readSince('0').facts.map((f) => f.kind)).toEqual(['human.message']);
    expect(queue.list({ botId: l.id }).filter((i) => i.state !== 'dropped')).toMatchObject([{ reason: { kind: 'human', clientMessageId: (r as { card: { id: string } }).card.id } }]);
    // The trigger engine itself refuses the directed fact.
    expect(engine.route(log.readSince('0').facts[0])).toEqual([]);
    engine.dispose();
  });

  it('desktop: a queue that takes no wake answers queue_full with the card up; the same clientPostId queues it once later', () => {
    const l = lead();
    const queue = newQueue();
    let full = true;
    const wakes = { enqueue: (input: Parameters<typeof queue.enqueue>[0]) => (full ? null : queue.enqueue(input)) };
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    const ports = { factLog: log, wakes, bots: dirOf([l]) };
    const input = { workspaceId: 'ws-1', title: 'Ship it', clientPostId: 'cp-2', source: 'desktop' as const };
    expect(postHumanMessage(writer, ports, input)).toMatchObject({ ok: false, code: 'queue_full', card: { clientPostId: 'cp-2' } });
    expect(postHumanMessage(writer, ports, input)).toMatchObject({ ok: false, code: 'queue_full' });
    full = false;
    const retried = postHumanMessage(writer, ports, input);
    expect(retried).toMatchObject({ ok: true, duplicate: true, addressee: { botId: l.id } });
    const again = postHumanMessage(writer, ports, input);
    expect(again).toMatchObject({ ok: true, duplicate: true, wakeId: (retried as { wakeId?: string }).wakeId });
    expect(writer.read('ws-1').cards).toHaveLength(1);
    expect(queue.list({ states: ['queued'] })).toHaveLength(1);
    // One fact for the one message.
    expect(log.readSince('0').facts.filter((f) => f.kind === 'human.message')).toHaveLength(1);
  });

  it('the same clientPostId in two rooms is two messages: each wakes the bot with its own text', () => {
    const l = lead();
    const queue = newQueue();
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    const ports = { factLog: log, wakes: queue, bots: dirOf([l]) };
    const a = postHumanMessage(writer, ports, { workspaceId: 'ws-1', title: 'First', clientPostId: 'message-1', toBotId: l.id, source: 'desktop' });
    const b = postHumanMessage(writer, ports, { workspaceId: 'ws-2', title: 'Second', clientPostId: 'message-1', toBotId: l.id, source: 'desktop' });
    expect(a).toMatchObject({ ok: true, wakeId: expect.any(String) });
    expect(b).toMatchObject({ ok: true, wakeId: expect.any(String) });
    expect((a as { wakeId: string }).wakeId).not.toBe((b as { wakeId: string }).wakeId);
    expect(queue.list({ botId: l.id, states: ['queued'] }).map((i) => (i.reason as { text: string }).text)).toEqual(['First', 'Second']);
  });

  it('desktop: a lead whose queue is at the cap still takes the owner\'s message', () => {
    const l = lead();
    const queue = newQueue();
    for (let i = 0; i < WAKE_LIMITS.PER_BOT_QUEUE_CAP; i++) queue.enqueue({ botId: l.id, workspaceId: 'ws-1', reason: { kind: 'manual', by: 'human' }, priority: 1 });
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    const r = postHumanMessage(writer, { factLog: log, wakes: queue, bots: dirOf([l]) }, { workspaceId: 'ws-1', title: 'Now', source: 'desktop' });
    expect(r).toMatchObject({ ok: true, wakeId: expect.any(String) });
  });

  it('desktop: a retry queues the card\'s own text, and a card older than the wake record retention queues nothing', () => {
    const l = lead();
    const queue = newQueue();
    let full = true;
    const wakes = { enqueue: (input: Parameters<typeof queue.enqueue>[0]) => (full ? null : queue.enqueue(input)) };
    const writer = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms') });
    const ports = { factLog: log, wakes, bots: dirOf([l]) };
    expect(postHumanMessage(writer, ports, { workspaceId: 'ws-1', title: 'Ship it', clientPostId: 'cp-3', source: 'desktop' })).toMatchObject({ code: 'queue_full' });
    full = false;
    expect(postHumanMessage(writer, ports, { workspaceId: 'ws-1', title: 'Delete prod', clientPostId: 'cp-3', source: 'desktop' })).toMatchObject({ ok: true, duplicate: true });
    expect(queue.list({ states: ['queued'] })).toMatchObject([{ reason: { kind: 'human', text: 'Ship it' } }]);

    const old = new RoomWriter({ dir: path.join(dir, 'factory', 'rooms-old'), now: () => Date.now() - WAKE_RECORD_RETAIN_MS - 1 });
    full = true;
    expect(postHumanMessage(old, ports, { workspaceId: 'ws-1', title: 'Long ago', clientPostId: 'cp-4', source: 'desktop' })).toMatchObject({ code: 'queue_full' });
    full = false;
    const retry = postHumanMessage(old, ports, { workspaceId: 'ws-1', title: 'Long ago', clientPostId: 'cp-4', source: 'desktop' });
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    expect(retry).not.toHaveProperty('wakeId');
    expect(queue.list({ states: ['queued'] })).toHaveLength(1);
  });
});

describe('a bot task that stops waiting for input (A5)', () => {
  it('is a move out of input_required of a bot\'s task', () => {
    const bot = { dispatch: { origin: { kind: 'bot' } } };
    expect(botTaskStoppedWaiting({ from: 'input_required', to: 'working', entry: bot })).toBe(true);
    expect(botTaskStoppedWaiting({ from: 'input_required', to: 'cancelled', entry: bot })).toBe(true);
    expect(botTaskStoppedWaiting({ from: 'working', to: 'input_required', entry: bot })).toBe(false);
    expect(botTaskStoppedWaiting({ from: 'input_required', to: 'working', entry: { dispatch: { origin: { kind: 'orchestrator' } } } })).toBe(false);
    expect(botTaskStoppedWaiting({ from: null, to: 'working', entry: bot })).toBe(false);
  });
});

describe('stopTaskWorker (a stop of a bot task\'s worker)', () => {
  const entry = { id: 'wtask-1', ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task' } as LedgerEntry;
  function daemon(stopAgent: (id: string) => unknown = () => ({ ok: true, stopped: true }), live: readonly string[] = []) {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-stop-worker-'));
    const calls: string[] = [];
    let sessions: Array<{ id: string; spawnCwd: string; agentProcessAlive?: boolean }> = [
      { id: 'own', spawnCwd: wt },
      { id: 'own-codex', spawnCwd: wt },
      { id: 'owner-terminal', spawnCwd: wt },
      { id: 'elsewhere', spawnCwd: os.tmpdir() },
    ].map((x) => (live.includes(x.id) ? { ...x, agentProcessAlive: true } : x));
    const rpc = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'task.mission.list') return { ok: true, tasks: [{ id: 'wtask-1', worktreePath: wt }] };
      if (method === 'daemon.listSessions') return sessions;
      if (method === 'session.stopAgent') {
        calls.push(`stopAgent:${String(params?.sessionId)}`);
        return stopAgent(String(params?.sessionId));
      }
      if (method === 'daemon.destroySession') {
        calls.push(`destroy:${String(params?.id)}`);
        sessions = sessions.filter((x) => x.id !== params?.id);
        return { ok: true };
      }
      throw new Error(method);
    });
    return { client: () => ({ rpc }) as never, calls, wt };
  }

  it('stops the agent tree first, then the pane, and only the task workspace\'s own panes', async () => {
    const d = daemon();
    try {
      expect(await stopTaskWorker(entry, d.client, (ws) => (ws === 'ws-task' ? ['own'] : []))).toBe(1);
      expect(d.calls).toEqual(['stopAgent:own', 'destroy:own']);
    } finally {
      fs.rmSync(d.wt, { recursive: true, force: true });
    }
  });

  it('counts only panes whose agent it stopped: a plain shell pane is closed but is no worker', async () => {
    const d = daemon(() => ({ ok: true, stopped: false }));
    try {
      expect(await stopTaskWorker(entry, d.client, () => ['own'])).toBe(0);
      expect(d.calls).toEqual(['stopAgent:own', 'destroy:own']);
    } finally {
      fs.rmSync(d.wt, { recursive: true, force: true });
    }
  });

  it('agentsOnly (a task stopped before): stops a leftover agent and keeps every pane', async () => {
    const left = daemon();
    const shell = daemon(() => ({ ok: true, stopped: false }));
    try {
      expect(await stopTaskWorker(entry, left.client, () => ['own'], { agentsOnly: true })).toBe(1);
      expect(left.calls).toEqual(['stopAgent:own']);
      // Only a plain shell is left: nothing stopped, nothing counted, the pane stays.
      expect(await stopTaskWorker(entry, shell.client, () => ['own'], { agentsOnly: true })).toBe(0);
      expect(shell.calls).toEqual(['stopAgent:own']);
    } finally {
      fs.rmSync(left.wt, { recursive: true, force: true });
      fs.rmSync(shell.wt, { recursive: true, force: true });
    }
  });

  it('an agent the claude stop does not reach (Codex): counted by the daemon\'s liveness; agentsOnly closes only its pane', async () => {
    const full = daemon(() => ({ ok: true, stopped: false }), ['own-codex']);
    const left = daemon(() => ({ ok: true, stopped: false }), ['own-codex']);
    try {
      expect(await stopTaskWorker(entry, full.client, () => ['own', 'own-codex'])).toBe(1);
      expect(full.calls.filter((c) => c.startsWith('destroy:')).sort()).toEqual(['destroy:own', 'destroy:own-codex']);
      // The re-stop: the live Codex pane is closed, the plain shell stays.
      expect(await stopTaskWorker(entry, left.client, () => ['own', 'own-codex'], { agentsOnly: true })).toBe(1);
      expect(left.calls.filter((c) => c.startsWith('destroy:'))).toEqual(['destroy:own-codex']);
    } finally {
      fs.rmSync(full.wt, { recursive: true, force: true });
      fs.rmSync(left.wt, { recursive: true, force: true });
    }
  });

  describe('a WSL worker (#2254)', () => {
    const WSL = { distribution: 'Ubuntu-24.04', user: 'me' };
    function wslDaemon(sessions0: Array<Record<string, unknown>>) {
      const calls: string[] = [];
      let sessions = sessions0;
      const rpc = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'task.mission.list') return { ok: true, tasks: [{ id: 'wtask-1', worktreePath: 'C:\\Users\\me\\.wmux\\worktrees\\r\\task-1' }] };
        if (method === 'daemon.listSessions') return sessions;
        if (method === 'session.stopAgent') {
          calls.push(`stopAgent:${String(params?.sessionId)}`);
          return { ok: false, code: 'unsupported' };
        }
        if (method === 'daemon.destroySession') {
          calls.push(`destroy:${String(params?.id)}`);
          sessions = sessions.filter((x) => x.id !== params?.id);
          return { ok: true };
        }
        throw new Error(method);
      });
      return { client: () => ({ rpc }) as never, calls };
    }
    // spawnCwd is what resolveWslCwd answered; its launch line runs; its
    // Linux agent was never attributed (agentProcessAlive unknown).
    const worker = { id: 'wsl', spawnCwd: '/mnt/c/Users/me/.wmux/worktrees/r/task-1', wslTarget: WSL, commandRunning: true };

    it('its pane, started at the Linux path of the Windows worktree, is closed and counted; task-10 is another folder', async () => {
      const d = wslDaemon([worker, { ...worker, id: 'wsl-task-10', spawnCwd: '/mnt/c/Users/me/.wmux/worktrees/r/task-10' }]);
      expect(await stopTaskWorker(entry, d.client, () => ['wsl', 'wsl-task-10'], { platform: 'win32' })).toBe(1);
      expect(d.calls).toEqual(['stopAgent:wsl', 'destroy:wsl']);
    });

    describe('a workspace tree that is not known (#2267)', () => {
      const recordOf = (named: Record<string, string>) => (id: string) => (id in named ? { taskId: named[id] } : null);
      const rejection = async (p: Promise<number>) => (await p.catch((e: unknown) => e)) as WorkerStopPendingError;
      afterEach(() => setWorkerResumePorts(null));

      it('a WSL worker its session record names as the task\'s is stopped now', async () => {
        const d = wslDaemon([worker]);
        expect(await stopTaskWorker(entry, d.client, () => null, { platform: 'win32', sessionRecordOf: recordOf({ wsl: 'wtask-1' }) })).toBe(1);
        expect(d.calls).toEqual(['stopAgent:wsl', 'destroy:wsl']);
      });

      it('a WSL pane it cannot judge is left alone; the stop is partial and says the app is still loading', async () => {
        // Another task's record, and none: neither is the task's worker.
        const d = wslDaemon([worker, { ...worker, id: 'other-task' }, { ...worker, id: 'owner-wsl' }]);
        const err = await rejection(stopTaskWorker(entry, d.client, () => null, { platform: 'win32', sessionRecordOf: recordOf({ wsl: 'wtask-1', 'other-task': 'wtask-9' }) }));
        expect(err).toBeInstanceOf(WorkerStopPendingError);
        expect(err.message).toMatch(/the app is still loading its workspaces; stop again in a moment/);
        expect(err.pendingSessionIds).toEqual(['other-task', 'owner-wsl']);
        // The identified worker was stopped, and is counted.
        expect(err.workers).toBe(1);
        expect(d.calls).toEqual(['stopAgent:wsl', 'destroy:wsl']);
      });

      it('a native worker is stopped and counted beside an unjudged WSL pane', async () => {
        const native = { id: 'native', spawnCwd: 'C:\\Users\\me\\.wmux\\worktrees\\r\\task-1', agentProcessAlive: true };
        const d = wslDaemon([native, { ...worker, id: 'owner-wsl' }]);
        const err = await rejection(stopTaskWorker(entry, d.client, () => null, { platform: 'win32', sessionRecordOf: recordOf({}) }));
        expect(err.workers).toBe(1);
        expect(err.pendingSessionIds).toEqual(['owner-wsl']);
        expect(d.calls).toEqual(['stopAgent:native', 'destroy:native']);
      });

      it('a pane only the reclaim record lists (an owner shell it took in) is not taken for the worker', async () => {
        setWorkerResumePorts({
          store: { get: (id: string) => (id === 'wtask-1' ? { taskId: 'wtask-1', sessions: [{ sessionId: 'owner-wsl', cwd: worker.spawnCwd }] } : null), all: () => [] },
        } as never);
        const d = wslDaemon([{ ...worker, id: 'owner-wsl' }]);
        const err = await rejection(stopTaskWorker(entry, d.client, () => null, { platform: 'win32', sessionRecordOf: recordOf({}) }));
        expect(err).toBeInstanceOf(WorkerStopPendingError);
        expect(d.calls).toEqual([]);
      });

      it('a WSL pane in another folder, or a plain WSL shell on an agentsOnly re-stop, does not make the stop partial', async () => {
        const elsewhere = wslDaemon([{ ...worker, id: 'wsl-task-10', spawnCwd: '/mnt/c/Users/me/.wmux/worktrees/r/task-10' }]);
        expect(await stopTaskWorker(entry, elsewhere.client, () => null, { platform: 'win32' })).toBe(0);
        expect(elsewhere.calls).toEqual([]);
        const shell = wslDaemon([{ ...worker, id: 'wsl-shell', commandRunning: false }]);
        expect(await stopTaskWorker(entry, shell.client, () => null, { agentsOnly: true, platform: 'win32' })).toBe(0);
        expect(shell.calls).toEqual([]);
      });

      it('once the tree is known: the normal path, the task workspace\'s own panes only', async () => {
        const d = wslDaemon([worker, { ...worker, id: 'owner-wsl' }]);
        expect(await stopTaskWorker(entry, d.client, (ws) => (ws === 'ws-task' ? ['wsl'] : ['owner-wsl']), { platform: 'win32', sessionRecordOf: recordOf({}) })).toBe(1);
        expect(d.calls).toEqual(['stopAgent:wsl', 'destroy:wsl']);
      });
    });

    it('agentsOnly: a leftover WSL worker is closed; a plain WSL shell and an exec unit with no agent left stay', async () => {
      const left = wslDaemon([worker]);
      expect(await stopTaskWorker(entry, left.client, () => ['wsl'], { agentsOnly: true, platform: 'win32' })).toBe(1);
      expect(left.calls).toEqual(['stopAgent:wsl', 'destroy:wsl']);
      const kept = wslDaemon([
        { ...worker, id: 'wsl-shell', commandRunning: false },
        { ...worker, id: 'wsl-fresh', commandRunning: undefined },
        { id: 'exec', spawnCwd: 'C:\\Users\\me\\.wmux\\worktrees\\r\\task-1', exec: { command: 'claude' }, agentProcessAlive: false },
      ]);
      expect(await stopTaskWorker(entry, kept.client, () => ['wsl-shell', 'wsl-fresh', 'exec'], { agentsOnly: true, platform: 'win32' })).toBe(0);
      expect(kept.calls.filter((c) => c.startsWith('destroy:'))).toEqual([]);
    });
  });

  it('an agent the daemon could not stop fails the stop and destroys nothing', async () => {
    const d = daemon(() => ({ ok: false, code: 'still_running' }));
    try {
      await expect(stopTaskWorker(entry, d.client, () => ['own'])).rejects.toThrow(/still_running/);
      expect(d.calls).toEqual(['stopAgent:own']);
    } finally {
      fs.rmSync(d.wt, { recursive: true, force: true });
    }
  });
});

describe('wakeImagesOf', () => {
  it("a human wake's owner card photos, read from the store; other wakes and cards have none", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wake-photos-'));
    try {
      const writer = new RoomWriter({ dir: path.join(d, 'rooms'), log: () => undefined });
      const store = new RoomAttachmentStore({
        root: path.join(d, 'photos'), uploadsDir: d, log: () => undefined,
        normalize: (b) => ({ data: b, width: 1, height: 1 }),
      });
      const src = path.join(d, 'a.jpg');
      fs.writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
      const imported = store.importFile('ws-1', src);
      if (!imported.ok) throw new Error('import failed');
      const posted = writer.post({ workspaceId: 'ws-1', kind: 'human', actor: { kind: 'human' }, title: 'see', attachments: [imported.attachment] });
      if (!posted.ok) throw new Error('post failed');
      const profile = { workspaceId: 'ws-1' };
      const wake = (runId: string) => ({ workspaceId: 'ws-1', reason: { kind: 'human' as const, text: 'see', source: 'phone' as const, runId } });
      expect(wakeImagesOf(writer, store, profile, wake(humanRunId(posted.card.id)))).toEqual({
        images: [{ mediaType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64') }], missing: 0,
      });
      expect(wakeImagesOf(writer, store, profile, wake('run-c-none'))).toBeNull();
      expect(wakeImagesOf(writer, store, profile, { workspaceId: 'ws-1', reason: { kind: 'manual', by: 'human' } })).toBeNull();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

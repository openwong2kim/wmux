// bot.* auth matrix (§13 rules 1-2), not_started before start, and the module
// lifecycle: start loads the stores and publishes the singletons, a wake runs
// a turn, a bot-origin task transition wakes its bot, dispose clears them.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' } }));

const ledgerMock = vi.hoisted(() => {
  type Listener = (t: unknown) => void;
  const listeners = new Set<Listener>();
  const rows = new Map<string, Record<string, unknown>>();
  return {
    listeners,
    rows,
    ledger: {
      onTransition: (l: Listener) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      get: (id: string) => rows.get(id) ?? null,
      list: () => [...rows.values()],
    },
  };
});
vi.mock('../../../deck/taskLedgerHost', () => ({ getTaskLedger: () => ledgerMock.ledger }));

import type { RpcContext } from '../../../../shared/rpc';
import type { BrainAdapter, BrainEvent } from '../../../deck/BrainAdapter';
import { registerBotRpcHandlers, botRuntimeModule, wakeOnOwnerAnswer, type SetJobPorts } from '../bot.rpc';
import { DISMISSED_ANSWER } from '../../../factory/handoffRouter';
import { WakeTaint } from '../../../factory/wakeTaint';
import type { Handoff } from '../../../../shared/handoff';
import type { ThreadId } from '../../../../shared/room';
import type { BotRuntime } from '../../../factory/BotRuntime';
import type { WakeQueue } from '../../../factory/wakeQueue';
import type { FactoryHostDeps, FactoryRouter } from '../../../factory/factoryHost';
import { BotStore, botsFilePath, getBotDirectory } from '../../../factory/botStore';
import { getWakeQueue } from '../../../factory/wakeQueue';
import { getBotRuntime } from '../../../factory/BotRuntime';
import { factorySettingsPath, getFactorySettingsStore } from '../../../factory/factorySettings';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

function captureRouter(): { router: FactoryRouter; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const router = {
    register: (method: string, handler: Handler) => handlers.set(method, handler),
    onBotRefused: () => () => undefined,
  } as unknown as FactoryRouter;
  return { router, handlers };
}

const OPERATOR: RpcContext = { origin: 'local', operator: true, firstParty: true };
const PANE: RpcContext = { origin: 'local', firstParty: true };
const botCtx = (role: 'moa' | 'verifier', botId = 'bot-0000000a'): RpcContext => ({
  origin: 'local',
  commanderWorkspace: 'ws-1',
  bot: { workspaceId: 'ws-1', botId, role },
});

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-botrpc-'));
  ledgerMock.listeners.clear();
  ledgerMock.rows.clear();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bot.* auth matrix', () => {
  it('refuses a caller that is neither the operator nor a bot, for every method', async () => {
    const { router, handlers } = captureRouter();
    registerBotRpcHandlers(router, () => null);
    for (const [method, h] of handlers) {
      expect(await h({ botId: 'bot-0000000a' }, PANE), method).toMatchObject({ ok: false, code: 'not_authorized' });
      expect(await h({ botId: 'bot-0000000a' }, undefined), method).toMatchObject({ ok: false, code: 'not_authorized' });
    }
  });

  it('every bot reads the directory and only its own status; no bot parks; operator-only methods refuse every bot', async () => {
    const { router, handlers } = captureRouter();
    registerBotRpcHandlers(router, () => null);
    const call = (m: string, p: Record<string, unknown>, ctx: RpcContext) => (handlers.get(m) as Handler)(p, ctx);
    expect(await call('bot.list', {}, botCtx('verifier'))).toMatchObject({ code: 'not_started' });
    expect(await call('bot.list', {}, botCtx('moa'))).toMatchObject({ code: 'not_started' });
    expect(await call('bot.status', { botId: 'bot-0000000b' }, botCtx('verifier'))).toMatchObject({ code: 'not_authorized' });
    expect(await call('bot.status', {}, botCtx('verifier'))).toMatchObject({ code: 'not_started' });
    expect(await call('bot.setJob', { botId: 'bot-0000000b', job: 'x' }, botCtx('moa'))).toMatchObject({ code: 'not_authorized' });
    expect(await call('bot.setJob', { job: 'x' }, botCtx('verifier'))).toMatchObject({ code: 'not_started' });
    for (const m of ['bot.create', 'bot.update', 'bot.remove', 'bot.wake', 'bot.park', 'bot.resume', 'bot.interrupt']) {
      expect(await call(m, { botId: 'bot-0000000a' }, botCtx('moa')), m).toMatchObject({ code: 'not_authorized' });
      expect(await call(m, { botId: 'bot-0000000a' }, OPERATOR), m).toMatchObject({ code: 'not_started' });
    }
  });
});

describe('bot.remove', () => {
  function rigRemove(withStop: boolean, workerStops = true) {
    const store = new BotStore(botsFilePath(dir));
    const created = store.create({ workspaceId: 'ws-1', template: 'developer', name: 'Developer' });
    if (!created.ok) throw new Error('create');
    const botId = created.bot.id;
    const order: string[] = [];
    const runtime = {
      remove: (id: string, opts: { hue?: number }) => {
        order.push('remove');
        return store.remove(id, opts);
      },
      profileChanged: (id: string) => { order.push(`off ${String(store.get(id)?.enabled)}`); },
      currentTurn: () => null,
      interrupt: () => ({ ok: false, code: 'not_running' }),
    } as unknown as BotRuntime;
    // Two open tasks: this bot's and another bot's.
    const rows = [
      { id: 'task-mine', rev: 1, status: 'working', dispatch: { origin: { kind: 'bot', botId } } },
      { id: 'task-other', rev: 1, status: 'working', dispatch: { origin: { kind: 'bot', botId: 'bot-ffffffff' } } },
    ];
    const updates: Array<{ id: string; status: string; summary?: string }> = [];
    const workersStopped: string[] = [];
    const stopPorts = withStop ? {
      runtime: () => runtime,
      botIds: () => store.list().map((b) => b.id),
      ledger: {
        list: (f: { openOnly?: boolean }) => (f.openOnly ? rows : []),
        get: (id: string) => rows.find((x) => x.id === id) ?? null,
        update: async (u: { id: string; status: string; summary?: string }) => {
          order.push(`cancel ${u.id}`);
          updates.push(u);
          const row = rows.find((x) => x.id === u.id);
          if (row) row.status = u.status;
          return { ok: true };
        },
      },
      gates: () => null,
      stopWorker: async (e: { id: string }) => {
        if (!workerStops) throw new Error('still running');
        workersStopped.push(e.id);
        return 1;
      },
      stopResumed: async () => 0,
      launchesInFlight: () => [],
      log: () => undefined,
    } : null;
    const { router, handlers } = captureRouter();
    registerBotRpcHandlers(router, () => ({ store, runtime, queue: {} as WakeQueue }), undefined, {
      stopPorts: () => stopPorts as never,
      afterRemove: async (id: string) => { order.push(`forget ${id === botId ? 'it' : id}`); },
    });
    const call = (p: Record<string, unknown>) => (handlers.get('bot.remove') as Handler)(p, OPERATOR);
    return { store, botId, order, updates, workersStopped, call };
  }

  it('stops that bot\'s work as Stop does (its tasks end "stopped by owner"), then removes it with a tombstone', async () => {
    const r = rigRemove(true);
    const stored = r.store.get(r.botId)?.hue;
    expect(stored).toEqual(expect.any(Number));
    expect(await r.call({ botId: r.botId, hue: 4 })).toMatchObject({ ok: true, botId: r.botId, stopped: { ok: true, workersStopped: 1, tasksCancelled: 1 } });
    // Off before the stop snapshots, so nothing new starts meanwhile.
    // Then its approval requests and skills are let go of (forgetRemovedBot).
    expect(r.order).toEqual(['off false', 'cancel task-mine', 'remove', 'forget it']);
    expect(r.updates).toEqual([expect.objectContaining({ id: 'task-mine', status: 'cancelled', summary: 'stopped by owner' })]);
    expect(r.workersStopped).toEqual(['task-mine']);
    expect(r.store.get(r.botId)).toBeNull();
    // Its stored slot, not the caller's.
    expect(r.store.listRemoved()).toEqual([expect.objectContaining({ id: r.botId, name: 'Developer', hue: stored })]);
  });

  it('a stop that could not stop everything keeps the bot, switched off, and says to delete again', async () => {
    const r = rigRemove(true, false);
    expect(await r.call({ botId: r.botId })).toMatchObject({ ok: false, code: 'stop_failed' });
    expect(r.store.get(r.botId)?.enabled).toBe(false);
    expect(r.order).not.toContain('remove');
    expect(r.order).not.toContain('forget it');
    expect(r.store.listRemoved()).toEqual([]);
  });

  it('refuses a bad colour slot or an unknown bot; without a stop it still removes', async () => {
    const r = rigRemove(false);
    expect(await r.call({ botId: r.botId, hue: 8 })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await r.call({ botId: 'bot-ffffffff' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await r.call({ botId: r.botId })).toMatchObject({ ok: true });
    expect(r.order).toEqual(['off false', 'remove', 'forget it']);
  });
});

describe('bot.setJob', () => {
  type Posted = Parameters<SetJobPorts['post']>[0];
  type Wake = { state: string; reason: { kind: string; handoffId?: string }; owner?: 'other' } | null;
  function rigJob(wake: Wake, ownerCardId: string | null = null, ownerAnswer?: SetJobPorts['ownerAnswer']) {
    const store = new BotStore(botsFilePath(dir));
    const created = store.create({ workspaceId: 'ws-1', name: 'Wmux Issue' });
    if (!created.ok) throw new Error('create');
    const botId = created.bot.id;
    const changed = vi.fn();
    const posted: Posted[] = [];
    const given: string[] = [];
    const runtime = { profileChanged: changed, status: () => null } as unknown as BotRuntime;
    const queue = {
      get: (id: string) => (id === 'w-run' && wake ? { id, botId: wake.owner === 'other' ? 'bot-ffffffff' : botId, state: wake.state, reason: wake.reason } : null),
    } as unknown as WakeQueue;
    const { router, handlers } = captureRouter();
    registerBotRpcHandlers(router, () => ({ store, runtime, queue }), {
      runningWakeId: () => (wake ? 'w-run' : null),
      runningThread: () => 'issue:github.com/acme/app#3',
      ownerCardId: () => ownerCardId,
      post: (c) => { posted.push(c); },
      jobGiven: (id) => { given.push(id); },
      ...(ownerAnswer ? { ownerAnswer } : {}),
    });
    const ctx: RpcContext = { origin: 'local', commanderWorkspace: 'ws-1', bot: { workspaceId: 'ws-1', botId, role: 'lead' } };
    const call = (p: Record<string, unknown>, c: RpcContext = ctx) => (handlers.get('bot.setJob') as Handler)(p, c);
    return { store, botId, changed, posted, given, call, handlers };
  }

  it('a bot sets its own job during a wake on the owner\'s words; main posts a job_changed card carrying the previous job', async () => {
    const r = rigJob({ state: 'running', reason: { kind: 'human' } });
    const res = await r.call({ job: 'Find the root cause of each issue and fix it.' });
    expect(res).toMatchObject({ ok: true, previous: null, bot: { job: 'Find the root cause of each issue and fix it.' } });
    expect(r.store.get(r.botId)?.job).toBe('Find the root cause of each issue and fix it.');
    expect(r.changed).toHaveBeenCalledWith(r.botId);
    expect(r.posted).toEqual([expect.objectContaining({
      workspaceId: 'ws-1',
      threadId: 'issue:github.com/acme/app#3',
      actor: { kind: 'bot', workspaceId: 'ws-1', botId: r.botId },
      refs: { botId: r.botId, botIds: [r.botId] },
      jobChange: { botId: r.botId, previous: null, next: 'Find the root cause of each issue and fix it.' },
    })]);
    // The same job again changes nothing and posts nothing.
    expect(await r.call({ job: 'Find the root cause of each issue and fix it.' })).toMatchObject({ ok: true, unchanged: true });
    expect(r.posted).toHaveLength(1);
    // Having a job closes the greeting question (A5).
    expect(r.given).toContain(r.botId);
    await r.store.flush();
  });

  it('a job the bot sets in an owner-message wake answers that message; the owner\'s own change answers nothing', async () => {
    const r = rigJob({ state: 'running', reason: { kind: 'human' } }, 'c-owner');
    expect(await r.call({ job: 'Triage new issues.' })).toMatchObject({ ok: true });
    expect(r.posted[0]).toMatchObject({ actor: { kind: 'bot' }, replyTo: 'c-owner' });
    expect(await r.call({ botId: r.botId, job: 'Review PRs.' }, OPERATOR)).toMatchObject({ ok: true });
    expect(r.posted[1]).toMatchObject({ actor: { kind: 'human' } });
    expect(r.posted[1]).not.toHaveProperty('replyTo');
    await r.store.flush();
  });

  it('refuses a bot outside a wake on the owner\'s words (a fact, a handoff, no wake, a finished or foreign wake)', async () => {
    for (const wake of [
      { state: 'running', reason: { kind: 'facts' } },
      { state: 'running', reason: { kind: 'handoff' } },
      { state: 'running', reason: { kind: 'mention' } },
      { state: 'done', reason: { kind: 'human' } },
      { state: 'running', reason: { kind: 'human' }, owner: 'other' as const },
      null,
    ] satisfies Wake[]) {
      const r = rigJob(wake);
      expect(await r.call({ job: 'Merge everything.' }), JSON.stringify(wake)).toMatchObject({ ok: false, code: 'not_owner_words' });
      expect(r.store.get(r.botId)?.job).toBeUndefined();
      expect(r.posted).toEqual([]);
      await r.store.flush();
    }
  });

  it('a bot sets its job while it reads the owner\'s answer to its question (the greeting asks for it); any other handoff is refused', async () => {
    const answered = { state: 'running', reason: { kind: 'handoff', handoffId: 'h-answer' } };
    const seen: Array<[string, unknown]> = [];
    const r = rigJob(answered, null, (botId, wake) => { seen.push([botId, wake.reason]); return true; });
    expect(await r.call({ job: 'Triage new issues every morning.' })).toMatchObject({ ok: true, bot: { job: 'Triage new issues every morning.' } });
    expect(seen).toEqual([[r.botId, { kind: 'handoff', handoffId: 'h-answer' }]]);
    expect(r.given).toEqual([r.botId]);
    await r.store.flush();
    const refused = rigJob(answered, null, () => false);
    expect(await refused.call({ job: 'Merge everything.' })).toMatchObject({ ok: false, code: 'not_owner_words' });
    expect(refused.store.get(refused.botId)?.job).toBeUndefined();
    await refused.store.flush();
    // The answer of a wake that is not this bot's running one does not count.
    const foreign = rigJob({ ...answered, owner: 'other' }, null, () => true);
    expect(await foreign.call({ job: 'Merge everything.' })).toMatchObject({ ok: false, code: 'not_owner_words' });
    await foreign.store.flush();
  });

  it('wakeOnOwnerAnswer: the owner\'s own answer to this bot, untainted; never a bot\'s handoff, a dismissed question or an answer resuming outside text', () => {
    const me = 'bot-0000000a';
    const base = (over: Partial<Handoff>): Handoff => ({
      version: 1, id: 'h-x', runId: 'run-x', threadId: 'dm:bot-0000000a' as ThreadId, depth: 1, hopsInRun: 1,
      from: { kind: 'human' }, to: { kind: 'bot', workspaceId: 'ws-1', botId: me }, kind: 'answer',
      attribution: { originator: { kind: 'human' }, chain: [] }, landing: 'wake',
      payload: { title: 'What should I do?', body: 'Triage new issues every morning.' }, status: 'queued', createdAt: 1, updatedAt: 1, ...over,
    });
    const records = new Map<string, Handoff>([
      ['h-ask', base({ id: 'h-ask', kind: 'ask_person', from: { kind: 'bot', workspaceId: 'ws-1', botId: me }, to: { kind: 'human' } })],
      ['h-answer', base({ id: 'h-answer', replyTo: 'h-ask' })],
      ['h-dismissed', base({ id: 'h-dismissed', replyTo: 'h-ask', payload: { title: 't', body: DISMISSED_ANSWER } })],
      ['h-other', base({ id: 'h-other', replyTo: 'h-ask', to: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-0000000b' } })],
      ['h-bot', base({ id: 'h-bot', kind: 'dispatch', from: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-0000000b' } })],
      // A question asked mid-hop on a bot's handoff (unmarked: tainted).
      ['h-hop', base({ id: 'h-hop', kind: 'dispatch', from: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-0000000b' } })],
      ['h-ask-hop', base({ id: 'h-ask-hop', kind: 'ask_person', forHop: 'h-hop', from: { kind: 'bot', workspaceId: 'ws-1', botId: me }, to: { kind: 'human' } })],
      ['h-answer-hop', base({ id: 'h-answer-hop', replyTo: 'h-ask-hop' })],
    ]);
    const handoff = (id: string) => records.get(id) ?? null;
    const taint = new WakeTaint({ facts: () => [], handoff, taskRow: () => null, runningWake: () => null });
    const on = (handoffId: string, t: WakeTaint | null = taint) => wakeOnOwnerAnswer(me, { reason: { kind: 'handoff', handoffId } }, { handoff, taint: t });
    expect(on('h-answer')).toBe(true);
    expect(on('h-dismissed')).toBe(false);
    expect(on('h-other')).toBe(false);
    expect(on('h-bot')).toBe(false);
    expect(on('h-answer-hop')).toBe(false);
    expect(on('h-missing')).toBe(false);
    // An answer whose question is gone (pruned) no longer says which hop it resumed.
    records.set('h-orphan', base({ id: 'h-orphan', replyTo: 'h-pruned' }));
    expect(on('h-orphan')).toBe(false);
    // The tracker alone refuses it too: its question pruned, the answer reads as outside text.
    const prunedTaint = new WakeTaint({ facts: () => [], handoff: (id) => (id === 'h-ask' ? null : handoff(id)), taskRow: () => null, runningWake: () => null });
    expect(wakeOnOwnerAnswer(me, { reason: { kind: 'handoff', handoffId: 'h-answer' } }, { handoff, taint: prunedTaint })).toBe(false);
    expect(on('h-answer', null)).toBe(false);
    expect(wakeOnOwnerAnswer(me, { reason: { kind: 'routine', routineId: 'r-1', dueAt: 1 } }, { handoff, taint })).toBe(false);
  });

  it('refuses another bot\'s job, a malformed or over-long job; the operator sets or clears any bot\'s, outside any wake', async () => {
    const r = rigJob(null);
    expect(await r.call({ botId: 'bot-0000000f', job: 'x' })).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(await r.call({ job: 42 })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await r.call({ botId: r.botId, job: 'x'.repeat(5000) }, OPERATOR)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await r.call({ job: 'x' }, OPERATOR)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await r.call({ botId: r.botId, job: 'Review PRs.' }, OPERATOR)).toMatchObject({ ok: true, bot: { job: 'Review PRs.' } });
    expect(r.posted[0]).toMatchObject({ actor: { kind: 'human' }, jobChange: { previous: null, next: 'Review PRs.' } });
    expect(r.posted[0].threadId).toBeUndefined();
    expect(r.given).toEqual([r.botId]);
    expect(await r.call({ botId: r.botId, job: null }, OPERATOR)).toMatchObject({ ok: true, previous: 'Review PRs.' });
    // Clearing the job gives none.
    expect(r.given).toEqual([r.botId]);
    expect(r.store.get(r.botId)?.job).toBeUndefined();
    expect(r.posted[1]).toMatchObject({ jobChange: { previous: 'Review PRs.', next: null } });
    // The owner's profile edit gives one too.
    expect(await (r.handlers.get('bot.update') as Handler)({ botId: r.botId, patch: { job: 'Triage issues.' } }, OPERATOR)).toMatchObject({ ok: true });
    expect(r.given).toEqual([r.botId, r.botId]);
    // A repository change goes through the folder, resolved as Add bot does.
    const update = r.handlers.get('bot.update') as Handler;
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'lfui-botrepo-'));
    try {
      expect(await update({ botId: r.botId, patch: { repoFolder: plain } }, OPERATOR)).toMatchObject({ ok: false, code: 'not_a_repo' });
      expect(await update({ botId: r.botId, patch: { repoFolder: plain, repo: { repoKey: 'github.com/a/b', repoPath: plain } } }, OPERATOR)).toMatchObject({ ok: false, code: 'invalid_argument' });
      expect(r.store.get(r.botId)?.repo).toBeUndefined();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    await r.store.flush();
  });
});

class OkAdapter implements BrainAdapter {
  sessionId: string | null = null;
  prompts: string[] = [];
  start(): void {
    /* nothing to prime */
  }
  async *send(text: string): AsyncIterable<BrainEvent> {
    this.prompts.push(text);
    this.sessionId = 'sess-x';
    yield { type: 'turn-end', sessionId: 'sess-x' };
  }
  interrupt(): void {
    /* turns end by themselves */
  }
  dispose(): void {
    /* nothing held */
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

describe('bot-runtime module', () => {
  it('start publishes the runtime; operator create/wake runs a turn; a bot task transition wakes the bot', async () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(factorySettingsPath(dir), JSON.stringify({ version: 1, enabled: true }));
    const { router, handlers } = captureRouter();
    const adapters: OkAdapter[] = [];
    const sent: unknown[] = [];
    const deps = {
      wmuxDir: () => dir,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (_c: string, p: unknown) => sent.push(p) } }),
    } as unknown as FactoryHostDeps;
    const mod = botRuntimeModule(router, deps, {
      engines: () => {
        const a = new OkAdapter();
        adapters.push(a);
        return { ok: true, adapter: a };
      },
    });
    const call = (m: string, p: Record<string, unknown>) => (handlers.get(m) as Handler)(p, OPERATOR);
    expect(await call('bot.list', {})).toMatchObject({ code: 'not_started' });
    await mod.start();
    expect(getBotDirectory()).not.toBeNull();
    expect(getWakeQueue()).not.toBeNull();
    // A window that listed the bots before start is told to read them again.
    expect(sent).toEqual([{ type: 'bots-changed' }]);

    const created = (await call('bot.create', { workspaceId: 'ws-1', role: 'verifier' })) as { ok: boolean; bot: { id: string } };
    expect(created.ok).toBe(true);
    const botId = created.bot.id;
    expect(await call('bot.create', { workspaceId: 'ws-1', role: 'verifier' })).toMatchObject({ ok: true });
    expect(await call('bot.wake', { botId, text: 'x', threadId: 'not a thread' })).toMatchObject({ code: 'invalid_argument' });
    expect(await call('bot.wake', { botId, text: 'ping', threadId: 'general' })).toMatchObject({ ok: true, wake: { threadId: 'general' } });
    await settle();
    expect(adapters[0].prompts[0]).toContain('ping');
    expect(await call('bot.status', { botId })).toMatchObject({ ok: true, status: { presence: 'idle', sessionId: 'sess-x' } });
    expect(sent).toContainEqual({ type: 'bots-changed' });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'bot.status' }));

    // A task this bot started asks for input → one wake for it. (Its report,
    // review_requested, wakes it from the system gate: factory/taskGate.ts.)
    ledgerMock.rows.set('task-1', { id: 'task-1', title: 'verify #12', status: 'input_required', summary: 'gate green' });
    for (const l of ledgerMock.listeners) {
      l({ entry: { id: 'task-1', rev: 2, ownerWorkspaceId: 'ws-1', dispatch: { origin: { kind: 'bot', botId } } }, from: 'working', to: 'input_required', by: { kind: 'worker' } });
    }
    // A pane-origin task wakes nobody.
    for (const l of ledgerMock.listeners) {
      l({ entry: { id: 'task-2', ownerWorkspaceId: 'ws-1', dispatch: { origin: { kind: 'pane' } } }, from: 'working', to: 'failed', by: { kind: 'worker' } });
    }
    await settle();
    expect(adapters[0].prompts).toHaveLength(2);
    expect(adapters[0].prompts[1]).toContain('task.input_required:task-1@2');
    // The same status again at a later rev is a new wake, not a duplicate.
    for (const l of ledgerMock.listeners) {
      l({ entry: { id: 'task-1', rev: 4, ownerWorkspaceId: 'ws-1', dispatch: { origin: { kind: 'bot', botId } } }, from: 'working', to: 'input_required', by: { kind: 'worker' } });
    }
    await settle();
    expect(adapters[0].prompts).toHaveLength(3);
    expect(adapters[0].prompts[1]).toContain('gate green');
    expect(adapters[0].prompts[1]).toContain('Thread: task:task-1');

    expect(await call('bot.remove', { botId })).toMatchObject({ ok: true });
    expect(await call('bot.status', { botId })).toMatchObject({ code: 'not_found' });
    await mod.dispose();
    expect(getBotRuntime()).toBeNull();
    expect(ledgerMock.listeners.size).toBe(0);
  });

  it('the factory switched off through the settings store cancels a running turn and ends its session', async () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(factorySettingsPath(dir), JSON.stringify({ version: 1, enabled: true }));
    const { router, handlers } = captureRouter();
    const disposed: boolean[] = [];
    class HangAdapter extends OkAdapter {
      // eslint-disable-next-line require-yield
      async *send(text: string): AsyncIterable<BrainEvent> {
        this.prompts.push(text);
        await new Promise<never>(() => undefined);
      }
      dispose(): void {
        disposed.push(true);
      }
    }
    const deps = { wmuxDir: () => dir, getMainWindow: () => null } as unknown as FactoryHostDeps;
    const mod = botRuntimeModule(router, deps, { engines: () => ({ ok: true, adapter: new HangAdapter() }) });
    const call = (m: string, p: Record<string, unknown>) => (handlers.get(m) as Handler)(p, OPERATOR);
    await mod.start();
    const created = (await call('bot.create', { workspaceId: 'ws-1', role: 'verifier' })) as { bot: { id: string } };
    const woke = (await call('bot.wake', { botId: created.bot.id, text: 'go' })) as { wake: { id: string } };
    await settle();
    expect(await call('bot.status', { botId: created.bot.id })).toMatchObject({ status: { presence: 'running' } });
    await getFactorySettingsStore()!.update({ enabled: false });
    await settle();
    expect(getBotRuntime()!.wakeState(woke.wake.id)).toBe('interrupted');
    expect(disposed).toEqual([true]);
    await mod.dispose();
  });

  it('creates no bot of its own: an HQ setting no longer brings a Moa', async () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(factorySettingsPath(dir), JSON.stringify({ version: 1, enabled: true, hqWorkspaceId: 'ws-hq' }));
    const { router, handlers } = captureRouter();
    const deps = { wmuxDir: () => dir, getMainWindow: () => null } as unknown as FactoryHostDeps;
    const mod = botRuntimeModule(router, deps, { engines: () => ({ ok: true, adapter: new OkAdapter() }) });
    await mod.start();
    await getFactorySettingsStore()!.update({ enabled: false });
    await getFactorySettingsStore()!.update({ enabled: true, planConsent: { version: 1, at: '2026-10-15T00:00:00.000Z' } });
    const listed = (await (handlers.get('bot.list') as Handler)({}, OPERATOR)) as { bots: unknown[] };
    expect(listed.bots).toEqual([]);
    await settle();
    await mod.dispose();
  });

  it('bot.create with greet:true queues the new bot\'s intro wake once; without it, none', async () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(factorySettingsPath(dir), JSON.stringify({ version: 1, enabled: false }));
    const { router, handlers } = captureRouter();
    const deps = { wmuxDir: () => dir, getMainWindow: () => null } as unknown as FactoryHostDeps;
    const mod = botRuntimeModule(router, deps, { engines: () => ({ ok: true, adapter: new OkAdapter() }) });
    const call = (m: string, p: Record<string, unknown>) => (handlers.get(m) as Handler)(p, OPERATOR);
    await mod.start();
    const greeted = (await call('bot.create', { workspaceId: 'ws-1', name: 'Wmux Dev', template: 'developer', greet: true })) as { bot: { id: string; template: string } };
    expect(greeted.bot.template).toBe('developer');
    const quiet = (await call('bot.create', { workspaceId: 'ws-1', name: 'Quiet' })) as { bot: { id: string } };
    expect(await call('bot.create', { workspaceId: 'ws-1', greet: 'yes' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    const reasons = (botId: string) => (getWakeQueue() as WakeQueue).list({ botId }).map((i) => i.reason.kind);
    expect(reasons(greeted.bot.id)).toEqual(['intro']);
    expect(reasons(quiet.bot.id)).toEqual([]);
    await settle();
    await mod.dispose();
  });

  it('stop (quit, before any module disposes) ends the running bot sessions', async () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(factorySettingsPath(dir), JSON.stringify({ version: 1, enabled: true }));
    const { router, handlers } = captureRouter();
    const disposed: boolean[] = [];
    class HangAdapter extends OkAdapter {
      // eslint-disable-next-line require-yield
      async *send(text: string): AsyncIterable<BrainEvent> {
        this.prompts.push(text);
        await new Promise<never>(() => undefined);
      }
      dispose(): void {
        disposed.push(true);
      }
    }
    const deps = { wmuxDir: () => dir, getMainWindow: () => null } as unknown as FactoryHostDeps;
    const mod = botRuntimeModule(router, deps, { engines: () => ({ ok: true, adapter: new HangAdapter() }) });
    const call = (m: string, p: Record<string, unknown>) => (handlers.get(m) as Handler)(p, OPERATOR);
    await mod.start();
    const created = (await call('bot.create', { workspaceId: 'ws-1', role: 'verifier' })) as { bot: { id: string } };
    await call('bot.wake', { botId: created.bot.id, text: 'go' });
    await settle();
    mod.stop();
    expect(disposed).toEqual([true]);
    await mod.dispose();
  });
});

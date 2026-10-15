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
import { registerBotRpcHandlers, botRuntimeModule, type SetJobPorts } from '../bot.rpc';
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

describe('bot.setJob', () => {
  type Posted = Parameters<SetJobPorts['post']>[0];
  type Wake = { state: string; reason: { kind: string }; owner?: 'other' } | null;
  function rigJob(wake: Wake, ownerCardId: string | null = null) {
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

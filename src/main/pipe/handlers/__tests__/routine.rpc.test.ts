// routine.* and bot.stopMyWork: who may call what, the owner's-words rule
// for setting a routine, and what a bot's lifecycle does to its routines.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, on: vi.fn() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() }, BrowserWindow: class {} }));

import type { BotBinding, BotProfile } from '../../../../shared/bot';
import type { RpcContext } from '../../../../shared/rpc';
import type { WakeItem } from '../../../../shared/wake';
import { RoutineStore, routinesPath } from '../../../factory/routines';
import { onBotLifecycle, registerRoutineHandlers, routineApprovalHost, routineMinIntervalMs, turnOnOwnerWords } from '../routine.rpc';
import { TAINTED_CONVERSATION_SAVES_NOTHING } from '../../../factory/conversationMarks';

const A = 'bot-0000000a';
const B = 'bot-0000000b';
const asBot = (botId: string): RpcContext => ({ origin: 'local', bot: { workspaceId: 'ws-1', botId, role: 'lead' } as BotBinding });
const OPERATOR: RpcContext = { origin: 'local', operator: true, firstParty: true };
const WIRE: RpcContext = { origin: 'local', externalWire: true };

let dir = '';
const stores: RoutineStore[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-w2-routine-rpc-'));
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.flush().catch(() => undefined)));
  fs.rmSync(dir, { recursive: true, force: true });
});

function profile(id: string, extra: Partial<BotProfile> = {}): BotProfile {
  return {
    version: 1, id, workspaceId: 'ws-1', role: 'lead', name: id, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerDay: 10, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 60_000 },
    enabled: true, createdAt: 1, updatedAt: 1, ...extra,
  };
}

function rig(opts: { ownerWords?: boolean; guestWake?: boolean | 'unknown'; conversationTainted?: boolean; stop?: Parameters<typeof registerRoutineHandlers>[1]['stop'] } = {}) {
  const store = new RoutineStore({
    file: routinesPath(dir),
    bots: () => ({ get: (id: string) => profile(id) }),
    wakes: () => null,
    factLog: () => null,
    rooms: () => null,
    factoryEnabled: () => true,
    log: () => undefined,
  });
  stores.push(store);
  store.load();
  const handlers = new Map<string, (raw: unknown, ctx?: RpcContext) => Promise<unknown>>();
  const keys: string[] = [];
  registerRoutineHandlers({ register: (m, h) => handlers.set(m, h as never) }, {
    store: () => store,
    ownerWords: () => opts.ownerWords ?? true,
    guestWake: () => opts.guestWake ?? false,
    conversationTainted: () => opts.conversationTainted ?? false,
    defaultKey: (botId) => {
      keys.push(botId);
      return `wake:w-${botId}:r1`;
    },
    ...(opts.stop ? { stop: opts.stop } : {}),
  });
  const call = (method: string, raw: unknown, ctx?: RpcContext) => (handlers.get(method) as (r: unknown, c?: RpcContext) => Promise<unknown>)(raw, ctx);
  return { store, call, keys };
}

const params = { title: 'Check PRs', prompt: 'Look at the open PRs.', schedule: { kind: 'interval', everyMs: 60 * 60_000 } };

describe('routine.set', () => {
  it('a bot sets its own routine in a turn on the owner\'s words; the default key makes a retried turn create one', async () => {
    const r = rig();
    const first = await r.call('routine.set', params, asBot(A)) as { ok: true; routine: { id: string; botId: string } };
    expect(first).toMatchObject({ ok: true, routine: { botId: A, workspaceId: 'ws-1' } });
    expect(await r.call('routine.set', params, asBot(A))).toEqual(first);
    expect(r.store.list(A)).toHaveLength(1);
    // The binding names the bot: a botId in the params changes nothing.
    await r.call('routine.set', { ...params, botId: B, clientRoutineId: 'k2' }, asBot(A));
    expect(r.store.list(B)).toHaveLength(0);
  });

  it('refuses the operator, a stranger, a turn not on the owner\'s words, and before start', async () => {
    const r = rig({ ownerWords: false });
    expect(await r.call('routine.set', params, OPERATOR)).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(await r.call('routine.set', params, WIRE)).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(await r.call('routine.set', params, asBot(A))).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(r.store.list()).toEqual([]);
  });

  it('refuses a turn on the owner\'s words whose wake is guest-sourced (the answer to a guest\'s question) or of unknown provenance', async () => {
    for (const g of [true, 'unknown'] as const) {
      const r = rig({ guestWake: g });
      const res = await r.call('routine.set', params, asBot(A)) as { ok: boolean; code?: string; message?: string };
      expect(res).toMatchObject({ ok: false, code: 'not_authorized' });
      expect(res.message).toContain('external guest');
      expect(r.store.list()).toEqual([]);
    }
  });

  it('a wake not known clean pauses a routine but does not resume one', async () => {
    const opts: { guestWake: boolean | 'unknown' } = { guestWake: false };
    const r = rig(opts);
    const a = await r.call('routine.set', params, asBot(A)) as { routine: { id: string } };
    for (const g of [true, 'unknown'] as const) {
      opts.guestWake = g;
      expect(await r.call('routine.pause', { routineId: a.routine.id, paused: true }, asBot(A))).toMatchObject({ ok: true, routine: { state: 'paused' } });
      expect(await r.call('routine.pause', { routineId: a.routine.id, paused: false }, asBot(A))).toMatchObject({ ok: false, code: 'not_authorized', message: expect.stringContaining('external guest') });
      expect(r.store.list(A)[0]).toMatchObject({ state: 'paused' });
    }
    opts.guestWake = false;
    expect(await r.call('routine.pause', { routineId: a.routine.id, paused: false }, asBot(A))).toMatchObject({ ok: true });
  });

  it('the owner\'s "yes" to its question, in a conversation that took in outside text, sets no routine', async () => {
    // The bot asked (ask_person); the owner answered yes: a turn on the owner's words.
    const yes = turnOnOwnerWords(A, {
      wake: () => ({ id: 'w', reason: { kind: 'handoff', handoffId: 'h-yes' } }) as WakeItem,
      handoff: (id) => ({ handoffId: id, kind: 'answer', from: 'o', title: '', body: 'yes', ownerWords: true }),
    });
    expect(yes).toBe(true);
    const r = rig({ ownerWords: yes, conversationTainted: true });
    expect(await r.call('routine.set', params, asBot(A))).toEqual({ ok: false, code: 'not_authorized', message: TAINTED_CONVERSATION_SAVES_NOTHING });
    expect(r.store.list()).toEqual([]);
    // The same answer in a clean conversation sets it.
    expect(await rig({ ownerWords: yes }).call('routine.set', params, asBot(A))).toMatchObject({ ok: true });
  });

  it('turnOnOwnerWords: the owner\'s message or answer; a closed question, a mention, facts, a plain handoff or no turn are not', () => {
    const item = (reason: WakeItem['reason']) => (() => ({ id: 'w', reason }) as WakeItem);
    const answers = (id: string) => (id === 'h-answer' ? { handoffId: id, kind: 'answer', from: 'o', title: '', body: '', ownerWords: true }
      : id === 'h-closed' ? { handoffId: id, kind: 'answer', from: 'o', title: '', body: '', ownerWords: true, dismissed: true as const }
        : { handoffId: id, kind: 'message', from: 'b', title: '', body: '' });
    expect(turnOnOwnerWords(A, { wake: item({ kind: 'human', text: 'hi', source: 'desktop' }) })).toBe(true);
    expect(turnOnOwnerWords(A, { wake: item({ kind: 'handoff', handoffId: 'h-answer' }), handoff: answers })).toBe(true);
    expect(turnOnOwnerWords(A, { wake: item({ kind: 'handoff', handoffId: 'h-msg' }), handoff: answers })).toBe(false);
    // A question closed without an answer gave no instruction.
    expect(turnOnOwnerWords(A, { wake: item({ kind: 'handoff', handoffId: 'h-closed' }), handoff: answers })).toBe(false);
    expect(turnOnOwnerWords(A, { wake: item({ kind: 'mention', cardId: 'c', handoffId: 'h-answer', fromBotId: B }), handoff: answers })).toBe(false);
    expect(turnOnOwnerWords(A, { wake: item({ kind: 'routine', routineId: 'r-x', dueAt: 1 }) })).toBe(false);
    expect(turnOnOwnerWords(A, { wake: () => null })).toBe(false);
    expect(turnOnOwnerWords(A, { wake: () => { throw new Error('x'); } })).toBe(false);
  });
});

describe('routine.list / routine.pause', () => {
  it('a bot lists its own; the operator one bot\'s or all; anyone else is refused', async () => {
    const r = rig();
    await r.call('routine.set', params, asBot(A));
    await r.call('routine.set', params, asBot(B));
    expect(await r.call('routine.list', { botId: B }, asBot(A))).toMatchObject({ ok: true, routines: [{ botId: A }] });
    expect(await r.call('routine.list', {}, OPERATOR)).toMatchObject({ ok: true, routines: [{ botId: A }, { botId: B }] });
    expect(await r.call('routine.list', { botId: B }, OPERATOR)).toMatchObject({ ok: true, routines: [{ botId: B }] });
    expect(await r.call('routine.list', { botId: 7 }, OPERATOR)).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await r.call('routine.list', {}, WIRE)).toMatchObject({ ok: false, code: 'not_authorized' });
  });

  it('a bot pauses and resumes only its own; the operator does not pause here', async () => {
    const r = rig();
    const a = await r.call('routine.set', params, asBot(A)) as { routine: { id: string } };
    expect(await r.call('routine.pause', { routineId: a.routine.id, paused: true }, asBot(B))).toMatchObject({ ok: false, code: 'not_found' });
    expect(await r.call('routine.pause', { routineId: a.routine.id, paused: true }, OPERATOR)).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(await r.call('routine.pause', { routineId: a.routine.id, paused: true }, asBot(A))).toMatchObject({ ok: true, routine: { state: 'paused', paused: { reason: 'bot' } } });
    expect(await r.call('routine.pause', { routineId: a.routine.id, paused: false }, asBot(A))).toMatchObject({ ok: true, routine: { state: 'active' } });
  });
});

describe('bot.stopMyWork', () => {
  it('a bot stops only itself; without the task ledger it pauses its routines', async () => {
    const r = rig();
    await r.call('routine.set', params, asBot(A));
    await r.call('routine.set', params, asBot(B));
    expect(await r.call('bot.stopMyWork', { botId: B }, OPERATOR)).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(await r.call('bot.stopMyWork', { botId: B }, asBot(A))).toEqual({ ok: true, workersStopped: 0, gatesCancelled: 0, routinesPaused: 1 });
    expect(r.store.list(A)[0]).toMatchObject({ state: 'paused', paused: { reason: 'stop' } });
    expect(r.store.list(B)[0]).toMatchObject({ state: 'active' });
  });

  it('with the stop ports it runs the owner\'s stop for that bot', async () => {
    const stop = vi.fn(async () => ({ ok: true, workersStopped: 2, gatesCancelled: 1, routinesPaused: 1 }));
    const r = rig({ stop });
    expect(await r.call('bot.stopMyWork', {}, asBot(A))).toEqual({ ok: true, workersStopped: 2, gatesCancelled: 1, routinesPaused: 1 });
    expect(stop).toHaveBeenCalledWith(A);
  });
});

describe('module helpers', () => {
  it('routineMinIntervalMs: a shorter floor only on an isolated instance, never below a second', () => {
    expect(routineMinIntervalMs({})).toBe(15 * 60_000);
    expect(routineMinIntervalMs({ WMUX_TEST_ROUTINE_MIN_MS: '5000' })).toBe(15 * 60_000);
    expect(routineMinIntervalMs({ WMUX_DATA_SUFFIX: '-verify-x', WMUX_TEST_ROUTINE_MIN_MS: '5000' })).toBe(5000);
    expect(routineMinIntervalMs({ WMUX_DATA_SUFFIX: '-verify-x', WMUX_TEST_ROUTINE_MIN_MS: '10' })).toBe(15 * 60_000);
    expect(routineMinIntervalMs({ WMUX_DATA_SUFFIX: '-verify-x', WMUX_TEST_ROUTINE_MIN_MS: 'soon' })).toBe(15 * 60_000);
  });

  it('onBotLifecycle: park and off pause, resume and on lift them, removal drops', async () => {
    const r = rig();
    await r.call('routine.set', params, asBot(A));
    onBotLifecycle(r.store, A, 'parked');
    expect(r.store.list(A)[0]).toMatchObject({ state: 'paused', paused: { reason: 'park' } });
    onBotLifecycle(r.store, A, 'resumed');
    expect(r.store.list(A)[0]).toMatchObject({ state: 'active' });
    onBotLifecycle(r.store, A, 'disabled');
    expect(r.store.list(A)[0]).toMatchObject({ state: 'paused', paused: { reason: 'off' } });
    // On again while Run bots is off: still paused, until the switch is on.
    onBotLifecycle(r.store, A, 'enabled', () => false);
    expect(r.store.list(A)[0]).toMatchObject({ state: 'paused' });
    onBotLifecycle(r.store, A, 'enabled', () => true);
    expect(r.store.list(A)[0]).toMatchObject({ state: 'active' });
    onBotLifecycle(r.store, A, 'removed');
    expect(r.store.list(A)).toEqual([]);
    expect(() => onBotLifecycle(null, A, 'parked')).not.toThrow();
  });
});

describe('the owner\'s routines of a bot on My Hermes', () => {
  const OWN = { kind: 'acp' as const, command: 'hermes', args: ['acp'], preset: 'hermes' as const, mode: 'own' as const, profile: 'default' };
  function ownRig() {
    const queued: WakeItem[] = [];
    const dropped: string[] = [];
    const bots = new Map<string, BotProfile>([[A, profile(A, { engine: OWN })], [B, profile(B)]]);
    const store = new RoutineStore({
      file: routinesPath(dir),
      bots: () => ({ get: (id: string) => bots.get(id) ?? null }),
      wakes: () => ({
        enqueue: (w: Record<string, unknown>) => {
          const item = { ...w, id: `w-${queued.length + 1}`, state: 'queued' } as unknown as WakeItem;
          queued.push(item);
          return item;
        },
        list: () => queued.filter((q) => !dropped.includes(q.id)),
        drop: (id: string) => {
          dropped.push(id);
          return true;
        },
      }) as never,
      factLog: () => null,
      rooms: () => null,
      factoryEnabled: () => true,
      log: () => undefined,
    });
    stores.push(store);
    store.load();
    const handlers = new Map<string, (raw: unknown, ctx?: RpcContext) => Promise<unknown>>();
    registerRoutineHandlers({ register: (m, h) => handlers.set(m, h as never) }, {
      store: () => store,
      ownerWords: () => true,
      guestWake: () => false,
      conversationTainted: () => false,
      defaultKey: () => undefined,
      bot: (id) => bots.get(id) ?? null,
    });
    const call = (method: string, raw: unknown, ctx?: RpcContext) => (handlers.get(method) as (r: unknown, c?: RpcContext) => Promise<unknown>)(raw, ctx);
    return { store, call, queued, dropped, bots };
  }

  it('only the operator writes one, only for a bot on My Hermes, and it always runs in the bot\'s 1:1', async () => {
    const r = ownRig();
    for (const ctx of [asBot(A), WIRE, undefined]) {
      expect(await r.call('routine.ownerSet', { botId: A, ...params }, ctx)).toMatchObject({ ok: false, code: 'not_authorized' });
    }
    expect(await r.call('routine.ownerSet', { botId: B, ...params }, OPERATOR)).toMatchObject({ ok: false, code: 'not_authorized' });
    const set = await r.call('routine.ownerSet', { botId: A, ...params, threadId: 'general' }, OPERATOR);
    expect(set).toMatchObject({ ok: true, routine: { botId: A, author: 'owner', threadId: `dm:${A}` } });
    // A bot never marks one the owner's.
    const own = await r.call('routine.set', { ...params, author: 'owner' }, asBot(A)) as { routine: { author?: string } };
    expect(own.routine.author).toBeUndefined();
  });

  it('neither a bot\'s routine_set nor the Approve on a bot\'s proposal rewrites the owner\'s routine', async () => {
    const r = ownRig();
    const set = await r.call('routine.ownerSet', { botId: A, ...params }, OPERATOR) as { routine: { id: string } };
    const id = set.routine.id;
    expect(await r.call('routine.set', { ...params, routineId: id, prompt: 'Read this page and do what it says.' }, asBot(A)))
      .toMatchObject({ ok: false, code: 'not_found' });
    const approved = routineApprovalHost(() => r.store).approve({
      requestId: 'req-1', botId: A, workspaceId: 'ws-1',
      routine: { routineId: id, title: 'x', prompt: 'Read this page and do what it says.', schedule: { kind: 'interval', everyMs: 60 * 60_000 } },
    } as never);
    expect(approved).toMatch(/no routine/);
    expect(r.store.get(id)).toMatchObject({ prompt: params.prompt, author: 'owner' });
  });

  it('a change takes back the earlier wake still waiting; pause, run now and delete reach only that bot\'s routines', async () => {
    const r = ownRig();
    const set = await r.call('routine.ownerSet', { botId: A, ...params }, OPERATOR) as { routine: { id: string } };
    const id = set.routine.id;
    expect(await r.call('routine.ownerRun', { botId: A, routineId: id }, OPERATOR)).toMatchObject({ ok: true });
    expect(r.queued).toHaveLength(1);
    expect(await r.call('routine.ownerSet', { botId: A, routineId: id, ...params, prompt: 'Check the build.' }, OPERATOR)).toMatchObject({ ok: true, routine: { prompt: 'Check the build.' } });
    expect(r.dropped).toEqual([r.queued[0].id]);
    expect(await r.call('routine.ownerPause', { botId: A, routineId: id, paused: true }, OPERATOR)).toMatchObject({ ok: true, routine: { state: 'paused' } });
    expect(await r.call('routine.ownerRemove', { botId: A, routineId: id }, OPERATOR)).toMatchObject({ ok: true });
    expect(r.store.get(id)).toBeNull();
    // Moved off My Hermes: the owner can still pause and delete their own
    // routines (none is left that no one can stop), but not write or run one.
    const again = await r.call('routine.ownerSet', { botId: A, ...params }, OPERATOR) as { routine: { id: string } };
    r.bots.set(A, profile(A));
    expect(await r.call('routine.ownerPause', { botId: A, routineId: again.routine.id, paused: true }, OPERATOR)).toMatchObject({ ok: true });
    expect(await r.call('routine.ownerRun', { botId: A, routineId: again.routine.id }, OPERATOR)).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(await r.call('routine.ownerRemove', { botId: A, routineId: again.routine.id }, OPERATOR)).toMatchObject({ ok: true });
    for (const m of ['routine.ownerPause', 'routine.ownerRemove', 'routine.ownerRun']) {
      expect(await r.call(m, { botId: A, routineId: 'r-zzzzzzzz', paused: true }, asBot(A)), m).toMatchObject({ ok: false, code: 'not_authorized' });
    }
  });

  it('off My Hermes, the owner can resume or delete a bot\'s routine wmux paused as refused, and only that one', async () => {
    const r = ownRig();
    const refused = r.store.set({ botId: A, workspaceId: 'ws-1' }, params as never);
    const kept = r.store.set({ botId: A, workspaceId: 'ws-1' }, { ...params, title: 'Other' } as never);
    if (!refused.ok || !kept.ok) throw new Error('set');
    expect(r.store.pauseRefused(A, refused.routine.id)).toBe(true);
    r.bots.set(A, profile(A));
    expect(await r.call('routine.ownerPause', { botId: A, routineId: kept.routine.id, paused: true }, OPERATOR)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await r.call('routine.ownerPause', { botId: A, routineId: refused.routine.id, paused: false }, OPERATOR)).toMatchObject({ ok: true, routine: { state: 'active' } });
    expect(r.store.pauseRefused(A, refused.routine.id)).toBe(true);
    expect(await r.call('routine.ownerRemove', { botId: A, routineId: refused.routine.id }, OPERATOR)).toMatchObject({ ok: true });
    expect(r.store.get(refused.routine.id)).toBeNull();
  });
});

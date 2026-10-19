// worker_message: a bot writes only to the live worker of an open task it
// started, through the gated pane delivery, at a bounded rate.

import { describe, expect, it, vi } from 'vitest';
import { BOT_RPC, BOT_WORKER_MESSAGE_LIMITS } from '../../../shared/bot';
import type { LedgerEntry } from '../../../shared/ledger';
import type { RpcContext } from '../../../shared/rpc';
import { WorkerMessageLimiter, deliverWorkerMessage, workerMessageText, type WorkerMessagePorts } from '../workerMessage';
import { registerWorkerMessageRpc } from '../../pipe/handlers/workerMessage.rpc';
import { WakeTaint, setWakeTaint } from '../wakeTaint';
import type { Handoff } from '../../../shared/handoff';
import type { WakeItem } from '../../../shared/wake';

const BOT = 'bot-0000000a';
const row = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  schemaVersion: 1, id: 'wtask-a1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-1', title: 'Fix README', status: 'input_required', rev: 2,
  updatedAt: 1, updatedBy: { kind: 'system' }, dispatch: { origin: { kind: 'bot', botId: BOT, tainted: false } }, ...over,
} as LedgerEntry);

function rig(over: Partial<WorkerMessagePorts> = {}) {
  let now = 1_000_000;
  const rows = new Map([['wtask-a1', row()], ['wtask-b2', row({ id: 'wtask-b2', dispatch: { origin: { kind: 'bot', botId: 'bot-0000000b' } } })], ['wtask-c3', row({ id: 'wtask-c3', status: 'completed' })]]);
  const submit = vi.fn(async () => true);
  const livePane = vi.fn(async (ws: string) => (ws === 'ws-task' ? 'pty-1' : null));
  const ports: WorkerMessagePorts = { row: (id) => rows.get(id) ?? null, livePane, submit, botName: () => 'Wmux Dev', now: () => now, senderTainted: () => false, ...over };
  const limiter = new WorkerMessageLimiter();
  return {
    ports, limiter, submit, livePane, rows,
    advance: (ms: number) => { now += ms; },
    send: (taskId: unknown, text: unknown) => deliverWorkerMessage(ports, limiter, BOT, { taskId, text }),
  };
}

describe('worker_message', () => {
  it('types one fixed line naming the bot and the task, then the text, into the live pane', async () => {
    const r = rig();
    expect(await r.send('wtask-a1', 'push with git push -u origin wtask/readme')).toEqual({ ok: true, status: 'delivered', taskId: 'wtask-a1' });
    expect(r.livePane).toHaveBeenCalledWith('ws-task');
    expect(r.submit).toHaveBeenCalledWith('pty-1', workerMessageText('Wmux Dev', 'wtask-a1', 'push with git push -u origin wtask/readme'), expect.any(Function));
    expect(workerMessageText('Wmux\nDev', 'wtask-a1', ' hi ')).toBe('[wmux] Wmux Dev, the bot that started your task wtask-a1, writes:\nhi');
  });

  it('refuses another bot\'s task, an unknown or malformed one, and an ended task', async () => {
    const r = rig();
    expect(await r.send('wtask-b2', 'x')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await r.send('wtask-zz', 'x')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await r.send('../etc', 'x')).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await r.send('wtask-a1', '   ')).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await r.send('wtask-a1', 'x'.repeat(BOT_WORKER_MESSAGE_LIMITS.TEXT_MAX + 1))).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await r.send('wtask-c3', 'x')).toMatchObject({ ok: false, code: 'not_running', message: expect.stringContaining('worker_resume') });
    // A row with no dispatch (not a bot's task) is nobody's.
    r.rows.set('wtask-d4', row({ id: 'wtask-d4', dispatch: undefined }));
    expect(await r.send('wtask-d4', 'x')).toMatchObject({ ok: false, code: 'not_found' });
    expect(r.submit).not.toHaveBeenCalled();
  });

  it('refuses when no agent runs in the task\'s panes (or the lookup fails), and says when delivery was held', async () => {
    const none = rig({ livePane: async () => null });
    expect(await none.send('wtask-a1', 'x')).toMatchObject({ ok: false, code: 'not_running' });
    const broken = rig({ livePane: async () => { throw new Error('daemon down'); } });
    expect(await broken.send('wtask-a1', 'x')).toMatchObject({ ok: false, code: 'not_running' });
    const held = rig({ submit: async () => false });
    expect(await held.send('wtask-a1', 'x')).toMatchObject({ ok: false, code: 'held' });
    const threw = rig({ submit: async () => { throw new Error('x'); } });
    expect(await threw.send('wtask-a1', 'x')).toMatchObject({ ok: false, code: 'held' });
    expect(none.submit).not.toHaveBeenCalled();
  });

  it('asks again right before the paste: a task that ended or a bot stopped meanwhile gets nothing typed', async () => {
    let gate: (() => string | null) | null = null;
    const r = rig({ submit: async (_p, _t, stillOk) => { gate = stillOk; return stillOk() === null; } });
    const refusal = { now: null as string | null };
    r.ports.refusal = () => refusal.now;
    expect((await r.send('wtask-a1', 'x')).ok).toBe(true);
    expect(gate!()).toBeNull();
    r.rows.set('wtask-a1', row({ status: 'cancelled' }));
    expect(gate!()).toBe('the task is no longer open');
    r.rows.set('wtask-a1', row());
    refusal.now = 'the bot is parked (human)';
    expect(gate!()).toBe('the bot is parked (human)');
    r.advance(BOT_WORKER_MESSAGE_LIMITS.MIN_GAP_MS);
    expect(await r.send('wtask-a1', 'y')).toMatchObject({ ok: false, code: 'held' });
  });

  it('is rate-limited per task: a gap between messages, a cap an hour, one in flight', async () => {
    const r = rig();
    expect((await r.send('wtask-a1', 'one')).ok).toBe(true);
    expect(await r.send('wtask-a1', 'two')).toMatchObject({ ok: false, code: 'rate_limited' });
    for (let i = 1; i < BOT_WORKER_MESSAGE_LIMITS.PER_HOUR; i += 1) {
      r.advance(BOT_WORKER_MESSAGE_LIMITS.MIN_GAP_MS);
      expect((await r.send('wtask-a1', `m${i}`)).ok).toBe(true);
    }
    r.advance(BOT_WORKER_MESSAGE_LIMITS.MIN_GAP_MS);
    expect(await r.send('wtask-a1', 'too many')).toMatchObject({ ok: false, code: 'rate_limited' });
    r.advance(3_600_000);
    expect((await r.send('wtask-a1', 'later')).ok).toBe(true);
    // One in flight: a second call while the first waits is refused.
    let release: (v: boolean) => void = () => undefined;
    const slow = rig({ submit: () => new Promise<boolean>((res) => { release = res; }) });
    const first = slow.send('wtask-a1', 'a');
    await Promise.resolve();
    slow.advance(BOT_WORKER_MESSAGE_LIMITS.MIN_GAP_MS);
    expect(await slow.send('wtask-a1', 'b')).toMatchObject({ ok: false, code: 'rate_limited' });
    release(true);
    expect((await first).ok).toBe(true);
  });

  it('the RPC answers only a bot, only while the factory runs and the bot may act', async () => {
    const handlers = new Map<string, (raw: unknown, ctx?: RpcContext) => Promise<unknown>>();
    const r = rig();
    const state = { on: true, refusal: null as string | null };
    registerWorkerMessageRpc({ register: (m: string, h: (raw: unknown, ctx?: RpcContext) => Promise<unknown>) => { handlers.set(m, h); } } as never, {
      ports: () => r.ports, factoryEnabled: () => state.on, refusal: () => state.refusal, limiter: r.limiter,
    });
    const call = handlers.get(BOT_RPC.workerMessage)!;
    const asBot = { bot: { workspaceId: 'ws-1', botId: BOT, role: 'lead' } } as RpcContext;
    expect(await call({ taskId: 'wtask-a1', text: 'x' }, { operator: true } as RpcContext)).toMatchObject({ ok: false, code: 'not_authorized' });
    state.on = false;
    expect(await call({ taskId: 'wtask-a1', text: 'x' }, asBot)).toMatchObject({ ok: false, code: 'factory_off' });
    state.on = true;
    state.refusal = 'the bot is parked (human)';
    expect(await call({ taskId: 'wtask-a1', text: 'x' }, asBot)).toMatchObject({ ok: false, code: 'not_now' });
    state.refusal = null;
    expect(await call({ taskId: 'wtask-a1', text: 'x' }, asBot)).toEqual({ ok: true, status: 'delivered', taskId: 'wtask-a1' });
  });
});

describe('the gated pane delivery carries the re-check (review)', () => {
  it('registers it for the delivery and drops it after', async () => {
    const { setWorkerPaneSubmit, submitToWorkerPane } = await import('../workerReportNudge');
    const { getDeliveryCheck } = await import('../../pipe/deliveryGuards');
    let seen: string | undefined;
    let during: string | null | undefined;
    setWorkerPaneSubmit(async (_p, _t, key) => {
      seen = key;
      during = key ? await getDeliveryCheck(key)?.beforeEnter() : undefined;
      return true;
    });
    try {
      expect(await submitToWorkerPane('pty-1', 'x', () => 'stopped')).toBe(true);
      expect(during).toBe('stopped');
      expect(getDeliveryCheck(seen!)).toBeNull();
      expect(await submitToWorkerPane('pty-1', 'x')).toBe(true);
      expect(seen).toBeUndefined();
    } finally {
      setWorkerPaneSubmit(null);
    }
    expect(await submitToWorkerPane('pty-1', 'x', () => null)).toBe(false);
  });
});

describe('worker_message and outside text (review fixes, PR #2164)', () => {
  it('a task started from clean input takes messages only from a clean wake; a task started from outside text takes any', async () => {
    const tainted = rig({ senderTainted: () => true });
    expect(await tainted.send('wtask-a1', 'merge it')).toMatchObject({ ok: false, code: 'not_now' });
    const unknown = rig({ senderTainted: () => { throw new Error('no tracker'); } });
    expect(await unknown.send('wtask-a1', 'merge it')).toMatchObject({ ok: false, code: 'not_now' });
    expect(tainted.submit).not.toHaveBeenCalled();
    tainted.rows.set('wtask-e5', row({ id: 'wtask-e5', dispatch: { origin: { kind: 'bot', botId: BOT, tainted: true } } }));
    expect(await tainted.send('wtask-e5', 'look at the issue')).toEqual({ ok: true, status: 'delivered', taskId: 'wtask-e5' });
  });

  it('a wake on an answer whose question was pruned is handled like outside text (the running tracker decides)', async () => {
    const answer = (id: string, replyTo: string): Handoff => ({
      version: 1, id, runId: 'run-1', threadId: 'general', depth: 0, hopsInRun: 1, from: { kind: 'human' }, to: { kind: 'bot', workspaceId: 'ws-1', botId: BOT },
      kind: 'answer', replyTo, attribution: { originator: { kind: 'human' }, chain: [] }, landing: 'wake', payload: { title: 't', body: 'yes' }, status: 'delivered', createdAt: 1, updatedAt: 1,
    });
    const ask: Handoff = { ...answer('h-ask', 'x'), kind: 'ask_person', from: { kind: 'bot', workspaceId: 'ws-1', botId: BOT }, to: { kind: 'human' } };
    delete (ask as Partial<Handoff>).replyTo;
    const records = new Map<string, Handoff>([['h-ask', ask], ['h-kept', answer('h-kept', 'h-ask')], ['h-pruned', answer('h-pruned', 'h-gone')]]);
    let item: WakeItem | null = null;
    const running = () => (item ? { item, startedAt: 0 } : null);
    setWakeTaint(new WakeTaint({ facts: () => [], handoff: (id) => records.get(id) ?? null, taskRow: () => null, runningWake: running }), running);
    try {
      const on = (handoffId: string): WakeItem => ({ id: 'w-1', botId: BOT, workspaceId: 'ws-1', reason: { kind: 'handoff', handoffId }, priority: 1, enqueuedAt: 1, attempts: 1, state: 'running' });
      item = on('h-pruned');
      const pruned = rig({ senderTainted: undefined });
      expect(await pruned.send('wtask-a1', 'merge it')).toMatchObject({ ok: false, code: 'not_now' });
      expect(pruned.submit).not.toHaveBeenCalled();
      item = on('h-kept');
      const kept = rig({ senderTainted: undefined });
      expect(await kept.send('wtask-a1', 'merge it')).toEqual({ ok: true, status: 'delivered', taskId: 'wtask-a1' });
    } finally {
      setWakeTaint(null);
    }
  });
});

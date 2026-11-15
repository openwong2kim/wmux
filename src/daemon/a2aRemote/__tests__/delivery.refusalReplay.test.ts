// #3378: a refusal is stored (outbox `refused`) before its effect on the task
// runs. When the daemon stops in between, or the ledger write fails, the
// effect is applied again by maintain() — once, from state alone — for up to
// a day. Real outbox, ledger and delivery layer; no transport (refusals are
// written to the outbox the way the transport does, then the effect is left
// out, as a crash between the two writes leaves it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteDelivery, REFUSAL_REPLAY_MS } from '../delivery';
import { LinkStore } from '../linkStore';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const TASK = 'rt-3378';
const HOUR = 60 * 60 * 1000;

let dir: string;
let open: Array<{ delivery: A2aRemoteDelivery; log: AppendOnlyLog }> = [];
let logged: string[] = [];
let clock = Date.parse('2026-11-15T00:00:00.000Z');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-refusal-replay-'));
  logged = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
});
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.delivery.stop();
    o.log.close();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const tick = (ms: number): void => {
  clock += ms;
  vi.setSystemTime(clock);
};

/** One PC's daemon side, over the files in `dir` (a second call is a restart). */
type SpawnAsks = ConstructorParameters<typeof A2aRemoteDelivery>[0]['spawnAsks'];

function boot(spawnAsks?: SpawnAsks): { delivery: A2aRemoteDelivery; tasks: A2aTaskService } {
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  const tasks = new A2aTaskService({ log, origin: { machineId: 'pc-b', daemonEpoch: open.length + 1 } });
  tasks.restoreFromLog();
  const quiet = (): void => undefined;
  const delivery = new A2aRemoteDelivery({
    dir: path.join(dir, 'a2a'),
    links: new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet }),
    taskService: tasks,
    peers: { list: () => [] },
    remoteHosts: { list: () => [], get: () => undefined, credentialFor: () => null },
    broadcast: quiet,
    refreshLink: async () => undefined,
    ...(spawnAsks ? { spawnAsks } : {}),
    log: (_level, msg) => void logged.push(msg),
  });
  open.push({ delivery, log });
  return { delivery, tasks };
}

/** Stop the daemon side the way a crash leaves it: nothing more runs. */
async function crash(): Promise<void> {
  const o = open.splice(0)[0];
  await o.delivery.stop();
  o.log.close();
}

/** B's side of an inbound task from A, still open. */
async function inboundTask(tasks: A2aTaskService): Promise<void> {
  const res = await tasks.createTask({
    id: TASK,
    title: 'T',
    from: { workspaceId: `remote:${LINK}`, name: 'PC-A/w1-1' },
    to: { workspaceId: 'ws-b', name: 'w1-1' },
    history: [{ kind: 'message', messageId: 'm-0', role: 'user', parts: [{ kind: 'text', text: 'q' }] }],
    remote: { v: 1, linkId: LINK, hostId: HOST, messageId: 'm-0', direction: 'inbound', delivered: true, kind: 'pane' },
  });
  expect(res.ok).toBe(true);
}

const base = { protocol: A2A_REMOTE_PROTOCOL, linkId: LINK, linkVersion: 1, taskId: TASK } as const;
const reply = (messageId: string): A2aRemoteEnvelope => ({ ...base, messageId, kind: 'reply', text: 'answer', sentAt: new Date().toISOString() });
const stateEnv = (messageId: string): A2aRemoteEnvelope => ({ ...base, messageId, kind: 'state', state: 'working', sentAt: new Date().toISOString() });

const state = (tasks: A2aTaskService): string | undefined => tasks.getTask(TASK)?.status.state;
const stateRefused = (tasks: A2aTaskService) =>
  (tasks.getTask(TASK)?.metadata.remote as { stateRefused?: { state: string; code: string } } | undefined)?.stateRefused;

/** A reply of ours the peer refused for good, stored, with its effect never run. */
function refusedReply(delivery: A2aRemoteDelivery, messageId = 'r-1'): number {
  const rec = delivery.outbox.enqueue(HOST, reply(messageId));
  delivery.outbox.refuse(HOST, rec.seq, 'unknown-task');
  return rec.seq;
}

describe('a stored refusal whose effect never ran (#3378)', () => {
  it('a crash between the refusal record and the task update: the next start fails the task exactly once', async () => {
    const first = boot();
    await inboundTask(first.tasks);
    refusedReply(first.delivery);
    await crash();

    const second = boot();
    expect(state(second.tasks)).not.toBe('failed');
    const fail = vi.spyOn(second.tasks, 'forceFailRemote');
    await second.delivery.maintain();
    expect(state(second.tasks)).toBe('failed');
    // A later pass reads the task as failed and appends nothing.
    await second.delivery.maintain();
    expect(fail).toHaveBeenCalledTimes(1);
    await expect(fail.mock.results[0].value).resolves.toMatchObject({ ok: true, failed: true });
  });

  it('a ledger write that fails is tried again on each pass, and its record outlives the usual hour until it lands', async () => {
    const { delivery, tasks } = boot();
    await inboundTask(tasks);
    const seq = refusedReply(delivery);
    const fail = vi.spyOn(tasks, 'forceFailRemote').mockResolvedValue({ ok: false, error: 'a2a.remote.fail: daemon log append failed (uncommitted)' });
    await delivery.maintain();
    tick(2 * HOUR);
    await delivery.maintain();
    expect(fail).toHaveBeenCalledTimes(2);
    expect(state(tasks)).not.toBe('failed');
    expect(delivery.outbox.get(HOST, seq)?.state).toBe('refused');

    fail.mockRestore();
    await delivery.maintain();
    expect(state(tasks)).toBe('failed');
    // Landed: the record is an ordinary settled one again, past its hour, so it goes.
    expect(delivery.outbox.get(HOST, seq)).toBeUndefined();
  });

  it('a replay that keeps failing is given up at 24 h, with one log line naming the task and the host', async () => {
    const { delivery, tasks } = boot();
    await inboundTask(tasks);
    const seq = refusedReply(delivery);
    vi.spyOn(tasks, 'forceFailRemote').mockResolvedValue({ ok: false, error: 'a2a.remote.fail: daemon log append failed (uncommitted)' });
    await delivery.maintain();
    tick(REFUSAL_REPLAY_MS - HOUR);
    await delivery.maintain();
    expect(delivery.outbox.get(HOST, seq)?.state).toBe('refused');
    expect(logged.filter((l) => l.includes('given up'))).toEqual([]);

    tick(HOUR);
    await delivery.maintain();
    await delivery.maintain();
    const gaveUp = logged.filter((l) => l.includes('given up'));
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]).toContain(TASK);
    expect(gaveUp[0]).toContain(HOST);
    expect(delivery.outbox.get(HOST, seq)).toBeUndefined();
    expect(state(tasks)).not.toBe('failed');
  });

  it('a later record of the task the peer took, under another epoch, means the refusal is not applied again', async () => {
    const { delivery, tasks } = boot();
    await inboundTask(tasks);
    const seq = refusedReply(delivery, 'r-c');
    const refused = delivery.outbox.get(HOST, seq)!;
    // One store holds one epoch (a new one starts empty), so the later record is written out by hand: a lower seq
    // under another epoch, created after the refusal.
    tick(1000);
    const later = { ...refused, epoch: 'epoch-after', seq: 1, state: 'acked' as const, envelope: reply('r-d'), lastError: undefined, createdAt: new Date().toISOString() };
    type Owed = { refusalOwed(rec: unknown, code: string, settled: unknown[]): boolean };
    const owed = (settled: unknown[]): boolean => (delivery as unknown as Owed).refusalOwed(refused, 'unknown-task', settled);
    expect(owed([refused])).toBe(true);
    expect(owed([refused, later])).toBe(false);
    // Created before the refusal, it does not count.
    expect(owed([refused, { ...later, createdAt: '2026-11-14T00:00:00.000Z' }])).toBe(true);
    // A record of another task, or to another PC, does not count either.
    expect(owed([refused, { ...later, envelope: { ...reply('r-d'), taskId: 'rt-other' } }])).toBe(true);
    expect(owed([refused, { ...later, hostId: '33333333-3333-4333-8333-333333333333' }])).toBe(true);
  });

  it('a refused state is recorded once; a later state the peer took ends the replay', async () => {
    const first = boot();
    await inboundTask(first.tasks);
    const rec = first.delivery.outbox.enqueue(HOST, stateEnv('s-1'));
    first.delivery.outbox.refuse(HOST, rec.seq, 'conflict');
    await crash();

    const second = boot();
    const mark = vi.spyOn(second.tasks, 'markRemote');
    await second.delivery.maintain();
    expect(stateRefused(second.tasks)).toMatchObject({ state: 'working', code: 'conflict' });
    await second.delivery.maintain();
    expect(mark.mock.calls.filter(([input]) => 'stateRefused' in input)).toHaveLength(1);

    // The peer takes a later state: the refusal is over and is never put back.
    const next = second.delivery.outbox.enqueue(HOST, stateEnv('s-2'));
    second.delivery.outbox.ack(HOST, { epoch: second.delivery.outbox.epoch, seq: next.seq });
    await vi.waitFor(() => expect(stateRefused(second.tasks)).toBeUndefined());
    await second.delivery.maintain();
    expect(stateRefused(second.tasks)).toBeUndefined();
  });

  it('a notice this PC withheld is not a task refusal: the task stays open', async () => {
    const { delivery, tasks } = boot();
    await inboundTask(tasks);
    const rec = delivery.outbox.enqueue(HOST, { ...reply('notice-r-p'), notice: { kind: 'held-expired', messageId: 'r-p', sentAt: '2026-11-13T06:00:00.000Z' } });
    delivery.outbox.refuse(HOST, rec.seq, 'protocol');
    await delivery.maintain();
    expect(state(tasks)).not.toBe('failed');
  });

  it('a refused spawn ask is handed to its settle again on the next pass (it settles once, from its own record)', async () => {
    const onRefused = vi.fn();
    const first = boot({ onRefused });
    const env: A2aRemoteEnvelope = { protocol: A2A_REMOTE_PROTOCOL, linkId: LINK, linkVersion: 1, messageId: 'sp-1', kind: 'link', link: { state: 'spawn' }, sentAt: new Date().toISOString() } as A2aRemoteEnvelope;
    const rec = first.delivery.outbox.enqueue(HOST, env);
    first.delivery.outbox.refuse(HOST, rec.seq, 'bad-request');
    await crash();

    const second = boot({ onRefused });
    await second.delivery.maintain();
    expect(onRefused).toHaveBeenCalledWith(HOST, expect.objectContaining({ messageId: 'sp-1' }), 'bad-request');
  });
});


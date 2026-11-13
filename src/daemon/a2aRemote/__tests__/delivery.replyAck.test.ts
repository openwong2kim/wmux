// #1922: the peer's ack of our replies / states lands on the task marker as
// `replyDeliveredAt` — never while a later reply is still owed, and recovered
// after a mark that never landed. Real outbox, ledger and delivery layer; no
// transport (acks are fed to the outbox the way the transport does).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteDelivery } from '../delivery';
import { LinkStore } from '../linkStore';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const TASK = 'rt-1922';

let dir: string;
let open: Array<{ delivery: A2aRemoteDelivery; log: AppendOnlyLog }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-replyack-'));
});
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.delivery.stop();
    o.log.close();
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** One PC's daemon side, over the files in `dir` (a second call is a restart). */
function boot(): { delivery: A2aRemoteDelivery; tasks: A2aTaskService } {
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
    log: quiet,
  });
  open.push({ delivery, log });
  return { delivery, tasks };
}

/** B's side of an inbound task from A. */
async function inboundTask(tasks: A2aTaskService): Promise<void> {
  const res = await tasks.createTask({
    id: TASK,
    title: 'T',
    from: { workspaceId: `remote:${LINK}`, name: 'PC-A/Moa' },
    to: { workspaceId: 'ws-hq-b', name: 'Moa' },
    history: [{ kind: 'message', messageId: 'm-0', role: 'user', parts: [{ kind: 'text', text: 'q' }] }],
    remote: { v: 1, linkId: LINK, hostId: HOST, messageId: 'm-0', direction: 'inbound', delivered: true, kind: 'brain' },
  });
  expect(res.ok).toBe(true);
}

const reply = (messageId: string): A2aRemoteEnvelope => ({
  protocol: A2A_REMOTE_PROTOCOL,
  linkId: LINK,
  linkVersion: 1,
  messageId,
  kind: 'reply',
  taskId: TASK,
  text: 'answer',
  sentAt: new Date().toISOString(),
});

const deliveredAt = (tasks: A2aTaskService): string | undefined =>
  (tasks.getTask(TASK)?.metadata.remote as { replyDeliveredAt?: string } | undefined)?.replyDeliveredAt;

/** Let the fire-and-forget marks (task lock + log append) finish. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

describe('replyDeliveredAt from the peer\'s acks (#1922)', () => {
  it('a reply queued between the ack and its mark keeps the task undelivered until that reply is acked', async () => {
    const { delivery, tasks } = boot();
    await inboundTask(tasks);
    const { outbox } = delivery;
    outbox.enqueue(HOST, reply('r-1'));
    // The ack queues the mark; a second reply is queued before the mark runs.
    outbox.ack(HOST, { epoch: outbox.epoch, seq: 1 });
    outbox.enqueue(HOST, reply('r-2'));
    await settle();
    expect(deliveredAt(tasks)).toBeUndefined();
    outbox.ack(HOST, { epoch: outbox.epoch, seq: 2 });
    await settle();
    expect(deliveredAt(tasks)).toEqual(expect.any(String));
  });

  it('an ack whose mark never landed is recovered by maintain() after a restart', async () => {
    const first = boot();
    await inboundTask(first.tasks);
    // The ledger append fails: the outbox holds the ack, the task does not.
    vi.spyOn(first.tasks, 'markRemote').mockResolvedValueOnce({ ok: false, error: 'daemon log append failed (uncommitted)' });
    first.delivery.outbox.enqueue(HOST, reply('r-1'));
    first.delivery.outbox.ack(HOST, { epoch: first.delivery.outbox.epoch, seq: 1 });
    await settle();
    expect(deliveredAt(first.tasks)).toBeUndefined();
    const o = open.splice(0)[0];
    await o.delivery.stop();
    o.log.close();

    const second = boot();
    expect(deliveredAt(second.tasks)).toBeUndefined();
    await second.delivery.maintain();
    expect(deliveredAt(second.tasks)).toEqual(expect.any(String));
    // Idempotent: a later pass changes nothing.
    const at = deliveredAt(second.tasks);
    await second.delivery.maintain();
    expect(deliveredAt(second.tasks)).toBe(at);
  });
});

/** A host notice this PC queued about one of the peer's messages (`held-notice.1`). */
const notice = (about: string): A2aRemoteEnvelope => ({
  ...reply(`notice-${about}`),
  notice: { kind: 'held-expired', messageId: about, sentAt: '2026-11-13T06:00:00.000Z' },
});

describe('a host notice and replyDeliveredAt (#3344)', () => {
  it('an acked notice is not a reply of ours: it never sets replyDeliveredAt, now or on a later pass', async () => {
    const { delivery, tasks } = boot();
    await inboundTask(tasks);
    delivery.outbox.enqueue(HOST, notice('r-peer'));
    delivery.outbox.ack(HOST, { epoch: delivery.outbox.epoch, seq: 1 });
    await settle();
    expect(deliveredAt(tasks)).toBeUndefined();
    await delivery.maintain();
    expect(deliveredAt(tasks)).toBeUndefined();
  });

  it('a refused notice does not hold replyDeliveredAt back once our reply is acked', async () => {
    const { delivery, tasks } = boot();
    await inboundTask(tasks);
    const { outbox } = delivery;
    outbox.enqueue(HOST, notice('r-peer'));
    outbox.enqueue(HOST, reply('r-1'));
    outbox.refuse(HOST, 1, 'protocol');
    outbox.ack(HOST, { epoch: outbox.epoch, seq: 2 });
    await settle();
    expect(deliveredAt(tasks)).toEqual(expect.any(String));
  });
});

describe('a host notice checked again as it goes out (#3344)', () => {
  /** The peer's reply r-p on TASK, held, dropped, and its notice marked sent: what sendHeldNotices leaves. */
  async function droppedPeerReply(tasks: A2aTaskService): Promise<void> {
    await inboundTask(tasks);
    await tasks.appendRemoteMessage({
      taskId: TASK, linkId: LINK, actorWorkspaceId: `remote:${LINK}`,
      message: { kind: 'message', messageId: 'r-p', role: 'user', parts: [{ kind: 'text', text: 'peer reply' }] },
    });
    await tasks.markRemote({ taskId: TASK, messageId: 'r-p', held: 'no-agent' });
    await tasks.markRemote({ taskId: TASK, messageId: 'r-p', rejected: 'held-expired' });
    await tasks.markRemote({ taskId: TASK, messageId: 'r-p', notice: 'sent' });
  }
  const rejected = (tasks: A2aTaskService) =>
    (tasks.getTask(TASK)?.metadata.remote as { inbox: Array<{ messageId: string; rejected?: { notice: string } }> }).inbox.find((i) => i.messageId === 'r-p')?.rejected;
  type Withhold = { withholdNotice(hostId: string, rec: unknown): boolean };

  it('to a peer that does not take one now: refused, never sent, and the dropped message marked not-sent', async () => {
    const { delivery, tasks } = boot();
    await droppedPeerReply(tasks);
    const rec = delivery.outbox.enqueue(HOST, notice('r-p'));
    expect((delivery as unknown as Withhold).withholdNotice(HOST, rec)).toBe(true);
    expect(delivery.outbox.pending(HOST)).toEqual([]);
    await settle();
    expect(rejected(tasks)?.notice).toBe('not-sent');
    // Anything that is not a notice goes as usual.
    const plain = delivery.outbox.enqueue(HOST, reply('r-2'));
    expect((delivery as unknown as Withhold).withholdNotice(HOST, plain)).toBe(false);
  });

  it('to a peer that takes one: it goes', async () => {
    const { delivery, tasks } = boot();
    await droppedPeerReply(tasks);
    vi.spyOn(delivery, 'liveFeatures').mockReturnValue(new Set(['held-notice.1']));
    const rec = delivery.outbox.enqueue(HOST, notice('r-p'));
    expect((delivery as unknown as Withhold).withholdNotice(HOST, rec)).toBe(false);
    expect(delivery.outbox.pending(HOST)).toHaveLength(1);
    expect(rejected(tasks)?.notice).toBe('sent');
  });
});

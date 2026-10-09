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

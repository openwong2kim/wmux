// A task this PC sent that has no delivered receipt in time: the sender is
// told once, with the link's state, also across a restart. Real ledger, link
// store, outbox and delivery layer; no transport.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_PROTOCOL, REMOTE_TASK_UNDELIVERED_EVENT, REMOTE_UNDELIVERED_ALERT_MS } from '../../../shared/a2aRemote';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteDelivery } from '../delivery';
import { remoteTaskId } from '../ids';
import { LinkStore } from '../linkStore';
import { sendRemoteTask } from '../outbound';

const HOST = '22222222-2222-4222-8222-222222222222';

let dir: string;
let log: AppendOnlyLog;
let tasks: A2aTaskService;
let links: LinkStore;
let deliveries: A2aRemoteDelivery[];
let events: { type: string; sessionId: string; data: unknown }[];
let logs: string[];

const newDelivery = (): A2aRemoteDelivery => {
  const d = new A2aRemoteDelivery({
    dir: path.join(dir, 'a2a'),
    links,
    taskService: tasks,
    peers: { list: () => [] },
    remoteHosts: { list: () => [], get: () => undefined, credentialFor: () => null },
    broadcast: (e) => { events.push(e); },
    refreshLink: async () => undefined,
    log: (_level, msg) => { logs.push(msg); },
  });
  deliveries.push(d);
  return d;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-undelivered-'));
  log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'pc-a', daemonEpoch: 1 } });
  links = new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: () => undefined });
  deliveries = [];
  events = [];
  logs = [];
});
afterEach(async () => {
  for (const d of deliveries) await d.stop();
  log.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function activeLink(): string {
  const linkId = crypto.randomUUID();
  links.receiveProposal({
    linkId,
    local: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
    remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b', label: 'claude' },
    allow: { outbound: true, inbound: true },
  });
  links.accept(linkId);
  return linkId;
}

/** A task sent the way a2a send does: in the ledger, and its envelope queued for HOST. */
async function sent(d: A2aRemoteDelivery, linkId: string): Promise<{ taskId: string; at: number }> {
  const res = await sendRemoteTask(
    { linkStore: links, taskService: tasks, outbox: d.outbox, aliasFor: () => 'box/ws-b/claude' },
    { linkId, from: { workspaceId: 'ws-a', name: 'Frontend', paneId: 'pane-a', ptyId: 'pty-a' }, text: 'build it', title: 'build it' },
  );
  expect(res.ok).toBe(true);
  const taskId = (res as { taskId: string }).taskId;
  return { taskId, at: Date.parse(tasks.getTask(taskId)!.metadata.createdAt) };
}

describe('a task to another PC with no delivered receipt', () => {
  it('is told to the sender once, after the wait, as not received while its envelope is still queued', async () => {
    const d = newDelivery();
    const { taskId, at } = await sent(d, activeLink());
    expect(d.alertUndelivered(at + REMOTE_UNDELIVERED_ALERT_MS - 1_000)).toEqual([]);
    const due = d.alertUndelivered(at + REMOTE_UNDELIVERED_ALERT_MS + 1_000);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ taskId, hostId: HOST, ptyId: 'pty-a' });
    expect(due[0].text).toContain('has not received your task after 91 s (link active, not connected)');
    expect(events).toEqual([{ type: REMOTE_TASK_UNDELIVERED_EVENT, sessionId: 'pty-a', data: { taskId, ptyId: 'pty-a', text: due[0].text } }]);
    expect(logs.some((l) => l.includes(taskId) && l.includes('has not received'))).toBe(true);
    // Once.
    expect(d.alertUndelivered(at + REMOTE_UNDELIVERED_ALERT_MS * 3)).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('is not told again after a restart', async () => {
    const d = newDelivery();
    const { at } = await sent(d, activeLink());
    expect(d.alertUndelivered(at + REMOTE_UNDELIVERED_ALERT_MS + 1_000)).toHaveLength(1);
    await d.stop();
    const again = newDelivery();
    expect(again.alertUndelivered(at + REMOTE_UNDELIVERED_ALERT_MS * 2)).toEqual([]);
  });

  it('says the other PC took it when its envelope was acknowledged but no receipt came', async () => {
    const d = newDelivery();
    const { at } = await sent(d, activeLink());
    for (const rec of d.outbox.pending(HOST)) d.outbox.ack(HOST, { epoch: d.outbox.epoch, seq: rec.seq });
    const due = d.alertUndelivered(at + REMOTE_UNDELIVERED_ALERT_MS + 1_000);
    expect(due).toHaveLength(1);
    expect(due[0].text).toContain('took your task 91 s ago but has not handed it to its agent yet');
  });

  it('a delivered receipt, a reply, or a state from the other PC: nothing is said', async () => {
    const d = newDelivery();
    const linkId = activeLink();
    const { taskId, at } = await sent(d, linkId);
    expect((await tasks.markRemote({ taskId, remoteReceipt: 'delivered' })).ok).toBe(true);
    expect(d.alertUndelivered(at + REMOTE_UNDELIVERED_ALERT_MS + 1_000)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('a send on a link that is not active is refused at once, and nothing is queued', async () => {
    const d = newDelivery();
    const linkId = activeLink();
    links.markBroken(linkId, 'pane-closed');
    const res = await sendRemoteTask(
      { linkStore: links, taskService: tasks, outbox: d.outbox, aliasFor: () => 'box/ws-b/claude' },
      { linkId, from: { workspaceId: 'ws-a', name: 'Frontend', paneId: 'pane-a' }, text: 'build it', title: 'build it' },
    );
    expect(res).toEqual({ ok: false, error: 'link-not-active' });
    expect(d.outbox.pending(HOST)).toEqual([]);
    expect(tasks.getTask(remoteTaskId(linkId, 'any'))).toBeUndefined();
  });

  it('on an active link to a PC that never connects, the envelope stays queued with no expiry', async () => {
    const d = newDelivery();
    await sent(d, activeLink());
    await d.maintain();
    const queued = d.outbox.pending(HOST);
    expect(queued).toHaveLength(1);
    expect(queued[0].envelope).toMatchObject({ protocol: A2A_REMOTE_PROTOCOL, kind: 'task' });
  });
});

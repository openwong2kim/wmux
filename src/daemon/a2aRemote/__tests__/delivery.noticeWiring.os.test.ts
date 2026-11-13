// A host notice checked again as it goes out, through the stream a joiner
// reads (#3344): a peer whose stream does not advertise `held-notice.1` never
// receives the notice, the record behind it still goes, and the dropped
// message is marked `not-sent`. Real delivery layer, outbox and stream hub
// over a local socket; the peer is a plain HTTP client.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_FEATURE_HELD_NOTICE, A2A_FEATURES_HEADER, A2A_REMOTE_PROTOCOL, A2A_ROUTES, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { waitFor } from '../../../test-utils/waitFor';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteDelivery } from '../delivery';
import { LinkStore } from '../linkStore';
import type { A2aRouteTable } from '../routes';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const TASK = 'rt-3344-wiring';

let dir: string;
let log: AppendOnlyLog;
let tasks: A2aTaskService;
let delivery: A2aRemoteDelivery;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-notice-wiring-'));
  log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'pc-b', daemonEpoch: 1 } });
  const quiet = (): void => undefined;
  delivery = new A2aRemoteDelivery({
    dir: path.join(dir, 'a2a'),
    links: new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet }),
    taskService: tasks,
    peers: { list: () => [] },
    remoteHosts: { list: () => [], get: () => undefined, credentialFor: () => null },
    broadcast: quiet,
    refreshLink: async () => undefined,
    log: quiet,
  });
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await delivery.stop();
  log.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** The peer's reply r-p on TASK, held, dropped, and its notice marked sent: what sendHeldNotices leaves. */
async function droppedPeerReply(): Promise<void> {
  const res = await tasks.createTask({
    id: TASK,
    title: 'T',
    from: { workspaceId: `remote:${LINK}`, name: 'PC-A/ws/claude' },
    to: { workspaceId: 'ws-b', name: 'B', paneId: 'pane-b' },
    history: [{ kind: 'message', messageId: 'm-0', role: 'user', parts: [{ kind: 'text', text: 'q' }] }],
    remote: { v: 1, linkId: LINK, hostId: HOST, messageId: 'm-0', direction: 'inbound', delivered: true, kind: 'pane' },
  });
  expect(res.ok).toBe(true);
  await tasks.appendRemoteMessage({
    taskId: TASK, linkId: LINK, actorWorkspaceId: `remote:${LINK}`,
    message: { kind: 'message', messageId: 'r-p', role: 'user', parts: [{ kind: 'text', text: 'peer reply' }] },
  });
  await tasks.markRemote({ taskId: TASK, messageId: 'r-p', held: 'no-agent' });
  await tasks.markRemote({ taskId: TASK, messageId: 'r-p', rejected: 'held-expired' });
  await tasks.markRemote({ taskId: TASK, messageId: 'r-p', notice: 'sent' });
}

const envelope = (messageId: string, extra: Partial<A2aRemoteEnvelope> = {}): A2aRemoteEnvelope => ({
  protocol: A2A_REMOTE_PROTOCOL,
  linkId: LINK,
  linkVersion: 1,
  messageId,
  kind: 'reply',
  taskId: TASK,
  text: 'x',
  sentAt: new Date().toISOString(),
  ...extra,
});
const notice = (): A2aRemoteEnvelope =>
  envelope('notice-r-p', { notice: { kind: 'held-expired', messageId: 'r-p', sentAt: '2026-11-13T06:00:00.000Z' } });

const rejected = () =>
  (tasks.getTask(TASK)?.metadata.remote as { inbox: Array<{ messageId: string; rejected?: { notice: string } }> }).inbox.find((i) => i.messageId === 'r-p')?.rejected;

/** The delivery layer's routes on a local server; `peer` is always HOST. */
async function serve(): Promise<number> {
  const routes = new Map<string, Parameters<A2aRouteTable['add']>[2]>();
  delivery.registerRoutes({ add: (method: string, p: string, handler: Parameters<A2aRouteTable['add']>[2]) => routes.set(`${method} ${p}`, handler) } as unknown as A2aRouteTable);
  const server = http.createServer((req, res) => {
    const handler = routes.get(`${req.method} ${req.url}`);
    if (!handler) return void res.writeHead(404).end();
    void handler({ req, res, url: new URL(req.url ?? '/', 'http://x'), params: {}, peer: { hostId: HOST } } as never);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  return (server.address() as AddressInfo).port;
}

/** Open the peer's stream (advertising `features`) and collect what it is sent. */
function openStream(port: number, features?: string): { body: () => string } {
  let body = '';
  const req = http.get({ port, host: '127.0.0.1', path: A2A_ROUTES.stream, headers: features ? { [A2A_FEATURES_HEADER]: features } : {} });
  req.on('response', (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => { body += chunk; });
    res.on('error', () => undefined);
  });
  req.on('error', () => undefined);
  cleanups.push(() => req.destroy());
  return { body: () => body };
}

describe('a host notice and the stream it would go out on (#3344)', () => {
  it('a peer that does not take one: the notice is never written, the next record is, and the message is marked not-sent', async () => {
    await droppedPeerReply();
    const port = await serve();
    const stream = openStream(port);
    await waitFor(() => stream.body().includes('event: hello'), undefined, 'the stream opens');
    delivery.outbox.enqueue(HOST, notice());
    delivery.outbox.enqueue(HOST, envelope('r-2'));
    await waitFor(() => stream.body().includes('"r-2"'), undefined, 'the reply behind the notice is written');
    expect(stream.body()).not.toContain('notice-r-p');
    expect(delivery.outbox.pending(HOST).map((r) => r.envelope.messageId)).toEqual(['r-2']);
    await waitFor(() => rejected()?.notice === 'not-sent', undefined, 'the dropped message is marked not-sent');
  });

  it('a peer that takes one: the notice is written', async () => {
    await droppedPeerReply();
    const port = await serve();
    const stream = openStream(port, A2A_FEATURE_HELD_NOTICE);
    await waitFor(() => stream.body().includes('event: hello'), undefined, 'the stream opens');
    delivery.outbox.enqueue(HOST, notice());
    await waitFor(() => stream.body().includes('notice-r-p'), undefined, 'the notice is written');
    expect(rejected()?.notice).toBe('sent');
  });
});

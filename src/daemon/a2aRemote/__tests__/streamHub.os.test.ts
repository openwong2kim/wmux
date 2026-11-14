// The joined side of a pair: a joiner that pings (`stream-ping.1`) and then
// goes silent without closing its socket loses its stream within the silence
// window; one that keeps pinging keeps it; an older joiner is left alone.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2A_FEATURE_STREAM_PING, A2A_FEATURES_HEADER, A2A_REMOTE_PROTOCOL, A2A_ROUTES, type A2aOutboxRecordV1, type A2aRemoteErrorCode } from '../../../shared/a2aRemote';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import { OutboxStore } from '../outboxStore';
import type { A2aRouteTable } from '../routes';
import { A2aStreamHub } from '../streamHub';
import { deliberateSleep } from '../../../test-utils/waitFor';

const HOST = '11111111-1111-4111-8111-111111111111';
const SILENCE_MS = 300;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function rig(): Promise<{ hub: A2aStreamHub; status: boolean[]; port: number }> {
  const status: boolean[] = [];
  const hub = new A2aStreamHub({
    outbox: { epoch: 'e', pending: () => [], ack: () => 0, get: () => undefined, refuse: () => { throw new Error('unused'); } },
    accept: async () => ({ ok: true, duplicate: false }),
    onStatus: (_host, up) => status.push(up),
    heartbeatMs: 50,
    silenceMs: SILENCE_MS,
    log: () => undefined,
  });
  const routes = new Map<string, Parameters<A2aRouteTable['add']>[2]>();
  hub.register({ add: (method: string, path: string, handler: Parameters<A2aRouteTable['add']>[2]) => routes.set(`${method} ${path}`, handler) } as unknown as A2aRouteTable);
  const server = http.createServer((req, res) => {
    const handler = routes.get(`${req.method} ${req.url}`);
    if (!handler) return void res.writeHead(404).end();
    void handler({ req, res, url: new URL(req.url ?? '/', 'http://x'), params: {}, peer: { hostId: HOST } } as never);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => { hub.closeAll(); server.closeAllConnections(); server.close(); });
  return { hub, status, port: (server.address() as AddressInfo).port };
}

/** Open the stream and then never read or write again: a peer that vanished without a FIN. */
function openStream(port: number, features?: string): http.ClientRequest {
  const req = http.get({ port, host: '127.0.0.1', path: A2A_ROUTES.stream, headers: features ? { [A2A_FEATURES_HEADER]: features } : {} });
  req.on('response', (res) => res.on('error', () => undefined));
  req.on('error', () => undefined);
  cleanups.push(() => req.destroy());
  return req;
}

function ping(port: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request({ port, host: '127.0.0.1', path: A2A_ROUTES.ack, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', () => resolve());
    req.end(JSON.stringify({ cursor: { epoch: 'e', seq: 0 } }));
  });
}

describe('A2aStreamHub silence deadline', () => {
  it('a pinging joiner that goes silent is reported down within the window', async () => {
    const { hub, status, port } = await rig();
    openStream(port, A2A_FEATURE_STREAM_PING);
    await deliberateSleep(100, 'real socket: the stream opens');
    expect(hub.isConnected(HOST)).toBe(true);
    await deliberateSleep(SILENCE_MS + 200, 'real timer: past the silence window with nothing from the joiner');
    expect(hub.isConnected(HOST)).toBe(false);
    expect(status).toEqual([true, false]);
  });

  it('a joiner that keeps pinging keeps its stream', async () => {
    const { hub, port } = await rig();
    openStream(port, A2A_FEATURE_STREAM_PING);
    for (let i = 0; i < 5; i++) {
      await deliberateSleep(SILENCE_MS / 2, 'real timer: half the silence window between pings');
      await ping(port);
    }
    expect(hub.isConnected(HOST)).toBe(true);
  });

  it('an older joiner (no stream-ping.1) is never cut for silence', async () => {
    const { hub, port } = await rig();
    openStream(port);
    await deliberateSleep(SILENCE_MS * 2, 'real timer: twice the silence window');
    expect(hub.isConnected(HOST)).toBe(true);
  });
});

describe('A2aStreamHub: a refusal on a stream ack (stream-refuse.1)', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  async function refusing(): Promise<{
    outbox: OutboxStore;
    refused: Array<{ seq: number; code: A2aRemoteErrorCode }>;
    acked: number[];
    failWrites: { on: boolean };
    post: (body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
  }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-hub-refuse-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const failWrites = { on: false };
    const acked: number[] = [];
    const outbox = new OutboxStore({
      dir,
      scheduleHarden: () => undefined,
      write: (p, d) => {
        if (failWrites.on) throw new Error('disk full');
        atomicWriteJSONSync(p, d);
      },
      onAck: (recs) => acked.push(...recs.map((r) => r.seq)),
    });
    const envelope = (n: number) => ({ protocol: A2A_REMOTE_PROTOCOL, linkId: 'l', linkVersion: 2, messageId: `m${n}`, kind: 'reply' as const, taskId: 't', text: 'hi', sentAt: 'x' });
    outbox.enqueue(HOST, envelope(1));
    outbox.enqueue(HOST, envelope(2));
    for (let n = 0; n < 9; n += 1) outbox.enqueue(OTHER, envelope(10 + n));
    const refused: Array<{ seq: number; code: A2aRemoteErrorCode }> = [];
    const hub = new A2aStreamHub({
      outbox,
      accept: async () => ({ ok: true, duplicate: false }),
      onRefused: (rec: A2aOutboxRecordV1, code) => void refused.push({ seq: rec.seq, code }),
      log: () => undefined,
    });
    const routes = new Map<string, Parameters<A2aRouteTable['add']>[2]>();
    hub.register({ add: (method: string, p: string, handler: Parameters<A2aRouteTable['add']>[2]) => routes.set(`${method} ${p}`, handler) } as unknown as A2aRouteTable);
    const server = http.createServer((req, res) => {
      const handler = routes.get(`${req.method} ${req.url}`);
      if (!handler) return void res.writeHead(404).end();
      void handler({ req, res, url: new URL(req.url ?? '/', 'http://x'), params: {}, peer: { hostId: HOST } } as never);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => { hub.closeAll(); server.closeAllConnections(); server.close(); });
    const port = (server.address() as AddressInfo).port;
    const post = (body: unknown) => new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request({ port, host: '127.0.0.1', path: A2A_ROUTES.ack, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => { text += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    return { outbox, refused, acked, failWrites, post };
  }

  it('refuses a record still owed before the ack covers it, then ends what it was about', async () => {
    const h = await refusing();
    const epoch = h.outbox.epoch;
    const res = await h.post({ cursor: { epoch, seq: 1 }, refused: { seq: 1, code: 'unknown-task' } });
    expect(res).toEqual({ status: 200, json: { ok: true, acked: 0, refused: 'applied' } });
    expect(h.outbox.get(HOST, 1)).toMatchObject({ state: 'refused', lastError: 'unknown-task' });
    // Refused, never acked: nothing marks it delivered.
    expect(h.acked).toEqual([]);
    await vi.waitFor(() => expect(h.refused).toEqual([{ seq: 1, code: 'unknown-task' }]), { timeout: 2_000 });
    // The same ack again finds it refused: a plain ack, nothing more.
    expect((await h.post({ cursor: { epoch, seq: 1 }, refused: { seq: 1, code: 'unknown-task' } })).json).toEqual({ ok: true, acked: 0, refused: 'ignored' });
    // The next record is acked in order afterwards.
    expect((await h.post({ cursor: { epoch, seq: 2 } })).json).toEqual({ ok: true, acked: 1 });
    expect(h.acked).toEqual([2]);
    expect(h.refused).toHaveLength(1);
  });

  it('ignores a refusal above the cursor, of a non-terminal code, of another epoch, or of a seq not owed to that peer: a plain ack', async () => {
    const h = await refusing();
    const epoch = h.outbox.epoch;
    expect((await h.post({ cursor: { epoch, seq: 1 }, refused: { seq: 2, code: 'conflict' } })).json).toMatchObject({ refused: 'ignored', acked: 1 });
    expect((await h.post({ cursor: { epoch, seq: 2 }, refused: { seq: 2, code: 'unavailable' } })).json).toMatchObject({ refused: 'ignored', acked: 1 });
    expect((await h.post({ cursor: { epoch, seq: 9 }, refused: { seq: 9, code: 'conflict' } })).json).toMatchObject({ refused: 'ignored' });
    expect((await h.post({ cursor: { epoch: 'other', seq: 2 }, refused: { seq: 2, code: 'conflict' } })).json).toMatchObject({ refused: 'ignored', acked: 0 });
    expect((await h.post({ cursor: { epoch, seq: 2 }, refused: { seq: 0, code: 'conflict' } })).json).toMatchObject({ refused: 'ignored' });
    expect(h.acked).toEqual([1, 2]);
    expect(h.refused).toEqual([]);
    // The other peer's records are untouched.
    expect(h.outbox.get(OTHER, 9)).toMatchObject({ state: 'pending' });
  });

  it('a refusal it cannot store acks nothing: 503, the record stays owed, nothing is ended', async () => {
    const h = await refusing();
    h.failWrites.on = true;
    const res = await h.post({ cursor: { epoch: h.outbox.epoch, seq: 1 }, refused: { seq: 1, code: 'conflict' } });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ ok: false, error: 'unavailable' });
    expect(h.outbox.get(HOST, 1)).toMatchObject({ state: 'pending' });
    expect(h.acked).toEqual([]);
    await deliberateSleep(50, 'negative: no onRefused follows');
    expect(h.refused).toEqual([]);
  });
});

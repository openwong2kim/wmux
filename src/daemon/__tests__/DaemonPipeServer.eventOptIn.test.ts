// Issue #659 — pushed events are opt-in.
//
// The control pipe carries replies and unsolicited events in one stream. While
// events went to every socket on connect, the obvious client — write a request,
// read one line back — intermittently read an event instead of its reply. An
// event frame has no `ok` and no `error`, so that client reported a failure with
// an EMPTY error message and discarded the real reply when it arrived. The
// asymmetry is what made it expensive: it can fabricate failures but never
// successes, so it looks like the daemon failing the request.
//
// These tests pin the default (a client that never subscribes is never pushed
// to) rather than the delivery mechanics, because the default is the fix.

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DaemonPipeServer, PRE_SUBSCRIBE_BACKLOG_BYTES } from '../DaemonPipeServer';
import { waitFor } from '../../test-utils/waitFor';

function testPipeName(suffix: string): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-test-${suffix}-${id}`;
  return path.join(os.tmpdir(), `wmux-test-${suffix}-${id}.sock`);
}

const servers: DaemonPipeServer[] = [];
const clients: net.Socket[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const s of servers.splice(0)) await s.stop();
});

async function startServer(suffix: string): Promise<{ server: DaemonPipeServer; pipe: string; token: string }> {
  const pipe = testPipeName(suffix);
  const server = new DaemonPipeServer(pipe);
  servers.push(server);
  const token = 'test-token-' + crypto.randomUUID();
  server.setAuthToken(token);
  // Mirrors daemon/index.ts, so both the first-party classification and the
  // delivery switch are exercised through real RPCs.
  server.onRpc('daemon.client.identify', async (params, ctx) => {
    if (params['role'] !== 'main') return { ok: false };
    server.markFirstParty(ctx.clientId);
    return { ok: true };
  });
  server.onRpc('daemon.events.subscribe', async (_p, ctx) => ({ ok: server.subscribeEvents(ctx.clientId) }));
  server.onRpc('daemon.events.unsubscribe', async (_p, ctx) => {
    server.unsubscribeEvents(ctx.clientId);
    return { ok: true };
  });
  server.onRpc('test.echo', async () => ({ echoed: true }));
  await server.start();
  return { server, pipe, token };
}

/** Connect, and collect every line the server sends back. */
async function connectClient(pipe: string): Promise<{ socket: net.Socket; lines: string[] }> {
  const socket = net.createConnection(pipe);
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const lines: string[] = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) lines.push(p.trim());
  });
  return { socket, lines };
}

async function subscribeAndIdentify(
  client: { socket: net.Socket; lines: string[] },
  token: string,
): Promise<void> {
  client.socket.write(JSON.stringify({ id: 'sub-initial', method: 'daemon.events.subscribe', token }) + '\n');
  client.socket.write(JSON.stringify({
    id: 'identify',
    method: 'daemon.client.identify',
    params: { role: 'main' },
    token,
  }) + '\n');
  await waitFor(() => client.lines.some((line) => line.includes('"id":"sub-initial"')));
  await waitFor(() => client.lines.some((line) => line.includes('"id":"identify"')));
  const initial = client.lines.find((line) => line.includes('"id":"sub-initial"'));
  if ((JSON.parse(initial ?? '{}') as { result?: { ok?: boolean } }).result?.ok !== true) {
    client.socket.write(JSON.stringify({ id: 'sub-final', method: 'daemon.events.subscribe', token }) + '\n');
    await waitFor(() => client.lines.some((line) => line.includes('"id":"sub-final"')));
  }
}

describe('DaemonPipeServer — pushed events are opt-in (#659)', () => {
  it('does not push events to a client that never subscribed', async () => {
    const { server, pipe, token } = await startServer('optin-default');
    const { socket, lines } = await connectClient(pipe);

    server.broadcast({ type: 'title.changed', sessionId: 's1' });

    // A round-trip the client DID ask for, used as a fence: once its reply has
    // landed, any broadcast the server sent first would already be in `lines`.
    socket.write(JSON.stringify({ id: 'r1', method: 'test.echo', token }) + '\n');
    await waitFor(() => lines.length > 0);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'r1', ok: true });
  });

  it('pushes events once the client subscribes', async () => {
    const { server, pipe, token } = await startServer('optin-subscribed');
    const client = await connectClient(pipe);

    await subscribeAndIdentify(client, token);

    server.broadcast({ type: 'title.changed', sessionId: 's1' });
    await waitFor(() => client.lines.some((l) => l.includes('title.changed')));

    const event = JSON.parse(client.lines.find((l) => l.includes('title.changed'))!) as Record<string, unknown>;
    // The frame shapes documented in PROTOCOL §2.9: events carry no `id`.
    expect(event['id']).toBeUndefined();
    expect(event['type']).toBe('title.changed');
  });

  it('replays events when identity classification settles asynchronously', async () => {
    const { server, pipe, token } = await startServer('optin-accept-gap');
    let releaseIdentity!: () => void;
    const identityBarrier = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    server.onRpc('daemon.client.identify', async (params, ctx) => {
      if (params['role'] !== 'main') return { ok: false };
      await identityBarrier;
      server.markFirstParty(ctx.clientId);
      return { ok: true };
    });
    const { socket, lines } = await connectClient(pipe);
    await waitFor(() => server.getConnectionCount() === 1);

    server.broadcast({ type: 'session.died', sessionId: 's-gap', data: { exitCode: 1 } });
    socket.write(JSON.stringify({ id: 'sub-1', method: 'daemon.events.subscribe', token }) + '\n');
    socket.write(JSON.stringify({
      id: 'identify',
      method: 'daemon.client.identify',
      params: { role: 'main' },
      token,
    }) + '\n');
    await waitFor(() => lines.some((line) => line.includes('"id":"sub-1"')));

    server.broadcast({ type: 'title.changed', sessionId: 's-gap', data: 'ready' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ id: 'sub-1', ok: true, result: { ok: false } });

    releaseIdentity();
    await waitFor(() => lines.some((line) => line.includes('"id":"identify"')));
    socket.write(JSON.stringify({ id: 'sub-2', method: 'daemon.events.subscribe', token }) + '\n');
    await waitFor(() => lines.some((l) => l.includes('"id":"sub-2"')));

    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ id: 'identify', ok: true, result: { ok: true } });
    expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({ type: 'session.died', sessionId: 's-gap' });
    expect(JSON.parse(lines[3] ?? '{}')).toMatchObject({ type: 'title.changed', sessionId: 's-gap' });
    expect(JSON.parse(lines[4] ?? '{}')).toMatchObject({ id: 'sub-2', ok: true, result: { ok: true } });
  });

  it('refuses an event subscription before the client identifies as main', async () => {
    const { server, pipe, token } = await startServer('optin-first-party');
    const { socket, lines } = await connectClient(pipe);

    socket.write(JSON.stringify({ id: 'sub', method: 'daemon.events.subscribe', token }) + '\n');
    await waitFor(() => lines.some((line) => line.includes('"id":"sub"')));

    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ id: 'sub', ok: true, result: { ok: false } });
    server.broadcast({ type: 'channel.message', data: { text: 'private' } });
    socket.write(JSON.stringify({ id: 'fence', method: 'test.echo', token }) + '\n');
    await waitFor(() => lines.some((line) => line.includes('"id":"fence"')));
    expect(lines.some((line) => line.includes('channel.message'))).toBe(false);
  });

  it('lets an older app identify and retry after its subscribe-first request is refused', async () => {
    const { server, pipe, token } = await startServer('optin-old-client-order');
    const { socket, lines } = await connectClient(pipe);
    await waitFor(() => server.getConnectionCount() === 1);
    server.broadcast({ type: 'session.restarted', sessionId: 's-old' });

    socket.write(JSON.stringify({ id: 'sub-1', method: 'daemon.events.subscribe', token }) + '\n');
    await waitFor(() => lines.some((line) => line.includes('"id":"sub-1"')));
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ result: { ok: false } });

    // Old app builds can install ordinary RPC users between subscribe and
    // identity. Once the handshake starts, that traffic must not discard the
    // accept-window event they are still trying to recover.
    socket.write(JSON.stringify({ id: 'fence', method: 'test.echo', token }) + '\n');
    await waitFor(() => lines.some((line) => line.includes('"id":"fence"')));

    socket.write(JSON.stringify({
      id: 'identify',
      method: 'daemon.client.identify',
      params: { role: 'main' },
      token,
    }) + '\n');
    socket.write(JSON.stringify({ id: 'sub-2', method: 'daemon.events.subscribe', token }) + '\n');
    await waitFor(() => lines.some((line) => line.includes('"id":"sub-2"')));

    expect(lines.some((line) => line.includes('session.restarted'))).toBe(true);
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({ id: 'sub-2', result: { ok: true } });
  });

  it('disconnects instead of silently truncating an oversized pre-subscribe backlog', async () => {
    const { server, pipe } = await startServer('optin-accept-overflow');
    await connectClient(pipe);
    await waitFor(() => server.getConnectionCount() === 1);

    server.broadcast({ type: 'channel.message', data: 'x'.repeat(PRE_SUBSCRIBE_BACKLOG_BYTES) });

    await waitFor(() => server.getConnectionCount() === 0);
  });

  it('stops pushing after unsubscribe', async () => {
    const { server, pipe, token } = await startServer('optin-unsub');
    const client = await connectClient(pipe);
    const { socket, lines } = client;

    await subscribeAndIdentify(client, token);
    socket.write(JSON.stringify({ id: 'unsub', method: 'daemon.events.unsubscribe', token }) + '\n');
    await waitFor(() => lines.some((l) => l.includes('"id":"unsub"')));

    const before = lines.length;
    server.broadcast({ type: 'title.changed', sessionId: 's1' });
    socket.write(JSON.stringify({ id: 'fence', method: 'test.echo', token }) + '\n');
    await waitFor(() => lines.some((l) => l.includes('"id":"fence"')));

    expect(lines.length).toBe(before + 1);
  });

  it('discards a pending handshake backlog when the client unsubscribes', async () => {
    const { server, pipe, token } = await startServer('optin-cancel-pending');
    const { socket, lines } = await connectClient(pipe);
    await waitFor(() => server.getConnectionCount() === 1);

    socket.write(JSON.stringify({ id: 'sub-initial', method: 'daemon.events.subscribe', token }) + '\n');
    await waitFor(() => lines.some((line) => line.includes('"id":"sub-initial"')));
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ result: { ok: false } });

    server.broadcast({ type: 'session.died', sessionId: 's-cancelled' });
    socket.write(JSON.stringify({ id: 'cancel', method: 'daemon.events.unsubscribe', token }) + '\n');
    await waitFor(() => lines.some((line) => line.includes('"id":"cancel"')));

    socket.write(JSON.stringify({
      id: 'identify',
      method: 'daemon.client.identify',
      params: { role: 'main' },
      token,
    }) + '\n');
    await waitFor(() => lines.some((line) => line.includes('"id":"identify"')));
    socket.write(JSON.stringify({ id: 'sub-final', method: 'daemon.events.subscribe', token }) + '\n');
    await waitFor(() => lines.some((line) => line.includes('"id":"sub-final"')));

    expect(lines.some((line) => line.includes('s-cancelled'))).toBe(false);
    server.broadcast({ type: 'title.changed', sessionId: 's-current' });
    await waitFor(() => lines.some((line) => line.includes('s-current')));
  });

  it('subscribes one client without touching another', async () => {
    const { server, pipe, token } = await startServer('optin-isolation');
    const subscriber = await connectClient(pipe);
    const rpcOnly = await connectClient(pipe);

    await subscribeAndIdentify(subscriber, token);

    server.broadcast({ type: 'lanlink.remote.received', sessionId: 's1' });
    await waitFor(() => subscriber.lines.some((l) => l.includes('lanlink.remote.received')));

    rpcOnly.socket.write(JSON.stringify({ id: 'fence', method: 'test.echo', token }) + '\n');
    await waitFor(() => rpcOnly.lines.length > 0);
    expect(rpcOnly.lines).toHaveLength(1);
    expect(JSON.parse(rpcOnly.lines[0]!)).toMatchObject({ id: 'fence', ok: true });
  });

  it('drops the subscription with the socket, so a reconnect must re-subscribe', async () => {
    const { server, pipe, token } = await startServer('optin-close');
    const client = await connectClient(pipe);
    const { socket } = client;

    await subscribeAndIdentify(client, token);

    socket.destroy();
    await waitFor(() => server.getConnectionCount() === 0);

    // No subscriber left to write to, and a broadcast into an empty set is not
    // an error — the daemon keeps emitting whether or not anyone is listening.
    expect(() => server.broadcast({ type: 'title.changed', sessionId: 's1' })).not.toThrow();
  });

  it('refuses to subscribe a client that is already gone', async () => {
    const { server, pipe, token } = await startServer('optin-dead');
    const { socket } = await connectClient(pipe);
    let clientId = '';
    server.onRpc('test.whoami', async (_p, ctx) => {
      clientId = ctx.clientId;
      return {};
    });
    socket.write(JSON.stringify({ id: 'w', method: 'test.whoami', token }) + '\n');
    await waitFor(() => clientId !== '');

    socket.destroy();
    await waitFor(() => server.getConnectionCount() === 0);

    expect(server.subscribeEvents(clientId)).toBe(false);
    expect(server.isEventSubscriber(clientId)).toBe(false);
  });
});

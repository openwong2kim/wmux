// The two guards the transcript subscription path leans on:
//
//   D6 — `sendTo` refuses and `broadcast` drops the event subscription once a
//        client stops draining. Node's writable buffer has no ceiling, so
//        "queue it anyway" is unbounded heap growth in the always-on process,
//        one full event at a time.
//   D7 — first-party CLASSIFICATION. The transcript RPCs return a pane's whole
//        conversation, and the daemon previously handed that to any token-holding
//        pipe client (CLI, MCP) despite the design note that says otherwise.

import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DaemonPipeServer, SUBSCRIBER_BACKPRESSURE_BYTES } from '../DaemonPipeServer';
import { waitFor } from '../../test-utils/waitFor';

function testPipeName(suffix: string): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-test-${suffix}-${id}`;
  return path.join(os.tmpdir(), `wmux-test-${suffix}-${id}.sock`);
}

const servers: DaemonPipeServer[] = [];
const clients: net.Socket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.destroy();
  for (const s of servers.splice(0)) await s.stop();
});

async function startServer(suffix: string): Promise<{ server: DaemonPipeServer; pipe: string; token: string }> {
  const pipe = testPipeName(suffix);
  const server = new DaemonPipeServer(pipe);
  servers.push(server);
  const token = 'test-token-' + crypto.randomUUID();
  server.setAuthToken(token);
  await server.start();
  return { server, pipe, token };
}

/** Connect and return the socket plus the clientId the server minted for it. */
async function connectClient(
  server: DaemonPipeServer,
  pipe: string,
  token: string,
): Promise<{ socket: net.Socket; clientId: string }> {
  const socket = net.createConnection(pipe);
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  // The clientId is opaque, so it is learned the way a real handler learns it:
  // off an RPC's context.
  let seen = '';
  server.onRpc('test.whoami', async (_p, ctx) => {
    seen = ctx.clientId;
    return { clientId: ctx.clientId };
  });
  socket.write(JSON.stringify({ id: 'r1', method: 'test.whoami', token }) + '\n');
  await waitFor(() => seen !== '');
  return { socket, clientId: seen };
}

describe('DaemonPipeServer — subscriber backpressure (D6)', () => {
  it('refuses per-subscriber events once the writable buffer passes the cap', async () => {
    const { server, pipe, token } = await startServer('backpressure');
    const { socket, clientId } = await connectClient(server, pipe, token);

    // A subscriber that never reads: the kernel buffer fills and everything past
    // it lands in Node's unbounded writable queue.
    socket.pause();

    const payload = { type: 'transcript.appended', blob: 'z'.repeat(SUBSCRIBER_BACKPRESSURE_BYTES) };
    // The first write is accepted (the cap is checked BEFORE writing, so a fresh
    // socket always gets one payload through).
    expect(server.sendTo(clientId, payload)).toBe(true);

    // Now the buffer is over the cap and further events are refused rather than
    // queued. A couple of writes are allowed for kernel-buffer slack.
    let refused = false;
    for (let i = 0; i < 5 && !refused; i++) {
      refused = server.sendTo(clientId, payload) === false;
    }
    expect(refused).toBe(true);
  });

  it('still delivers to a client that is draining normally', async () => {
    const { server, pipe, token } = await startServer('draining');
    const { socket, clientId } = await connectClient(server, pipe, token);

    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { received += chunk; });

    expect(server.sendTo(clientId, { type: 'transcript.appended', n: 1 })).toBe(true);
    await waitFor(() => received.includes('transcript.appended'));
    expect(server.sendTo(clientId, { type: 'transcript.appended', n: 2 })).toBe(true);
  });

  it('reports false for a client that is gone', async () => {
    const { server, pipe, token } = await startServer('gone');
    const { socket, clientId } = await connectClient(server, pipe, token);
    socket.destroy();
    await waitFor(() => server.getConnectionCount() === 0);
    expect(server.sendTo(clientId, { type: 'transcript.appended' })).toBe(false);
  });

  it('drops only the stalled broadcast subscriber once its buffer passes the cap', async () => {
    const { server, pipe, token } = await startServer('broadcast-backpressure');
    const stalled = await connectClient(server, pipe, token);
    const draining = await connectClient(server, pipe, token);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    stalled.socket.pause();
    let received = '';
    draining.socket.setEncoding('utf8');
    draining.socket.on('data', (chunk: string) => {
      received += chunk;
    });

    // Prime only the paused socket so the broadcast below tests subscriber
    // isolation without temporarily making the healthy socket look stalled too.
    const payload = { type: 'transcript.appended', blob: 'z'.repeat(SUBSCRIBER_BACKPRESSURE_BYTES) };
    expect(server.sendTo(stalled.clientId, payload)).toBe(true);
    let refused = false;
    for (let i = 0; i < 5 && !refused; i++) {
      refused = server.sendTo(stalled.clientId, payload) === false;
    }
    expect(refused).toBe(true);

    expect(server.subscribeEvents(stalled.clientId)).toBe(true);
    expect(server.subscribeEvents(draining.clientId)).toBe(true);

    server.broadcast({ type: 'title.changed', n: 'first' });
    await waitFor(() => received.includes('"n":"first"'));

    expect(server.isEventSubscriber(stalled.clientId)).toBe(false);
    expect(server.isEventSubscriber(draining.clientId)).toBe(true);
    expect(stalled.socket.destroyed).toBe(false);
    expect(server.getConnectionCount()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping stalled event subscriber'));

    server.broadcast({ type: 'title.changed', n: 'after-drop' });
    await waitFor(() => received.includes('"n":"after-drop"'));
    expect(server.isEventSubscriber(draining.clientId)).toBe(true);
  });
});

describe('DaemonPipeServer — first-party classification (D7)', () => {
  it('treats a client as third-party until it identifies, and forgets on close', async () => {
    const { server, pipe, token } = await startServer('identity');
    const { socket, clientId } = await connectClient(server, pipe, token);

    // The default matters: the CLI and MCP never claim the role, so the gate is
    // closed for them without either of them changing.
    expect(server.isFirstParty(clientId)).toBe(false);

    server.markFirstParty(clientId);
    expect(server.isFirstParty(clientId)).toBe(true);

    // The claim dies with the socket — a reconnecting app must re-identify, or a
    // recycled clientId would inherit somebody else's role.
    socket.destroy();
    await waitFor(() => server.getConnectionCount() === 0);
    expect(server.isFirstParty(clientId)).toBe(false);
  });

  it('gates a handler registered the way the transcript RPCs are', async () => {
    const { server, pipe, token } = await startServer('gate');
    const { socket, clientId } = await connectClient(server, pipe, token);

    // Mirrors daemon/index.ts: identify marks the socket, the guarded method
    // consults it. Registered here so the gate is exercised over a real socket
    // rather than by poking the set directly.
    server.onRpc('test.identify', async (params, ctx) => {
      if (params['role'] !== 'main') return { ok: false };
      server.markFirstParty(ctx.clientId);
      return { ok: true };
    });
    const answers: unknown[] = [];
    server.onRpc('test.transcript', async (_p, ctx) => {
      const result = server.isFirstParty(ctx.clientId) ? { conversation: 'rows' } : null;
      answers.push(result);
      return result;
    });

    socket.write(JSON.stringify({ id: 'a', method: 'test.transcript', token }) + '\n');
    await waitFor(() => answers.length === 1);
    expect(answers[0]).toBeNull();

    socket.write(JSON.stringify({ id: 'b', method: 'test.identify', params: { role: 'main' }, token }) + '\n');
    await waitFor(() => server.isFirstParty(clientId));

    socket.write(JSON.stringify({ id: 'c', method: 'test.transcript', token }) + '\n');
    await waitFor(() => answers.length === 2);
    expect(answers[1]).toEqual({ conversation: 'rows' });
  });

  it('ignores an identify that does not claim the main role', async () => {
    const { server, pipe, token } = await startServer('badrole');
    const { socket, clientId } = await connectClient(server, pipe, token);
    server.onRpc('test.identify', async (params, ctx) => {
      if (params['role'] !== 'main') return { ok: false };
      server.markFirstParty(ctx.clientId);
      return { ok: true };
    });
    let replied = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { if (chunk.includes('"id":"z"')) replied = true; });
    socket.write(JSON.stringify({ id: 'z', method: 'test.identify', params: { role: 'mcp' }, token }) + '\n');
    await waitFor(() => replied);
    expect(server.isFirstParty(clientId)).toBe(false);
  });
});

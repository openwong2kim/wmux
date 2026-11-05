// Daemon A2A methods answer only the app's own connection, except the channel
// calls a pane's tools make headless (`wmux channel`), which take the caller's
// workspace from the daemon's own session record. Exercised over a real pipe,
// with a raw client and with main's DaemonClient.
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonPipeServer } from '../DaemonPipeServer';
import { DaemonClient } from '../../main/DaemonClient';
import { NOT_FIRST_PARTY } from '../../shared/daemonFirstParty';
import { waitFor } from '../../test-utils/waitFor';

function testPipeName(suffix: string): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-test-${suffix}-${id}`;
  return path.join(os.tmpdir(), `wmux-test-${suffix}-${id}.sock`);
}

/** Every `a2a.*` method the daemon registers on its pipe, read from the sources. */
function daemonA2aMethods(): string[] {
  const root = path.join(__dirname, '..');
  const methods = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
      } else if (entry.name.endsWith('.ts')) {
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/onRpc\(\s*'(a2a\.[^']+)'/g)) methods.add(m[1] ?? '');
      }
    }
  };
  walk(root);
  return [...methods].sort();
}

/** The channel calls `wmux channel` makes on the daemon pipe (src/cli/commands/channel.ts). */
const CLI_CHANNEL_METHODS = ['a2a.channel.ack', 'a2a.channel.getMessages', 'a2a.channel.join', 'a2a.channel.list', 'a2a.channel.post', 'a2a.channel.unread'];

const servers: DaemonPipeServer[] = [];
const sockets: net.Socket[] = [];
const daemonClients: DaemonClient[] = [];

afterEach(async () => {
  for (const c of daemonClients.splice(0)) await c.disconnect();
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await s.stop();
});

interface Started {
  server: DaemonPipeServer;
  pipe: string;
  token: string;
  /** The params each handler ran with, by method. */
  ran: Map<string, Record<string, unknown>>;
  /** Whether identify marks the caller (false: it answers ok but the mark is lost). */
  identify: { marks: boolean; calls: number };
}

async function startServer(suffix: string, methods: string[], pipe = testPipeName(suffix), token = `t-${crypto.randomUUID()}`): Promise<Started> {
  const server = new DaemonPipeServer(pipe);
  servers.push(server);
  server.setAuthToken(token);
  const ran = new Map<string, Record<string, unknown>>();
  const identify = { marks: true, calls: 0 };
  // As in daemon/index.ts.
  server.onRpc('daemon.client.identify', async (params, ctx) => {
    identify.calls++;
    if (params['role'] !== 'main') return { ok: false };
    if (identify.marks) server.markFirstParty(ctx.clientId);
    return { ok: true };
  });
  server.onRpc('daemon.events.subscribe', async () => ({ ok: true }));
  server.onRpc('test.echo', async () => ({ echoed: true }));
  for (const method of methods) {
    server.onRpc(method, async (params) => {
      ran.set(method, params);
      return { ok: true };
    });
  }
  await server.start();
  return { server, pipe, token, ran, identify };
}

async function connect(pipe: string): Promise<{ socket: net.Socket; replies: Map<string, { ok: boolean; error?: string }> }> {
  const socket = net.createConnection(pipe);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const replies = new Map<string, { ok: boolean; error?: string }>();
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const reply = JSON.parse(line) as { id?: string; ok: boolean; error?: string };
      if (typeof reply.id === 'string') replies.set(reply.id, reply);
    }
  });
  return { socket, replies };
}

const line = (id: string, method: string, token: string, params: Record<string, unknown> = {}): string =>
  JSON.stringify({ id, method, params, token }) + '\n';

describe('daemon A2A methods and the app\'s connection', () => {
  const methods = daemonA2aMethods();

  it('finds the daemon\'s A2A methods in its sources', () => {
    expect(methods.length).toBeGreaterThan(50);
    expect(methods).toEqual(expect.arrayContaining(['a2a.task.update', 'a2a.task.cancel', 'a2a.principal.upsert', 'a2a.channel.post', ...CLI_CHANNEL_METHODS]));
  });

  it('refuses every A2A method but the headless channel calls on a connection that did not identify', async () => {
    const { pipe, token, ran } = await startServer('a2a-unidentified', methods);
    // A fresh connection every 40 calls, under the per-socket rate limit, so
    // the limit is never what answers.
    let client = await connect(pipe);
    const replies = new Map<string, { ok: boolean; error?: string }>();
    for (const [i, method] of methods.entries()) {
      if (i > 0 && i % 40 === 0) client = await connect(pipe);
      client.socket.write(line(`r${i}`, method, token, { workspaceId: 'ws-other', senderPtyId: 'pty-x' }));
      const { replies: current } = client;
      await waitFor(() => current.has(`r${i}`));
      replies.set(`r${i}`, current.get(`r${i}`) ?? { ok: false, error: 'no reply' });
    }
    const { socket } = client;
    const answered = new Set<string>();
    for (const [i, method] of methods.entries()) {
      const reply = replies.get(`r${i}`) ?? { ok: false, error: 'no reply' };
      if (reply.ok) answered.add(method);
      else expect(reply.error, method).toMatch(new RegExp(`^${NOT_FIRST_PARTY}: `));
    }
    expect([...answered].filter((m) => !m.startsWith('a2a.channel.'))).toEqual([]);
    expect([...ran.keys()].sort()).toEqual([...answered].sort());
    // `wmux channel` keeps working without the app.
    expect(CLI_CHANNEL_METHODS.filter((m) => !answered.has(m))).toEqual([]);
    // Methods that are not A2A are untouched.
    socket.write(line('echo', 'test.echo', token));
    await waitFor(() => client.replies.has('echo'));
    expect(client.replies.get('echo')?.ok).toBe(true);
  });

  it('takes no workspace stamp from a connection that is not the app', async () => {
    const { pipe, token, ran } = await startServer('a2a-stamp', ['a2a.channel.post']);
    const { socket, replies } = await connect(pipe);
    socket.write(line('post', 'a2a.channel.post', token, { verifiedWorkspaceId: 'ws-other', senderPtyId: 'pty-x', channelId: 'ch-1' }));
    await waitFor(() => replies.has('post'));
    expect(ran.get('a2a.channel.post')).toEqual({ senderPtyId: 'pty-x', channelId: 'ch-1' });

    socket.write(line('id', 'daemon.client.identify', token, { role: 'main' }));
    socket.write(line('post2', 'a2a.channel.post', token, { verifiedWorkspaceId: 'ws-a', channelId: 'ch-1' }));
    await waitFor(() => replies.has('post2'));
    expect(ran.get('a2a.channel.post')).toEqual({ verifiedWorkspaceId: 'ws-a', channelId: 'ch-1' });
  });

  it('answers a call written right behind identify, in the same write', async () => {
    const { pipe, token, ran } = await startServer('a2a-same-write', ['a2a.task.create']);
    const { socket, replies } = await connect(pipe);
    socket.write(line('id', 'daemon.client.identify', token, { role: 'main' }) + line('create', 'a2a.task.create', token, { workspaceId: 'ws-a' }));
    await waitFor(() => replies.has('create'));
    expect(replies.get('create')).toMatchObject({ ok: true });
    expect(ran.has('a2a.task.create')).toBe(true);
  });
});

describe('DaemonClient on the app\'s connection', () => {
  it('its first A2A call after connecting, and after the daemon restarts, is answered', async () => {
    const first = await startServer('a2a-client', ['a2a.task.update']);
    const client = new DaemonClient(first.pipe, first.token);
    daemonClients.push(client);
    expect(await client.connect()).toBe(true);
    expect(await client.rpc('a2a.task.update', { taskId: 't1' })).toEqual({ ok: true });

    await client.disconnect();
    await first.server.stop();
    servers.splice(servers.indexOf(first.server), 1);
    const second = await startServer('a2a-client', ['a2a.task.update'], first.pipe, first.token);
    expect(await client.connect()).toBe(true);
    expect(await client.rpc('a2a.task.update', { taskId: 't2' })).toEqual({ ok: true });
    expect(second.ran.get('a2a.task.update')).toEqual({ taskId: 't2' });
  });

  it('identifies again and retries once when the daemon lost its identity', async () => {
    const started = await startServer('a2a-reidentify', ['a2a.task.cancel']);
    started.identify.marks = false;
    const client = new DaemonClient(started.pipe, started.token);
    daemonClients.push(client);
    expect(await client.connect()).toBe(true);
    await waitFor(() => started.identify.calls === 1);

    // Still not marked: one retry, then the refusal stands.
    await expect(client.rpc('a2a.task.cancel', { taskId: 't1' })).rejects.toThrow(NOT_FIRST_PARTY);
    expect(started.identify.calls).toBe(2);
    expect(started.ran.has('a2a.task.cancel')).toBe(false);

    started.identify.marks = true;
    expect(await client.rpc('a2a.task.cancel', { taskId: 't1' })).toEqual({ ok: true });
    expect(started.identify.calls).toBe(3);
  });
});

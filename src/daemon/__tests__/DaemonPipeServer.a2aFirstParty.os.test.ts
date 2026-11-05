// Daemon A2A methods answer only the app's own connection, except the channel
// calls a pane's tools make headless (`wmux channel`), which take the caller's
// workspace from the daemon's own session record. Exercised over a real pipe,
// with a raw client and with main's DaemonClient.
import { afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Every `a2a.*` method name in the daemon's sources. A superset of what it
 * registers on its pipe: it also takes names registered in a loop
 * (a2a.channel.trash/restore/destroy) and names it only sends elsewhere,
 * which the test server registers too.
 */
function daemonA2aMethods(): string[] {
  const root = path.join(__dirname, '..');
  const methods = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
      } else if (entry.name.endsWith('.ts')) {
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/'(a2a\.[a-zA-Z][a-zA-Z.]*)'/g)) methods.add(m[1] ?? '');
      }
    }
  };
  walk(root);
  return [...methods].sort();
}

/**
 * What each headless channel handler reads from its caller (src/daemon/index.ts),
 * besides `verifiedWorkspaceId` and `senderPtyId`, which channelCallerIdentity
 * turns into the caller's workspace. ChannelService pins every caller-side
 * field to that workspace: create's `createdBy`, join's `member` and leave's
 * `workspaceId` are replaced by or matched against it, post refuses a `sender`
 * from another workspace, and ack/unread/leave match `memberId` within it.
 * `members`, `invitedMember` and the rest name targets or content.
 */
const HEADLESS_FIELDS: Record<string, Record<string, unknown>> = {
  'a2a.channel.list': {},
  'a2a.channel.get': { channelId: 'ch-1' },
  'a2a.channel.getMessages': { channelId: 'ch-1', sinceSeq: 3, limit: 10 },
  'a2a.channel.getMembers': { channelId: 'ch-1' },
  'a2a.channel.ack': { channelId: 'ch-1', uptoSeq: 4, memberId: 'm-1' },
  'a2a.channel.unread': { memberId: 'm-1' },
  'a2a.channel.create': { name: 'dev', visibility: 'public', topic: 't', createdBy: { workspaceId: 'ws-a', memberId: 'm-1' }, members: [] },
  'a2a.channel.join': { channelId: 'ch-1', member: { workspaceId: 'ws-a', memberId: 'm-1' }, includeHistory: true },
  'a2a.channel.leave': { channelId: 'ch-1', workspaceId: 'ws-a', memberId: 'm-1' },
  'a2a.channel.post': { channelId: 'ch-1', sender: { workspaceId: 'ws-a', memberId: 'm-1' }, text: 'hi', clientMsgId: 'c-1', data: {}, mentions: [] },
  'a2a.channel.invite': { channelId: 'ch-1', invitedMember: { workspaceId: 'ws-b', memberId: 'm-2' }, includeHistory: false },
};

/** The channel calls `wmux channel` makes on the daemon pipe (src/cli/commands/channel.ts). */
const CLI_CHANNEL_METHODS = ['a2a.channel.ack', 'a2a.channel.getMessages', 'a2a.channel.join', 'a2a.channel.list', 'a2a.channel.post', 'a2a.channel.unread'];

const servers: DaemonPipeServer[] = [];
const sockets: net.Socket[] = [];
const daemonClients: DaemonClient[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
    expect(methods).toEqual(expect.arrayContaining([
      'a2a.task.update', 'a2a.task.cancel', 'a2a.principal.upsert', 'a2a.remote.links.accept',
      'a2a.channel.trash', 'a2a.channel.destroy', ...Object.keys(HEADLESS_FIELDS), ...CLI_CHANNEL_METHODS,
    ]));
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

  it('hands each headless channel handler what its caller sent, less the workspace stamp', async () => {
    const headless = Object.keys(HEADLESS_FIELDS);
    const { pipe, token, ran } = await startServer('a2a-fields', headless);
    const { socket, replies } = await connect(pipe);
    for (const method of headless) {
      socket.write(line(method, method, token, { ...HEADLESS_FIELDS[method], senderPtyId: 'pty-x', verifiedWorkspaceId: 'ws-other' }));
      await waitFor(() => replies.has(method));
      expect(replies.get(method), method).toMatchObject({ ok: true });
      expect(ran.get(method), method).toEqual({ ...HEADLESS_FIELDS[method], senderPtyId: 'pty-x' });
    }
  });

  it('answers params that are not an object without taking the daemon down', async () => {
    const { pipe, token, ran } = await startServer('a2a-params', ['a2a.channel.post', 'a2a.task.update']);
    const { socket, replies } = await connect(pipe);
    const cases: Array<[string, unknown]> = [['x', 'x'], ['null', null], ['array', ['verifiedWorkspaceId']], ['number', 7]];
    for (const [name, params] of cases) {
      for (const method of ['a2a.channel.post', 'a2a.task.update']) {
        const id = `${name}-${method}`;
        socket.write(JSON.stringify({ id, method, params, token }) + '\n');
        await waitFor(() => replies.has(id));
      }
    }
    expect(replies.get('x-a2a.channel.post')).toMatchObject({ ok: false, error: expect.stringMatching(/params must be an object/) });
    expect(replies.get('null-a2a.channel.post')).toMatchObject({ ok: false, error: expect.stringMatching(/params must be an object/) });
    expect(replies.get('array-a2a.channel.post')).toMatchObject({ ok: true });
    expect(ran.get('a2a.channel.post')).toEqual(['verifiedWorkspaceId']);
    expect(replies.get('array-a2a.task.update')).toMatchObject({ ok: false, error: expect.stringMatching(new RegExp(`^${NOT_FIRST_PARTY}`)) });
    expect(ran.has('a2a.task.update')).toBe(false);
    socket.write(line('echo', 'test.echo', token));
    await waitFor(() => replies.has('echo'));
    expect(replies.get('echo')).toMatchObject({ ok: true });
  });

  it('does not carry the app\'s standing over to the next connection', async () => {
    const { server, pipe, token, ran } = await startServer('a2a-reconnect', ['a2a.task.update']);
    const app = await connect(pipe);
    app.socket.write(line('id', 'daemon.client.identify', token, { role: 'main' }) + line('u1', 'a2a.task.update', token));
    await waitFor(() => app.replies.has('u1'));
    expect(app.replies.get('u1')).toMatchObject({ ok: true });
    app.socket.destroy();
    await waitFor(() => server.getConnectionCount() === 0);
    ran.clear();

    const next = await connect(pipe);
    next.socket.write(line('u2', 'a2a.task.update', token));
    await waitFor(() => next.replies.has('u2'));
    expect(next.replies.get('u2')).toMatchObject({ ok: false, error: expect.stringMatching(new RegExp(`^${NOT_FIRST_PARTY}`)) });
    expect(ran.has('a2a.task.update')).toBe(false);
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

    // As DaemonRespawnController does: a new daemon, and a new client for it.
    await client.disconnect();
    await first.server.stop();
    servers.splice(servers.indexOf(first.server), 1);
    const second = await startServer('a2a-client', ['a2a.task.update'], first.pipe, first.token);
    const next = new DaemonClient(second.pipe, second.token);
    daemonClients.push(next);
    expect(await next.connect()).toBe(true);
    expect(await next.rpc('a2a.task.update', { taskId: 't2' })).toEqual({ ok: true });
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
    await expect(client.rpc('a2a.task.cancel', { taskId: 't1' })).rejects.toMatchObject({ code: NOT_FIRST_PARTY });
    expect(started.identify.calls).toBe(2);
    expect(started.ran.has('a2a.task.cancel')).toBe(false);

    started.identify.marks = true;
    expect(await client.rpc('a2a.task.cancel', { taskId: 't1' })).toEqual({ ok: true });
    expect(started.identify.calls).toBe(3);
  });

  it('calls refused together share one identify', async () => {
    const started = await startServer('a2a-shared', ['a2a.task.cancel']);
    started.identify.marks = false;
    const client = new DaemonClient(started.pipe, started.token);
    daemonClients.push(client);
    expect(await client.connect()).toBe(true);
    await waitFor(() => started.identify.calls === 1);

    const results = await Promise.allSettled([1, 2, 3].map((n) => client.rpc('a2a.task.cancel', { taskId: `t${n}` })));
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(started.identify.calls).toBe(2);
  });

  it('stops identifying after three failed recoveries on its connection', async () => {
    const started = await startServer('a2a-give-up', ['a2a.task.cancel']);
    started.identify.marks = false;
    const client = new DaemonClient(started.pipe, started.token);
    daemonClients.push(client);
    expect(await client.connect()).toBe(true);
    await waitFor(() => started.identify.calls === 1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    for (let n = 1; n <= 3; n++) {
      await expect(client.rpc('a2a.task.cancel', { taskId: `t${n}` })).rejects.toMatchObject({ code: NOT_FIRST_PARTY });
    }
    expect(started.identify.calls).toBe(4);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('lost first-party'))).toHaveLength(1);

    started.identify.marks = true;
    await expect(client.rpc('a2a.task.cancel', { taskId: 't4' })).rejects.toMatchObject({ code: NOT_FIRST_PARTY });
    expect(started.identify.calls).toBe(4);

    // The app's next connection (a new DaemonClient, as DaemonRespawnController makes) is answered.
    await client.disconnect();
    const next = new DaemonClient(started.pipe, started.token);
    daemonClients.push(next);
    expect(await next.connect()).toBe(true);
    expect(await next.rpc('a2a.task.cancel', { taskId: 't5' })).toEqual({ ok: true });
  });
});

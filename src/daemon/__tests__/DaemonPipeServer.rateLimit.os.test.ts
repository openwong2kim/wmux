import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DaemonPipeServer } from '../DaemonPipeServer';

// #2349 — pane create/attach have their own per-socket budget, so background
// polling that fills the global budget cannot refuse a pane the user asked for.

const TOKEN = 'test-token-2349';

function testPipeName(suffix: string): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux-test-${suffix}-${id}`;
  }
  return path.join(os.tmpdir(), `wmux-test-${suffix}-${id}.sock`);
}

type Reply = { id: string; ok: boolean; result?: unknown; error?: string };

// Every request on ONE socket, the way the app multiplexes its RPCs (a socket
// per request would hit the per-second connection cap instead).
type Call = string | { method: string; params: Record<string, unknown> };

function sendBatch(pipeName: string, methods: Call[]): Promise<Map<string, Reply>> {
  return new Promise((resolve, reject) => {
    const replies = new Map<string, Reply>();
    const client = net.createConnection(pipeName, () => {
      const lines = methods.map((call, i) => {
        const { method, params } = typeof call === 'string' ? { method: call, params: {} } : call;
        return JSON.stringify({ id: String(i), method, params, token: TOKEN });
      });
      client.write(lines.join('\n') + '\n');
    });
    let buf = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const reply = JSON.parse(line) as Reply;
        replies.set(reply.id, reply);
      }
      if (replies.size === methods.length) {
        client.destroy();
        resolve(replies);
      }
    });
    client.on('error', reject);
  });
}

describe('DaemonPipeServer interactive RPC budget (#2349)', () => {
  let server: DaemonPipeServer;
  let pipeName: string;

  beforeEach(async () => {
    // One frozen second: the limiter windows are 1s of Date.now(), and a batch
    // that straddled a boundary would reset the counts mid-flood.
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    pipeName = testPipeName('rate');
    server = new DaemonPipeServer(pipeName);
    server.setAuthToken(TOKEN);
    server.onRpc('daemon.ping', async () => ({ pong: true }));
    server.onRpc('task.mission.list', async () => ({ ok: true, tasks: [] }));
    server.onRpc('daemon.createSession', async () => ({ created: true }));
    server.onRpc('daemon.attachSession', async () => ({ attached: true }));
    server.onRpc('daemon.destroySession', async () => ({ destroyed: true }));
    server.onRpc('task.mission.start', async () => ({ ok: true, taskId: 't1' }));
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    vi.restoreAllMocks();
  });

  it('dispatches createSession/attachSession after a background flood used up the global budget', async () => {
    const methods = [
      ...Array.from({ length: 250 }, () => 'task.mission.list'),
      'daemon.createSession',
      'daemon.attachSession',
    ];
    const replies = await sendBatch(pipeName, methods);
    expect(replies.get('250')).toMatchObject({ ok: true, result: { created: true } });
    expect(replies.get('251')).toMatchObject({ ok: true, result: { attached: true } });
  });

  it('keeps destroySession background: a flood refuses it like any background call', async () => {
    const methods: Call[] = [
      { method: 'daemon.createSession', params: { id: 'daemon-new1' } },
      ...Array.from({ length: 250 }, () => 'task.mission.list'),
      { method: 'daemon.destroySession', params: { id: 'daemon-new1' } },
    ];
    const replies = await sendBatch(pipeName, methods);
    expect(replies.get('0')).toMatchObject({ ok: true });
    expect(replies.get('251')).toMatchObject({ ok: false, error: 'rate limited (global)' });
  });

  it('a cleanup sweep of 150 destroySession calls does not block a create', async () => {
    const methods: Call[] = [
      ...Array.from({ length: 150 }, (_, i) => ({ method: 'daemon.destroySession', params: { id: `daemon-old${i}` } })),
      ...Array.from({ length: 100 }, (_, i) => ({ method: 'daemon.createSession', params: { id: `daemon-c${i}` } })),
      ...Array.from({ length: 60 }, () => 'daemon.ping'),
    ];
    const replies = await sendBatch(pipeName, methods);
    const at = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => replies.get(String(from + k))!);
    // The sweep is served from the background budget...
    expect(at(0, 150).every((r) => r.ok)).toBe(true);
    // ...so the reserved one still has room for every create...
    expect(at(150, 250).every((r) => r.ok)).toBe(true);
    // ...and the sweep counted against the global limit: 50 more pings pass.
    const pings = at(250, 310);
    expect(pings.filter((r) => r.ok)).toHaveLength(50);
    expect(pings.filter((r) => !r.ok).every((r) => r.error === 'rate limited (global)')).toBe(true);
  });

  it('dispatches task.mission.start (the first write of a fan-out task) after a background flood used up the global budget', async () => {
    const methods = [...Array.from({ length: 250 }, () => 'task.mission.list'), 'task.mission.start'];
    const replies = await sendBatch(pipeName, methods);
    expect(replies.get('249')).toMatchObject({ ok: false, error: 'rate limited (global)' });
    expect(replies.get('250')).toMatchObject({ ok: true, result: { ok: true, taskId: 't1' } });
  });

  it('charges the aggregate cap only for dispatched calls: the refused excess of one socket leaves the others their share', async () => {
    const creates = (n: number, tag: string): Call[] =>
      Array.from({ length: n }, (_, i) => ({ method: 'daemon.createSession', params: { id: `daemon-${tag}${i}` } }));
    // A asks for 200: its own cap dispatches 100 and refuses the rest.
    const a = [...(await sendBatch(pipeName, creates(200, 'a'))).values()];
    expect(a.filter((r) => r.ok)).toHaveLength(100);
    // B still gets the other 100 of the aggregate, its first call included.
    const b = await sendBatch(pipeName, creates(100, 'b'));
    expect(b.get('0')).toMatchObject({ ok: true });
    expect([...b.values()].every((r) => r.ok)).toBe(true);
    // The aggregate is now spent.
    const c = await sendBatch(pipeName, creates(1, 'c'));
    expect(c.get('0')).toMatchObject({ ok: false, error: 'rate limited (interactive)' });
  });

  it('bounds interactive calls across all sockets by the aggregate cap, apart from background traffic', async () => {
    // Three clients, each under its own 100/s cap, 270 together: 200 pass.
    const interactive = Array.from({ length: 90 }, (_, i) => (i % 2 === 0 ? 'daemon.createSession' : 'daemon.attachSession'));
    const all: Reply[] = [];
    for (let c = 0; c < 3; c++) all.push(...(await sendBatch(pipeName, interactive)).values());
    expect(all.filter((r) => r.ok)).toHaveLength(200);
    const refused = all.filter((r) => !r.ok);
    expect(refused).toHaveLength(70);
    for (const r of refused) expect(r.error).toBe('rate limited (interactive)');
    // The interactive class neither used nor shares the background budget.
    const background = [...(await sendBatch(pipeName, Array.from({ length: 210 }, () => 'daemon.ping'))).values()];
    expect(background.filter((r) => r.ok)).toHaveLength(200);
    expect(background.filter((r) => r.error === 'rate limited (global)')).toHaveLength(10);
  });

  it('still refuses background calls past the global limit in the same second', async () => {
    // Priority, not a raised limit: 200 background calls pass, the rest are
    // refused, and interactive calls in between do not count against them.
    const methods = [
      ...Array.from({ length: 150 }, () => 'task.mission.list'),
      ...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'daemon.createSession' : 'daemon.attachSession')),
      ...Array.from({ length: 100 }, () => 'daemon.ping'),
    ];
    const replies = await sendBatch(pipeName, methods);
    const background = methods
      .map((m, i) => ({ m, r: replies.get(String(i))! }))
      .filter(({ m }) => m === 'task.mission.list' || m === 'daemon.ping');
    expect(background.filter(({ r }) => r.ok)).toHaveLength(200);
    const refused = background.filter(({ r }) => !r.ok);
    expect(refused).toHaveLength(50);
    for (const { r } of refused) expect(r.error).toBe('rate limited (global)');
    const interactive = methods
      .map((m, i) => ({ m, r: replies.get(String(i))! }))
      .filter(({ m }) => m === 'daemon.createSession' || m === 'daemon.attachSession');
    expect(interactive.every(({ r }) => r.ok)).toBe(true);
  });

  it('bounds interactive calls by their own per-socket cap', async () => {
    const methods = Array.from({ length: 150 }, (_, i) => (i % 2 === 0 ? 'daemon.createSession' : 'daemon.attachSession'));
    const replies = await sendBatch(pipeName, methods);
    const all = [...replies.values()];
    expect(all.filter((r) => r.ok)).toHaveLength(100);
    const refused = all.filter((r) => !r.ok);
    expect(refused).toHaveLength(50);
    for (const r of refused) expect(r.error).toBe('rate limited (interactive)');
    // The refused ones are the tail: the first 100 in the second are served.
    for (let i = 0; i < 100; i++) expect(replies.get(String(i))!.ok).toBe(true);
  });
});

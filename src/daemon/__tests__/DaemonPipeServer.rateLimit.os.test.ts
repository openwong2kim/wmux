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

// The phone browser stream's pushes from main: their own budget, for the
// first-party app only; frame lines up to 900 KiB arrive in many reads.
describe('DaemonPipeServer stream push budget', () => {
  let server: DaemonPipeServer;
  let pipeName: string;

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    pipeName = testPipeName('push');
    server = new DaemonPipeServer(pipeName);
    server.setAuthToken(TOKEN);
    server.onRpc('daemon.ping', async () => ({ pong: true }));
    server.onRpc('task.mission.list', async () => ({ ok: true, tasks: [] }));
    server.onRpc('test.firstParty', async (_params, ctx) => { server.markFirstParty(ctx.clientId); return { ok: true }; });
    server.onRpc('daemon.phone.browserStream', async (params) => ({ ok: true, known: true, size: String(params.data ?? '').length }));
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    vi.restoreAllMocks();
  });

  it('serves a first-party client\'s pushes after a background flood used up the global budget, up to their own cap', async () => {
    const methods: Call[] = [
      'test.firstParty',
      ...Array.from({ length: 250 }, () => 'task.mission.list'),
      ...Array.from({ length: 130 }, () => ({ method: 'daemon.phone.browserStream', params: { kind: 'ping' } })),
    ];
    const replies = await sendBatch(pipeName, methods);
    const pushes = Array.from({ length: 130 }, (_, k) => replies.get(String(251 + k))!);
    expect(pushes.slice(0, 120).every((r) => r.ok)).toBe(true);
    expect(pushes.slice(120).every((r) => r.error === 'rate limited (stream)')).toBe(true);
    // The pushes did not count against the background budget either.
    expect(replies.get('250')).toMatchObject({ ok: false, error: 'rate limited (global)' });
  });

  it('logs refused pushes at most once per 10 s per socket, with the count since the last line', async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const push = { method: 'daemon.phone.browserStream', params: { kind: 'ping' } };
    // One socket for every batch: the throttle is per socket.
    const client = net.createConnection(pipeName);
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    client.setEncoding('utf8');
    let next = 0;
    let buf = '';
    let waiting: { left: number; done: () => void } | null = null;
    client.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim() && waiting && --waiting.left === 0) waiting.done();
    });
    const batch = (calls: Call[]) => new Promise<void>((resolve) => {
      waiting = { left: calls.length, done: resolve };
      client.write(calls.map((call) => {
        const { method, params } = typeof call === 'string' ? { method: call, params: {} } : call;
        return JSON.stringify({ id: String(next++), method, params, token: TOKEN });
      }).join('\n') + '\n');
    });
    const refusalLines = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('rate limited (stream)'));
    await batch(['test.firstParty', ...Array.from({ length: 130 }, () => push)]);
    // The first refusal is reported at once; the next nine wait for the next line.
    expect(refusalLines()).toHaveLength(1);
    expect(refusalLines()[0]).toMatch(/: 1 browser stream push\(es\) refused from c\d+/);
    now += 5_000;
    await batch(Array.from({ length: 130 }, () => push));
    expect(refusalLines()).toHaveLength(1);
    now += 5_000;
    await batch(Array.from({ length: 125 }, () => push));
    // 9 + 10 since the first line, and the one that brings this line.
    expect(refusalLines()).toHaveLength(2);
    expect(refusalLines()[1]).toMatch(/: 20 browser stream push\(es\) refused/);
    // The rest of a burst is not lost when nothing is refused after it: the
    // socket's close reports it (as the window's end would).
    // The same second, its budget spent: 4 left over from the batch above and these 3.
    await batch(Array.from({ length: 3 }, () => push));
    expect(refusalLines()).toHaveLength(2);
    client.destroy();
    await vi.waitFor(() => expect(refusalLines()).toHaveLength(3), { timeout: 5_000 });
    expect(refusalLines()[2]).toMatch(/: 7 browser stream push\(es\) refused/);
  });

  it('bounds pushes across first-party sockets by the aggregate cap', async () => {
    const batch: Call[] = ['test.firstParty', ...Array.from({ length: 100 }, () => ({ method: 'daemon.phone.browserStream', params: { kind: 'ping' } }))];
    const all: Reply[] = [];
    for (let c = 0; c < 3; c++) {
      const replies = await sendBatch(pipeName, batch);
      all.push(...Array.from({ length: 100 }, (_, k) => replies.get(String(1 + k))!));
    }
    expect(all.filter((r) => r.ok)).toHaveLength(240);
    expect(all.filter((r) => !r.ok).every((r) => r.error === 'rate limited (stream)')).toBe(true);
  });

  it('charges a non-first-party client\'s pushes to the ordinary counters', async () => {
    const methods: Call[] = [
      ...Array.from({ length: 150 }, () => ({ method: 'daemon.phone.browserStream', params: { kind: 'ping' } })),
      ...Array.from({ length: 100 }, () => 'daemon.ping'),
    ];
    const all = [...(await sendBatch(pipeName, methods)).values()];
    expect(all.filter((r) => r.ok)).toHaveLength(200);
    expect(all.filter((r) => !r.ok).every((r) => r.error === 'rate limited (global)')).toBe(true);
  });

  it('reads 900 KiB lines that arrive in many reads, two of them back to back', async () => {
    const data = 'A'.repeat(900 * 1024 - 200);
    const line = (id: string) => JSON.stringify({ id, method: 'daemon.phone.browserStream', params: { kind: 'frame', data }, token: TOKEN }) + '\n';
    const replies = await new Promise<Reply[]>((resolve, reject) => {
      const got: Reply[] = [];
      const client = net.createConnection(pipeName, async () => {
        // Both lines in small pieces, the end of the first and the start of
        // the second in one write: past 1 MiB together, each under it alone.
        const both = line('a') + line('b');
        for (let i = 0; i < both.length; i += 48 * 1024) {
          client.write(both.slice(i, i + 48 * 1024));
          await new Promise((r) => setImmediate(r));
        }
      });
      let buf = '';
      client.setEncoding('utf8');
      client.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) got.push(JSON.parse(l) as Reply);
        if (got.length === 2) { client.destroy(); resolve(got); }
      });
      client.on('close', () => resolve(got));
      client.on('error', reject);
    });
    expect(replies.map((r) => [r.id, r.ok, (r.result as { size?: number } | undefined)?.size])).toEqual([['a', true, data.length], ['b', true, data.length]]);
  });

  it('still closes a connection whose line passes 1 MiB', async () => {
    const closed = await new Promise<boolean>((resolve) => {
      const client = net.createConnection(pipeName, () => {
        const big = 'x'.repeat(256 * 1024);
        for (let i = 0; i < 5; i++) client.write(big);
      });
      client.on('close', () => resolve(true));
      client.on('error', () => undefined);
      setTimeout(() => { client.destroy(); resolve(false); }, 5_000);
    });
    expect(closed).toBe(true);
  });
});

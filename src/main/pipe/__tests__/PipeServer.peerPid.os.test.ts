// PipeServer hands each request the pid the OS reports for its connection
// (shared/peerPid.ts), and that process's start time (shared/processStartTime.ts),
// read over a real socket.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { RpcRequest, RpcResponse } from '../../../shared/rpc';
import type { RpcRouter } from '../RpcRouter';

const paths = vi.hoisted(() => ({ pipe: '', token: '', port: '' }));
vi.mock('../../../shared/constants', () => ({
  getPipeName: () => paths.pipe,
  getAuthTokenPath: () => paths.token,
  getTcpPortPath: () => paths.port,
}));
vi.mock('../../../shared/security', () => ({ secureWriteTokenFile: vi.fn(), scheduleTokenFileReHarden: vi.fn() }));
const startTime = vi.hoisted(() => ({ unreadable: false }));
vi.mock('../../../shared/processStartTime', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../shared/processStartTime')>();
  return { ...real, processStartTime: (pid: number) => (startTime.unreadable ? null : real.processStartTime(pid)) };
});

import { PipeServer } from '../PipeServer';
import { processStartTime } from '../../../shared/processStartTime';
import { setBrokerIdentitySource, setBrokerStampSource } from '../handlers/peerPidShadow';

const supported = process.platform === 'darwin' || process.platform === 'linux';
let server: PipeServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
  startTime.unreadable = false;
  setBrokerIdentitySource(() => null);
  setBrokerStampSource(() => false);
});

/** One request over a real socket from this process; the dispatch mock that saw it. */
async function sendOne(extra: Record<string, unknown> = {}) {
  const id = crypto.randomBytes(4).toString('hex');
  paths.pipe = path.join(os.tmpdir(), `wmux-pipe-peer-${id}.sock`);
  paths.token = path.join(os.tmpdir(), `wmux-pipe-peer-${id}.token`);
  paths.port = path.join(os.tmpdir(), `wmux-pipe-peer-${id}.port`);
  const dispatch = vi.fn(async (request: RpcRequest): Promise<RpcResponse> => ({ id: request.id, ok: true, result: null }));
  server = new PipeServer({ dispatch } as unknown as RpcRouter);
  server.start();
  const token = server.getAuthToken();
  await vi.waitFor(() => new Promise<void>((resolve, reject) => {
    const client = net.connect(paths.pipe, () => {
      client.write(JSON.stringify({ id: 'r1', method: 'system.identify', params: {}, token, ...extra }) + '\n');
    });
    client.on('data', () => { client.destroy(); resolve(); });
    client.on('error', reject);
  }), { timeout: 5_000 });
  return dispatch;
}

/** A server and one open connection to it from this process: `send` writes
 *  raw text and resolves with the next `count` response lines. */
async function openSession() {
  const id = crypto.randomBytes(4).toString('hex');
  paths.pipe = path.join(os.tmpdir(), `wmux-pipe-peer-${id}.sock`);
  paths.token = path.join(os.tmpdir(), `wmux-pipe-peer-${id}.token`);
  paths.port = path.join(os.tmpdir(), `wmux-pipe-peer-${id}.port`);
  const dispatch = vi.fn(async (request: RpcRequest): Promise<RpcResponse> => ({ id: request.id, ok: true, result: null }));
  server = new PipeServer({ dispatch } as unknown as RpcRouter);
  server.start();
  const token = server.getAuthToken();
  const client = await vi.waitFor(() => new Promise<net.Socket>((resolve, reject) => {
    const c = net.connect(paths.pipe, () => resolve(c));
    c.on('error', reject);
  }), { timeout: 5_000 });
  let buf = '';
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  client.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    waiters.splice(0).forEach((w) => w());
  });
  const send = async (raw: string, count = 1): Promise<string[]> => {
    const start = lines.length;
    client.write(raw);
    await vi.waitFor(() => { if (lines.length < start + count) throw new Error('waiting'); }, { timeout: 5_000 });
    return lines.slice(start, start + count);
  };
  const request = (fields: Record<string, unknown>) => JSON.stringify({ id: crypto.randomBytes(3).toString('hex'), method: 'a2a.resolve.identity', params: {}, token, ...fields }) + '\n';
  return { dispatch, send, request, close: () => client.destroy() };
}

describe.runIf(supported)('PipeServer lines that are not requests', () => {
  it('answers a line that parses to null (or another non-object) and goes on with the rest of the chunk', async () => {
    const s = await openSession();
    const out = await s.send('null\n7\n"x"\n' + s.request({ id: 'after' }), 4);
    expect(out.slice(0, 3).map((l) => JSON.parse(l))).toEqual(Array(3).fill({ id: null, ok: false, error: 'Invalid request' }));
    expect(JSON.parse(out[3])).toMatchObject({ id: 'after', ok: true });
    expect(s.dispatch).toHaveBeenCalledTimes(1);
    s.close();
  });
});

describe.runIf(supported)('PipeServer peer pid', () => {
  it('dispatches with the pid of the process that connected, and its start time', async () => {
    // Values the request names for these are ignored.
    const dispatch = await sendOne({ peerPid: 1, peerStartedAt: '1', viaTcp: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), expect.objectContaining({
      externalWire: true,
      peerPid: process.pid,
      peerStartedAt: String(processStartTime(process.pid)),
    }));
    const ctx = (dispatch.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect('viaTcp' in ctx).toBe(false);
  });

  it('dispatches with the pid alone when the start time cannot be read', async () => {
    startTime.unreadable = true;
    const dispatch = await sendOne();
    const ctx = (dispatch.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(ctx.peerPid).toBe(process.pid);
    expect('peerStartedAt' in ctx).toBe(false);
  });
});

describe.runIf(supported)('PipeServer broker stamp', () => {
  const STAMP = 'c'.repeat(64);
  const asBroker = (pid: number) => {
    const startedAt = processStartTime(pid);
    setBrokerIdentitySource(() => ({ pid, startedAt: startedAt === null ? null : String(startedAt) }));
    setBrokerStampSource((stamp) => stamp === STAMP);
  };
  const seen = (dispatch: Awaited<ReturnType<typeof sendOne>>) => {
    const [request, ctx] = dispatch.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    return { request, ctx };
  };

  it('marks a call stamped when its connection is the spawned broker and the stamp is the one sent', async () => {
    asBroker(process.pid);
    const { request, ctx } = seen(await sendOne({ method: 'a2a.resolve.identity', brokerStamp: STAMP }));
    expect(ctx.brokerStamped).toBe(true);
    // Removed before dispatch: no handler sees it.
    expect('brokerStamp' in request).toBe(false);
  });

  it('does not mark a call with another stamp, or with none, from the same connection', async () => {
    asBroker(process.pid);
    const wrong = seen(await sendOne({ method: 'a2a.resolve.identity', brokerStamp: 'd'.repeat(64) }));
    expect('brokerStamped' in wrong.ctx).toBe(false);
    expect('brokerStamp' in wrong.request).toBe(false);
    server?.stop();
    const none = seen(await sendOne({ method: 'a2a.resolve.identity' }));
    expect('brokerStamped' in none.ctx).toBe(false);
  });

  it('refuses the stamp on a connection that is not the spawned broker, even when it matches', async () => {
    asBroker(process.ppid);
    const { request, ctx } = seen(await sendOne({ method: 'a2a.resolve.identity', brokerStamp: STAMP }));
    expect(ctx.peerPid).toBe(process.pid);
    expect('brokerStamped' in ctx).toBe(false);
    expect('brokerStamp' in request).toBe(false);
  });

  it('marks only a2a.resolve.identity, whatever else carries the stamp', async () => {
    asBroker(process.pid);
    const { request, ctx } = seen(await sendOne({ brokerStamp: STAMP }));
    expect(request.method).toBe('system.identify');
    expect('brokerStamped' in ctx).toBe(false);
  });

  it('does not mark a stamp that is not a string, and removes it all the same', async () => {
    asBroker(process.pid);
    for (const bad of [12345, { stamp: STAMP }, [STAMP], null, true]) {
      server?.stop();
      const { request, ctx } = seen(await sendOne({ method: 'a2a.resolve.identity', brokerStamp: bad }));
      expect('brokerStamped' in ctx, JSON.stringify(bad)).toBe(false);
      expect('brokerStamp' in request, JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps the stamp out of the response', async () => {
    asBroker(process.pid);
    const s = await openSession();
    const [line] = await s.send(s.request({ brokerStamp: STAMP }));
    expect(line).not.toContain(STAMP);
    expect(line).not.toContain('brokerStamp');
    const [request, ctx] = s.dispatch.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(ctx.brokerStamped).toBe(true);
    expect('brokerStamp' in request).toBe(false);
    s.close();
  });

  it('marks nothing on the old broker connection once the broker has restarted', async () => {
    asBroker(process.pid);
    const s = await openSession();
    await s.send(s.request({ brokerStamp: STAMP }));
    expect((s.dispatch.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1].brokerStamped).toBe(true);
    // The supervisor respawned the broker: another pid, and a new stamp.
    const NEW = 'f'.repeat(64);
    setBrokerIdentitySource(() => ({ pid: process.ppid, startedAt: String(processStartTime(process.ppid)) }));
    setBrokerStampSource((stamp) => stamp === NEW);
    await s.send(s.request({ brokerStamp: STAMP }));
    await s.send(s.request({ brokerStamp: NEW }));
    const later = s.dispatch.mock.calls.slice(1).map((c) => (c as unknown as [unknown, Record<string, unknown>])[1]);
    expect(later.map((ctx) => 'brokerStamped' in ctx)).toEqual([false, false]);
    s.close();
  });

  it('takes no stamped mark from the request itself', async () => {
    asBroker(process.ppid);
    const { ctx } = seen(await sendOne({ method: 'a2a.resolve.identity', brokerStamped: true }));
    expect('brokerStamped' in ctx).toBe(false);
  });
});

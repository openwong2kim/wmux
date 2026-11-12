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

describe.runIf(supported)('PipeServer peer pid', () => {
  it('dispatches with the pid of the process that connected, and its start time', async () => {
    const dispatch = await sendOne({ peerPid: 1, peerStartedAt: '1' });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), expect.objectContaining({
      externalWire: true,
      peerPid: process.pid,
      peerStartedAt: String(processStartTime(process.pid)),
    }));
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
    const { request, ctx } = seen(await sendOne({ brokerStamp: STAMP }));
    expect(ctx.brokerStamped).toBe(true);
    // Removed before dispatch: no handler sees it.
    expect('brokerStamp' in request).toBe(false);
  });

  it('does not mark a call with another stamp, or with none, from the same connection', async () => {
    asBroker(process.pid);
    const wrong = seen(await sendOne({ brokerStamp: 'd'.repeat(64) }));
    expect('brokerStamped' in wrong.ctx).toBe(false);
    expect('brokerStamp' in wrong.request).toBe(false);
    server?.stop();
    const none = seen(await sendOne());
    expect('brokerStamped' in none.ctx).toBe(false);
  });

  it('refuses the stamp on a connection that is not the spawned broker, even when it matches', async () => {
    asBroker(process.ppid);
    const { request, ctx } = seen(await sendOne({ brokerStamp: STAMP }));
    expect(ctx.peerPid).toBe(process.pid);
    expect('brokerStamped' in ctx).toBe(false);
    expect('brokerStamp' in request).toBe(false);
  });

  it('takes no stamped mark from the request itself', async () => {
    asBroker(process.ppid);
    const { ctx } = seen(await sendOne({ brokerStamped: true }));
    expect('brokerStamped' in ctx).toBe(false);
  });
});

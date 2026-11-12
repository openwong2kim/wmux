// Windows: a request that came over the loopback TCP fallback is marked
// ctx.viaTcp, and one over the named pipe is not (for wmux doctor's count of
// claims taken over TCP).
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
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

import { PipeServer } from '../PipeServer';

let server: PipeServer | null = null;
afterEach(() => { server?.stop(); server = null; });

function request(target: string | { host: string; port: number }, token: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const send = () => client.write(JSON.stringify({ id: 'r1', method: 'system.identify', params: {}, token }) + '\n');
    const client = typeof target === 'string' ? net.connect(target, send) : net.connect(target, send);
    client.on('data', () => { client.destroy(); resolve(); });
    client.on('error', reject);
  });
}

describe.runIf(process.platform === 'win32')('PipeServer TCP fallback', () => {
  it('marks a request over TCP, and not one over the named pipe', async () => {
    const id = crypto.randomBytes(4).toString('hex');
    paths.pipe = `\\\\.\\pipe\\wmux-viatcp-${id}`;
    paths.token = path.join(os.tmpdir(), `wmux-viatcp-${id}.token`);
    paths.port = path.join(os.tmpdir(), `wmux-viatcp-${id}.port`);
    const dispatch = vi.fn(async (req: RpcRequest): Promise<RpcResponse> => ({ id: req.id, ok: true, result: null }));
    server = new PipeServer({ dispatch } as unknown as RpcRouter);
    server.start();
    const token = server.getAuthToken();
    const port = await vi.waitFor(() => {
      const value = Number(fs.readFileSync(paths.port, 'utf8'));
      if (!Number.isInteger(value) || value <= 0) throw new Error('no port yet');
      return value;
    }, { timeout: 5_000 });

    await request({ host: '127.0.0.1', port }, token);
    await vi.waitFor(() => request(paths.pipe, token), { timeout: 5_000 });

    const [overTcp, overPipe] = dispatch.mock.calls.map((call) => (call as unknown[])[1] as Record<string, unknown>);
    expect(overTcp.viaTcp).toBe(true);
    expect('viaTcp' in overPipe).toBe(false);
    fs.rmSync(paths.port, { force: true });
  });
});

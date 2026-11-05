// PipeServer hands each request the pid the OS reports for its connection
// (shared/peerPid.ts), read over a real socket.
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

import { PipeServer } from '../PipeServer';

const supported = process.platform === 'darwin' || process.platform === 'linux';
let server: PipeServer | null = null;
afterEach(() => { server?.stop(); server = null; });

describe.runIf(supported)('PipeServer peer pid', () => {
  it('dispatches with the pid of the process that connected', async () => {
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
        client.write(JSON.stringify({ id: 'r1', method: 'system.identify', params: {}, token, peerPid: 1 }) + '\n');
      });
      client.on('data', () => { client.destroy(); resolve(); });
      client.on('error', reject);
    }), { timeout: 5_000 });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), expect.objectContaining({ externalWire: true, peerPid: process.pid }));
  });
});

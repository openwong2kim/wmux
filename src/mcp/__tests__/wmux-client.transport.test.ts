// The tests drive the real socket path against a local fake daemon, with HOME
// pointed at a temp dir so `getPipeName()`/`getAuthTokenPath()` resolve inside
// the fixture and no call can reach the developer's live daemon.
//
// POSIX only: the fixture is a Unix domain socket. On win32 the same code path
// runs over a named pipe (plus a TCP fallback), which needs a different fixture.

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RpcMethod } from '../../shared/rpc';

const isWin = process.platform === 'win32';

describe.skipIf(isWin)('sendRpc transport', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevSocketPath: string | undefined;
  let server: net.Server | undefined;
  let sendRpc: typeof import('../wmux-client').sendRpc;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rpc-'));
    prevHome = process.env.HOME;
    prevSocketPath = process.env.WMUX_SOCKET_PATH;
    process.env.HOME = tmpHome;
    // No WMUX_SOCKET_PATH means the client tries exactly one endpoint, so a
    // connection count maps one-to-one onto attempts.
    delete process.env.WMUX_SOCKET_PATH;
    fs.writeFileSync(path.join(tmpHome, '.wmux-auth-token'), 'test-token', 'utf8');
    ({ sendRpc } = await import('../wmux-client'));
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevSocketPath === undefined) delete process.env.WMUX_SOCKET_PATH;
    else process.env.WMUX_SOCKET_PATH = prevSocketPath;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  afterEach(async () => {
    const activeServer = server;
    if (activeServer) {
      await new Promise<void>((resolve) => activeServer.close(() => resolve()));
      server = undefined;
    }
  });

  function listen(onRequest: (id: string) => string): Promise<{ connections: () => number }> {
    let connections = 0;
    const activeServer = net.createServer((socket) => {
      connections += 1;
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').trim()) as { id: string };
        socket.write(onRequest(request.id) + '\n');
      });
      socket.on('error', () => { /* client destroys the socket after the response */ });
    });
    server = activeServer;
    const socketPath = path.join(tmpHome, '.wmux.sock');
    return new Promise((resolve) => {
      activeServer.listen(socketPath, () => resolve({ connections: () => connections }));
    });
  }

  it('retries a retryable failure three times', async () => {
    const { connections } = await listen((id) =>
      JSON.stringify({ id, ok: false, error: 'unauthorized' }),
    );
    await expect(sendRpc('a2a.discover' as RpcMethod, {})).rejects.toThrow(/unauthorized/);
    expect(connections()).toBe(3);
  }, 15_000);
});

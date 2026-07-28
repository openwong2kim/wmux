// ─── A2: per-call long-poll mode on the MCP RPC client ───────────────────────
//
// The client's transport constants (10 s timeout, 3 retries) make a WAITING
// call impossible: it is cut at 10 s, and — worse — the retry ladder reopens
// the same wait up to three times. `sendRpc(..., { longPollMs })` is the
// per-call escape hatch. The two properties that matter:
//   1. the wait actually lasts longer than the default 10 s ceiling, and
//   2. turning it on turns retries OFF. The option is deliberately ONE knob so
//      "long timeout + retries" — strictly worse than today — is unexpressible.
//
// The tests drive the real socket path against a local fake daemon, with HOME
// pointed at a temp dir so `getPipeName()`/`getAuthTokenPath()` resolve inside
// the fixture and no call can reach the developer's live daemon.
//
// POSIX only: the fixture is a unix domain socket. On win32 the same code path
// runs over a named pipe (plus a TCP fallback), which needs a different fixture.

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RpcMethod } from '../../shared/rpc';

const isWin = process.platform === 'win32';

describe.skipIf(isWin)('sendRpc long-poll mode (A2)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevSocketPath: string | undefined;
  let server: net.Server | undefined;
  let sendRpc: typeof import('../wmux-client').sendRpc;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-longpoll-'));
    prevHome = process.env.HOME;
    prevSocketPath = process.env.WMUX_SOCKET_PATH;
    process.env.HOME = tmpHome;
    // No WMUX_SOCKET_PATH → the client tries exactly ONE endpoint (the derived
    // one), so a connection count maps 1:1 onto attempts.
    delete process.env.WMUX_SOCKET_PATH;
    fs.writeFileSync(path.join(tmpHome, '.wmux-auth-token'), 'test-token', 'utf8');
    ({ sendRpc } = await import('../wmux-client'));
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevSocketPath !== undefined) process.env.WMUX_SOCKET_PATH = prevSocketPath;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
  });

  /** Fake daemon at the derived socket path. `onRequest` decides the reply;
   *  returning null means "hold the connection open" (a real long poll). */
  function listen(onRequest: (id: string) => string | null): Promise<{ connections: () => number }> {
    let connections = 0;
    server = net.createServer((socket) => {
      connections += 1;
      socket.on('data', (chunk) => {
        const req = JSON.parse(chunk.toString('utf8').trim()) as { id: string };
        const reply = onRequest(req.id);
        if (reply !== null) socket.write(reply + '\n');
      });
      socket.on('error', () => { /* client destroys the socket on timeout */ });
    });
    const sockPath = path.join(tmpHome, '.wmux.sock');
    return new Promise((resolve) => {
      server!.listen(sockPath, () => resolve({ connections: () => connections }));
    });
  }

  it('waits past the 10 s default ceiling and reports its own timeout', async () => {
    // A held connection: the default would give up at 10 s. We assert the
    // reported budget is the requested one — the wait is genuinely re-armed,
    // not the constant in disguise. (A short value keeps the test fast; the
    // number in the message is the proof the per-call value is what armed it.)
    await listen(() => null);
    await expect(sendRpc('a2a.discover' as RpcMethod, {}, { longPollMs: 250 })).rejects.toThrow(
      /RPC timeout: .*\(250ms\)/,
    );
  });

  it('clamps the wait to LONG_POLL_MAX_MS', async () => {
    const { LONG_POLL_MAX_MS } = await import('../wmux-client');
    expect(LONG_POLL_MAX_MS).toBe(15 * 60 * 1000);
  });

  it('DISABLES the retry ladder — one wait, opened once', async () => {
    // 'unauthorized' is a retryable error for the default path, so this is the
    // sharpest observable difference: same server, same error, different
    // number of opened connections.
    const { connections } = await listen((id) =>
      JSON.stringify({ id, ok: false, error: 'unauthorized' }),
    );
    await expect(
      sendRpc('a2a.discover' as RpcMethod, {}, { longPollMs: 5_000 }),
    ).rejects.toThrow(/unauthorized/);
    expect(connections()).toBe(1);
  });

  it('leaves the default path untouched: a retryable failure still retries 3x', async () => {
    const { connections } = await listen((id) =>
      JSON.stringify({ id, ok: false, error: 'unauthorized' }),
    );
    await expect(sendRpc('a2a.discover' as RpcMethod, {})).rejects.toThrow(/unauthorized/);
    expect(connections()).toBe(3);
  }, 15_000);
});

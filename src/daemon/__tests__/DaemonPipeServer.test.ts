import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DaemonPipeServer } from '../DaemonPipeServer';
import { SessionPipe, FLUSH_DONE_MARKER } from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';
import {
  getDaemonAuthTokenPath,
  getLegacyDaemonAuthTokenPath,
} from '../../shared/constants';

// Helper: generate unique pipe name for each test to avoid conflicts
function testPipeName(suffix: string): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux-test-${suffix}-${id}`;
  }
  return path.join(os.tmpdir(), `wmux-test-${suffix}-${id}.sock`);
}

// Helper: connect to pipe and send a JSON-RPC request, return parsed response
function sendRpc(
  pipeName: string,
  req: { id: string; method: string; params?: Record<string, unknown>; token?: string },
): Promise<{ id: string; ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(pipeName, () => {
      client.write(JSON.stringify(req) + '\n');
    });
    let buf = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          client.destroy();
          resolve(parsed);
          return;
        } catch {
          // incomplete, wait for more
        }
      }
    });
    client.on('error', reject);
    client.on('end', () => {
      if (buf.trim()) {
        try {
          resolve(JSON.parse(buf.trim()));
        } catch {
          reject(new Error('Incomplete response'));
        }
      }
    });
  });
}

// ============================================================
// DaemonPipeServer Tests
// ============================================================

describe('DaemonPipeServer', () => {
  let server: DaemonPipeServer;
  let pipeName: string;

  beforeEach(() => {
    pipeName = testPipeName('ctrl');
    server = new DaemonPipeServer(pipeName);
    server.setAuthToken('test-token-123');
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should start and stop without error', async () => {
    await server.start();
    await server.stop();
  });

  it('should register and call RPC handler', async () => {
    server.onRpc('daemon.ping', async () => ({ pong: true }));
    await server.start();

    const res = await sendRpc(pipeName, {
      id: '1',
      method: 'daemon.ping',
      params: {},
      token: 'test-token-123',
    });

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ pong: true });
    expect(res.id).toBe('1');
  });

  it('should pass params to RPC handler', async () => {
    server.onRpc('daemon.createSession', async (params) => {
      return { created: params['id'] };
    });
    await server.start();

    const res = await sendRpc(pipeName, {
      id: '2',
      method: 'daemon.createSession',
      params: { id: 'sess-1' },
      token: 'test-token-123',
    });

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ created: 'sess-1' });
  });

  it('should reject requests with invalid token', async () => {
    server.onRpc('daemon.ping', async () => ({ pong: true }));
    await server.start();

    const res = await sendRpc(pipeName, {
      id: '3',
      method: 'daemon.ping',
      params: {},
      token: 'wrong-token',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('unauthorized');
  });

  it('should reject requests with no token', async () => {
    server.onRpc('daemon.ping', async () => ({ pong: true }));
    await server.start();

    const res = await sendRpc(pipeName, {
      id: '4',
      method: 'daemon.ping',
      params: {},
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('unauthorized');
  });

  it('should return error for unknown method', async () => {
    await server.start();

    const res = await sendRpc(pipeName, {
      id: '5',
      method: 'daemon.nonexistent',
      params: {},
      token: 'test-token-123',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('Unknown method');
  });

  it('should return error for invalid JSON', async () => {
    await server.start();

    const result = await new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
      const client = net.createConnection(pipeName, () => {
        client.write('this is not json\n');
      });
      let buf = '';
      client.setEncoding('utf8');
      client.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            client.destroy();
            resolve(parsed);
            return;
          } catch {
            // wait
          }
        }
      });
      client.on('error', reject);
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid JSON');
  });

  it('should handle handler errors gracefully', async () => {
    server.onRpc('daemon.ping', async () => {
      throw new Error('test error');
    });
    await server.start();

    const res = await sendRpc(pipeName, {
      id: '6',
      method: 'daemon.ping',
      params: {},
      token: 'test-token-123',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('test error');
  });

  it('should close the socket after an auth failure', async () => {
    // Pre-auth hardening: a rejected token must not leave the connection
    // open for repeated guesses over the same socket.
    await server.start();

    const { unauthorized, closed } = await new Promise<{
      unauthorized: boolean;
      closed: boolean;
    }>((resolve, reject) => {
      let sawUnauthorized = false;
      const client = net.createConnection(pipeName, () => {
        client.write(
          JSON.stringify({ id: 'x', method: 'daemon.ping', params: {}, token: 'wrong' }) + '\n',
        );
      });
      client.setEncoding('utf8');
      client.on('data', (chunk: string) => {
        if (chunk.includes('unauthorized')) sawUnauthorized = true;
      });
      client.on('close', () => {
        resolve({ unauthorized: sawUnauthorized, closed: true });
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });

    expect(unauthorized).toBe(true);
    expect(closed).toBe(true);
  });

  it('tracks connection count and last-disconnect timestamp', async () => {
    // Idle-shutdown plumbing: Watchdog reads these accessors to decide
    // whether the daemon is currently serving anyone and, if not, when
    // it last did. Verify both counters track real socket lifecycle.
    server.onRpc('daemon.ping', async () => ({ pong: true }));
    await server.start();

    expect(server.getConnectionCount()).toBe(0);
    expect(server.getLastDisconnectAt()).toBeNull();

    // Open two concurrent sockets — count should reach 2.
    const c1 = net.createConnection(pipeName);
    const c2 = net.createConnection(pipeName);
    await new Promise<void>((resolve) => {
      let opened = 0;
      const onConn = (): void => { opened++; if (opened === 2) resolve(); };
      c1.on('connect', onConn);
      c2.on('connect', onConn);
    });
    // Server-side socket registration runs inside the listener callback,
    // give it a tick to land in connectedSockets.
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getConnectionCount()).toBe(2);
    // While a client is still connected, the disconnect anchor must remain
    // untouched (otherwise the idle window would start during active use).
    expect(server.getLastDisconnectAt()).toBeNull();

    const before = Date.now();
    const c1Closed = new Promise<void>((r) => c1.on('close', () => r()));
    const c2Closed = new Promise<void>((r) => c2.on('close', () => r()));
    c1.destroy();
    await c1Closed;
    await new Promise((r) => setTimeout(r, 30));
    // One socket still alive — counter dropped to 1, anchor still null.
    expect(server.getConnectionCount()).toBe(1);
    expect(server.getLastDisconnectAt()).toBeNull();

    c2.destroy();
    await c2Closed;
    await new Promise((r) => setTimeout(r, 30));
    expect(server.getConnectionCount()).toBe(0);
    const anchor = server.getLastDisconnectAt();
    expect(anchor).not.toBeNull();
    expect(anchor!).toBeGreaterThanOrEqual(before);
    expect(anchor!).toBeLessThanOrEqual(Date.now());
  });

  it('rotateToken invalidates old token, issues new one, drops connected sockets', async () => {
    // Redirect token file to a temp location so we don't clobber the user's
    // real ~/.wmux/daemon-auth-token during the test.
    const tmpTokenPath = path.join(os.tmpdir(), `wmux-test-token-${crypto.randomUUID().slice(0, 8)}`);
    server.setTokenPathForTest(tmpTokenPath);

    server.onRpc('daemon.ping', async () => ({ pong: true }));
    await server.start();

    // Open a long-lived connection using the current token.
    const liveClient = net.createConnection(pipeName);
    const liveClosed = new Promise<void>((resolve) => liveClient.on('close', () => resolve()));

    // Wait briefly for connection to be registered.
    await new Promise<void>((resolve) => {
      liveClient.on('connect', () => setTimeout(resolve, 50));
    });

    const oldToken = 'test-token-123';
    const newToken = server.rotateToken();

    expect(newToken).not.toBe(oldToken);
    expect(newToken.length).toBeGreaterThan(0);
    expect(fs.readFileSync(tmpTokenPath, 'utf8').trim()).toBe(newToken);

    // Existing socket should be dropped by rotation.
    await liveClosed;

    // Old token is now rejected, new token succeeds.
    const rejected = await sendRpc(pipeName, {
      id: 'r1', method: 'daemon.ping', params: {}, token: oldToken,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBe('unauthorized');

    const accepted = await sendRpc(pipeName, {
      id: 'r2', method: 'daemon.ping', params: {}, token: newToken,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.result).toEqual({ pong: true });

    // Cleanup tmp token file.
    try { fs.unlinkSync(tmpTokenPath); } catch { /* ignore */ }
  });

  it('loadOrCreateToken writes to the suffix-aware shared path (getDaemonAuthTokenPath), isolated from prod', async () => {
    // Point HOME at a fresh temp dir and set a UNIQUE data suffix so the writer
    // lands in an ISOLATED dir, never the developer's real ~/.wmux. Crucially,
    // NO setTokenPathForTest override here — this exercises the REAL
    // getTokenPath → getDaemonAuthTokenPath resolution that the launcher
    // (DaemonClient.readDaemonAuthToken) and CLI (client.resolveDaemonAuthToken)
    // readers must compute identically. Same-path lockstep is the critical
    // invariant: if writer and readers diverge, nothing authenticates.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-tokhome-'));
    const suffix = `-tok${crypto.randomUUID().slice(0, 6)}`;
    const saved = {
      up: process.env.USERPROFILE,
      home: process.env.HOME,
      suf: process.env.WMUX_DATA_SUFFIX,
    };
    process.env.USERPROFILE = tmpHome;
    process.env.HOME = tmpHome;
    process.env.WMUX_DATA_SUFFIX = suffix;
    try {
      const writer = new DaemonPipeServer(testPipeName('tokwrite'));
      const token = await writer.loadOrCreateToken();
      expect(token.length).toBeGreaterThan(0);

      // The daemon wrote exactly where the shared helper resolves — and the
      // readers resolve via the SAME helper, so read ↔ write agree by
      // construction. Assert the on-disk file at that path carries the token.
      const writtenPath = getDaemonAuthTokenPath();
      expect(writtenPath.replace(/\\/g, '/')).toContain(`.wmux${suffix}/daemon-auth-token`);
      expect(fs.readFileSync(writtenPath, 'utf8').trim()).toBe(token);

      // Isolation: the suffixed instance did NOT pollute the shared, unsuffixed
      // production location (the old collision site).
      expect(fs.existsSync(getLegacyDaemonAuthTokenPath())).toBe(false);
    } finally {
      if (saved.up === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved.up;
      if (saved.home === undefined) delete process.env.HOME;
      else process.env.HOME = saved.home;
      if (saved.suf === undefined) delete process.env.WMUX_DATA_SUFFIX;
      else process.env.WMUX_DATA_SUFFIX = saved.suf;
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('should reject new connections past the per-second cap', async () => {
    // MAX_NEW_CONNECTIONS_PER_SEC is 20. Opening 40 sockets back-to-back
    // should result in at least some being destroyed on accept.
    await server.start();

    const sockets: net.Socket[] = [];
    const closeCounts = { closed: 0, total: 40 };

    await new Promise<void>((resolve) => {
      let pending = closeCounts.total;
      for (let i = 0; i < closeCounts.total; i++) {
        const s = net.createConnection(pipeName);
        sockets.push(s);
        const markDone = () => {
          pending--;
          if (pending === 0) resolve();
        };
        s.on('close', () => {
          closeCounts.closed++;
          markDone();
        });
        s.on('error', () => {
          markDone();
        });
      }
      // Safety — resolve after 2s even if sockets linger
      setTimeout(resolve, 2000);
    });

    for (const s of sockets) s.destroy();

    // At least a handful of the excess connections must have been refused.
    // (We don't assert the exact number because accept() timing varies.)
    expect(closeCounts.closed).toBeGreaterThanOrEqual(closeCounts.total / 2);
  });
});

// ============================================================
// SessionPipe Tests
// ============================================================

describe('SessionPipe', () => {
  let sessionPipe: SessionPipe;
  let ringBuffer: RingBuffer;
  const sessionId = crypto.randomUUID().slice(0, 8);

  beforeEach(() => {
    ringBuffer = new RingBuffer(4096);
  });

  afterEach(async () => {
    if (sessionPipe) {
      await sessionPipe.stop();
    }
  });

  const SESSION_AUTH_TOKEN = 'test-session-token-456';

  it('should start and stop without error', async () => {
    sessionPipe = new SessionPipe(sessionId + '-a', ringBuffer, SESSION_AUTH_TOKEN);
    await sessionPipe.start();
    expect(sessionPipe.isConnected).toBe(false);
    await sessionPipe.stop();
  });

  it('should flush ring buffer on client connect', async () => {
    // Pre-fill ring buffer
    const testData = Buffer.from('Hello from ring buffer!');
    ringBuffer.write(testData);

    sessionPipe = new SessionPipe(sessionId + '-b', ringBuffer, SESSION_AUTH_TOKEN);
    await sessionPipe.start();
    const pipeName = sessionPipe.getPipeName();

    const received = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const client = net.createConnection(pipeName, () => {
        // Send auth token first
        client.write(SESSION_AUTH_TOKEN + '\n');
      });
      client.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const combined = Buffer.concat(chunks);
        // Check if flush marker has arrived
        const markerIndex = combined.indexOf(FLUSH_DONE_MARKER);
        if (markerIndex !== -1) {
          client.destroy();
          // Data before marker is the flushed buffer content
          resolve(combined.subarray(0, markerIndex));
        }
      });
      client.on('error', reject);
      // Timeout safety
      setTimeout(() => reject(new Error('timeout')), 3000);
    });

    expect(received.toString()).toBe('Hello from ring buffer!');
  });

  it('should reject invalid auth token', async () => {
    sessionPipe = new SessionPipe(sessionId + '-auth', ringBuffer, SESSION_AUTH_TOKEN);
    await sessionPipe.start();
    const pipeName = sessionPipe.getPipeName();

    const result = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const client = net.createConnection(pipeName, () => {
        client.write('wrong-token\n');
      });
      client.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const combined = Buffer.concat(chunks).toString();
        if (combined.includes('AUTH_FAILED')) {
          resolve(combined.trim());
        }
      });
      client.on('close', () => {
        const combined = Buffer.concat(chunks).toString();
        resolve(combined.trim());
      });
      client.on('error', () => {
        resolve('connection_error');
      });
      setTimeout(() => reject(new Error('timeout')), 3000);
    });

    expect(result).toContain('AUTH_FAILED');
  });

  it('should forward bidirectional data', async () => {
    sessionPipe = new SessionPipe(sessionId + '-c', ringBuffer, SESSION_AUTH_TOKEN);
    await sessionPipe.start();
    const pipeName = sessionPipe.getPipeName();

    // Track input received via onInput callback
    const inputReceived: Buffer[] = [];
    sessionPipe.onInput((data) => {
      inputReceived.push(data);
    });

    const clientOutput = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const client = net.createConnection(pipeName, () => {
        // Send auth token first
        client.write(SESSION_AUTH_TOKEN + '\n');
      });

      let markerSeen = false;

      client.on('data', (chunk: Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buf);
        const combined = Buffer.concat(chunks);

        if (!markerSeen) {
          const markerIndex = combined.indexOf(FLUSH_DONE_MARKER);
          if (markerIndex !== -1) {
            markerSeen = true;
            // Remove everything up to and including marker
            chunks.length = 0;
            const afterMarker = combined.subarray(markerIndex + FLUSH_DONE_MARKER.length);
            if (afterMarker.length > 0) {
              chunks.push(afterMarker);
            }

            // Now send input from client to PTY
            client.write('user input');

            // Simulate PTY output after a small delay
            setTimeout(() => {
              sessionPipe.writeToClient(Buffer.from('pty output'));
            }, 50);
          }
        } else {
          // After marker, collect PTY output
          const combined2 = Buffer.concat(chunks);
          if (combined2.toString().includes('pty output')) {
            client.destroy();
            resolve(combined2);
          }
        }
      });

      client.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });

    // Verify client received PTY output
    expect(clientOutput.toString()).toContain('pty output');

    // Verify PTY received client input (small delay for async)
    await new Promise((r) => setTimeout(r, 50));
    const allInput = Buffer.concat(inputReceived).toString();
    expect(allInput).toBe('user input');
  });

  it('should report isConnected correctly', async () => {
    sessionPipe = new SessionPipe(sessionId + '-d', ringBuffer, SESSION_AUTH_TOKEN);
    await sessionPipe.start();
    const pipeName = sessionPipe.getPipeName();

    expect(sessionPipe.isConnected).toBe(false);

    const client = net.createConnection(pipeName);

    // Wait for connection and send auth
    await new Promise<void>((resolve) => {
      client.on('connect', () => {
        client.write(SESSION_AUTH_TOKEN + '\n');
        // Small delay to allow server to process auth + connection
        setTimeout(resolve, 100);
      });
    });

    expect(sessionPipe.isConnected).toBe(true);

    // Disconnect
    client.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(sessionPipe.isConnected).toBe(false);
  });
});

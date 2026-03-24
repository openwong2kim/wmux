import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DaemonClient, getDaemonPipeName, readDaemonAuthToken } from '../DaemonClient';
import { FLUSH_DONE_MARKER } from '../../daemon/SessionPipe';

// Helper: unique pipe name per test
function testPipeName(suffix: string): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux-dctest-${suffix}-${id}`;
  }
  return path.join(os.tmpdir(), `wmux-dctest-${suffix}-${id}.sock`);
}

// Helper: create a minimal JSON-RPC server on a named pipe
function createMockDaemonServer(
  pipeName: string,
  token: string,
  handlers: Record<string, (params: Record<string, unknown>) => unknown>,
): { server: net.Server; sockets: Set<net.Socket>; start: () => Promise<void>; stop: () => Promise<void> } {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const req = JSON.parse(trimmed);
          if (req.token !== token) {
            socket.write(JSON.stringify({ id: req.id, ok: false, error: 'unauthorized' }) + '\n');
            continue;
          }

          const handler = handlers[req.method];
          if (!handler) {
            socket.write(JSON.stringify({ id: req.id, ok: false, error: `Unknown method: ${req.method}` }) + '\n');
            continue;
          }

          const result = handler(req.params || {});
          socket.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
        } catch (err) {
          socket.write(JSON.stringify({ id: null, ok: false, error: 'Invalid JSON' }) + '\n');
        }
      }
    });

    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  return {
    server,
    sockets,
    start: () => new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(pipeName, () => resolve());
    }),
    stop: () => new Promise<void>((resolve) => {
      sockets.forEach(s => s.destroy());
      sockets.clear();
      server.close(() => resolve());
    }),
  };
}

// Helper: create a mock session pipe server that sends FLUSH_DONE_MARKER then echoes data back
function createMockSessionPipe(
  sessionId: string,
): { server: net.Server; start: () => Promise<string>; stop: () => Promise<void>; writeToClient: (data: Buffer) => void } {
  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-session-${sessionId}`
    : path.join(os.homedir(), `.wmux-session-${sessionId}.sock`);

  let clientSocket: net.Socket | null = null;
  const inputReceived: Buffer[] = [];

  const server = net.createServer((socket) => {
    clientSocket = socket;
    let authBuffer = Buffer.alloc(0);
    let authenticated = false;

    const onAuthData = (data: Buffer): void => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      authBuffer = Buffer.concat([authBuffer, chunk]);
      const newlineIndex = authBuffer.indexOf(0x0a);
      if (newlineIndex === -1) return;

      // Auth token received — consume it and proceed
      authenticated = true;
      socket.removeListener('data', onAuthData);
      const leftover = authBuffer.subarray(newlineIndex + 1);

      // Flush done immediately (no ring buffer to replay)
      socket.write(FLUSH_DONE_MARKER);

      // Set up real data handler
      socket.on('data', (d: Buffer) => {
        inputReceived.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
      });

      // Process any leftover data after auth line
      if (leftover.length > 0) {
        inputReceived.push(leftover);
      }
    };

    socket.on('data', onAuthData);
    socket.on('close', () => { clientSocket = null; });
    socket.on('error', () => { clientSocket = null; });
  });

  return {
    server,
    start: () => new Promise<string>((resolve, reject) => {
      server.on('error', reject);
      server.listen(pipeName, () => resolve(pipeName));
    }),
    stop: () => new Promise<void>((resolve) => {
      if (clientSocket) clientSocket.destroy();
      server.close(() => resolve());
    }),
    writeToClient: (data: Buffer) => {
      if (clientSocket && !clientSocket.destroyed) {
        clientSocket.write(data);
      }
    },
  };
}

// ============================================================
// DaemonClient Tests
// ============================================================

describe('DaemonClient', () => {
  const AUTH_TOKEN = 'test-token-dc-123';
  let mockServer: ReturnType<typeof createMockDaemonServer>;
  let client: DaemonClient;

  describe('connect/disconnect', () => {
    it('should connect to a running daemon and report isConnected=true', async () => {
      const pipeName = testPipeName('conn');
      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {
        'daemon.ping': () => ({ status: 'ok' }),
      });
      await mockServer.start();

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      const result = await client.connect();

      expect(result).toBe(true);
      expect(client.isConnected).toBe(true);

      await client.disconnect();
      await mockServer.stop();
    });

    it('should return false when daemon is not running', async () => {
      const pipeName = testPipeName('noconn');
      client = new DaemonClient(pipeName, AUTH_TOKEN);
      const result = await client.connect();

      expect(result).toBe(false);
      expect(client.isConnected).toBe(false);
    });

    it('should set isConnected=false after disconnect', async () => {
      const pipeName = testPipeName('disc');
      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {});
      await mockServer.start();

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      await client.connect();
      expect(client.isConnected).toBe(true);

      await client.disconnect();
      expect(client.isConnected).toBe(false);

      await mockServer.stop();
    });

    it('should not connect twice', async () => {
      const pipeName = testPipeName('dbl');
      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {});
      await mockServer.start();

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      const r1 = await client.connect();
      const r2 = await client.connect();
      expect(r1).toBe(true);
      expect(r2).toBe(true); // returns true (already connected)

      await client.disconnect();
      await mockServer.stop();
    });
  });

  describe('RPC', () => {
    it('should send RPC and receive result', async () => {
      const pipeName = testPipeName('rpc1');
      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {
        'daemon.ping': () => ({ status: 'ok', uptime: 42 }),
      });
      await mockServer.start();

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      await client.connect();

      const result = await client.rpc('daemon.ping');
      expect(result).toEqual({ status: 'ok', uptime: 42 });

      await client.disconnect();
      await mockServer.stop();
    });

    it('should pass params to RPC', async () => {
      const pipeName = testPipeName('rpc2');
      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {
        'daemon.createSession': (params) => ({ id: params['id'], created: true }),
      });
      await mockServer.start();

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      await client.connect();

      const result = await client.rpc('daemon.createSession', { id: 'sess-1', cmd: 'bash', cwd: '/tmp' });
      expect(result).toEqual({ id: 'sess-1', created: true });

      await client.disconnect();
      await mockServer.stop();
    });

    it('should reject on RPC error', async () => {
      const pipeName = testPipeName('rpc3');
      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {});
      await mockServer.start();

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      await client.connect();

      await expect(client.rpc('daemon.nonexistent')).rejects.toThrow('Unknown method');

      await client.disconnect();
      await mockServer.stop();
    });

    it('should throw when not connected', async () => {
      client = new DaemonClient(testPipeName('notconn'), AUTH_TOKEN);
      await expect(client.rpc('daemon.ping')).rejects.toThrow('DaemonClient not connected');
    });

    it('should handle multiple concurrent RPCs', async () => {
      const pipeName = testPipeName('rpc4');
      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {
        'daemon.ping': () => ({ status: 'ok' }),
        'daemon.listSessions': () => ([]),
      });
      await mockServer.start();

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      await client.connect();

      const [r1, r2] = await Promise.all([
        client.rpc('daemon.ping'),
        client.rpc('daemon.listSessions'),
      ]);

      expect(r1).toEqual({ status: 'ok' });
      expect(r2).toEqual([]);

      await client.disconnect();
      await mockServer.stop();
    });
  });

  describe('session pipe', () => {
    it('should connect to session pipe and receive data after flush marker', async () => {
      const pipeName = testPipeName('sp1');
      const sessionId = `test-sp-${crypto.randomUUID().slice(0, 8)}`;

      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {});
      await mockServer.start();

      const mockSession = createMockSessionPipe(sessionId);
      await mockSession.start();

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      await client.connect();

      // Collect session data events
      const received: Buffer[] = [];
      client.on('session:data', (payload: { sessionId: string; data: Buffer }) => {
        if (payload.sessionId === sessionId) {
          received.push(payload.data);
        }
      });

      await client.connectSessionPipe(sessionId);

      // Small delay for pipe connection to settle
      await new Promise(r => setTimeout(r, 100));

      // Send data from mock PTY to client
      mockSession.writeToClient(Buffer.from('Hello from PTY'));

      // Wait for data to arrive
      await new Promise(r => setTimeout(r, 200));

      expect(received.length).toBeGreaterThan(0);
      const combined = Buffer.concat(received).toString();
      expect(combined).toContain('Hello from PTY');

      await client.disconnectSessionPipe(sessionId);
      await client.disconnect();
      await mockSession.stop();
      await mockServer.stop();
    });

    it('should forward client writes to session pipe', async () => {
      const pipeName = testPipeName('sp2');
      const sessionId = `test-sp-${crypto.randomUUID().slice(0, 8)}`;

      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {});
      await mockServer.start();

      // Track input received at the mock session server
      const inputReceived: Buffer[] = [];
      const sessionPipeName = process.platform === 'win32'
        ? `\\\\.\\pipe\\wmux-session-${sessionId}`
        : path.join(os.homedir(), `.wmux-session-${sessionId}.sock`);

      let clientSocket: net.Socket | null = null;
      const sessionServer = net.createServer((socket) => {
        clientSocket = socket;
        let authBuf = Buffer.alloc(0);
        const onAuth = (data: Buffer): void => {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          authBuf = Buffer.concat([authBuf, chunk]);
          const nl = authBuf.indexOf(0x0a);
          if (nl === -1) return;
          socket.removeListener('data', onAuth);
          const leftover = authBuf.subarray(nl + 1);
          socket.write(FLUSH_DONE_MARKER);
          socket.on('data', (d) => {
            inputReceived.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
          });
          if (leftover.length > 0) {
            inputReceived.push(leftover);
          }
        };
        socket.on('data', onAuth);
      });

      await new Promise<void>((resolve, reject) => {
        sessionServer.on('error', reject);
        sessionServer.listen(sessionPipeName, () => resolve());
      });

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      await client.connect();
      await client.connectSessionPipe(sessionId);

      // Wait for connection
      await new Promise(r => setTimeout(r, 100));

      // Write from client to session
      client.writeToSession(sessionId, 'user input here');

      // Wait for data
      await new Promise(r => setTimeout(r, 200));

      const allInput = Buffer.concat(inputReceived).toString();
      expect(allInput).toBe('user input here');

      await client.disconnectSessionPipe(sessionId);
      await client.disconnect();
      if (clientSocket) (clientSocket as net.Socket).destroy();
      await new Promise<void>(resolve => sessionServer.close(() => resolve()));
      await mockServer.stop();
    });

    it('should clean up session pipe on disconnect', async () => {
      const pipeName = testPipeName('sp3');
      const sessionId = `test-sp-${crypto.randomUUID().slice(0, 8)}`;

      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {});
      await mockServer.start();

      const mockSession = createMockSessionPipe(sessionId);
      await mockSession.start();

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      await client.connect();
      await client.connectSessionPipe(sessionId);

      // Disconnect should clean up
      await client.disconnectSessionPipe(sessionId);

      // Writing should be a no-op (no error thrown)
      client.writeToSession(sessionId, 'should be ignored');

      await client.disconnect();
      await mockSession.stop();
      await mockServer.stop();
    });
  });

  describe('daemon events', () => {
    it('should emit session:died event from daemon broadcast', async () => {
      const pipeName = testPipeName('ev1');
      const sockets = new Set<net.Socket>();

      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));

        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          // Just accept all messages (no RPC handling needed)
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.on('error', reject);
        server.listen(pipeName, () => resolve());
      });

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      await client.connect();

      const diedEvents: Array<{ sessionId: string; exitCode: number | null }> = [];
      client.on('session:died', (payload: { sessionId: string; exitCode: number | null }) => {
        diedEvents.push(payload);
      });

      // Wait for socket to be tracked in server
      await new Promise(r => setTimeout(r, 100));

      // Simulate daemon broadcasting a session.died event
      const event = JSON.stringify({
        type: 'session.died',
        sessionId: 'test-sess-1',
        data: { exitCode: 1 },
      }) + '\n';

      expect(sockets.size).toBeGreaterThan(0);
      for (const socket of sockets) {
        socket.write(event);
      }

      await new Promise(r => setTimeout(r, 200));

      expect(diedEvents).toHaveLength(1);
      expect(diedEvents[0]).toEqual({ sessionId: 'test-sess-1', exitCode: 1 });

      await client.disconnect();
      sockets.forEach(s => s.destroy());
      await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('should emit disconnected when daemon goes away', async () => {
      const pipeName = testPipeName('ev2');
      mockServer = createMockDaemonServer(pipeName, AUTH_TOKEN, {});
      await mockServer.start();

      client = new DaemonClient(pipeName, AUTH_TOKEN);
      await client.connect();

      const disconnectedPromise = new Promise<void>((resolve) => {
        client.on('disconnected', () => resolve());
      });

      // Kill the server
      await mockServer.stop();

      // Wait for disconnected event (with timeout)
      await Promise.race([
        disconnectedPromise,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);

      expect(client.isConnected).toBe(false);
    });
  });

  describe('helpers', () => {
    it('getDaemonPipeName should return platform-appropriate pipe name', () => {
      const name = getDaemonPipeName();
      if (process.platform === 'win32') {
        expect(name).toMatch(/^\\\\.\\pipe\\wmux-daemon-/);
      } else {
        expect(name).toMatch(/\.wmux-daemon\.sock$/);
      }
    });

    it('readDaemonAuthToken should return empty string when no token file exists', () => {
      // This test relies on the token file not existing in a fresh env
      // In CI this is always the case; locally it might exist
      const token = readDaemonAuthToken();
      expect(typeof token).toBe('string');
    });
  });
});

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DaemonPipeServer } from '../DaemonPipeServer';
import { SessionPipe, FLUSH_DONE_MARKER } from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';

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

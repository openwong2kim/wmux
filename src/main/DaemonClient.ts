import net from 'node:net';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { RpcResponse, DaemonEvent } from '../shared/rpc';
import { FLUSH_DONE_MARKER } from '../daemon/SessionPipe';

const RPC_TIMEOUT_MS = 10_000;
const MAX_LINE_BUFFER = 1024 * 1024; // 1 MB

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Client for connecting to wmux-daemon from the Electron main process.
 * Communicates over Named Pipe (Windows) / Unix domain socket using JSON-RPC.
 *
 * Events:
 *   'session:data'   — { sessionId: string, data: Buffer }
 *   'session:died'   — { sessionId: string, exitCode: number | null }
 *   'disconnected'   — daemon control pipe disconnected
 *   'event'          — DaemonEvent from daemon broadcast
 */
export class DaemonClient extends EventEmitter {
  private controlPipe: net.Socket | null = null;
  private sessionPipes: Map<string, net.Socket> = new Map();
  private connected: boolean = false;
  private requestId: number = 0;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private controlBuffer: string = '';

  constructor(
    private pipeName: string,
    private authToken: string,
  ) {
    super();
  }

  /** Attempt to connect to daemon control pipe. Returns false on failure (for fallback). */
  async connect(): Promise<boolean> {
    if (this.connected) return true;

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 5_000);

      const socket = net.createConnection(this.pipeName, () => {
        clearTimeout(timeout);
        this.controlPipe = socket;
        this.connected = true;
        this.setupControlPipe(socket);
        resolve(true);
      });

      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  /** Disconnect from daemon, cleaning up all pipes. */
  async disconnect(): Promise<void> {
    // Disconnect all session pipes first
    const sessionIds = Array.from(this.sessionPipes.keys());
    for (const sessionId of sessionIds) {
      await this.disconnectSessionPipe(sessionId);
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('DaemonClient disconnecting'));
      this.pendingRequests.delete(id);
    }

    // Disconnect control pipe
    if (this.controlPipe) {
      this.controlPipe.destroy();
      this.controlPipe = null;
    }
    this.connected = false;
    this.controlBuffer = '';
  }

  /** Send an RPC call over the control pipe. */
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.controlPipe || !this.connected) {
      throw new Error('DaemonClient not connected');
    }

    const id = `req-${++this.requestId}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method} (${RPC_TIMEOUT_MS}ms)`));
      }, RPC_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const request = JSON.stringify({
        id,
        method,
        params,
        token: this.authToken,
      }) + '\n';

      this.controlPipe!.write(request);
    });
  }

  /** Connect a session data pipe for streaming PTY output/input. */
  async connectSessionPipe(sessionId: string): Promise<void> {
    if (this.sessionPipes.has(sessionId)) return;

    const pipeName = this.getSessionPipeName(sessionId);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Session pipe connection timeout: ${sessionId}`));
      }, 5_000);

      const socket = net.createConnection(pipeName, () => {
        clearTimeout(timeout);
        // Send auth token before setting up data handler
        socket.write(this.authToken + '\n');
        this.sessionPipes.set(sessionId, socket);
        this.setupSessionPipe(sessionId, socket);
        resolve();
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** Disconnect a session data pipe. */
  async disconnectSessionPipe(sessionId: string): Promise<void> {
    const socket = this.sessionPipes.get(sessionId);
    if (socket) {
      socket.destroy();
      this.sessionPipes.delete(sessionId);
    }
  }

  /** Write input data to a session via its data pipe. */
  writeToSession(sessionId: string, data: string | Buffer): void {
    const socket = this.sessionPipes.get(sessionId);
    if (socket && !socket.destroyed) {
      socket.write(data);
    }
  }

  /** Whether the daemon control pipe is connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  // --- Private helpers ---

  private getSessionPipeName(sessionId: string): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\wmux-session-${sessionId}`;
    }
    const os = require('os');
    return `${os.homedir()}/.wmux-session-${sessionId}.sock`;
  }

  private setupControlPipe(socket: net.Socket): void {
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      this.controlBuffer += chunk;

      // Prevent OOM
      if (this.controlBuffer.length > MAX_LINE_BUFFER) {
        this.controlBuffer = '';
        return;
      }

      const lines = this.controlBuffer.split('\n');
      this.controlBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleControlMessage(trimmed);
      }
    });

    socket.on('error', () => {
      // Node.js will fire 'close' after 'error' — cleanup happens there
    });

    socket.on('close', () => {
      if (!this.connected) return; // guard against double emission
      this.connected = false;
      this.controlPipe = null;
      this.controlBuffer = '';
      this.emit('disconnected');
    });
  }

  private handleControlMessage(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line, (key, value) => {
        // Proto pollution prevention
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      });
    } catch {
      return;
    }

    // Check if it's a response to a pending RPC request
    const id = parsed['id'] as string | undefined;
    if (id && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id)!;
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);

      const response = parsed as unknown as RpcResponse;
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(response.error ?? 'Unknown RPC error'));
      }
      return;
    }

    // Otherwise treat as a daemon broadcast event
    const event = parsed as unknown as DaemonEvent;
    if (event.type) {
      this.emit('event', event);

      // Emit specific events for convenience
      if (event.type === 'session.died') {
        const data = event.data as { exitCode?: number | null } | null;
        this.emit('session:died', {
          sessionId: event.sessionId,
          exitCode: data?.exitCode ?? null,
        });
      }
    }
  }

  private setupSessionPipe(sessionId: string, socket: net.Socket): void {
    let flushed = false;
    let pendingChunks: Buffer[] = [];

    socket.on('data', (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      if (!flushed) {
        // Accumulate until we see the FLUSH_DONE_MARKER
        pendingChunks.push(buf);
        const combined = Buffer.concat(pendingChunks);
        const markerIndex = combined.indexOf(FLUSH_DONE_MARKER);

        if (markerIndex !== -1) {
          flushed = true;

          // Emit data before marker (ring buffer replay)
          if (markerIndex > 0) {
            this.emit('session:data', {
              sessionId,
              data: combined.subarray(0, markerIndex),
            });
          }

          // Emit data after marker (if any real-time data arrived in same chunk)
          const afterMarker = combined.subarray(markerIndex + FLUSH_DONE_MARKER.length);
          if (afterMarker.length > 0) {
            this.emit('session:data', { sessionId, data: afterMarker });
          }

          pendingChunks = [];
        }
      } else {
        // Real-time mode — emit directly
        this.emit('session:data', { sessionId, data: buf });
      }
    });

    socket.on('close', () => {
      this.sessionPipes.delete(sessionId);
    });

    socket.on('error', () => {
      this.sessionPipes.delete(sessionId);
    });
  }
}

/** Get the daemon control pipe name for the current platform/user. */
export function getDaemonPipeName(): string {
  const os = require('os');
  const path = require('path');
  const username = os.userInfo().username || 'default';
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux-daemon-${username}`;
  }
  return path.join(os.homedir(), '.wmux-daemon.sock');
}

/** Read the daemon auth token from disk. Returns empty string if not found. */
export function readDaemonAuthToken(): string {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tokenPath = path.join(os.homedir(), '.wmux', 'daemon-auth-token');
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return '';
  }
}

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

  /** Synchronous disconnect — for use in process exit/session-end handlers
   *  where async operations cannot complete, AND for runtime recovery
   *  paths (the respawn controller's hang detector) where we need to
   *  drop the socket fast but still keep the rest of the app responsive.
   *  Destroys all sockets immediately and rejects every pending RPC so
   *  callers do not hang forever waiting on a reply that can no longer
   *  arrive. (Codex review #4 on issue #54 respawn loop.) */
  disconnectSync(): void {
    for (const [, socket] of this.sessionPipes) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.sessionPipes.clear();

    // Reject pending requests so in-flight RPC promises settle instead
    // of dangling. The async `disconnect()` already does this; the sync
    // path used to skip it because the exit path didn't care, but the
    // respawn controller calls disconnectSync at runtime — silently
    // dropped pendings would leave renderer actions hung forever.
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      try { pending.reject(new Error('DaemonClient disconnected')); } catch { /* defensive */ }
      this.pendingRequests.delete(id);
    }

    if (this.controlPipe) {
      try { this.controlPipe.destroy(); } catch { /* ignore */ }
      this.controlPipe = null;
    }
    this.connected = false;
    this.controlBuffer = '';
  }

  /**
   * Send an RPC call over the control pipe.
   *
   * `opts.timeoutMs` overrides the default {@link RPC_TIMEOUT_MS}. Pass a
   * larger value for long-running RPCs such as `daemon.shutdown`, which may
   * exceed 10 s while RingBuffer dumps complete.
   */
  async rpc(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (!this.controlPipe || !this.connected) {
      throw new Error('DaemonClient not connected');
    }

    const id = `req-${++this.requestId}`;
    const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

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

  /**
   * Connect a session data pipe for streaming PTY output/input.
   *
   * Idempotency is liveness-based, not map-presence-based. A stale entry
   * left over from a daemon-side pipe replacement (renderer reload,
   * daemon hot-reconnect, etc.) used to early-return success, leaving
   * writes to silently route to a half-dead socket. Now the call always
   * verifies the existing socket is still usable; if not, the stale
   * entry is torn down and a fresh pipe is opened.
   *
   * Caller can force a fresh connection (e.g. `pty:reconnect` after a
   * known daemon-side replacement) by passing `forceFresh: true`.
   */
  async connectSessionPipe(sessionId: string, opts?: { forceFresh?: boolean }): Promise<void> {
    const existing = this.sessionPipes.get(sessionId);
    if (existing) {
      const isHealthy = !existing.destroyed && existing.writable;
      if (isHealthy && !opts?.forceFresh) return;
      // Stale or caller demands fresh — tear down before reconnecting.
      // Removing from the map first prevents the close/error handlers
      // from racing the new entry we're about to install.
      this.sessionPipes.delete(sessionId);
      existing.destroy();
    }

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

  /**
   * Cheap liveness check for a session's data pipe. Used by pty:reconnect
   * to probe the freshly opened socket before reporting success, so a
   * truthy reconnect can't mask a half-dead pipe.
   */
  isSessionPipeWritable(sessionId: string): boolean {
    const socket = this.sessionPipes.get(sessionId);
    if (!socket) return false;
    return !socket.destroyed && socket.writable;
  }

  /**
   * Write input data to a session via its data pipe. Returns true if the
   * data was handed to a live socket, false if the call silently dropped.
   *
   * A false return points the caller at one of: (a) the session pipe was
   * never connected, (b) the cached socket was torn down between attach
   * and write, (c) the daemon replaced the pipe and our cached entry is
   * a stale reference about to receive its close event. The caller is
   * responsible for surfacing the drop so users don't see input-mute
   * without explanation.
   */
  writeToSession(sessionId: string, data: string | Buffer): boolean {
    const socket = this.sessionPipes.get(sessionId);
    if (!socket) return false;
    if (socket.destroyed || !socket.writable) return false;
    socket.write(data);
    return true;
  }

  /**
   * Read structured OSC 133 prompt/command events from a daemon session.
   * Returns an empty payload with sessionFound=false when the session does
   * not exist, so callers can degrade without throwing.
   */
  async readPromptEvents(
    sessionId: string,
    opts: { limit?: number; sinceOffset?: number; lastCommandOnly?: boolean } = {},
  ): Promise<{
    events: Array<{ type: string; ts: number; byteOffset: number; exitCode?: number }>;
    lastCompletedRange: { startOffset: number; endOffset: number; exitCode: number | null } | null;
    totalBytesWritten: number;
    sessionFound: boolean;
  }> {
    const params: Record<string, unknown> = { sessionId };
    if (opts.limit !== undefined) params.limit = opts.limit;
    if (opts.sinceOffset !== undefined) params.sinceOffset = opts.sinceOffset;
    if (opts.lastCommandOnly) params.lastCommandOnly = true;
    const result = await this.rpc('daemon.readPromptEvents', params);
    return result as {
      events: Array<{ type: string; ts: number; byteOffset: number; exitCode?: number }>;
      lastCompletedRange: { startOffset: number; endOffset: number; exitCode: number | null } | null;
      totalBytesWritten: number;
      sessionFound: boolean;
    };
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

      // Emit specific events for convenience. Daemon mode consumers (in
      // particular, DaemonNotificationRouter) subscribe to these to mirror
      // the local-mode PTYBridge wiring: activity → 'running', agent →
      // metadata + notification + toast, critical → approval request.
      switch (event.type) {
        case 'session.died': {
          const data = event.data as { exitCode?: number | null } | null;
          this.emit('session:died', {
            sessionId: event.sessionId,
            exitCode: data?.exitCode ?? null,
          });
          break;
        }
        case 'session.destroyed':
          // pty:dispose path — distinct from session.died (natural exit).
          // Notification router treats both the same: clear agentStatus.
          this.emit('session:destroyed', { sessionId: event.sessionId });
          break;
        case 'activity.idle':
          this.emit('session:idle', { sessionId: event.sessionId });
          break;
        case 'activity.active':
          this.emit('session:active', { sessionId: event.sessionId });
          break;
        case 'agent.event':
          this.emit('session:agent', { sessionId: event.sessionId, event: event.data });
          break;
        case 'agent.critical':
          this.emit('session:critical', { sessionId: event.sessionId, event: event.data });
          break;
        default:
          break;
      }
    }
  }

  private setupSessionPipe(sessionId: string, socket: net.Socket): void {
    let flushed = false;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    const MAX_PENDING_BYTES = 10 * 1024 * 1024; // 10 MB safety cap

    socket.on('data', (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      if (!flushed) {
        pendingChunks.push(buf);
        pendingBytes += buf.length;

        // Prevent unbounded accumulation if flush marker never arrives
        if (pendingBytes > MAX_PENDING_BYTES) {
          flushed = true;
          pendingChunks = [];
          pendingBytes = 0;
          return;
        }

        // Accumulate until we see the FLUSH_DONE_MARKER
        const combined = Buffer.concat(pendingChunks);
        const markerIndex = combined.indexOf(FLUSH_DONE_MARKER);

        if (markerIndex !== -1) {
          flushed = true;
          // markerIndex is exactly the count of replayed scrollback bytes:
          // 0 when the daemon's ringBuffer was empty (mismatch case from
          // the scrollback-restore-sync design — recovery cap dropped this
          // session, or it was created fresh by reconcile fallback). The
          // renderer uses this to decide whether to wipe its .txt cache.
          const recoveredBytes = markerIndex;

          // Emit data before marker (ring buffer replay)
          if (markerIndex > 0) {
            this.emit('session:data', {
              sessionId,
              data: combined.subarray(0, markerIndex),
            });
          }

          // Fire flush-complete BEFORE the post-marker data so the
          // renderer's reset-or-keep decision lands before any live PTY
          // bytes start composing on the buffer.
          this.emit('session:flushComplete', { sessionId, recoveredBytes });

          // Emit data after marker (if any real-time data arrived in same chunk)
          const afterMarker = combined.subarray(markerIndex + FLUSH_DONE_MARKER.length);
          if (afterMarker.length > 0) {
            this.emit('session:data', { sessionId, data: afterMarker });
          }

          pendingChunks = [];
          pendingBytes = 0;
        }
      } else {
        // Real-time mode — emit directly
        this.emit('session:data', { sessionId, data: buf });
      }
    });

    socket.on('close', () => {
      pendingChunks = [];
      pendingBytes = 0;
      this.sessionPipes.delete(sessionId);
    });

    socket.on('error', () => {
      pendingChunks = [];
      pendingBytes = 0;
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

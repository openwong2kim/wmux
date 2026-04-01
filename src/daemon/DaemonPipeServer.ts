import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { RpcRequest, RpcResponse } from '../shared/rpc';

const MAX_LINE_BUFFER = 1024 * 1024; // 1 MB — prevent OOM from malicious clients

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Daemon Control Pipe server.
 * Listens on a Named Pipe (Windows) or Unix domain socket for JSON-RPC requests.
 * Each request must include a valid auth token.
 */
export class DaemonPipeServer {
  private server: net.Server | null = null;
  private authToken: string = '';
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly connectedSockets = new Set<net.Socket>();
  private readonly rateLimits = new Map<net.Socket, { count: number; resetAt: number }>();
  private globalRate = { count: 0, resetAt: 0 };

  private static readonly MAX_CONNECTIONS = 20;
  private static readonly GLOBAL_RATE_LIMIT = 200;
  private static readonly PER_SOCKET_RATE_LIMIT = 50;

  private activePipeName: string;

  constructor(private readonly pipeName: string) {
    this.activePipeName = pipeName;
  }

  /** Get the actual pipe name being used (may differ from requested if fallback occurred). */
  getActivePipeName(): string {
    return this.activePipeName;
  }

  /** Load existing auth token from disk, or generate a new one. */
  async loadOrCreateToken(): Promise<string> {
    const tokenPath = this.getTokenPath();
    try {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing) {
        this.authToken = existing;
        return this.authToken;
      }
    } catch {
      // file doesn't exist yet
    }

    this.authToken = crypto.randomUUID();
    // Ensure directory exists
    const dir = path.dirname(tokenPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(tokenPath, this.authToken, { encoding: 'utf8', mode: 0o600 });
    return this.authToken;
  }

  /** Start listening on the control pipe. */
  async start(): Promise<void> {
    if (this.server) return;

    if (!this.authToken) {
      await this.loadOrCreateToken();
    }

    // On Windows, named pipes can linger as zombie handles after process death.
    // Strategy: try to connect to the existing pipe first. If the connection
    // succeeds, a live process owns it — fall back to a suffixed name.
    // If the connection is refused / reset, the pipe is a zombie — force-
    // release it by briefly connecting+destroying, then retry listen.
    const maxAttempts = process.platform === 'win32' ? 4 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidateName = attempt === 0
        ? this.pipeName
        : `${this.pipeName}-${attempt}`;

      try {
        await this.tryListen(candidateName);
        this.activePipeName = candidateName;
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EACCES') {
          throw err;
        }

        // Attempt to reclaim the zombie pipe before falling back
        if (process.platform === 'win32' && code === 'EADDRINUSE') {
          const reclaimed = await this.tryReclaimPipe(candidateName);
          if (reclaimed) {
            try {
              await this.tryListen(candidateName);
              this.activePipeName = candidateName;
              return;
            } catch {
              // Reclaim succeeded but listen still failed — fall through
            }
          }
        }

        if (attempt === maxAttempts - 1) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  /**
   * Attempt to reclaim a zombie Windows named pipe.
   *
   * When a process crashes without closing its pipe handle, Windows keeps the
   * pipe object alive until all handles are closed.  We probe the pipe:
   *   - If connect succeeds → a live process owns it, cannot reclaim.
   *   - If connect gets ECONNREFUSED/ECONNRESET → zombie pipe. Connecting
   *     and immediately destroying the socket releases the last handle,
   *     freeing the pipe name for reuse.
   */
  private tryReclaimPipe(name: string): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = net.connect(name);
      const timer = setTimeout(() => {
        probe.destroy();
        resolve(false);
      }, 2000);
      timer.unref();

      probe.on('connect', () => {
        // Pipe is owned by a live process — cannot reclaim
        clearTimeout(timer);
        probe.destroy();
        resolve(false);
      });

      probe.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        probe.destroy();
        if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EPIPE') {
          // Zombie pipe — the connect attempt released the handle
          // Wait briefly for Windows to clean up the pipe name
          setTimeout(() => resolve(true), 200);
        } else {
          resolve(false);
        }
      });
    });
  }

  /** Try to listen on a specific pipe name. */
  private tryListen(name: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        if (this.connectedSockets.size >= DaemonPipeServer.MAX_CONNECTIONS) {
          socket.destroy();
          return;
        }
        this.connectedSockets.add(socket);
        socket.on('close', () => {
          this.connectedSockets.delete(socket);
          this.rateLimits.delete(socket);
        });
        this.handleConnection(socket);
      });

      server.maxConnections = DaemonPipeServer.MAX_CONNECTIONS;

      server.on('error', (err: NodeJS.ErrnoException) => {
        reject(err);
      });

      // On Unix, remove stale socket file before listening
      if (process.platform !== 'win32') {
        try {
          const stat = fs.lstatSync(name);
          if (stat.isSocket()) {
            fs.unlinkSync(name);
          }
        } catch {
          // File doesn't exist — fine
        }
      }

      server.listen(name, () => {
        this.server = server;
        resolve();
      });
    });
  }

  /** Stop the server and destroy all connections. */
  async stop(): Promise<void> {
    if (!this.server) return;

    for (const socket of this.connectedSockets) {
      socket.destroy();
    }
    this.connectedSockets.clear();

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        // Clean up Unix socket file
        if (process.platform !== 'win32') {
          try {
            const stat = fs.lstatSync(this.pipeName);
            if (stat.isSocket()) {
              fs.unlinkSync(this.pipeName);
            }
          } catch {
            // File doesn't exist — fine
          }
        }
        resolve();
      });
      this.server = null;
    });
  }

  /** Register a handler for an RPC method. */
  onRpc(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  /** Return the current auth token. */
  getAuthToken(): string {
    return this.authToken;
  }

  /** For testing: set token directly without file I/O. */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /** Broadcast an event to all connected clients as a newline-delimited JSON message. */
  broadcast(event: unknown): void {
    const msg = JSON.stringify(event) + '\n';
    this.connectedSockets.forEach((socket) => {
      if (!socket.destroyed) {
        try {
          socket.write(msg);
        } catch {
          // ignore write errors on individual sockets
        }
      }
    });
  }

  private getTokenPath(): string {
    const home = os.homedir();
    return path.join(home, '.wmux', 'daemon-auth-token');
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      // Security: prevent OOM from clients that never send newlines
      if (buffer.length > MAX_LINE_BUFFER) {
        socket.destroy();
        return;
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.processLine(socket, trimmed);
      }
    });

    socket.on('end', () => {
      const trimmed = buffer.trim();
      if (trimmed) {
        this.processLine(socket, trimmed);
      }
      buffer = '';
    });

    socket.on('error', () => {
      socket.destroy();
    });
  }

  private processLine(socket: net.Socket, line: string): void {
    let request: RpcRequest;

    try {
      request = JSON.parse(line, (key, value) => {
        // Proto pollution prevention
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      }) as RpcRequest;
    } catch {
      const errorResponse = JSON.stringify({ id: null, ok: false, error: 'Invalid JSON' });
      socket.write(errorResponse + '\n');
      return;
    }

    // Authenticate before rate limit check (prevents DoS via rate exhaustion)
    // Use timing-safe comparison to prevent timing attacks
    const tokenBuf = Buffer.from(request.token || '');
    const authBuf = Buffer.from(this.authToken);
    if (tokenBuf.length !== authBuf.length || !crypto.timingSafeEqual(tokenBuf, authBuf)) {
      const res = JSON.stringify({ id: request.id, ok: false, error: 'unauthorized' });
      socket.write(res + '\n');
      return;
    }

    // Global rate limit
    const now = Date.now();
    if (now > this.globalRate.resetAt) {
      this.globalRate = { count: 0, resetAt: now + 1000 };
    }
    this.globalRate.count++;
    if (this.globalRate.count > DaemonPipeServer.GLOBAL_RATE_LIMIT) {
      const res = JSON.stringify({ id: request.id, ok: false, error: 'rate limited (global)' });
      socket.write(res + '\n');
      return;
    }

    // Per-socket rate limit
    let limit = this.rateLimits.get(socket);
    if (!limit || now > limit.resetAt) {
      limit = { count: 0, resetAt: now + 1000 };
      this.rateLimits.set(socket, limit);
    }
    limit.count++;
    if (limit.count > DaemonPipeServer.PER_SOCKET_RATE_LIMIT) {
      const res = JSON.stringify({ id: request.id, ok: false, error: 'rate limited' });
      socket.write(res + '\n');
      return;
    }

    // Dispatch to handler
    this.dispatch(request)
      .then((response) => {
        if (!socket.destroyed) {
          socket.write(JSON.stringify(response) + '\n');
        }
      })
      .catch(() => {
        if (!socket.destroyed) {
          const res = JSON.stringify({ id: request.id, ok: false, error: 'Internal server error' });
          socket.write(res + '\n');
        }
      });
  }

  private async dispatch(request: RpcRequest): Promise<RpcResponse> {
    if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') {
      return { id: request?.id || '', ok: false, error: 'Invalid RPC request: missing id or method' };
    }
    if (request.params !== undefined && (typeof request.params !== 'object' || request.params === null)) {
      return { id: request.id, ok: false, error: 'Invalid RPC request: params must be an object' };
    }

    const handler = this.handlers.get(request.method);
    if (!handler) {
      return { id: request.id, ok: false, error: `Unknown method: ${request.method}` };
    }

    try {
      const result = await handler(request.params ?? {});
      return { id: request.id, ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id: request.id, ok: false, error: message };
    }
  }
}

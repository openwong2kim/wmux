import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { RpcRequest, RpcResponse } from '../shared/rpc';
import { secureWriteTokenFile, scheduleTokenFileReHarden } from '../shared/security';
import { getDaemonAuthTokenPath } from '../shared/constants';

const MAX_LINE_BUFFER = 1024 * 1024; // 1 MB — prevent OOM from malicious clients

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** Action a reclaim probe implies, distinguishing a live owner from a zombie. */
export type ReclaimOutcome = 'live-owner' | 'reclaimed' | 'unreclaimable';

/**
 * Classify a reclaim-probe result into the action the pipe server should take.
 * Pure, so the live-owner-vs-zombie decision is unit-testable without a real
 * socket.
 *   - connect succeeded         → 'live-owner'    (a live process owns the pipe)
 *   - ECONNREFUSED/RESET/EPIPE   → 'reclaimed'     (zombie; probe released it)
 *   - timeout / any other error  → 'unreclaimable' (ambiguous; do NOT claim live)
 *
 * The 'live-owner' vs 'unreclaimable' split is the split-brain fix (Defect 3):
 * the OLD code folded both into "false" and then fell back to a `-N` suffix,
 * spawning a second LIVE daemon on the canonical pipe. Only a confirmed live
 * owner must make `start()` yield; an ambiguous probe keeps the legacy retry.
 */
export function classifyReclaimProbe(
  event: 'connect' | 'error' | 'timeout',
  errCode?: string,
): ReclaimOutcome {
  if (event === 'connect') return 'live-owner';
  if (event === 'timeout') return 'unreclaimable';
  if (errCode === 'ECONNREFUSED' || errCode === 'ECONNRESET' || errCode === 'EPIPE') {
    return 'reclaimed';
  }
  return 'unreclaimable';
}

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
  private connectionRate = { count: 0, resetAt: 0 };

  private static readonly MAX_CONNECTIONS = 20;
  private static readonly GLOBAL_RATE_LIMIT = 200;
  private static readonly PER_SOCKET_RATE_LIMIT = 50;
  private static readonly MAX_NEW_CONNECTIONS_PER_SEC = 20;

  private activePipeName: string;
  private tokenPathOverride: string | null = null;

  // Idle-shutdown bookkeeping. `lastDisconnectAt` is updated whenever the
  // last connected socket closes, i.e. only when `connectedSockets.size`
  // drops to 0. While at least one client is connected the value is left
  // alone — Watchdog reads it together with `getConnectionCount()` so a
  // long-lived main process keeps the daemon alive on its own.
  private lastDisconnectAt: number | null = null;

  constructor(private readonly pipeName: string) {
    this.activePipeName = pipeName;
  }

  /** For testing: redirect the on-disk token file to a temp path. */
  setTokenPathForTest(tokenPath: string): void {
    this.tokenPathOverride = tokenPath;
  }

  /** Get the actual pipe name being used (may differ from requested if fallback occurred). */
  getActivePipeName(): string {
    return this.activePipeName;
  }

  /** Number of currently connected RPC clients. */
  getConnectionCount(): number {
    return this.connectedSockets.size;
  }

  /**
   * Timestamp (ms) of the moment the last connection dropped to zero, or
   * `null` if a client has never connected during this daemon's lifetime.
   * Watchdog uses this together with the daemon's `startTime` to compute
   * an idle window — see `src/daemon/index.ts` idle-shutdown logic.
   */
  getLastDisconnectAt(): number | null {
    return this.lastDisconnectAt;
  }

  /** Load existing auth token from disk, or generate a new one. */
  async loadOrCreateToken(): Promise<string> {
    const tokenPath = this.getTokenPath();
    try {
      const existing = fs.readFileSync(tokenPath, 'utf8').trim();
      if (existing) {
        this.authToken = existing;
        // RCA A12 — re-harden the ACL on the EXISTING token file. Tokens created
        // by older versions (or carrying broad inherited ACLs) would otherwise
        // remain readable by Administrators/SYSTEM/other local accounts, letting
        // any local process steal the token and drive the daemon RPC surface.
        // Deferred to background (S-A): the sync harden's whoami+PowerShell
        // shell-outs cost 3.5-3.8s here — directly on the launcher-blocked
        // critical path, since loadOrCreateToken runs inside start() before
        // tryListen and before the daemon-pipe file the launcher polls for.
        // The token VALUE is unchanged, so deferring the tightening adds no
        // material exposure (the file sat under the same ACL its whole prior
        // lifetime); the RPC surface is protected by the token value itself.
        // The scheduler is fully async (never *Sync), so the harden cannot
        // stall the freshly-opened control pipe's event loop either.
        scheduleTokenFileReHarden(tokenPath);
        console.log('[lifecycle] daemon auth token loaded from disk — ACL re-harden scheduled (deferred)');
        return this.authToken;
      }
    } catch {
      // file doesn't exist yet
    }

    this.authToken = crypto.randomUUID();
    // Ensure directory exists
    secureWriteTokenFile(tokenPath, this.authToken);
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

        // Attempt to reclaim the pipe before falling back. Distinguish a LIVE
        // owner from a genuine zombie: a live owner on the CANONICAL pipe
        // (attempt 0) means we are a redundant second daemon — the split-brain
        // trigger (Defect 3). We must NOT fall back to the `-N` suffix (that
        // produces two live daemons racing for the session pipes); fail fast so
        // the entrypoint exits cleanly and the launcher reconnects to the
        // existing daemon. The `-N` suffix stays only for the genuine-zombie
        // and ambiguous cases.
        if (process.platform === 'win32' && code === 'EADDRINUSE') {
          const outcome = await this.tryReclaimPipe(candidateName);
          if (outcome === 'reclaimed') {
            try {
              await this.tryListen(candidateName);
              this.activePipeName = candidateName;
              return;
            } catch {
              // Reclaim succeeded but listen still failed — fall through
            }
          } else if (outcome === 'live-owner' && attempt === 0) {
            const e = new Error(
              `[daemon] canonical control pipe ${candidateName} is owned by a live daemon — refusing to start a redundant second daemon`,
            ) as NodeJS.ErrnoException;
            e.code = 'EDAEMON_ALREADY_RUNNING';
            throw e;
          }
          // 'unreclaimable', or a live-owner on a `-N` attempt: fall through to
          // the next suffix (legacy behavior for the genuinely ambiguous or
          // multi-daemon-cleanup case).
        }

        if (attempt === maxAttempts - 1) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  /**
   * Probe a Windows named pipe to decide whether it can be reclaimed. Returns
   * a three-state outcome (see `classifyReclaimProbe`):
   *   - 'live-owner': connect succeeded → a live process owns it. start() must
   *     yield rather than fall back to a `-N` suffix (the split-brain fix).
   *   - 'reclaimed': connect refused/reset → zombie; the probe released the
   *     last handle, the name is free to retry.
   *   - 'unreclaimable': timeout / unexpected error → ambiguous; neither claim
   *     a live owner nor assume the name is free.
   */
  private tryReclaimPipe(name: string): Promise<ReclaimOutcome> {
    return new Promise((resolve) => {
      const probe = net.connect(name);
      const timer = setTimeout(() => {
        probe.destroy();
        resolve(classifyReclaimProbe('timeout'));
      }, 2000);
      timer.unref();

      probe.on('connect', () => {
        clearTimeout(timer);
        probe.destroy();
        resolve(classifyReclaimProbe('connect'));
      });

      probe.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        probe.destroy();
        const outcome = classifyReclaimProbe('error', err.code);
        if (outcome === 'reclaimed') {
          // The connect attempt released the zombie handle — wait briefly for
          // Windows to clean up the pipe name before the caller retries listen.
          setTimeout(() => resolve('reclaimed'), 200);
        } else {
          resolve(outcome);
        }
      });
    });
  }

  /** Try to listen on a specific pipe name. */
  private tryListen(name: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        // Pre-auth connection rate limit: mitigates brute-force on auth token
        // when the pipe DACL itself cannot be restricted (libuv limitation).
        const now = Date.now();
        if (now > this.connectionRate.resetAt) {
          this.connectionRate = { count: 0, resetAt: now + 1000 };
        }
        this.connectionRate.count++;
        if (this.connectionRate.count > DaemonPipeServer.MAX_NEW_CONNECTIONS_PER_SEC) {
          socket.destroy();
          return;
        }

        if (this.connectedSockets.size >= DaemonPipeServer.MAX_CONNECTIONS) {
          socket.destroy();
          return;
        }
        this.connectedSockets.add(socket);
        socket.on('close', () => {
          this.connectedSockets.delete(socket);
          this.rateLimits.delete(socket);
          // Record the moment we dropped to zero clients so the Watchdog
          // idle-shutdown timer has an anchor. We re-stamp on every drop
          // to zero (not just the first), so a flapping reconnect cycle
          // pushes the deadline forward instead of accumulating idle time.
          if (this.connectedSockets.size === 0) {
            this.lastDisconnectAt = Date.now();
          }
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

  /**
   * Rotate the daemon auth token. Drops all currently connected clients and
   * rewrites the token file. Used to respond to suspected token leakage —
   * any attacker holding the old token is immediately locked out.
   */
  rotateToken(): string {
    const newToken = crypto.randomUUID();
    secureWriteTokenFile(this.getTokenPath(), newToken);
    this.authToken = newToken;
    for (const socket of this.connectedSockets) {
      socket.destroy();
    }
    this.connectedSockets.clear();
    this.rateLimits.clear();
    // Forced drop-to-zero — keep idle-window accounting consistent.
    this.lastDisconnectAt = Date.now();
    return newToken;
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

  // Suffix-aware daemon token path (single source of truth in shared/constants).
  // The daemon WRITER deliberately never falls back to the legacy unsuffixed
  // path — a suffixed ('-dev'/dogfood) instance must mint its OWN token instead
  // of adopting production's, which is the whole point of the isolation.
  private getTokenPath(): string {
    if (this.tokenPathOverride) return this.tokenPathOverride;
    return getDaemonAuthTokenPath();
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
      // Close the socket so brute-force must pay the per-second connection cap
      // for every new token attempt instead of spamming a single long-lived socket.
      socket.destroy();
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

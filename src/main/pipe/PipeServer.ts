import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { getPipeName, getAuthTokenPath, getTcpPortPath } from '../../shared/constants';
import { secureWriteTokenFile, scheduleTokenFileReHarden } from '../../shared/security';
import type { RpcRequest } from '../../shared/rpc';
import { RpcRouter } from './RpcRouter';

const MAX_LINE_BUFFER = 1024 * 1024; // 1 MB — prevent OOM from malicious clients

export class PipeServer {
  private server: net.Server | null = null;
  private tcpServer: net.Server | null = null;
  private readonly router: RpcRouter;
  private readonly connectedSockets = new Set<net.Socket>();
  private authToken: string;
  private readonly rateLimits = new Map<net.Socket, { count: number; resetAt: number }>();
  private retryCount = 0;
  private static readonly MAX_RETRIES = 5;
  private static readonly MAX_CONNECTIONS = 50;
  private static readonly GLOBAL_RATE_LIMIT = 200;
  private static readonly MAX_NEW_CONNECTIONS_PER_SEC = 30;
  private globalRate = { count: 0, resetAt: 0 };
  private connectionRate = { count: 0, resetAt: 0 };

  constructor(router: RpcRouter) {
    this.router = router;
    // Reuse existing token from file if available — prevents token mismatch
    // when Vite dev server restarts the app (MCP client may still hold old token)
    this.authToken = this.loadOrCreateToken();
  }

  private loadOrCreateToken(): string {
    try {
      const existing = fs.readFileSync(getAuthTokenPath(), 'utf8').trim();
      if (existing) {
        // RCA A12 — re-harden the ACL on the existing ~/.wmux-auth-token: the
        // write path locks perms only on creation, so a token loaded from disk
        // could remain broadly readable. Deferred to background (S-A): the
        // sync harden's whoami+PowerShell shell-outs cost ~2s of cold start
        // inside this very constructor, while the token VALUE is unchanged —
        // an attacker exploiting the loose-ACL window could have read the
        // file at any point of its prior on-disk lifetime, so deferral adds
        // no material exposure. Failures are logged by the scheduler
        // (best-effort, same contract as the old sync path).
        scheduleTokenFileReHarden(getAuthTokenPath());
        return existing;
      }
    } catch { /* file doesn't exist yet */ }
    // Persist the freshly generated token immediately so MCP clients and other
    // processes don't see an empty token file during the window between server
    // init and McpRegistrar.register() — previously a race that forced clients
    // onto an env-var fallback if they raced the registrar.
    const token = crypto.randomUUID();
    try {
      secureWriteTokenFile(getAuthTokenPath(), token);
    } catch (err) {
      console.warn('[PipeServer] Failed to persist auth token at init:', err);
    }
    return token;
  }

  getAuthToken(): string {
    return this.authToken;
  }

  /**
   * Rotate the auth token. Drops all connected clients (they must reconnect
   * with the new token) and rewrites the on-disk token file atomically via
   * secureWriteTokenFile. Used to respond to suspected token leakage.
   */
  rotateToken(): string {
    const newToken = crypto.randomUUID();
    secureWriteTokenFile(getAuthTokenPath(), newToken);
    this.authToken = newToken;
    for (const socket of this.connectedSockets) {
      socket.destroy();
    }
    this.connectedSockets.clear();
    this.rateLimits.clear();
    return newToken;
  }

  start(): void {
    if (this.server) return;
    this.retryCount = 0;
    this.startInternal();
    this.startTcpFallback();
  }

  private startInternal(): void {
    this.server = net.createServer((socket) => {
      if (!this.admitConnection(socket)) return;
      this.connectedSockets.add(socket);
      socket.on('close', () => {
        this.connectedSockets.delete(socket);
        this.rateLimits.delete(socket);
      });
      this.handleConnection(socket);
    });

    this.server.maxConnections = PipeServer.MAX_CONNECTIONS;

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        this.retryCount++;
        if (this.retryCount > PipeServer.MAX_RETRIES) {
          console.error(
            `[PipeServer] EADDRINUSE — exceeded max retries (${PipeServer.MAX_RETRIES}). Giving up.`,
          );
          this.server = null;
          return;
        }
        console.warn(
          `[PipeServer] EADDRINUSE — retry ${this.retryCount}/${PipeServer.MAX_RETRIES} in 1s...`,
        );
        this.server!.removeAllListeners();
        this.server!.close();
        this.server = null;
        setTimeout(() => this.startInternal(), 1000);
      } else {
        console.error('[PipeServer] Server error:', err);
      }
    });

    const pipeName = getPipeName();
    // On Unix, remove stale socket file before listening
    if (process.platform !== 'win32') {
      try {
        const stat = require('fs').lstatSync(pipeName);
        // Only remove if it's a socket (not a symlink to something else)
        if (stat.isSocket()) {
          require('fs').unlinkSync(pipeName);
        } else {
          console.warn(`[PipeServer] ${pipeName} exists but is not a socket — skipping removal`);
        }
      } catch {
        // File doesn't exist — fine
      }
    }
    this.server.listen(pipeName, () => {
      this.retryCount = 0;
      console.log(`[PipeServer] Listening on ${pipeName}`);
    });
  }

  stop(): void {
    if (!this.server && !this.tcpServer) {
      return;
    }

    // Destroy all connected sockets
    for (const socket of this.connectedSockets) {
      socket.destroy();
    }
    this.connectedSockets.clear();

    if (this.server) {
      this.server.close((err) => {
        if (err) {
          console.error('[PipeServer] Error closing server:', err);
        } else {
          console.log('[PipeServer] Server closed.');
        }
        // Clean up Unix socket file
        if (process.platform !== 'win32') {
          const stopPipeName = getPipeName();
          try {
            const stat = require('fs').lstatSync(stopPipeName);
            if (stat.isSocket()) {
              require('fs').unlinkSync(stopPipeName);
            } else {
              console.warn(`[PipeServer] ${stopPipeName} exists but is not a socket — skipping removal`);
            }
          } catch {
            // File doesn't exist — fine
          }
        }
      });
      this.server = null;
    }

    if (this.tcpServer) {
      this.tcpServer.close();
      this.tcpServer = null;
      // Clean up TCP port file
      try { fs.unlinkSync(getTcpPortPath()); } catch { /* ignore */ }
      console.log('[PipeServer] TCP fallback server closed.');
    }
  }

  private startTcpFallback(): void {
    if (process.platform !== 'win32') return; // Only needed on Windows

    this.tcpServer = net.createServer((socket) => {
      if (!this.admitConnection(socket)) return;
      this.connectedSockets.add(socket);
      socket.on('close', () => {
        this.connectedSockets.delete(socket);
        this.rateLimits.delete(socket);
      });
      this.handleConnection(socket);
    });

    this.tcpServer.maxConnections = PipeServer.MAX_CONNECTIONS;

    this.tcpServer.on('error', (err) => {
      console.error('[PipeServer] TCP fallback error:', err);
    });

    // Listen on random port on localhost only
    this.tcpServer.listen(0, '127.0.0.1', () => {
      const addr = this.tcpServer!.address() as net.AddressInfo;
      const portFile = getTcpPortPath();
      fs.writeFileSync(portFile, String(addr.port), { encoding: 'utf8', mode: 0o600 });
      console.log(`[PipeServer] TCP fallback listening on 127.0.0.1:${addr.port}`);
    });
  }

  /**
   * Enforce pre-auth connection rate limit.
   * Returns false (and destroys the socket) when the per-second cap is exceeded,
   * mitigating brute-force token enumeration over a pipe that cannot be restricted
   * by DACL from Node.js.
   */
  private admitConnection(socket: net.Socket): boolean {
    const now = Date.now();
    if (now > this.connectionRate.resetAt) {
      this.connectionRate = { count: 0, resetAt: now + 1000 };
    }
    this.connectionRate.count++;
    if (this.connectionRate.count > PipeServer.MAX_NEW_CONNECTIONS_PER_SEC) {
      socket.destroy();
      return false;
    }
    return true;
  }

  private handleConnection(socket: net.Socket): void {
    console.log('[PipeServer] Client connected.');

    let buffer = '';

    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      // Security: prevent OOM from clients that never send newlines
      if (buffer.length > MAX_LINE_BUFFER) {
        console.warn('[PipeServer] Client exceeded max buffer size — disconnecting.');
        socket.destroy();
        return;
      }

      const lines = buffer.split('\n');
      // 마지막 요소는 아직 완성되지 않은 부분 — 다음 청크를 기다림
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        this.processLine(socket, trimmed);
      }
    });

    socket.on('end', () => {
      // 연결 종료 시 남은 버퍼 처리
      const trimmed = buffer.trim();
      if (trimmed) {
        this.processLine(socket, trimmed);
      }
      buffer = '';
      console.log('[PipeServer] Client disconnected.');
    });

    socket.on('error', (err) => {
      console.error('[PipeServer] Socket error:', err);
      socket.destroy();
    });
  }

  private processLine(socket: net.Socket, line: string): void {
    let request: RpcRequest;

    try {
      request = JSON.parse(line, (key, value) => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      }) as RpcRequest;
    } catch {
      const errorResponse = JSON.stringify({
        id: null,
        ok: false,
        error: 'Invalid JSON',
      });
      socket.write(errorResponse + '\n');
      return;
    }

    // Authenticate first: reject unauthenticated requests before consuming rate limit budget.
    // This prevents unauthenticated attackers from exhausting rate limits to DoS legitimate clients.
    const tokenBuf = Buffer.from(request.token || '');
    const authBuf = Buffer.from(this.authToken);
    if (tokenBuf.length !== authBuf.length || !crypto.timingSafeEqual(tokenBuf, authBuf)) {
      const unauthorizedResponse = JSON.stringify({
        id: request.id,
        ok: false,
        error: 'unauthorized',
      });
      socket.write(unauthorizedResponse + '\n');
      // Close the socket so each token guess must pay the per-second connection cap.
      socket.destroy();
      return;
    }

    // Rate limiting: per-socket (50/s) and global (200/s) — only for authenticated requests
    const now = Date.now();

    // Global rate limit across all sockets
    if (now > this.globalRate.resetAt) {
      this.globalRate = { count: 0, resetAt: now + 1000 };
    }
    this.globalRate.count++;
    if (this.globalRate.count > PipeServer.GLOBAL_RATE_LIMIT) {
      const rateLimitResponse = JSON.stringify({
        id: request.id,
        ok: false,
        error: 'rate limited (global)',
      });
      socket.write(rateLimitResponse + '\n');
      return;
    }

    // Per-socket rate limit
    let limit = this.rateLimits.get(socket);
    if (!limit || now > limit.resetAt) {
      limit = { count: 0, resetAt: now + 1000 };
      this.rateLimits.set(socket, limit);
    }
    limit.count++;
    if (limit.count > 50) {
      const rateLimitResponse = JSON.stringify({
        id: request.id,
        ok: false,
        error: 'rate limited',
      });
      socket.write(rateLimitResponse + '\n');
      return;
    }

    this.router
      .dispatch(request)
      .then((response) => {
        if (!socket.destroyed) {
          socket.write(JSON.stringify(response) + '\n');
        }
      })
      .catch((err: unknown) => {
        console.error('[PipeServer] Dispatch error:', err);
        if (!socket.destroyed) {
          const errorResponse = JSON.stringify({
            id: request.id,
            ok: false,
            error: 'Internal server error',
          });
          socket.write(errorResponse + '\n');
        }
      });
  }
}

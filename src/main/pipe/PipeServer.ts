import * as net from 'net';
import * as crypto from 'crypto';
import { getPipeName } from '../../shared/constants';
import type { RpcRequest } from '../../shared/rpc';
import { RpcRouter } from './RpcRouter';

const MAX_LINE_BUFFER = 1024 * 1024; // 1 MB — prevent OOM from malicious clients

export class PipeServer {
  private server: net.Server | null = null;
  private readonly router: RpcRouter;
  private readonly connectedSockets = new Set<net.Socket>();
  private readonly authToken: string;
  private readonly rateLimits = new Map<net.Socket, { count: number; resetAt: number }>();

  constructor(router: RpcRouter) {
    this.router = router;
    this.authToken = crypto.randomUUID();
  }

  getAuthToken(): string {
    return this.authToken;
  }

  start(): void {
    if (this.server) {
      return;
    }

    this.server = net.createServer((socket) => {
      this.connectedSockets.add(socket);
      socket.on('close', () => {
        this.connectedSockets.delete(socket);
        this.rateLimits.delete(socket);
      });
      this.handleConnection(socket);
    });

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn('[PipeServer] EADDRINUSE — retrying in 1s...');
        setTimeout(() => {
          if (this.server) {
            this.server.close();
            this.server.listen(getPipeName());
          }
        }, 1000);
      } else {
        console.error('[PipeServer] Server error:', err);
      }
    });

    const pipeName = getPipeName();
    this.server.listen(pipeName, () => {
      console.log(`[PipeServer] Listening on ${pipeName}`);
    });
  }

  stop(): void {
    if (!this.server) {
      return;
    }

    // Destroy all connected sockets
    for (const socket of this.connectedSockets) {
      socket.destroy();
    }
    this.connectedSockets.clear();

    this.server.close((err) => {
      if (err) {
        console.error('[PipeServer] Error closing server:', err);
      } else {
        console.log('[PipeServer] Server closed.');
      }
    });

    this.server = null;
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
      request = JSON.parse(line) as RpcRequest;
    } catch {
      const errorResponse = JSON.stringify({
        id: null,
        ok: false,
        error: 'Invalid JSON',
      });
      socket.write(errorResponse + '\n');
      return;
    }

    // Rate limiting: max 50 requests per second per socket
    const now = Date.now();
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

    // Authenticate: every request must carry a valid token
    if (request.token !== this.authToken) {
      const unauthorizedResponse = JSON.stringify({
        id: request.id,
        ok: false,
        error: 'unauthorized',
      });
      socket.write(unauthorizedResponse + '\n');
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

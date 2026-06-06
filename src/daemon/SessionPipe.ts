import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import type { RingBuffer } from './RingBuffer';

/** Marker sent after Ring Buffer flush to signal transition to real-time mode. */
export const FLUSH_DONE_MARKER = Buffer.from('\x00WMUX_FLUSH_DONE\x00');

/**
 * Per-session data pipe for raw byte streaming.
 * Created on attach, destroyed on detach.
 *
 * Flow:
 *   attach  -> start() -> client connects -> flush ring buffer -> real-time mode
 *   detach  -> stop()  -> pipe cleaned up
 *
 * Output: PTY stdout -> writeToClient() -> client socket
 * Input:  client socket -> onInput callback -> PTY stdin
 */
export class SessionPipe {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private inputCallback: ((data: Buffer) => void) | null = null;
  private flushed = false;
  private connectionRate = { count: 0, resetAt: 0 };

  // A single session pipe is legitimately consumed by at most one renderer at a time.
  // Anything above this cap in a 1-second window is brute-force / scanner traffic.
  private static readonly MAX_NEW_CONNECTIONS_PER_SEC = 10;

  private readonly authTokenProvider: () => string;

  constructor(
    private readonly sessionId: string,
    private readonly ringBuffer: RingBuffer,
    authToken: string | (() => string),
  ) {
    this.authTokenProvider = typeof authToken === 'function' ? authToken : () => authToken;
  }

  /** Get the platform-specific pipe name for this session. */
  getPipeName(): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\wmux-session-${this.sessionId}`;
    }
    return `${os.homedir()}/.wmux-session-${this.sessionId}.sock`;
  }

  /** Start listening for a single client connection. */
  async start(): Promise<void> {
    if (this.server) return;

    const pipeName = this.getPipeName();

    // On Unix, remove a stale socket file left by a prior run.
    if (process.platform !== 'win32') {
      try {
        const stat = fs.lstatSync(pipeName);
        if (stat.isSocket()) {
          fs.unlinkSync(pipeName);
        }
      } catch {
        // File doesn't exist — fine
      }
    }

    // RCA (2026-05-28 dogfood): a session pane died when its named pipe could
    // not bind — `EADDRINUSE: \\.\pipe\wmux-session-<id>` — because a PRIOR
    // SessionPipe for the same sessionId had not yet released the name
    // (renderer detach/reattach, daemon reconnect). On Windows the OS frees a
    // named-pipe name shortly after the previous handle closes, so retry
    // EADDRINUSE a few times with short backoff before giving up. Any other
    // listen error (or exhausted retries) propagates to the caller as before.
    const MAX_BIND_ATTEMPTS = 5;
    const BIND_RETRY_MS = 100;
    for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt++) {
      try {
        await this.listenOnce(pipeName);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EADDRINUSE' && attempt < MAX_BIND_ATTEMPTS) {
          await new Promise<void>((r) => setTimeout(r, BIND_RETRY_MS));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Single bind attempt. Resolves once listening (and assigns this.server),
   * rejects on the first listen error. The server is created fresh per attempt
   * and closed on error so a retry can rebind cleanly.
   */
  private listenOnce(pipeName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        // Pre-auth connection throttle: Named Pipe DACL cannot be restricted from
        // Node.js (libuv limitation), so brute-force token guessers are rate-capped
        // at the accept() layer before reaching auth.
        const now = Date.now();
        if (now > this.connectionRate.resetAt) {
          this.connectionRate = { count: 0, resetAt: now + 1000 };
        }
        this.connectionRate.count++;
        if (this.connectionRate.count > SessionPipe.MAX_NEW_CONNECTIONS_PER_SEC) {
          socket.destroy();
          return;
        }

        // Only one client at a time
        if (this.client) {
          socket.destroy();
          return;
        }
        this.client = socket;
        this.flushed = false;
        this.handleClient(socket);
      });

      // Single connection only
      server.maxConnections = 1;

      let settled = false;
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        // Close the failed server so a retry can rebind the same name cleanly.
        try { server.close(); } catch { /* ignore */ }
        reject(err);
      });

      server.listen(pipeName, () => {
        if (settled) return;
        settled = true;
        this.server = server;
        resolve();
      });
    });
  }

  /** Write PTY output data to the connected client. */
  writeToClient(data: Buffer): void {
    if (this.client && !this.client.destroyed && this.flushed) {
      this.client.write(data);
    }
  }

  /** Register callback for client input (forwarded to PTY stdin). */
  onInput(callback: (data: Buffer) => void): void {
    this.inputCallback = callback;
  }

  /** Stop the session pipe and clean up. */
  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    if (!this.server) return;

    const pipeName = this.getPipeName();

    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        if (process.platform !== 'win32') {
          try {
            const stat = fs.lstatSync(pipeName);
            if (stat.isSocket()) {
              fs.unlinkSync(pipeName);
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

  /** Whether a client is currently connected. */
  get isConnected(): boolean {
    return this.client !== null && !this.client.destroyed;
  }

  /** Disconnect any authenticated client after daemon token rotation. */
  handleAuthTokenRotated(): void {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.flushed = false;
    this.connectionRate = { count: 0, resetAt: 0 };
  }

  private handleClient(socket: net.Socket): void {
    // Auth handshake: client must send TOKEN\n within 5 seconds
    let authBuffer = Buffer.alloc(0);
    let authenticated = false;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        socket.destroy();
        if (this.client === socket) {
          this.client = null;
          this.flushed = false;
        }
      }
    }, 5_000);

    const onAuthData = (data: Buffer): void => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      authBuffer = Buffer.concat([authBuffer, chunk]);

      const newlineIndex = authBuffer.indexOf(0x0a); // '\n'
      if (newlineIndex === -1) {
        // No newline yet — keep buffering (but cap at 1KB to prevent abuse)
        if (authBuffer.length > 1024) {
          clearTimeout(authTimeout);
          socket.destroy();
          if (this.client === socket) {
            this.client = null;
            this.flushed = false;
          }
        }
        return;
      }

      clearTimeout(authTimeout);
      const clientToken = authBuffer.subarray(0, newlineIndex);
      const expectedToken = Buffer.from(this.authTokenProvider());

      if (clientToken.length !== expectedToken.length ||
          !crypto.timingSafeEqual(clientToken, expectedToken)) {
        socket.write('AUTH_FAILED\n');
        socket.destroy();
        if (this.client === socket) {
          this.client = null;
          this.flushed = false;
        }
        return;
      }

      // Auth succeeded
      authenticated = true;
      socket.removeListener('data', onAuthData);

      // Any data after the newline is leftover input — process after setup
      const leftover = authBuffer.subarray(newlineIndex + 1);

      // Step 1: Flush ring buffer contents
      const buffered = this.ringBuffer.readAll();
      // Instrumentation for #35 (scrollback-empty-after-restart). Pairs
      // with `[recovery] session X bytes=N` on daemon startup and
      // `Suspended session X (buffer: N bytes)` on shutdown. If those
      // two upstream stages report N>0 but this prints bytes=0, the
      // renderer attach raced the recovery write and we flushed before
      // RingBuffer was repopulated — the scrollback-empty signature.
      // eslint-disable-next-line no-console
      console.log(
        `[SessionPipe.flush] sessionId=${this.sessionId} bytes=${buffered.length}`,
      );
      if (buffered.length > 0) {
        socket.write(buffered);
      }

      // Step 2: Send flush done marker
      socket.write(FLUSH_DONE_MARKER);
      this.flushed = true;

      // Step 3: Forward client input to PTY via callback
      socket.on('data', (inputData: Buffer) => {
        if (this.inputCallback) {
          this.inputCallback(Buffer.isBuffer(inputData) ? inputData : Buffer.from(inputData));
        }
      });

      // Process any leftover data after the auth token line
      if (leftover.length > 0 && this.inputCallback) {
        this.inputCallback(leftover);
      }
    };

    socket.on('data', onAuthData);

    socket.on('close', () => {
      clearTimeout(authTimeout);
      if (this.client === socket) {
        this.client = null;
        this.flushed = false;
      }
    });

    socket.on('error', () => {
      clearTimeout(authTimeout);
      if (this.client === socket) {
        socket.destroy();
        this.client = null;
        this.flushed = false;
      }
    });
  }
}

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

  constructor(
    private readonly sessionId: string,
    private readonly ringBuffer: RingBuffer,
    private readonly authToken: string,
  ) {}

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

    return new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => {
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
      this.server.maxConnections = 1;

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        reject(err);
      });

      // On Unix, remove stale socket file
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

      this.server.listen(pipeName, () => {
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
      const expectedToken = Buffer.from(this.authToken);

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

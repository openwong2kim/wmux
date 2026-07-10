import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import type { RingBuffer } from './RingBuffer';

/** Marker sent after Ring Buffer flush to signal transition to real-time mode. */
export const FLUSH_DONE_MARKER = Buffer.from('\x00WMUX_FLUSH_DONE\x00');

/**
 * In-band announcement that a live-pipe re-flush is starting (phase 3 PR-B).
 * Written on the ALREADY-FLUSHED stream right before live output is
 * suppressed; everything after it up to the next FLUSH_DONE_MARKER is replay
 * (snapshot or raw) that the client must accumulate exactly like the initial
 * flush. Carrying the state transition in the stream itself is what makes the
 * protocol race-free: no RPC-vs-stream ordering can misclassify bytes.
 */
export const RESYNC_BEGIN_MARKER = Buffer.from('\x00WMUX_RESYNC_BEGIN\x00');

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
  private reflushInFlight = false;
  private connectionRate = { count: 0, resetAt: 0 };

  // A single session pipe is legitimately consumed by at most one renderer at a time.
  // Anything above this cap in a 1-second window is brute-force / scanner traffic.
  private static readonly MAX_NEW_CONNECTIONS_PER_SEC = 10;

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

  /** Whether the connected client has completed its initial flush (live mode). */
  get isFlushed(): boolean {
    return this.isConnected && this.flushed;
  }

  /**
   * Live-pipe re-flush (phase 3 PR-B): re-run the flush sequence on the
   * EXISTING connected socket — no teardown, no re-auth, so the input path
   * (which never checks `flushed`, see handleClient step 3) keeps flowing and
   * there is no input dead-zone and no dead-pane replacement.
   *
   * Gap-free byte accounting: every PTY byte lands in exactly one of
   *   - pre-T0  — ring buffer readAll, parsed into the snapshot,
   *   - T0..T1  — tee'd from the bridge while the snapshot is generated;
   *               drained into the snapshot, with any post-last-drain
   *               leftovers written verbatim AFTER the marker (they are live
   *               bytes the headless parser never saw),
   *   - post-T1 — normal live writes (flushed=true again).
   * T0 and T1 are single synchronous blocks, so no 'data' event can interleave
   * with the capture or the finalize.
   *
   * Degrade ladder ("slower, never wrong"): when the generator declines
   * (alt-screen, margins, budget, error), fall back to a classic raw
   * ring-buffer replay — the exact bytes the initial flush would send.
   */
  async reflush(opts: {
    /** The session's PTY bridge — tee source for bytes arriving mid-generation. */
    bridge: {
      on(event: 'data', listener: (data: Buffer) => void): unknown;
      removeListener(event: 'data', listener: (data: Buffer) => void): unknown;
    };
    cols: number;
    rows: number;
    scrollback?: number;
    generate: (req: {
      cols: number;
      rows: number;
      scrollback?: number;
      initial: Buffer;
      drainQueue: () => Buffer[];
    }) => Promise<
      | { ok: true; payload: Buffer; bytesIn: number; durationMs: number }
      | { ok: false; reason: string; detail?: string }
    >;
    /**
     * Global snapshot-slot acquisition (HeadlessSnapshot.enqueueSnapshotJob).
     * The ENTIRE suppress→snapshot→finalize window runs inside the slot so
     * that under concurrent reveals a queued pane keeps streaming live until
     * its work can actually start — announcing RESYNC_BEGIN before holding
     * the slot would suppress it for N×budget and outlive the renderer's
     * resync timeout (Codex P2). Omitted (tests) → run immediately.
     */
    enqueue?: <T>(job: () => Promise<T>) => Promise<T>;
  }): Promise<{ mode: 'snapshot' | 'raw'; fallbackReason?: string }> {
    // Order matters: an in-flight reflush holds `flushed=false` from its T0
    // block, so the busy check must run BEFORE the flushed check or a
    // concurrent call would always misreport as UNAVAILABLE. The busy window
    // covers the queue wait too (reflushInFlight is set before enqueue).
    if (this.reflushInFlight) {
      throw new Error('RESYNC_BUSY: a re-flush is already in progress');
    }
    if (!this.isFlushed) {
      throw new Error('RESYNC_UNAVAILABLE: no flushed client on session pipe');
    }
    this.reflushInFlight = true;
    try {
      const enqueue = opts.enqueue ?? (<T>(job: () => Promise<T>) => job());
      return await enqueue(() => this.reflushInSlot(opts));
    } finally {
      this.reflushInFlight = false;
    }
  }

  /** The slot-holding body of {@link reflush} — see the protocol notes there. */
  private async reflushInSlot(opts: {
    bridge: {
      on(event: 'data', listener: (data: Buffer) => void): unknown;
      removeListener(event: 'data', listener: (data: Buffer) => void): unknown;
    };
    cols: number;
    rows: number;
    scrollback?: number;
    generate: (req: {
      cols: number;
      rows: number;
      scrollback?: number;
      initial: Buffer;
      drainQueue: () => Buffer[];
    }) => Promise<
      | { ok: true; payload: Buffer; bytesIn: number; durationMs: number }
      | { ok: false; reason: string; detail?: string }
    >;
  }): Promise<{ mode: 'snapshot' | 'raw'; fallbackReason?: string }> {
    // Re-validate under the slot: the client can disconnect (or be replaced
    // by a fresh connection mid-initial-flush) during the queue wait.
    const socket = this.client;
    if (!socket || socket.destroyed || !this.flushed) {
      throw new Error('RESYNC_UNAVAILABLE: no flushed client on session pipe');
    }
    const teeQueue: Buffer[] = [];
    const tee = (data: Buffer) => {
      teeQueue.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    };
    try {
      // T0 — one synchronous block: announce, suppress live writes, capture
      // the ring, arm the tee. Nothing can arrive between these statements.
      socket.write(RESYNC_BEGIN_MARKER);
      this.flushed = false;
      const initial = this.ringBuffer.readAll();
      opts.bridge.on('data', tee);

      let outcome: Awaited<ReturnType<typeof opts.generate>>;
      try {
        outcome = await opts.generate({
          cols: opts.cols,
          rows: opts.rows,
          scrollback: opts.scrollback,
          initial,
          drainQueue: () => teeQueue.splice(0),
        });
      } catch (err) {
        outcome = {
          ok: false,
          reason: 'error',
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      // T1 — finalize. MUST stay synchronous through `flushed = true`: a
      // 'data' event firing between tee removal and re-enable would be lost.
      opts.bridge.removeListener('data', tee);
      if (this.client !== socket || socket.destroyed) {
        // Client vanished (or reconnected fresh) mid-generation — the new
        // connection runs its own initial flush; abort without touching it.
        throw new Error('RESYNC_DISCONNECTED: client changed during re-flush');
      }
      // RIS prefix: live bytes that raced ahead of RESYNC_BEGIN were buffered
      // by the renderer's pending-resync state and get written BEFORE this
      // replay — but they are pre-T0 bytes the snapshot (or raw readAll)
      // already contains. A full reset first makes the replay idempotent
      // against that duplicated prefix instead of appending misaligned.
      const RIS = Buffer.from('\x1bc');
      if (outcome.ok) {
        const tailRaw = teeQueue.length > 0 ? Buffer.concat(teeQueue.splice(0)) : null;
        socket.write(RIS);
        socket.write(outcome.payload);
        socket.write(FLUSH_DONE_MARKER);
        this.flushed = true;
        if (tailRaw && tailRaw.length > 0) {
          socket.write(tailRaw);
        }
        // eslint-disable-next-line no-console
        console.log(
          `[SessionPipe.reflush] sessionId=${this.sessionId} mode=snapshot payload=${outcome.payload.length} parsed=${outcome.bytesIn} durationMs=${outcome.durationMs}`,
        );
        return { mode: 'snapshot' };
      }
      // Raw degrade: the ring keeps being written by the session manager
      // independent of this pipe, so a fresh readAll here already contains
      // every tee'd byte — the classic replay, gap-free because this block
      // is synchronous.
      teeQueue.length = 0;
      const raw = this.ringBuffer.readAll();
      socket.write(RIS);
      socket.write(raw);
      socket.write(FLUSH_DONE_MARKER);
      this.flushed = true;
      // A3 rollout metric: fallback-rate by reason.
      // eslint-disable-next-line no-console
      console.log(
        `[SessionPipe.reflush] sessionId=${this.sessionId} mode=raw fallbackReason=${outcome.reason}${outcome.detail ? ` detail=${outcome.detail}` : ''} bytes=${raw.length}`,
      );
      return { mode: 'raw', fallbackReason: outcome.reason };
    } finally {
      opts.bridge.removeListener('data', tee);
    }
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

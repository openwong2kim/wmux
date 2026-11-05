import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSessionSocketPath } from '../shared/constants';
import { ATTACH_SNAPSHOT_MIN_BYTES } from '../shared/terminal/attachSnapshot';
import type { RingBuffer, ReplayGeometry } from './RingBuffer';
import type { OutputModeTracker } from './util/outputModeTracker';
import { readRingTailWithModesAndGeometry, readRingWithModesAndGeometry } from './sessionTextReplay';
import { enqueueSnapshotJob, generateSnapshotUnqueued, runSmallSnapshotJob, MAX_SCROLLBACK } from './HeadlessSnapshot';
import {
  createSessionPipeMarkers,
  type SessionPipeMarkers,
} from './sessionPipeMarkers';

// Re-exported for existing importers; the factory lives in the dependency-free
// sessionPipeMarkers module so the Electron main bundle can derive the same
// authenticated markers without dragging @xterm/headless into its Vite graph.
export { createSessionPipeMarkers };

/**
 * TASK-10: initial-attach flushes at or above ATTACH_SNAPSHOT_MIN_BYTES go
 * through the daemon-side HeadlessSnapshot instead of shipping raw bytes (see
 * its definition). The resync/reflush path has its own caller-side policy —
 * see reflush.
 */
export { ATTACH_SNAPSHOT_MIN_BYTES };
/** The attach snapshot's second try parses only this much of the ring's
 *  newest output (see flushRingBuffer). Small enough to finish well inside
 *  the budget on a busy daemon, large enough to hold many full redraws of an
 *  agent's screen. */
export const ATTACH_TAIL_SNAPSHOT_BYTES = 1024 * 1024;
/** The second try's budget. It runs in the same snapshot queue slot as the
 *  first, so every other pane's attach and reveal waits behind both; 1 MB
 *  parses in about 0.25 s at the measured ~4 MB/s. */
export const ATTACH_TAIL_SNAPSHOT_BUDGET_MS = 1500;

/** How long releaseClient waits for the client to close its side (#3073). */
export const CLIENT_RELEASE_MS = 500;

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
  private inputCallback: ((data: Buffer) => unknown) | null = null;
  private pendingInput: Buffer | null = null;
  private inputDrainDispose?: () => void;
  private flushed = false;
  private reflushInFlight = false;
  private socketPeakQueuedBytes = 0;
  private resyncQueuedBytes = 0;
  private connectionRate = { count: 0, resetAt: 0 };
  private readonly markers: SessionPipeMarkers;

  /**
   * Fired when the AUTHED client socket goes away (close or error) without a
   * detach RPC — i.e. the GUI crashed / was force-killed. The daemon wires this
   * to demote a stuck-'attached' session to 'detached' after a grace period so
   * the TTL reaper can eventually age it out (#557). Never fires for pre-auth
   * sockets (scanner/handshake churn).
   */
  onClientGone?: () => void;

  // A single session pipe is legitimately consumed by at most one renderer at a time.
  // Anything above this cap in a 1-second window is brute-force / scanner traffic.
  private static readonly MAX_NEW_CONNECTIONS_PER_SEC = 10;

  constructor(
    private readonly sessionId: string,
    private readonly ringBuffer: RingBuffer,
    private readonly authToken: string,
    /**
     * TASK-10: live terminal dimensions for the attach-flush snapshot mirror.
     * Optional — absent (older call sites, tests) disables snapshotting and
     * the flush ships raw bytes exactly as before.
     */
    private readonly getDims?: () => { cols: number; rows: number },
    /**
     * #1843: the session's output-mode tracker. A fullscreen TUI switches its
     * modes (alt screen, mouse tracking, bracketed paste) once, at startup;
     * after enough output those bytes have aged out of the ring, and a replay
     * without them leaves the renderer on the normal buffer with the mouse
     * off. Every replay below is led by the tracker's preamble. Absent (tests,
     * older call sites) replays the ring as-is.
     */
    private readonly getOutputModes?: () => Pick<OutputModeTracker, 'preamble'> | null,
  ) {
    this.markers = createSessionPipeMarkers(authToken);
  }

  /** Get the platform-specific pipe name for this session.
   * P7: Unix 소켓은 ~/.wmux{suffix}/ 하위 — shared 헬퍼가 클라이언트
   * (main/DaemonClient.getSessionPipeName)와 lockstep의 단일 진실 소스. */
  getPipeName(): string {
    return getSessionSocketPath(this.sessionId);
  }

  /** Counters only; the peak covers this pipe object's lifetime, including replay. */
  getMemoryDiagnostics(): { socketQueuedBytes: number; socketPeakQueuedBytes: number; resyncQueuedBytes: number } {
    return {
      socketQueuedBytes: this.client && !this.client.destroyed ? this.client.writableLength : 0,
      socketPeakQueuedBytes: this.socketPeakQueuedBytes,
      resyncQueuedBytes: this.resyncQueuedBytes,
    };
  }

  private writeOutput(socket: net.Socket, data: Buffer): void {
    socket.write(data);
    this.socketPeakQueuedBytes = Math.max(this.socketPeakQueuedBytes, socket.writableLength);
  }

  /** Start listening for a single client connection. */
  async start(): Promise<void> {
    if (this.server) return;

    const pipeName = this.getPipeName();

    // On Unix, ensure the parent dir (~/.wmux{suffix}) exists — P7 moved the
    // socket under it — then remove a stale socket file left by a prior run.
    if (process.platform !== 'win32') {
      try {
        fs.mkdirSync(path.dirname(pipeName), { recursive: true });
      } catch {
        // best-effort — bind가 곧 실패를 드러낸다
      }
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
        this.pendingInput = null;
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

  /**
   * Attach flush (TASK-10). Small buffers ship raw exactly as before. Large
   * buffers (≥ SNAPSHOT_MIN_BYTES, dims available) are replayed through a
   * headless terminal daemon-side and the SERIALIZED screen+scrollback is
   * shipped instead — same wire format (plain ANSI), a fraction of the
   * bytes, so the renderer's synchronous parse on reveal shrinks from
   * multi-second to near-instant.
   *
   * Ordering safety: writeToClient gates on `flushed`, so live PTY output
   * during the async parse never reaches the socket — it lands only in the
   * ring buffer. After the snapshot we re-read the ring and ship the bytes
   * that arrived during the parse as a DELTA, located by the ring's lifetime
   * byte counter. Only if more arrived than the ring holds is the snapshot
   * discarded and the fresh full read shipped raw — fail-open, never a gap.
   */
  private readRing(): ReturnType<typeof readRingWithModesAndGeometry> {
    return readRingWithModesAndGeometry(this.ringBuffer, this.getOutputModes?.() ?? null);
  }

  private async flushRingBuffer(socket: net.Socket): Promise<void> {
    // Waiting attaches retain only the ring, not a second full history copy.
    // Keep small rings off the queue so interactive shells do not wait behind
    // another pane's snapshot. Re-read dimensions inside the slot.
    //
    // #2585: a small ring with a size change in it is still parsed at its
    // written sizes (below), but here, not in the slot. Every new pane is
    // that ring: its preamble is written at the size estimated at create, and
    // the first fit resizes it before the renderer's reattach. Until the
    // flush-done marker the client gets no live output (writeToClient gates
    // on `flushed`) while its input already flows, so a queue held by other
    // panes' snapshots left new panes blank and unable to answer the shell's
    // cursor queries.
    //
    // That bounds each parse's input, not its memory: every headless terminal
    // is built with MAX_SCROLLBACK rows, and after a daemon restart every pane
    // reattaches at once. So a small-ring parse takes the separate small gate
    // (runSmallSnapshotJob), which waits only behind other small parses, never
    // behind the queue. A ring with no size change ships raw and takes neither.
    if (this.getDims && this.ringBuffer.size >= ATTACH_SNAPSHOT_MIN_BYTES) {
      return enqueueSnapshotJob(() => this.flushRingBufferInSlot(socket));
    }
    if (this.getDims && this.ringBuffer.hasGeometryChanges) {
      // The size above was read before the gate wait. A ring that grew past
      // the bar meanwhile is no longer small: leave the gate and take the
      // queue, without holding a gate place while waiting there.
      const grown = await runSmallSnapshotJob(async () => {
        if (this.ringBuffer.size >= ATTACH_SNAPSHOT_MIN_BYTES) return true;
        await this.flushRingBufferInSlot(socket);
        return false;
      });
      if (grown) return enqueueSnapshotJob(() => this.flushRingBufferInSlot(socket));
      return;
    }
    return this.flushRingBufferInSlot(socket);
  }

  private async flushRingBufferInSlot(socket: net.Socket): Promise<void> {
    // A queued attach may have disappeared or been replaced while waiting.
    if (socket.destroyed || this.client !== socket) return;
    const { raw: buffered, replay, geometry, writtenAt: writtenBefore } = this.readRing();
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

    let payload = replay;
    const dims = this.getDims?.();
    // A size change inside the ring garbles a raw replay (cursor-up redraws
    // land on the wrong rows), so such a ring goes through the snapshot
    // however small it is.
    const otherSize = !!geometry?.changes.length;
    if (dims && (buffered.length >= ATTACH_SNAPSHOT_MIN_BYTES || otherSize)) {
      // Reuses the resync path's HeadlessSnapshot (alt-screen/margins/
      // partial-tail fail-open ladder, DECSET modes tail), inside the global
      // concurrency-1 slot for a large ring and the small-ring gate for a
      // small one (see flushRingBuffer). No live tee here: unlike
      // reflush there is no bridge handle at this layer, so bytes arriving
      // DURING the parse are recovered by re-reading the ring afterwards —
      // writeToClient gates on `flushed`, so nothing reaches the socket in
      // between.
      let base = writtenBefore;
      let outcome = await generateSnapshotUnqueued({
        cols: dims.cols,
        rows: dims.rows,
        // Led by the mode preamble, so an alt screen or mouse / paste mode the
        // ring no longer carries is still restored. Geometry offsets are
        // shifted past the preamble by readRingWithModesAndGeometry.
        initial: replay,
        geometry,
        // This layer has no renderer config, and the renderer's xterm scrollback
        // is user-configurable (default 10k) above the snapshot DEFAULT (5k). A
        // successful snapshot would otherwise truncate history the raw replay
        // preserved, so request the lossless upper bound — the headless terminal
        // is per-snapshot and disposed.
        scrollback: MAX_SCROLLBACK,
      });
      if (socket.destroyed || this.client !== socket) return; // client left mid-parse
      if (!outcome.ok && outcome.reason === 'budget') {
        // The whole ring did not parse in time (seen on a live agent pane
        // while the daemon was busy). A raw replay of a cursor-addressed app's
        // history at mixed widths paints its redraws over each other, so
        // rebuild the screen from the newest output instead: older
        // scrollback is lost, the screen comes out right.
        // eslint-disable-next-line no-console
        console.log(
          `[SessionPipe.flush] sessionId=${this.sessionId} snapshot over budget (${outcome.detail ?? ''}), retrying on the newest ${ATTACH_TAIL_SNAPSHOT_BYTES} bytes`,
        );
        const tail = readRingTailWithModesAndGeometry(
          this.ringBuffer,
          this.getOutputModes?.() ?? null,
          ATTACH_TAIL_SNAPSHOT_BYTES,
        );
        base = tail.writtenAt;
        outcome = await generateSnapshotUnqueued({
          cols: dims.cols,
          rows: dims.rows,
          initial: tail.replay,
          geometry: tail.geometry,
          scrollback: MAX_SCROLLBACK,
          budgetMs: ATTACH_TAIL_SNAPSHOT_BUDGET_MS,
        });
        if (socket.destroyed || this.client !== socket) return;
      }
      // Size guard: when most of the history still fits inside the
      // serialized scrollback (buffers just past the threshold), the
      // cell-by-cell SGR reconstruction can come out BIGGER than the raw
      // stream. No win then — ship raw. The big-ring case this path exists
      // for (megabytes of overwritten history) compresses drastically.
      // Not when the size changed inside the ring: raw replays the history
      // at the current width, which garbles what was written at another.
      if (outcome.ok && outcome.payload.length >= buffered.length && !otherSize) {
        // No gain — ship raw. But re-read the ring first: bytes written DURING
        // the await were gated off the socket (flushed=false) and are absent
        // from the pre-parse `buffered`. Shipping `buffered` here would drop
        // that live delta until the next resync (silent output loss). `after`
        // ⊇ `buffered` by the append-only prefix property; a wrap only makes it
        // a fresh honest raw read — either way `after` is the correct payload.
        payload = this.readRing().replay;
        // eslint-disable-next-line no-console
        console.log(
          `[SessionPipe.flush] sessionId=${this.sessionId} mode=raw fallbackReason=no-gain snapshot=${outcome.payload.length} raw=${payload.length}`,
        );
      } else if (outcome.ok) {
        // The delta is the newest `written` bytes of the ring. A full ring
        // drops its oldest bytes on every write, so the old "pre-parse read is
        // a prefix of the new one" test failed for any byte arriving while an
        // 8 MB ring was parsed — and threw away every busy pane's snapshot.
        // The lifetime counter locates the delta whether or not the ring
        // dropped bytes; only a delta larger than the ring itself is lost.
        const { raw: after, replay: afterReplay } = this.readRing();
        const written = this.ringBuffer.totalBytesWritten - base;
        if (written > after.length) {
          payload = afterReplay;
          // eslint-disable-next-line no-console
          console.log(
            `[SessionPipe.flush] sessionId=${this.sessionId} snapshot discarded (live delta ${written} outran the ring) bytes=${after.length}`,
          );
        } else {
          payload = Buffer.concat([outcome.payload, after.subarray(after.length - written)]);
          // eslint-disable-next-line no-console
          console.log(
            `[SessionPipe.flush] sessionId=${this.sessionId} mode=snapshot ` +
              `${outcome.bytesIn} -> ${outcome.payload.length} bytes ` +
              `(+${written} live delta) durationMs=${outcome.durationMs}`,
          );
        }
      } else {
        // Snapshot failed (alt-screen, margins, budget, ...) — ship raw. Same
        // live-delta hazard as the no-gain branch: re-read the ring so bytes
        // that arrived during the failed parse are retransmitted, not dropped.
        payload = this.readRing().replay;
        // eslint-disable-next-line no-console
        console.log(
          `[SessionPipe.flush] sessionId=${this.sessionId} mode=raw fallbackReason=${outcome.reason}${'detail' in outcome && outcome.detail ? ` detail=${outcome.detail}` : ''}`,
        );
      }
    }

    if (payload.length > 0) {
      this.writeOutput(socket, payload);
    }
    this.writeOutput(socket, this.markers.flushDone);
    this.flushed = true;
  }

  /** Write PTY output data to the connected client. */
  writeToClient(data: Buffer): void {
    if (this.client && !this.client.destroyed && this.flushed) {
      this.writeOutput(this.client, data);
    }
  }

  /** Register callback for client input (forwarded to PTY stdin). */
  onInput(callback: (data: Buffer) => unknown): void {
    this.inputCallback = callback;
  }

  /** Pause only the incoming stream; output and reconnect keep their contracts. */
  setInputPaused(paused: boolean): void {
    if (paused) { this.client?.pause(); return; }
    if (this.pendingInput) {
      const pending = this.pendingInput;
      this.pendingInput = null;
      this.forwardInput(pending);
      if (this.pendingInput) return;
    }
    this.client?.resume();
  }

  private forwardInput(data: Buffer): void {
    try {
      if (this.inputCallback?.(data) === false) {
        // A paused socket has at most one unread callback in flight. Keep its
        // exact bytes for retry; do not acknowledge or drop a partial write.
        if (this.pendingInput || data.length > 256 * 1024) throw new Error('PTY input retry capacity exceeded');
        this.pendingInput = data;
        this.client?.pause();
      }
    } catch (error) {
      console.error('[SessionPipe] PTY input failed; closing input connection', error instanceof Error ? error.message : 'unknown error');
      this.pendingInput = null;
      this.client?.destroy();
    }
  }

  setInputDrainSubscription(dispose: () => void): void {
    this.inputDrainDispose?.(); this.inputDrainDispose = dispose;
  }

  /**
   * Let the client go before this pipe is replaced (daemon.attachSession)
   * without dropping input it already sent (#3073). Destroying the socket
   * discards bytes this end has not read yet, so the daemon ends its side
   * instead and keeps forwarding input until the client closes. main's
   * socket does not allow half-open (Node's default), so it ends its own side
   * right after what it already wrote (a Windows named pipe has no half-close
   * and closes at once). Output from here on stays in the ring,
   * for the next pipe's flush. A client that has not closed by `timeoutMs` is
   * destroyed by stop() as before.
   */
  async releaseClient(timeoutMs = CLIENT_RELEASE_MS): Promise<void> {
    const client = this.client;
    if (!client || client.destroyed) return;
    this.flushed = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      client.once('close', () => { clearTimeout(timer); resolve(); });
      client.end();
    });
  }

  /** Stop the session pipe and clean up. */
  async stop(): Promise<void> {
    this.pendingInput = null;
    this.inputDrainDispose?.(); this.inputDrainDispose = undefined;
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

  /** Whether a client socket is currently held (used by the orphan-demote guard). */
  hasClient(): boolean {
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
      geometry?: ReplayGeometry;
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
      geometry?: ReplayGeometry;
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
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      teeQueue.push(chunk);
      this.resyncQueuedBytes += chunk.length;
    };
    const drainQueue = () => {
      this.resyncQueuedBytes = 0;
      return teeQueue.splice(0);
    };
    try {
      // T0 — one synchronous block: announce, suppress live writes, capture
      // the ring, arm the tee. Nothing can arrive between these statements.
      this.writeOutput(socket, this.markers.resyncBegin);
      this.flushed = false;
      const { replay: initial, geometry } = this.readRing();
      opts.bridge.on('data', tee);

      let outcome: Awaited<ReturnType<typeof opts.generate>>;
      try {
        outcome = await opts.generate({
          cols: opts.cols,
          rows: opts.rows,
          scrollback: opts.scrollback,
          initial,
          geometry,
          drainQueue,
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
        const tailRaw = teeQueue.length > 0 ? Buffer.concat(drainQueue()) : null;
        this.writeOutput(socket, RIS);
        this.writeOutput(socket, outcome.payload);
        this.writeOutput(socket, this.markers.flushDone);
        this.flushed = true;
        if (tailRaw && tailRaw.length > 0) {
          this.writeOutput(socket, tailRaw);
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
      this.resyncQueuedBytes = 0;
      const raw = this.readRing().replay;
      this.writeOutput(socket, RIS);
      this.writeOutput(socket, raw);
      this.writeOutput(socket, this.markers.flushDone);
      this.flushed = true;
      // A3 rollout metric: fallback-rate by reason.
      // eslint-disable-next-line no-console
      console.log(
        `[SessionPipe.reflush] sessionId=${this.sessionId} mode=raw fallbackReason=${outcome.reason}${outcome.detail ? ` detail=${outcome.detail}` : ''} bytes=${raw.length}`,
      );
      return { mode: 'raw', fallbackReason: outcome.reason };
    } finally {
      opts.bridge.removeListener('data', tee);
      this.resyncQueuedBytes = 0;
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

      // Forward client input to PTY BEFORE the (possibly async) flush below:
      // input is independent of output-flush state, and wiring it here means
      // keystrokes arriving while a large snapshot builds are never dropped.
      socket.on('data', (inputData: Buffer) => {
        this.forwardInput(Buffer.isBuffer(inputData) ? inputData : Buffer.from(inputData));
      });
      if (leftover.length > 0 && this.inputCallback) {
        this.forwardInput(leftover);
      }

      // Flush the ring buffer (snapshot path may await); errors fail open to
      // a raw flush inside, so this catch only guards socket teardown races.
      void this.flushRingBuffer(socket).catch(() => {
        if (!socket.destroyed) socket.destroy();
      });
    };

    socket.on('data', onAuthData);

    socket.on('close', () => {
      clearTimeout(authTimeout);
      if (this.client === socket) {
        this.client = null;
        this.flushed = false;
        // Notify only for an authed client that vanished without a detach RPC
        // (GUI crash / kill). Pre-auth churn must not demote the session.
        if (authenticated) this.onClientGone?.();
      }
    });

    socket.on('error', () => {
      clearTimeout(authTimeout);
      if (this.client === socket) {
        socket.destroy();
        this.client = null;
        this.flushed = false;
        if (authenticated) this.onClientGone?.();
      }
    });
  }
}

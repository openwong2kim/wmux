// One long-lived `/api/events` SSE subscription per ATTACHED remote host.
//
// Why main and not the renderer: the attach roster that decides which hosts
// need a subscription is already main-owned and persisted
// (RemoteAttachmentsStore), the bearer token lives in main and structurally
// never crosses into the renderer (RemoteHostPublic), and the notification
// path this feeds (dispatchNotification) is a main-process function. A
// renderer-side subscription would need the token, would die on every Cmd+R,
// and would have to bridge every event back over IPC to reach the same
// dispatcher.
//
// Separate from RemoteHostClient on purpose: that class is per-PANE (attach
// ids, snapshot/meta pairing, write coalescing, a bounded retry budget after
// which the mirror reports a dead stream). This one is per-HOST, carries no
// pane state, and must keep retrying for as long as the host is attached.

import type { RemoteHost } from '../../shared/remoteHosts';
import { RemoteAttentionGate, type RemoteAttentionNotification } from './remoteAttention';

// Reconnect backoff, +/-30% jitter so several hosts dropped by one tailnet
// blip do not reconnect in lockstep. Unlike the pane client this never gives
// up: an attached host that is asleep overnight must start notifying again
// when it comes back, without the user re-attaching.
const BACKOFF_STEPS_MS = [1_000, 2_000, 5_000, 15_000, 60_000];
const JITTER_RATIO = 0.3;

/**
 * A rejected or missing endpoint is not a blip: retrying it a second later
 * only burns battery and log lines. 401/403 (token revoked, device removed)
 * and 404 (a daemon too old to have this route) go straight to the slowest
 * step, which still recovers on its own once the host is fixed.
 */
const HOPELESS_STATUSES = new Set([401, 403, 404]);

/**
 * No bytes for this long means the stream is a zombie: the daemon heartbeats
 * `/api/events` every 25s (sseHeartbeat.ts), so three missed beats is a
 * connection that a laptop sleep or a NAT rebind has silently severed while
 * leaving the socket open. Without this, `read()` parks forever and the host
 * simply stops notifying until the app restarts.
 */
const IDLE_TIMEOUT_MS = 75_000;

/**
 * Hard cap on the unterminated tail of the frame buffer. A remote daemon is
 * not trusted with unbounded main-process heap: a peer that never sends a
 * frame separator would otherwise grow this forever.
 */
const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * Token bucket, per host. A pane that loops OSC 9 — or a compromised host —
 * must not be able to fire unlimited OS banners. Excess is dropped rather
 * than queued: a stale backlog of toasts is worth less than none.
 */
const BURST_CAPACITY = 5;
const REFILL_INTERVAL_MS = 4_000;

/** SSE frame and line separators, per spec — a proxy may normalise newlines. */
const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

export interface RemoteAttentionSubscriberDeps {
  host: RemoteHost;
  /** Fires for each transition that survives the replay gate. */
  onNotification: (hostLabel: string, n: RemoteAttentionNotification) => void;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (t: ReturnType<typeof setTimeout>) => void;
  /** Deterministic backoff in tests. */
  jitter?: () => number;
}

function backoffForAttempt(attempt: number, jitter: () => number): number {
  const base = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
  return Math.max(0, Math.round(base + base * JITTER_RATIO * (jitter() * 2 - 1)));
}

export class RemoteAttentionSubscriber {
  private readonly deps: RemoteAttentionSubscriberDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly gate = new RemoteAttentionGate();

  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  /**
   * Bumped on every start(). Every async resumption point checks it, so a
   * stop()/start() pair cannot leave the aborted run's continuation alive to
   * schedule a second reconnect loop against the same gate.
   */
  private generation = 0;

  private tokens = BURST_CAPACITY;
  private lastRefillAt = 0;

  constructor(deps: RemoteAttentionSubscriberDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.generation += 1;
    void this.run(this.generation);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    const clear = this.deps.clearTimeoutImpl ?? clearTimeout;
    if (this.reconnectTimer) {
      clear(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.idleTimer) {
      clear(this.idleTimer);
      this.idleTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  /** True while `gen` is still the live run. */
  private current(gen: number): boolean {
    return !this.stopped && this.generation === gen;
  }

  private async run(gen: number): Promise<void> {
    if (!this.current(gen)) return;
    const controller = new AbortController();
    this.controller = controller;
    // No cursor on purpose — see RemoteAttentionGate: every connect replays
    // the whole window and every replayed event is suppressed, which is what
    // keeps a reconnect from banner-ing a backlog.
    this.gate.beginStream();

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.deps.host.origin}/api/events`, {
        headers: {
          Authorization: `Bearer ${this.deps.host.token}`,
          Accept: 'text/event-stream',
        },
        // Bearer-credentialed request: never follow a redirect. No request
        // timeout — the stream is long-lived by design, and the idle watchdog
        // below is what catches one that stops speaking.
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      this.scheduleReconnect(gen);
      return;
    }
    if (!this.current(gen)) {
      discard(res);
      return;
    }
    if (!res.ok || !res.body) {
      // An unread body pins its connection until GC; with an unbounded retry
      // loop behind it that is a socket leak, not a one-off.
      discard(res);
      this.scheduleReconnect(gen, res.status);
      return;
    }

    try {
      await this.pump(gen, res.body, controller);
    } catch {
      /* read error — treated the same as a clean end: reconnect */
    } finally {
      this.clearIdleWatchdog();
    }
    if (!this.current(gen)) return;
    this.scheduleReconnect(gen);
  }

  private async pump(
    gen: number,
    body: ReadableStream<Uint8Array>,
    controller: AbortController,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    this.armIdleWatchdog(controller);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (!this.current(gen)) return;
        this.armIdleWatchdog(controller);
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const match = FRAME_SEPARATOR.exec(buffer);
          if (!match) break;
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          this.handleFrame(frame);
          if (!this.current(gen)) return;
        }
        if (buffer.length > MAX_BUFFER_BYTES) {
          // A peer that never terminates a frame is not one to keep reading.
          controller.abort();
          return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleFrame(raw: string): void {
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of raw.split(/\r\n|\n|\r/)) {
      if (line.startsWith(':')) continue; // heartbeat comment
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (event === null) return;
    // Backoff resets on a real EVENT frame, not on a heartbeat: a host that
    // accepts the connection and then only comments would otherwise hold the
    // retry counter at zero and be reconnected every second forever.
    this.attempt = 0;
    const notification = this.gate.consume(event, dataLines.join('\n'));
    if (notification && this.takeToken()) this.deps.onNotification(this.deps.host.label, notification);
  }

  /** Token bucket — see BURST_CAPACITY. Excess notifications are dropped. */
  private takeToken(): boolean {
    const now = Date.now();
    if (this.lastRefillAt === 0) this.lastRefillAt = now;
    const refills = Math.floor((now - this.lastRefillAt) / REFILL_INTERVAL_MS);
    if (refills > 0) {
      this.tokens = Math.min(BURST_CAPACITY, this.tokens + refills);
      this.lastRefillAt += refills * REFILL_INTERVAL_MS;
    }
    if (this.tokens <= 0) return false;
    this.tokens -= 1;
    return true;
  }

  private armIdleWatchdog(controller: AbortController): void {
    this.clearIdleWatchdog();
    const timer = (this.deps.setTimeoutImpl ?? setTimeout)(() => {
      this.idleTimer = null;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdleWatchdog(): void {
    if (!this.idleTimer) return;
    (this.deps.clearTimeoutImpl ?? clearTimeout)(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleReconnect(gen: number, status?: number): void {
    if (!this.current(gen)) return;
    const attempt = status !== undefined && HOPELESS_STATUSES.has(status)
      ? BACKOFF_STEPS_MS.length - 1
      : this.attempt;
    const delay = backoffForAttempt(attempt, this.deps.jitter ?? Math.random);
    this.attempt = Math.min(this.attempt + 1, BACKOFF_STEPS_MS.length - 1);
    const timer = (this.deps.setTimeoutImpl ?? setTimeout)(() => {
      this.reconnectTimer = null;
      if (!this.current(gen)) return;
      void this.run(gen);
    }, delay);
    timer.unref?.();
    this.reconnectTimer = timer;
  }
}

/** Drain a response we are not going to read, so its socket is released. */
function discard(res: Response): void {
  void res.body?.cancel().catch(() => { /* already torn down */ });
}

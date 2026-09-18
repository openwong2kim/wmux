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
  private attempt = 0;
  private stopped = true;

  constructor(deps: RemoteAttentionSubscriberDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      (this.deps.clearTimeoutImpl ?? clearTimeout)(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
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
        // Bearer-credentialed request: never follow a redirect. No timeout —
        // the stream is long-lived by design (the daemon heartbeats it).
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    if (!res.ok || !res.body) {
      this.scheduleReconnect();
      return;
    }

    try {
      await this.pump(res.body);
    } catch {
      /* read error — treated the same as a clean end: reconnect */
    }
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        // Reset the backoff only once a frame has actually arrived: a host
        // that accepts the request then drops before sending anything would
        // otherwise retry forever at the shortest delay.
        this.attempt = 0;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.handleFrame(frame);
          if (this.stopped) return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleFrame(raw: string): void {
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue; // heartbeat comment
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (event === null) return;
    const notification = this.gate.consume(event, dataLines.join('\n'));
    if (notification) this.deps.onNotification(this.deps.host.label, notification);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = backoffForAttempt(this.attempt, this.deps.jitter ?? Math.random);
    this.attempt += 1;
    const timer = (this.deps.setTimeoutImpl ?? setTimeout)(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.run();
    }, delay);
    timer.unref?.();
    this.reconnectTimer = timer;
  }
}

// PC rail: one `/api/events` stream per web-paired host, for every host the
// column lists (not only attached ones).
//
//   frame ──▶ live? (id above the reset head) ──▶ onFrame(kind, data)  → renderer ledger
//         └─▶ RemoteAttentionGate (replay + dedup) ──▶ onNotification → toast, unless muted
//   connect / reconnect / end ──▶ onState('open' | 'reopen' | 'closed') → renderer reconciles
//
// Replayed frames are never forwarded: the reconcile that follows every open
// is the truth for what was raised while the stream was down. The transport
// rules (backoff, idle watchdog, no redirects) match RemoteAttentionSubscriber;
// frames are split and bounded in bytes by SseFrameSplitter.

import type { RemoteHost } from '../../shared/remoteHosts';
import { isCredentialSafeOriginString } from '../../shared/remotePairInput';
import type { PcRailAttentionFrameKind } from '../../shared/pcRail';
import { REMOTE_LIMITS } from '../../shared/remoteLimits';
import { SseFrameSplitter } from './sseFrameSplitter';
import { RemoteAttentionGate, type RemoteAttentionNotification } from './remoteAttention';

const BACKOFF_STEPS_MS = [1_000, 2_000, 5_000, 15_000, 60_000];
const JITTER_RATIO = 0.3;
const HOPELESS_STATUSES = new Set([401, 403, 404]);
/** The daemon heartbeats every 25 s; three missed beats is a dead socket. */
const IDLE_TIMEOUT_MS = 75_000;
const FRAME_KINDS: ReadonlySet<string> = new Set(['critical', 'approval', 'notify']);

export type PcRailStreamState = 'open' | 'reopen' | 'closed';

export interface PcRailAttentionStreamDeps {
  host: RemoteHost;
  onFrame: (kind: PcRailAttentionFrameKind, data: unknown) => void;
  onState: (state: PcRailStreamState) => void;
  onNotification: (hostLabel: string, n: RemoteAttentionNotification) => void;
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (t: ReturnType<typeof setTimeout>) => void;
  jitter?: () => number;
}

function backoffForAttempt(attempt: number, jitter: () => number): number {
  const base = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
  return Math.max(0, Math.round(base + base * JITTER_RATIO * (jitter() * 2 - 1)));
}

function safeParse(data: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(data);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class PcRailAttentionStream {
  private readonly deps: PcRailAttentionStreamDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly gate = new RemoteAttentionGate();
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private generation = 0;
  /** Streams opened so far in this run; the second and later are a reopen. */
  private opens = 0;
  private open = false;
  /** Highest event id that belongs to the current stream's replay. */
  private replayUntilId = Number.MAX_SAFE_INTEGER;
  private boundarySet = false;

  constructor(deps: PcRailAttentionStreamDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.opens = 0;
    this.generation += 1;
    void this.run(this.generation);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    const clear = this.deps.clearTimeoutImpl ?? clearTimeout;
    if (this.reconnectTimer) clear(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearIdleWatchdog();
    this.controller?.abort();
    this.controller = null;
    this.markClosed();
  }

  private current(gen: number): boolean {
    return !this.stopped && this.generation === gen;
  }

  private markClosed(): void {
    if (!this.open) return;
    this.open = false;
    this.deps.onState('closed');
  }

  private async run(gen: number): Promise<void> {
    if (!this.current(gen)) return;
    if (!isCredentialSafeOriginString(this.deps.host.origin)) return;
    const controller = new AbortController();
    this.controller = controller;
    this.gate.beginStream();
    this.replayUntilId = Number.MAX_SAFE_INTEGER;
    this.boundarySet = false;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.deps.host.origin}/api/events`, {
        headers: { Authorization: `Bearer ${this.deps.host.token}`, Accept: 'text/event-stream' },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      this.scheduleReconnect(gen);
      return;
    }
    if (!this.current(gen)) {
      void res.body?.cancel().catch(() => undefined);
      return;
    }
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => undefined);
      this.scheduleReconnect(gen, res.status);
      return;
    }

    this.open = true;
    this.deps.onState(this.opens++ === 0 ? 'open' : 'reopen');
    try {
      await this.pump(gen, res.body, controller);
    } catch {
      /* a read error ends the stream like a clean end */
    } finally {
      this.clearIdleWatchdog();
    }
    if (!this.current(gen)) return;
    this.markClosed();
    this.scheduleReconnect(gen);
  }

  private async pump(gen: number, body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    const reader = body.getReader();
    const splitter = new SseFrameSplitter(REMOTE_LIMITS.attentionBufferBytes);
    this.armIdleWatchdog(controller);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !this.current(gen)) return;
        this.armIdleWatchdog(controller);
        const frames = splitter.push(value);
        if (frames === null) {
          // A frame, or an unterminated tail, past the cap: stop reading this peer.
          controller.abort();
          return;
        }
        for (const frame of frames) {
          this.handleFrame(frame);
          if (!this.current(gen)) return;
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
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (event === null) return;
    this.attempt = 0;
    const data = dataLines.join('\n');
    if (event === 'reset') {
      // Only the first reset of a stream sets the replay boundary.
      if (!this.boundarySet) {
        this.boundarySet = true;
        const headId = safeParse(data)?.headId;
        if (typeof headId === 'number' && headId >= 0) this.replayUntilId = headId;
      }
    } else if (FRAME_KINDS.has(event)) {
      const parsed = safeParse(data);
      const id = parsed?.id;
      if (parsed && typeof id === 'number' && id > this.replayUntilId) {
        this.deps.onFrame(event as PcRailAttentionFrameKind, parsed);
      }
    }
    const notification = this.gate.consume(event, data);
    if (notification) this.deps.onNotification(this.deps.host.label, notification);
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
    const attempt = status !== undefined && HOPELESS_STATUSES.has(status) ? BACKOFF_STEPS_MS.length - 1 : this.attempt;
    const delay = backoffForAttempt(attempt, this.deps.jitter ?? Math.random);
    this.attempt = Math.min(this.attempt + 1, BACKOFF_STEPS_MS.length - 1);
    const timer = (this.deps.setTimeoutImpl ?? setTimeout)(() => {
      this.reconnectTimer = null;
      if (this.current(gen)) void this.run(gen);
    }, delay);
    timer.unref?.();
    this.reconnectTimer = timer;
  }
}

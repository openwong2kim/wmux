import {
  A2A_ROUTES,
  formatPeerCredential,
  type A2aOutboxRecordV1,
  type A2aRemoteDeliverResponse,
  type A2aRemoteErrorCode,
  type A2aRemoteEnvelope,
  type A2aRemoteHostRecordV1,
  type HostId,
  type PeerCredential,
} from '../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../shared/rpc';
import type { OutboxStore } from './outboxStore';
import { PinnedClientError, PinnedTlsClient, type PinnedClientOptions, type PinnedSseEvent } from './pinnedClient';
import { formatCursorId } from './streamHub';
import { errMsg, isPlainObject } from './storeFile';

/**
 * Cross-host A2A, JOINER side of the delivery transport: one session per
 * server this PC joined, over the certificate-pinned client.
 *
 *   stream — holds `GET /api/a2a/stream` open; each event is applied
 *            (`acceptInbound`) and acked only AFTER the ledger has it, so a
 *            crash in between redelivers (deduped by message key).
 *   pump   — POSTs this host's outbox to the server strictly in seq order
 *            (an ack covers every seq up to it, so N+1 never goes before N):
 *              ok / duplicate          → ack
 *              terminal refusal        → refuse + `onRefused` (the task fails)
 *              written, no answer      → outcome-unknown; the SAME envelope is
 *                                        resent later (idempotent by key)
 *              not sent / unavailable  → retried later
 *
 * Reconnects back off exponentially up to `backoffMaxMs`; the pinned client
 * walks the host's addresses in order on every attempt, and the address that
 * got through moves to the front (`onConnected`), so a PC that moved between
 * the LAN and a tailnet waits out an unreachable address once, not on every
 * reconnect. A certificate that
 * is not the pinned one stops the session (`identity-changed`): nothing is
 * sent until the pairing is redone. A stream that shows no event for
 * `livenessMs` is dropped and redialled.
 */

/** Refusals resending can never fix: the record is dropped and its task failed. */
export const TERMINAL_REFUSALS: ReadonlySet<A2aRemoteErrorCode> = new Set<A2aRemoteErrorCode>([
  'unknown-link',
  'link-not-active',
  'direction-not-allowed',
  'forbidden',
  'conflict',
  'stale-link-version',
  'unknown-task',
  'too-large',
  'bad-request',
  'protocol',
]);

export interface SessionTiming {
  backoffMinMs: number;
  backoffMaxMs: number;
  /** No stream event (heartbeat included) for this long → redial. */
  livenessMs: number;
  connectMs: number;
  requestMs: number;
}

export const DEFAULT_SESSION_TIMING: SessionTiming = {
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  livenessMs: 45_000,
  connectMs: 5_000,
  requestMs: 15_000,
};

/** What a session needs from a pinned client (a seam for tests). */
export interface SessionClient {
  requestJson(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
  openStream(path: string, opts: { signal: AbortSignal; lastEventId?: string }): AsyncGenerator<PinnedSseEvent, void, undefined>;
}

export interface JoinerSessionDeps {
  hostId: HostId;
  /** Re-read on every dial: an address or fingerprint update applies to the next one. */
  host: () => A2aRemoteHostRecordV1 | undefined;
  /** A dial got through (pin checked) at `address`: the store dials it first next time. */
  onConnected?: (address: string) => void;
  credential: () => PeerCredential | null;
  outbox: Pick<OutboxStore, 'epoch' | 'head' | 'openCount' | 'markSent' | 'markOutcomeUnknown' | 'refuse' | 'ack'>;
  /** Apply one server -> joiner envelope (`acceptInbound`). */
  accept: (envelope: unknown, peer: { hostId: HostId }) => Promise<A2aRemoteDeliverResponse>;
  /** The server refused a record for good: end what it was about. */
  onRefused: (record: A2aOutboxRecordV1, code: A2aRemoteErrorCode) => void | Promise<void>;
  /** The stream came up (or 5 minutes passed): fold the server's view of our links in. */
  reconcileLinks: () => Promise<void>;
  onStatus: (status: A2aRemoteHostStatus) => void;
  timing?: Partial<SessionTiming>;
  /** Test seam; default `new PinnedTlsClient(opts)`. */
  client?: (opts: PinnedClientOptions) => SessionClient;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const RECONCILE_EVERY_MS = 5 * 60_000;

export class JoinerSession {
  private readonly deps: JoinerSessionDeps;
  private readonly timing: SessionTiming;
  private readonly makeClient: (opts: PinnedClientOptions) => SessionClient;
  private status: A2aRemoteHostStatus;
  private running = false;
  private abort: AbortController | null = null;
  private lastEventId: string | undefined;
  private streamBackoff = 0;
  private pumpBackoff = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private wakeStream: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(deps: JoinerSessionDeps) {
    this.deps = deps;
    this.timing = { ...DEFAULT_SESSION_TIMING, ...deps.timing };
    this.makeClient = deps.client ?? ((opts): SessionClient => new PinnedTlsClient(opts));
    this.status = { hostId: deps.hostId, name: deps.host()?.name ?? '', role: 'joiner', state: 'disconnected', pending: 0 };
  }

  current(): A2aRemoteHostStatus {
    return { ...this.status, name: this.deps.host()?.name ?? this.status.name, pending: this.deps.outbox.openCount(this.deps.hostId) };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.streamLoop();
    this.reconcileTimer = setInterval(() => void this.reconcile(), RECONCILE_EVERY_MS);
    this.reconcileTimer.unref?.();
    this.wake();
  }

  /** Stop both loops; resolves once the stream loop has ended. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.wakeStream?.();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.pumpTimer = null;
    this.reconcileTimer = null;
    await this.loop;
    await this.pumping;
  }

  /** New outbox records for this host: pump now (unless a backoff is pending). */
  wake(): void {
    if (!this.running || this.status.state === 'identity-changed') return;
    if (this.pumpTimer) return; // a scheduled retry will pick it up
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
      if (this.pumpAgain && this.running) {
        this.pumpAgain = false;
        this.wake();
      }
    });
  }

  // --- stream -----------------------------------------------------------------

  private async streamLoop(): Promise<void> {
    while (this.running) {
      const client = this.client();
      if (!client) {
        this.setState('disconnected', 'not paired');
        await this.sleep(this.timing.backoffMaxMs);
        continue;
      }
      // A send that just got through already showed connected: keep it while the stream redials.
      if (this.status.state !== 'connected') this.setState('connecting');
      const abort = new AbortController();
      this.abort = abort;
      let liveness: ReturnType<typeof setTimeout> | null = null;
      const alive = (): void => {
        if (liveness) clearTimeout(liveness);
        liveness = setTimeout(() => abort.abort(), this.timing.livenessMs);
      };
      try {
        alive();
        for await (const ev of client.openStream(A2A_ROUTES.stream, {
          signal: abort.signal,
          ...(this.lastEventId !== undefined ? { lastEventId: this.lastEventId } : {}),
        })) {
          alive();
          if (ev.event === 'hello') {
            this.streamBackoff = 0;
            this.setState('connected');
            void this.reconcile();
            this.kick();
          } else if (ev.event === 'message') {
            const applied = await this.applyStreamEvent(client, ev);
            if (!applied) break; // our side failed: redial and get it again
          }
        }
        if (this.running && !abort.signal.aborted) this.setState('disconnected', 'stream ended');
      } catch (err) {
        if (err instanceof PinnedClientError && err.code === 'fingerprint-mismatch') {
          this.identityChanged(err.message);
          return;
        }
        this.setState('disconnected', streamError(err));
      } finally {
        if (liveness) clearTimeout(liveness);
        abort.abort();
        this.abort = null;
      }
      if (!this.running) break;
      if (this.status.state === 'connected') this.setState('disconnected', 'stream dropped');
      await this.sleep(this.nextDelay('stream'));
    }
  }

  /** Apply one stream event; ack it once the ledger holds it. False: retry later. */
  private async applyStreamEvent(client: SessionClient, ev: PinnedSseEvent): Promise<boolean> {
    const data = ev.data;
    if (!isPlainObject(data) || !isPlainObject(data['cursor']) || !isPlainObject(data['envelope'])) {
      this.deps.log('warn', `[a2a-remote] ${this.deps.hostId}: malformed stream event dropped`);
      return true;
    }
    const cursor = data['cursor'];
    if (typeof cursor['epoch'] !== 'string' || typeof cursor['seq'] !== 'number') return true;
    let result: A2aRemoteDeliverResponse;
    try {
      result = await this.deps.accept(data['envelope'], { hostId: this.deps.hostId });
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] ${this.deps.hostId}: applying a stream event failed: ${errMsg(err)}`);
      return false;
    }
    // Our own store failed: not acked, so the server sends it again.
    if (!result.ok && result.error === 'unavailable') return false;
    if (!result.ok) {
      // A refusal here never changes on a resend; ack so the server stops owing it.
      this.deps.log('warn', `[a2a-remote] ${this.deps.hostId}: refused a stream message (${result.error})`);
    }
    const c = { epoch: cursor['epoch'], seq: cursor['seq'] };
    try {
      await client.requestJson('POST', A2A_ROUTES.ack, { cursor: c });
    } catch {
      // The resume id below acks it on the next connection.
    }
    this.lastEventId = formatCursorId(c);
    return true;
  }

  // --- pump -------------------------------------------------------------------

  private async pump(): Promise<void> {
    const client = this.client();
    if (!client) return;
    for (;;) {
      if (!this.running) return;
      const rec = this.deps.outbox.head(this.deps.hostId);
      if (!rec) {
        this.pumpBackoff = 0;
        this.refreshPending();
        return;
      }
      const outcome = await this.send(client, rec);
      this.refreshPending();
      if (outcome === 'next') continue;
      if (outcome === 'stop') return;
      this.schedulePump(this.nextDelay('pump'));
      return;
    }
  }

  private async send(client: SessionClient, rec: A2aOutboxRecordV1): Promise<'next' | 'retry' | 'stop'> {
    const { hostId } = this.deps;
    try {
      this.deps.outbox.markSent(hostId, rec.seq);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] ${hostId}: outbox write failed: ${errMsg(err)}`);
      return 'retry';
    }
    let answer: { status: number; json: unknown };
    try {
      answer = await client.requestJson('POST', A2A_ROUTES.messages, rec.envelope);
    } catch (err) {
      if (err instanceof PinnedClientError && err.code === 'fingerprint-mismatch') {
        this.identityChanged(err.message);
        return 'stop';
      }
      if (err instanceof PinnedClientError && err.sent) {
        // It may have landed: resend the same envelope later (deduped there).
        this.tryOutbox(() => this.deps.outbox.markOutcomeUnknown(hostId, rec.seq));
      }
      return 'retry';
    }
    const body = isPlainObject(answer.json) ? answer.json : null;
    if (body?.['ok'] === true) this.reached();
    if (body?.['ok'] === true) {
      // An ack we could not record here: back off (the server dedupes the resend).
      return this.tryOutbox(() => this.deps.outbox.ack(hostId, { epoch: this.deps.outbox.epoch, seq: rec.seq })) ? 'next' : 'retry';
    }
    const code = typeof body?.['error'] === 'string' ? (body['error'] as A2aRemoteErrorCode) : null;
    if (code && TERMINAL_REFUSALS.has(code)) {
      if (!this.tryOutbox(() => this.deps.outbox.refuse(hostId, rec.seq, code))) return 'retry';
      try {
        await this.deps.onRefused(rec, code);
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] ${hostId}: ending a refused message's task failed: ${errMsg(err)}`);
      }
      if (code === 'unknown-link' || code === 'link-not-active') void this.reconcile();
      return 'next';
    }
    if (code === 'unauthorized') this.setState('disconnected', 'unauthorized');
    return 'retry';
  }

  /**
   * The server answered a send: it is reachable now. Show connected at once
   * and redial a stream that is still waiting out its backoff.
   */
  private reached(): void {
    if (this.status.state === 'connected' || this.status.state === 'identity-changed') return;
    this.setState('connected');
    this.streamBackoff = 0;
    this.wakeStream?.();
  }

  /** The connection is back: drop any pump backoff and send now. */
  private kick(): void {
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    this.pumpBackoff = 0;
    this.wake();
  }

  private schedulePump(delayMs: number): void {
    if (!this.running || this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.wake();
    }, delayMs);
    this.pumpTimer.unref?.();
  }

  // --- helpers ----------------------------------------------------------------

  private client(): SessionClient | null {
    const host = this.deps.host();
    const credential = this.deps.credential();
    if (!host || !credential) return null;
    return this.makeClient({
      addresses: host.addresses,
      port: host.port,
      fingerprint256: host.fingerprint256,
      credential: formatPeerCredential(credential),
      connectTimeoutMs: this.timing.connectMs,
      requestTimeoutMs: this.timing.requestMs,
      ...(this.deps.onConnected ? { onConnected: this.deps.onConnected } : {}),
    });
  }

  private async reconcile(): Promise<void> {
    if (!this.running || this.status.state === 'identity-changed') return;
    try {
      await this.deps.reconcileLinks();
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] ${this.deps.hostId}: link reconcile failed: ${errMsg(err)}`);
    }
  }

  private identityChanged(detail: string): void {
    this.deps.log('warn', `[a2a-remote] ${this.deps.hostId}: certificate is not the pinned one; stopped until re-paired (${detail})`);
    this.setState('identity-changed', 'fingerprint-mismatch');
    this.running = false;
    this.abort?.abort();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
  }

  private setState(state: A2aRemoteHostStatus['state'], lastError?: string): void {
    const prev = this.status;
    const next: A2aRemoteHostStatus = {
      ...prev,
      state,
      ...(state === 'connected' && prev.state !== 'connected' ? { connectedAt: new Date().toISOString() } : {}),
    };
    if (lastError !== undefined) next.lastError = lastError;
    else if (state === 'connected') delete next.lastError;
    this.status = next;
    if (prev.state !== next.state || prev.lastError !== next.lastError) this.deps.onStatus(this.current());
  }

  private refreshPending(): void {
    const pending = this.deps.outbox.openCount(this.deps.hostId);
    if (pending !== this.status.pending) {
      this.status = { ...this.status, pending };
      this.deps.onStatus(this.current());
    }
  }

  /** Run one outbox write; false (logged) when it did not land. */
  private tryOutbox(op: () => unknown): boolean {
    try {
      op();
      return true;
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] ${this.deps.hostId}: outbox write failed: ${errMsg(err)}`);
      return false;
    }
  }

  private nextDelay(which: 'stream' | 'pump'): number {
    const attempt = which === 'stream' ? this.streamBackoff++ : this.pumpBackoff++;
    return Math.min(this.timing.backoffMinMs * 2 ** attempt, this.timing.backoffMaxMs);
  }

  /** Sleep, cut short by stop(). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      t.unref?.();
      function done(): void {
        clearTimeout(t);
        resolve();
      }
      this.wakeStream = done;
    });
  }
}

function streamError(err: unknown): string {
  if (err instanceof PinnedClientError) {
    if (err.code === 'http' && err.status === 401) return 'unauthorized';
    return err.code === 'connect-failed' ? 'unreachable' : err.code;
  }
  return errMsg(err);
}

/** Envelope kinds whose refusal ends a ledger task, and which task. */
export function taskOfEnvelope(env: A2aRemoteEnvelope, remoteTaskIdOf: (linkId: string, messageId: string) => string): string | null {
  if (env.kind === 'task') return remoteTaskIdOf(env.linkId, env.messageId);
  if (env.kind === 'reply' || env.kind === 'state') return env.taskId ?? null;
  return null;
}

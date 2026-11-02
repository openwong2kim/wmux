import {
  A2A_FEATURE_STREAM_PING,
  A2A_REDIAL_BACKOFF_MIN_MS,
  A2A_ROUTES,
  A2A_STREAM_PING_MS,
  A2A_STREAM_SILENCE_MS,
  formatPeerCredential,
  parseA2aFeatures,
  type A2aOutboxRecordV1,
  type A2aRemoteDeliverResponse,
  type A2aRemoteErrorCode,
  type A2aRemoteEnvelope,
  type A2aRemoteHostRecordV1,
  type A2aRemoteImageRef,
  type HostId,
  type PeerCredential,
} from '../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../shared/rpc';
import type { OutboxStore } from './outboxStore';
import { PinnedClientError, PinnedTlsClient, type PinnedClientOptions, type PinnedSseEvent, type PinnedStreamedBody } from './pinnedClient';
import type { ImagePull } from './inbound';
import { formatCursorId, parseCursorId } from './streamHub';
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
  /** How often an open stream acks its cursor to a server that takes `stream-ping.1`. */
  pingMs: number;
}

export const DEFAULT_SESSION_TIMING: SessionTiming = {
  backoffMinMs: A2A_REDIAL_BACKOFF_MIN_MS,
  backoffMaxMs: 30_000,
  livenessMs: A2A_STREAM_SILENCE_MS,
  connectMs: 5_000,
  requestMs: 15_000,
  pingMs: A2A_STREAM_PING_MS,
};

/** What a session needs from a pinned client (a seam for tests). The byte transfers carry images (`images.1`). */
export interface SessionClient {
  requestJson(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
  openStream(path: string, opts: { signal: AbortSignal; lastEventId?: string; features?: readonly string[] }): AsyncGenerator<PinnedSseEvent, void, undefined>;
  putBytes?(path: string, body: Buffer, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; json: unknown }>;
  headStatus?(path: string, timeoutMs: number, signal?: AbortSignal): Promise<number>;
  getBytes?(path: string, opts: { maxBytes: number; timeoutMs: number; signal?: AbortSignal }): Promise<Buffer>;
  getStream?<T>(path: string, opts: { timeoutMs: number; signal?: AbortSignal; acceptEncoding?: string }, consume: (res: PinnedStreamedBody) => Promise<T>): Promise<T>;
}

/** A GET whose body `consume` reads as it arrives (JoinerSession.fetchStream). */
export type StreamedGet = <T>(
  path: string,
  opts: { timeoutMs: number; signal: AbortSignal; acceptEncoding?: string },
  consume: (res: PinnedStreamedBody) => Promise<T>,
) => Promise<T>;

/** Failed uploads of one message's images (each one sent and not answered, or refused for now) before the message is given up. */
export const IMAGE_UPLOAD_MAX_FAILURES = 4;
/** How long a message may keep failing its image uploads before it is given up. */
export const IMAGE_UPLOAD_MAX_MS = 10 * 60_000;

/**
 * The budget of one image transfer: 10 s plus the time the bytes take at
 * 1 Mbit/s, at most 2 minutes. (The other PC itself allows a request 30 s.)
 */
export function imageTransferBudgetMs(bytes: number): number {
  return Math.min(120_000, 10_000 + Math.ceil((bytes * 8) / 1_000));
}

export interface JoinerSessionDeps {
  hostId: HostId;
  /** Re-read on every dial: an address or fingerprint update applies to the next one. */
  host: () => A2aRemoteHostRecordV1 | undefined;
  /** A dial got through (pin checked) at `address`: the store dials it first next time. */
  onConnected?: (address: string) => void;
  credential: () => PeerCredential | null;
  outbox: Pick<OutboxStore, 'epoch' | 'head' | 'openCount' | 'markSent' | 'markOutcomeUnknown' | 'refuse' | 'ack'>;
  /** Apply one server -> joiner envelope (`acceptInbound`); `pull` fetches an image it names from the server. */
  accept: (envelope: unknown, peer: { hostId: HostId; pull?: ImagePull }) => Promise<A2aRemoteDeliverResponse>;
  /** The server refused a record for good (or its images could not be sent): end what it was about. */
  onRefused: (record: A2aOutboxRecordV1, code: A2aRemoteErrorCode, detail?: string) => void | Promise<void>;
  /** This PC's copies of the images it queued (`A2aImageStore.readOutgoing`). */
  images?: { readOutgoing(sha256: string): Promise<Buffer | null> };
  /** The stream came up (or 5 minutes passed): fold the server's view of our links in. */
  reconcileLinks: () => Promise<void>;
  onStatus: (status: A2aRemoteHostStatus) => void;
  /** Optional features this PC advertises on every stream open (`A2A_FEATURES_HEADER`). */
  features?: readonly string[];
  /** The server's stream `hello` said what it takes (none, from an older build). */
  onServerFeatures?: (features: string[]) => void;
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
  /** Aborted by stop() (and a pin mismatch): ends the pump's image transfers, so none runs on after a stop. */
  private halt = new AbortController();
  private lastEventId: string | undefined;
  private streamBackoff = 0;
  private pumpBackoff = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private wakeStream: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  /** What the server's latest stream `hello` advertised; undefined until one arrived. */
  private serverFeatures: string[] | undefined;
  /** Failed image uploads per outbox seq, since the first failure (in memory). */
  private readonly uploadFailures = new Map<number, { count: number; since: number; last: string }>();

  constructor(deps: JoinerSessionDeps) {
    this.deps = deps;
    this.timing = { ...DEFAULT_SESSION_TIMING, ...deps.timing };
    this.makeClient = deps.client ?? ((opts): SessionClient => new PinnedTlsClient(opts));
    this.status = { hostId: deps.hostId, name: deps.host()?.name ?? '', role: 'joiner', state: 'disconnected', pending: 0 };
  }

  current(): A2aRemoteHostStatus {
    return {
      ...this.status,
      name: this.deps.host()?.name ?? this.status.name,
      pending: this.deps.outbox.openCount(this.deps.hostId),
      ...(this.serverFeatures ? { features: [...this.serverFeatures] } : {}),
    };
  }

  /** What the server advertised on this session's latest stream; undefined before the first `hello`. */
  features(): readonly string[] | undefined {
    return this.serverFeatures;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.halt.signal.aborted) this.halt = new AbortController();
    this.loop = this.streamLoop();
    this.reconcileTimer = setInterval(() => void this.reconcile(), RECONCILE_EVERY_MS);
    this.reconcileTimer.unref?.();
    this.wake();
  }

  /** Stop both loops; resolves once the stream loop has ended. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.halt.abort();
    this.wakeStream?.();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.pumpTimer = null;
    this.reconcileTimer = null;
    await this.loop;
    await this.pumping;
  }

  /**
   * A GET from the server whose body is too large to hold (the files of a
   * conversation that PC hands this one): through a pinned client to the
   * host as it is now, ended by `opts.signal` or by stop(). Throws as the
   * pinned client does; a certificate that is not the pinned one stops the
   * session.
   */
  async fetchStream<T>(
    path: string,
    opts: { timeoutMs: number; signal: AbortSignal; acceptEncoding?: string },
    consume: (res: PinnedStreamedBody) => Promise<T>,
  ): Promise<T> {
    const client = this.status.state === 'identity-changed' ? null : this.client();
    if (!client?.getStream) throw new PinnedClientError('connect-failed', 'that PC cannot be reached from here now', { sent: false });
    try {
      return await client.getStream(path, { ...opts, signal: AbortSignal.any([opts.signal, this.halt.signal]) }, consume);
    } catch (err) {
      if (err instanceof PinnedClientError && err.code === 'fingerprint-mismatch') this.identityChanged(err.message);
      throw err;
    }
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
      // Tells a `stream-ping.1` server this PC is still there. On its own
      // timer, so a long image apply that holds up the event loop below
      // still pings.
      let ping: ReturnType<typeof setInterval> | null = null;
      try {
        alive();
        for await (const ev of client.openStream(A2A_ROUTES.stream, {
          signal: abort.signal,
          ...(this.lastEventId !== undefined ? { lastEventId: this.lastEventId } : {}),
          ...(this.deps.features && this.deps.features.length > 0 ? { features: this.deps.features } : {}),
        })) {
          alive();
          if (ev.event === 'hello') {
            this.serverFeatures = parseA2aFeatures(isPlainObject(ev.data) && Array.isArray(ev.data['features']) ? ev.data['features'] : '');
            this.deps.onServerFeatures?.([...this.serverFeatures]);
            if (ping) clearInterval(ping);
            ping = null;
            const epoch = isPlainObject(ev.data) && typeof ev.data['epoch'] === 'string' ? ev.data['epoch'] : null;
            if (epoch !== null && this.serverFeatures.includes(A2A_FEATURE_STREAM_PING)) {
              ping = setInterval(() => void this.ping(client, epoch), this.timing.pingMs);
              ping.unref?.();
            }
            this.streamBackoff = 0;
            this.setState('connected');
            void this.reconcile();
            this.kick();
          } else if (ev.event === 'message') {
            // An image fetch inside the apply takes as long as its bytes do:
            // no event arrives meanwhile, so liveness waits for the apply.
            if (liveness) clearTimeout(liveness);
            const applied = await this.applyStreamEvent(client, ev, abort.signal);
            alive();
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
        if (ping) clearInterval(ping);
        abort.abort();
        this.abort = null;
      }
      if (!this.running) break;
      if (this.status.state === 'connected') this.setState('disconnected', 'stream dropped');
      await this.sleep(this.nextDelay('stream'));
    }
  }

  /**
   * Re-ack what this PC has applied on the current stream (nothing yet: seq 0,
   * which acks nothing). The server only needs to hear from us; a failed ping
   * is left to the stream's own liveness.
   */
  private async ping(client: SessionClient, epoch: string): Promise<void> {
    const last = parseCursorId(this.lastEventId);
    const cursor = last && last.epoch === epoch ? last : { epoch, seq: 0 };
    try {
      await client.requestJson('POST', A2A_ROUTES.ack, { cursor });
    } catch {
      // Not an error: a dead path ends the stream through liveness.
    }
  }

  /** Apply one stream event; ack it once the ledger holds it. False: retry later. */
  private async applyStreamEvent(client: SessionClient, ev: PinnedSseEvent, signal: AbortSignal): Promise<boolean> {
    const data = ev.data;
    if (!isPlainObject(data) || !isPlainObject(data['cursor']) || !isPlainObject(data['envelope'])) {
      this.deps.log('warn', `[a2a-remote] ${this.deps.hostId}: malformed stream event dropped`);
      return true;
    }
    const cursor = data['cursor'];
    if (typeof cursor['epoch'] !== 'string' || typeof cursor['seq'] !== 'number') return true;
    let result: A2aRemoteDeliverResponse;
    try {
      result = await this.deps.accept(data['envelope'], { hostId: this.deps.hostId, pull: (ref) => this.pull(client, ref, signal) });
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
    // This send's own stop: a start() after a stop() gives the session a new one.
    const halt = this.halt.signal;
    try {
      this.deps.outbox.markSent(hostId, rec.seq);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] ${hostId}: outbox write failed: ${errMsg(err)}`);
      return 'retry';
    }
    if (rec.envelope.images && rec.envelope.images.length > 0) {
      const uploaded = await this.uploadImages(client, rec);
      if (uploaded !== 'ok') return uploaded;
    }
    // Stopped while the last upload was answered (a re-pair stops the old
    // session): the envelope is not posted against the old pin. Still owed.
    if (halt.aborted) return 'stop';
    let answer: { status: number; json: unknown };
    try {
      answer = await client.requestJson('POST', A2A_ROUTES.messages, rec.envelope);
    } catch (err) {
      if (err instanceof PinnedClientError && err.sent) {
        // It may have landed: resend the same envelope later (deduped there).
        this.tryOutbox(() => this.deps.outbox.markOutcomeUnknown(hostId, rec.seq));
      }
      // Stopped while the POST was out: its error, a pin mismatch included,
      // is the old session's and says nothing about the peer. Still owed.
      if (halt.aborted) return 'stop';
      if (err instanceof PinnedClientError && err.code === 'fingerprint-mismatch') {
        this.identityChanged(err.message);
        return 'stop';
      }
      return 'retry';
    }
    const body = isPlainObject(answer.json) ? answer.json : null;
    if (body?.['ok'] === true) this.reached();
    if (body?.['ok'] === true) {
      this.uploadFailures.delete(rec.seq);
      // An ack we could not record here: back off (the server dedupes the resend).
      return this.tryOutbox(() => this.deps.outbox.ack(hostId, { epoch: this.deps.outbox.epoch, seq: rec.seq })) ? 'next' : 'retry';
    }
    const code = typeof body?.['error'] === 'string' ? (body['error'] as A2aRemoteErrorCode) : null;
    if (code && TERMINAL_REFUSALS.has(code)) {
      if (!this.tryOutbox(() => this.deps.outbox.refuse(hostId, rec.seq, code))) return 'retry';
      this.uploadFailures.delete(rec.seq);
      try {
        await this.deps.onRefused(rec, code);
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] ${hostId}: ending a refused message's task failed: ${errMsg(err)}`);
      }
      if (code === 'unknown-link' || code === 'link-not-active') void this.reconcile();
      return 'next';
    }
    // Uploaded, yet not there: counts against the message's upload budget.
    if (code === 'attachment-missing') return this.uploadFailed(rec, 'the other PC did not keep an uploaded image');
    if (code === 'unauthorized') this.setState('disconnected', 'unauthorized');
    return 'retry';
  }

  /**
   * Upload a message's images before its envelope (the server answers
   * `attachment-missing` for one it does not hold). Each is asked about first
   * (HEAD): one the other PC already holds is not sent again. Unreachable is retried
   * like any send. An upload that was sent and failed counts; after
   * IMAGE_UPLOAD_MAX_FAILURES of them, or IMAGE_UPLOAD_MAX_MS since the
   * first, the message is given up (`attachment-failed`) so one slow link
   * never holds the rest of the queue behind it. A refusal that resending
   * cannot change (too large, not an image) and a sender copy that is gone
   * give it up at once.
   */
  private async uploadImages(client: SessionClient, rec: A2aOutboxRecordV1): Promise<'ok' | 'next' | 'retry' | 'stop'> {
    const images = rec.envelope.images ?? [];
    if (!client.putBytes || !this.deps.images) return this.giveUpImages(rec, 'this PC cannot upload images');
    const signal = this.halt.signal;
    for (const ref of images) {
      if (signal.aborted) return 'stop';
      // eslint-disable-next-line no-await-in-loop -- one upload at a time to one host
      const bytes = await this.deps.images.readOutgoing(ref.sha256);
      if (!bytes) return this.giveUpImages(rec, "this PC's copy of an image is gone");
      let answer: { status: number; json: unknown };
      try {
        // eslint-disable-next-line no-await-in-loop -- one question at a time to one host
        const held = client.headStatus ? await client.headStatus(`${A2A_ROUTES.blobs}/${ref.sha256}`, this.timing.requestMs, signal) : 404;
        if (held === 200) continue;
        if (held === 401) {
          this.setState('disconnected', 'unauthorized');
          return 'retry';
        }
        // eslint-disable-next-line no-await-in-loop -- one upload at a time to one host
        answer = await client.putBytes(`${A2A_ROUTES.blobs}/${ref.sha256}`, bytes, imageTransferBudgetMs(bytes.length), signal);
      } catch (err) {
        // This PC stopped the session: not a failed upload, and nothing more is sent.
        if (signal.aborted) return 'stop';
        if (err instanceof PinnedClientError && err.code === 'fingerprint-mismatch') {
          this.identityChanged(err.message);
          return 'stop';
        }
        if (err instanceof PinnedClientError && !err.sent) return 'retry';
        return this.uploadFailed(rec, err instanceof PinnedClientError ? err.code : errMsg(err));
      }
      if (answer.status === 200) continue;
      if (answer.status === 401) {
        this.setState('disconnected', 'unauthorized');
        return 'retry';
      }
      // Busy (too many uploads at once there): not counted as a failure, but
      // the message's time budget still runs.
      if (answer.status === 429) return this.uploadBusy(rec);
      if (answer.status === 413 || answer.status === 400) {
        return this.giveUpImages(rec, `the other PC refused an image (HTTP ${answer.status})`);
      }
      return this.uploadFailed(rec, `HTTP ${answer.status}`);
    }
    return 'ok';
  }

  private uploadBusy(rec: A2aOutboxRecordV1): Promise<'next' | 'retry'> | 'retry' {
    const now = Date.now();
    const prev = this.uploadFailures.get(rec.seq);
    const entry = { count: prev?.count ?? 0, since: prev?.since ?? now, last: prev?.last ?? 'the other PC is busy' };
    this.uploadFailures.set(rec.seq, entry);
    if (now - entry.since < IMAGE_UPLOAD_MAX_MS) return 'retry';
    return this.giveUpImages(rec, `the images could not be uploaded within ${IMAGE_UPLOAD_MAX_MS / 60_000} minutes (the other PC stayed busy)`);
  }

  private uploadFailed(rec: A2aOutboxRecordV1, reason: string): Promise<'next' | 'retry'> | 'retry' {
    const now = Date.now();
    const prev = this.uploadFailures.get(rec.seq);
    const entry = { count: (prev?.count ?? 0) + 1, since: prev?.since ?? now, last: reason };
    this.uploadFailures.set(rec.seq, entry);
    this.deps.log('warn', `[a2a-remote] ${this.deps.hostId}: image upload for #${rec.seq} failed (${reason}), ${entry.count} of ${IMAGE_UPLOAD_MAX_FAILURES}`);
    if (entry.count < IMAGE_UPLOAD_MAX_FAILURES && now - entry.since < IMAGE_UPLOAD_MAX_MS) return 'retry';
    return this.giveUpImages(
      rec,
      `the images could not be uploaded after ${entry.count} tries (last: ${reason}); the other PC allows one upload 30 seconds, ` +
        'so a link slower than about 1.4 Mbit/s cannot carry a 5 MB image',
    );
  }

  /** The message cannot carry its images: refuse it here (`attachment-failed`) and end its task with why. */
  private async giveUpImages(rec: A2aOutboxRecordV1, detail: string): Promise<'next' | 'retry'> {
    if (!this.tryOutbox(() => this.deps.outbox.refuse(this.deps.hostId, rec.seq, 'attachment-failed'))) return 'retry';
    this.uploadFailures.delete(rec.seq);
    this.deps.log('warn', `[a2a-remote] ${this.deps.hostId}: #${rec.seq} given up: ${detail}`);
    try {
      await this.deps.onRefused(rec, 'attachment-failed', detail);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] ${this.deps.hostId}: ending a refused message's task failed: ${errMsg(err)}`);
    }
    return 'next';
  }

  /**
   * Fetch one image a stream envelope named. Permanent: the server no longer
   * owes it (404), refused the request, or sent more than the ref says.
   */
  private async pull(client: SessionClient, ref: A2aRemoteImageRef, signal: AbortSignal): ReturnType<ImagePull> {
    if (!client.getBytes) return { ok: false, permanent: true, detail: 'this PC cannot fetch images' };
    try {
      const bytes = await client.getBytes(`${A2A_ROUTES.blobs}/${ref.sha256}`, { maxBytes: ref.bytes, timeoutMs: imageTransferBudgetMs(ref.bytes), signal });
      return { ok: true, bytes };
    } catch (err) {
      const permanent =
        err instanceof PinnedClientError &&
        ((err.code === 'http' && err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) ||
          err.code === 'protocol');
      const aborted = signal.aborted || (err instanceof PinnedClientError && err.code === 'aborted');
      return { ok: false, permanent: permanent && !aborted, detail: err instanceof PinnedClientError ? err.code : errMsg(err), ...(aborted ? { aborted: true } : {}) };
    }
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
    this.halt.abort();
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

import type http from 'node:http';
import {
  A2A_FEATURE_STREAM_PING,
  A2A_FEATURES_HEADER,
  A2A_ROUTES,
  A2A_STREAM_SILENCE_MS,
  parseA2aFeatures,
  type A2aOutboxRecordV1,
  type A2aRemoteDeliverResponse,
  type A2aRemoteErrorCode,
  type A2aStreamAckAnswer,
  type A2aStreamCursor,
  type A2aStreamEvent,
  type A2aStreamHello,
  type HostId,
} from '../../shared/a2aRemote';
import type { OutboxStore } from './outboxStore';
import type { A2aRouteTable } from './routes';
import { A2A_REQUEST_BODY_MAX, readJsonBody, sendJson } from './server';
import { errMsg, isPlainObject } from './storeFile';

/**
 * Cross-host A2A, SERVER side of the delivery transport (layer 4): the three
 * routes a joiner drives over its pinned connection.
 *
 *   POST /api/a2a/messages — one joiner -> server envelope, applied with the
 *                            authenticated peer's hostId (never the wire's).
 *   GET  /api/a2a/stream   — server -> joiner envelopes from this host's
 *                            outbox, as SSE. One stream per peer host: a new
 *                            one ends the old. Resumes from `Last-Event-ID:
 *                            <epoch>:<seq>`; an id from another epoch (the
 *                            outbox was rebuilt) replays everything still
 *                            owed — safe, the receiver dedupes by message key.
 *   POST /api/a2a/ack      — the joiner has applied the stream up to a cursor.
 *
 * Wire events: `event: hello` (stream is up, carries the outbox epoch and
 * what this PC takes, `A2aStreamHello`),
 * `event: heartbeat` every `heartbeatMs`, and plain `message` events carrying
 * an `A2aStreamEvent` with `id: <epoch>:<seq>`. The heartbeat is an EVENT, not
 * an SSE comment: the joiner's parser drops comments, so a comment could not
 * tell it the stream is still alive.
 *
 * The other way round: a joiner that advertised `stream-ping.1` acks its
 * cursor on a timer, and its stream ends after `silenceMs` with no request
 * from it. Writing heartbeats cannot tell a vanished joiner (sleep, Wi-Fi
 * off, no FIN) from a live one: the kernel buffers the bytes and only gives
 * up after minutes of retransmits.
 */

/**
 * Refusals resending can never fix: the record is dropped, and `onRefused` ends what it was about (see delivery.ts).
 * The joiner's pump reads the server's answers with them; a server takes only these on a stream ack
 * (`stream-refuse.1`).
 */
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
  // An approval the receiver's setting is off for: sent again, it is refused again.
  'approvals-off',
  // An approval past the receiver's window: stored there as final, so the same message is refused again; a new one is a new decision.
  'rate-limited',
]);

export const STREAM_HEARTBEAT_MS = 15_000;
const ACK_WARN_EVERY_MS = 60_000;

export interface A2aStreamHubDeps {
  outbox: Pick<OutboxStore, 'epoch' | 'pending' | 'ack' | 'get' | 'refuse'>;
  /**
   * `stream-refuse.1`: the joiner refused a record this host streamed it. Called once the refusal is stored, before
   * the ack, to end what the record was about as when a POST of it is refused (delivery.ts `onRefused`). Absent:
   * a refusal on an ack is ignored.
   */
  onRefused?: (record: A2aOutboxRecordV1, code: A2aRemoteErrorCode) => void | Promise<void>;
  /** Apply one envelope from `peer` (`acceptInbound`). */
  accept: (envelope: unknown, peer: { hostId: HostId }) => Promise<A2aRemoteDeliverResponse>;
  /**
   * Whether this host serves the stream for `hostId`. False when this host is
   * the JOINER of that pair (mutual pairing: the joiner role wins, so its own
   * session sends the outbox and the stream stays empty).
   */
  serves?: (hostId: HostId) => boolean;
  /** A peer's stream came up or went down. */
  onStatus?: (hostId: HostId, connected: boolean) => void;
  /** A peer's stream came up advertising these features (possibly none). */
  onFeatures?: (hostId: HostId, features: string[]) => void;
  /** What THIS PC takes, told to every joiner in the stream's `hello` (`A2aStreamHello.features`); a function: per joiner, read as its stream opens. */
  features?: readonly string[] | ((hostId: HostId) => readonly string[]);
  /**
   * Checked as each record goes out: true keeps it off the stream (the
   * caller refuses it, or it stays owed and is checked again next time).
   */
  withhold?: (hostId: HostId, rec: A2aOutboxRecordV1) => boolean;
  heartbeatMs?: number;
  /** A `stream-ping.1` joiner silent this long loses its stream (default `A2A_STREAM_SILENCE_MS`). */
  silenceMs?: number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

interface Stream {
  res: http.ServerResponse;
  /** Highest seq written on this stream. */
  lastSent: number;
  timer: ReturnType<typeof setInterval>;
  since: number;
  /** Armed only for a joiner that pings: ends the stream when it fires. */
  silence: ReturnType<typeof setTimeout> | null;
}

const STATUS_OF: Record<A2aRemoteErrorCode, number> = {
  'bad-request': 400,
  protocol: 400,
  unauthorized: 401,
  forbidden: 403,
  'direction-not-allowed': 403,
  'unknown-link': 404,
  'unknown-task': 404,
  conflict: 409,
  'link-not-active': 409,
  'stale-link-version': 409,
  'too-large': 413,
  unavailable: 503,
  'offer-closed': 409,
  'attachment-missing': 409,
  // Never answered by a peer (the sender records it); here for completeness.
  'attachment-failed': 400,
  'approvals-off': 403,
  // A refusal of that message like the others (the joiner reads the body's code); 429 is the upload path's busy.
  'rate-limited': 409,
};

/** `<epoch>:<seq>` → cursor; null when it is not one. */
export function parseCursorId(raw: unknown): A2aStreamCursor | null {
  if (typeof raw !== 'string') return null;
  const at = raw.lastIndexOf(':');
  if (at <= 0) return null;
  const seq = Number(raw.slice(at + 1));
  if (!/^\d{1,15}$/.test(raw.slice(at + 1)) || !Number.isSafeInteger(seq)) return null;
  return { epoch: raw.slice(0, at), seq };
}

export function formatCursorId(c: A2aStreamCursor): string {
  return `${c.epoch}:${c.seq}`;
}

export class A2aStreamHub {
  private readonly deps: A2aStreamHubDeps;
  private readonly streams = new Map<HostId, Stream>();
  /**
   * What each peer advertised on its latest stream open. In memory: a daemon
   * restart forgets it until the peer reconnects, and every reconnect
   * replaces it (a peer that went back to an older build advertises less).
   */
  private readonly features = new Map<HostId, ReadonlySet<string>>();
  /** When each peer's failed ack was last logged. */
  private readonly ackWarnAt = new Map<HostId, number>();

  constructor(deps: A2aStreamHubDeps) {
    this.deps = deps;
  }

  /** Add the three delivery routes to the authenticated route table. */
  register(table: A2aRouteTable): void {
    table.add('POST', A2A_ROUTES.messages, async ({ req, res, peer }) => {
      this.heard(peer.hostId);
      const body = await readJsonBody(req, A2A_REQUEST_BODY_MAX);
      if (body === 'too-large') return tooLarge(req, res);
      let answer: A2aRemoteDeliverResponse;
      try {
        answer = await this.deps.accept(body, { hostId: peer.hostId });
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] message from ${peer.hostId} failed: ${errMsg(err)}`);
        answer = { ok: false, error: 'unavailable' };
      }
      sendJson(res, answer.ok ? 200 : STATUS_OF[answer.error] ?? 400, answer);
    });

    table.add('POST', A2A_ROUTES.ack, async ({ req, res, peer }) => {
      this.heard(peer.hostId);
      const body = await readJsonBody(req, A2A_REQUEST_BODY_MAX);
      if (body === 'too-large') return tooLarge(req, res);
      const cursor = isPlainObject(body) && isPlainObject(body['cursor']) ? body['cursor'] : null;
      if (!cursor || typeof cursor['epoch'] !== 'string' || typeof cursor['seq'] !== 'number' || !Number.isSafeInteger(cursor['seq'])) {
        return sendJson(res, 400, { ok: false, error: 'bad-request' });
      }
      // `stream-refuse.1`: a refusal of one record goes with the ack that covers it. It is stored and what it was
      // about is ended before that ack, so a later record's ack never overtakes it.
      let refused: A2aStreamAckAnswer['refused'];
      const onRefused = this.deps.onRefused;
      if (onRefused && (body as Record<string, unknown>)['refused'] !== undefined) {
        const taken = await this.takeRefusal(peer.hostId, { epoch: cursor['epoch'], seq: cursor['seq'] }, (body as Record<string, unknown>)['refused'], onRefused);
        if (taken === 'unavailable') return sendJson(res, 503, { ok: false, error: 'unavailable' });
        refused = taken;
      }
      let acked = 0;
      try {
        acked = this.deps.outbox.ack(peer.hostId, { epoch: cursor['epoch'], seq: cursor['seq'] });
      } catch (err) {
        // A pinging joiner acks every 15 s: one line a minute is enough.
        const now = Date.now();
        if (now - (this.ackWarnAt.get(peer.hostId) ?? 0) >= ACK_WARN_EVERY_MS) {
          this.ackWarnAt.set(peer.hostId, now);
          this.deps.log('warn', `[a2a-remote] ack from ${peer.hostId} not stored: ${errMsg(err)}`);
        }
        return sendJson(res, 503, { ok: false, error: 'unavailable' });
      }
      const answer: A2aStreamAckAnswer = { ok: true, acked, ...(refused ? { refused } : {}) };
      sendJson(res, 200, answer);
    });

    table.add('GET', A2A_ROUTES.stream, ({ req, res, peer }) => this.open(req, res, peer.hostId));
  }

  /**
   * A joiner's refusal of one record on its ack. Taken only for a record this host streams to that joiner (it serves
   * it), of the current epoch, still owed (any state the stream sends), at or below the ack's cursor, with a terminal
   * code: it is refused in
   * the outbox, then `onRefused` ends what it was about (awaited; its failure is logged and the ack goes on).
   * Anything else is `ignored`, and the ack goes on as a plain one; a record already refused (a repeat of the same
   * ack) is one of those. `unavailable`: the refusal could not be stored, so nothing is acked.
   */
  private async takeRefusal(
    hostId: HostId,
    cursor: A2aStreamCursor,
    raw: unknown,
    onRefused: NonNullable<A2aStreamHubDeps['onRefused']>,
  ): Promise<'applied' | 'ignored' | 'unavailable'> {
    if (!isPlainObject(raw) || this.deps.serves?.(hostId) === false) return 'ignored';
    const seq = raw['seq'];
    const code = raw['code'];
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || seq > cursor.seq) return 'ignored';
    if (typeof code !== 'string' || !TERMINAL_REFUSALS.has(code as A2aRemoteErrorCode) || cursor.epoch !== this.deps.outbox.epoch) return 'ignored';
    const rec = this.deps.outbox.get(hostId, seq);
    // Still owed, as the stream sends it: `pending`, or `outcome-unknown` (left by a pump before this host served that
    // peer) only once this peer's stream carried it, so the refusal answers a record it really got. A record of a peer
    // this host joins was refused above (`serves`).
    const streamed = (this.streams.get(hostId)?.lastSent ?? 0) >= seq;
    if (rec?.state !== 'pending' && !(rec?.state === 'outcome-unknown' && streamed)) return 'ignored';
    try {
      this.deps.outbox.refuse(hostId, seq, code as A2aRemoteErrorCode);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] refusal from ${hostId} of #${seq} not stored: ${errMsg(err)}`);
      return 'unavailable';
    }
    this.deps.log('info', `[a2a-remote] ${hostId} refused streamed record #${seq} (${rec.envelope.kind}): ${code}`);
    try {
      await onRefused(rec, code as A2aRemoteErrorCode);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] ${hostId}: ending a refused record's task failed: ${errMsg(err)}`);
    }
    return 'applied';
  }

  /** New records are owed to `hostId`: write them to its stream, if one is open. */
  notify(hostId: HostId): void {
    const stream = this.streams.get(hostId);
    if (stream) this.flush(hostId, stream);
  }

  /** What `hostId` advertised on its latest stream, or undefined when it has not connected since this daemon started. */
  featuresOf(hostId: HostId): ReadonlySet<string> | undefined {
    return this.features.get(hostId);
  }

  isConnected(hostId: HostId): boolean {
    return this.streams.has(hostId);
  }

  connectedSince(hostId: HostId): number | undefined {
    return this.streams.get(hostId)?.since;
  }

  /** End `hostId`'s stream (its pairing was revoked). */
  close(hostId: HostId): void {
    this.features.delete(hostId);
    this.streams.get(hostId)?.res.end();
  }

  closeAll(): void {
    for (const s of [...this.streams.values()]) s.res.end();
  }

  // --- internals --------------------------------------------------------------

  /** `hostId`'s joiner made a request: its stream's silence deadline starts over. */
  private heard(hostId: HostId): void {
    const stream = this.streams.get(hostId);
    if (stream?.silence) this.armSilence(hostId, stream);
  }

  private armSilence(hostId: HostId, stream: Stream): void {
    if (stream.silence) clearTimeout(stream.silence);
    const silenceMs = this.deps.silenceMs ?? A2A_STREAM_SILENCE_MS;
    stream.silence = setTimeout(() => {
      if (this.streams.get(hostId) !== stream) return;
      this.deps.log('info', `[a2a-remote] ${hostId}: nothing heard for ${Math.round(silenceMs / 1000)}s, ending its stream`);
      // destroy, not end: a vanished peer never acknowledges a graceful close.
      stream.res.destroy();
    }, silenceMs);
    stream.silence.unref?.();
  }

  private open(req: http.IncomingMessage, res: http.ServerResponse, hostId: HostId): void {
    const prev = this.streams.get(hostId);
    if (prev) {
      // One stream per peer: the newest connection wins.
      this.streams.delete(hostId);
      clearInterval(prev.timer);
      if (prev.silence) clearTimeout(prev.silence);
      prev.res.end();
    }
    const advertised = parseA2aFeatures(req.headers[A2A_FEATURES_HEADER]);
    this.features.set(hostId, new Set(advertised));
    const epoch = this.deps.outbox.epoch;
    const resume = parseCursorId(req.headers['last-event-id']);
    if (resume && resume.epoch === epoch) {
      // Everything up to the resume point reached the joiner: a lost ack is recovered here.
      try {
        this.deps.outbox.ack(hostId, resume);
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] resume ack for ${hostId} not stored: ${errMsg(err)}`);
      }
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const own = typeof this.deps.features === 'function' ? this.deps.features(hostId) : this.deps.features;
    const hello: A2aStreamHello = { epoch, ...(own && own.length > 0 ? { features: [...own] } : {}) };
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    const heartbeatMs = this.deps.heartbeatMs ?? STREAM_HEARTBEAT_MS;
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write('event: heartbeat\ndata: {}\n\n');
    }, heartbeatMs);
    timer.unref?.();
    const stream: Stream = { res, lastSent: 0, timer, since: Date.now(), silence: null };
    this.streams.set(hostId, stream);
    if (advertised.includes(A2A_FEATURE_STREAM_PING)) this.armSilence(hostId, stream);
    // The request socket must not time out while the stream is idle between heartbeats.
    req.socket.setTimeout(0);
    res.on('close', () => {
      clearInterval(timer);
      if (stream.silence) clearTimeout(stream.silence);
      if (this.streams.get(hostId) === stream) {
        this.streams.delete(hostId);
        this.deps.onStatus?.(hostId, false);
      }
    });
    this.deps.onStatus?.(hostId, true);
    this.deps.onFeatures?.(hostId, advertised);
    this.flush(hostId, stream);
  }

  private flush(hostId: HostId, stream: Stream): void {
    if (stream.res.writableEnded || this.deps.serves?.(hostId) === false) return;
    const epoch = this.deps.outbox.epoch;
    for (const rec of this.deps.outbox.pending(hostId)) {
      if (rec.seq <= stream.lastSent) continue;
      if (this.deps.withhold?.(hostId, rec)) continue;
      const event: A2aStreamEvent = { cursor: { epoch, seq: rec.seq }, envelope: rec.envelope };
      stream.res.write(`id: ${formatCursorId(event.cursor)}\ndata: ${JSON.stringify(event)}\n\n`);
      stream.lastSent = rec.seq;
    }
  }
}

function tooLarge(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader('Connection', 'close');
  res.once('finish', () => req.socket.destroy());
  sendJson(res, 413, { ok: false, error: 'too-large' });
}

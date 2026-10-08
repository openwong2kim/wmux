import type http from 'node:http';
import {
  A2A_ROUTES,
  type A2aRemoteDeliverResponse,
  type A2aRemoteErrorCode,
  type A2aStreamCursor,
  type A2aStreamEvent,
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
 * Wire events: `event: hello` (stream is up, carries the outbox epoch),
 * `event: heartbeat` every `heartbeatMs`, and plain `message` events carrying
 * an `A2aStreamEvent` with `id: <epoch>:<seq>`. The heartbeat is an EVENT, not
 * an SSE comment: the joiner's parser drops comments, so a comment could not
 * tell it the stream is still alive.
 */

export const STREAM_HEARTBEAT_MS = 15_000;

export interface A2aStreamHubDeps {
  outbox: Pick<OutboxStore, 'epoch' | 'pending' | 'ack'>;
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
  heartbeatMs?: number;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

interface Stream {
  res: http.ServerResponse;
  /** Highest seq written on this stream. */
  lastSent: number;
  timer: ReturnType<typeof setInterval>;
  since: number;
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

  constructor(deps: A2aStreamHubDeps) {
    this.deps = deps;
  }

  /** Add the three delivery routes to the authenticated route table. */
  register(table: A2aRouteTable): void {
    table.add('POST', A2A_ROUTES.messages, async ({ req, res, peer }) => {
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
      const body = await readJsonBody(req, A2A_REQUEST_BODY_MAX);
      if (body === 'too-large') return tooLarge(req, res);
      const cursor = isPlainObject(body) && isPlainObject(body['cursor']) ? body['cursor'] : null;
      if (!cursor || typeof cursor['epoch'] !== 'string' || typeof cursor['seq'] !== 'number' || !Number.isSafeInteger(cursor['seq'])) {
        return sendJson(res, 400, { ok: false, error: 'bad-request' });
      }
      let acked = 0;
      try {
        acked = this.deps.outbox.ack(peer.hostId, { epoch: cursor['epoch'], seq: cursor['seq'] });
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] ack from ${peer.hostId} not stored: ${errMsg(err)}`);
        return sendJson(res, 503, { ok: false, error: 'unavailable' });
      }
      sendJson(res, 200, { ok: true, acked });
    });

    table.add('GET', A2A_ROUTES.stream, ({ req, res, peer }) => this.open(req, res, peer.hostId));
  }

  /** New records are owed to `hostId`: write them to its stream, if one is open. */
  notify(hostId: HostId): void {
    const stream = this.streams.get(hostId);
    if (stream) this.flush(hostId, stream);
  }

  isConnected(hostId: HostId): boolean {
    return this.streams.has(hostId);
  }

  connectedSince(hostId: HostId): number | undefined {
    return this.streams.get(hostId)?.since;
  }

  /** End `hostId`'s stream (its pairing was revoked). */
  close(hostId: HostId): void {
    this.streams.get(hostId)?.res.end();
  }

  closeAll(): void {
    for (const s of [...this.streams.values()]) s.res.end();
  }

  // --- internals --------------------------------------------------------------

  private open(req: http.IncomingMessage, res: http.ServerResponse, hostId: HostId): void {
    const prev = this.streams.get(hostId);
    if (prev) {
      // One stream per peer: the newest connection wins.
      this.streams.delete(hostId);
      clearInterval(prev.timer);
      prev.res.end();
    }
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
    res.write(`event: hello\ndata: ${JSON.stringify({ epoch })}\n\n`);
    const heartbeatMs = this.deps.heartbeatMs ?? STREAM_HEARTBEAT_MS;
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write('event: heartbeat\ndata: {}\n\n');
    }, heartbeatMs);
    timer.unref?.();
    const stream: Stream = { res, lastSent: 0, timer, since: Date.now() };
    this.streams.set(hostId, stream);
    // The request socket must not time out while the stream is idle between heartbeats.
    req.socket.setTimeout(0);
    res.on('close', () => {
      clearInterval(timer);
      if (this.streams.get(hostId) === stream) {
        this.streams.delete(hostId);
        this.deps.onStatus?.(hostId, false);
      }
    });
    this.deps.onStatus?.(hostId, true);
    this.flush(hostId, stream);
  }

  private flush(hostId: HostId, stream: Stream): void {
    if (stream.res.writableEnded || this.deps.serves?.(hostId) === false) return;
    const epoch = this.deps.outbox.epoch;
    for (const rec of this.deps.outbox.pending(hostId)) {
      if (rec.seq <= stream.lastSent) continue;
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

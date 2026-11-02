import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { StringDecoder } from 'node:string_decoder';
import { A2A_FEATURES_HEADER, normalizeFingerprint256, parseA2aFeatures } from '../../shared/a2aRemote';

/**
 * Certificate-pinned HTTPS client for cross-host A2A (joiner -> server).
 *
 * Identity is the pinned SHA-256 fingerprint, not a CA chain: the server runs a
 * self-signed certificate and the joiner learned its fingerprint from the
 * invite. The order is the security property:
 *
 *   1. TCP + TLS handshake, nothing else.
 *   2. Compare the leaf certificate's fingerprint with the pin. On mismatch the
 *      socket is destroyed before a single HTTP byte — and so before any
 *      credential — is written, and the remaining addresses are NOT tried: a
 *      host answering with the wrong certificate is an identity failure, not an
 *      unreachable address.
 *   3. Only then is an HTTP/1.1 request built on that socket.
 *
 * Addresses are tried in order (the one that last answered first, both in the
 * saved record and within one client instance); only connect-level failures
 * (refused, unreachable, DNS, handshake timeout) advance to the next one, each
 * after at most `connectTimeoutMs`. Proxy environment variables are ignored by construction: the
 * socket is dialled here and handed to `http.request` via `createConnection`,
 * so no agent — proxy-aware or not — is ever consulted.
 */

export interface PinnedClientOptions {
  /** Tried in order; the first that completes a handshake decides the outcome. */
  addresses: string[];
  port: number;
  /** The pinned leaf fingerprint (`X509Certificate.fingerprint256` form; case and colons are normalized). */
  fingerprint256: string;
  /**
   * Peer credential. Sent ONLY as `Authorization: Bearer`, never in a URL.
   * Absent only for the pairing exchange (`/api/pair`), which is how a joiner
   * obtains one; every `/api/a2a/*` route requires it. The pin is verified
   * before any request either way.
   */
  credential?: string;
  /** Budget per address for TCP connect + TLS handshake. */
  connectTimeoutMs: number;
  /** Budget from request start to a complete JSON answer (requestJson) or to response headers (openStream); the byte transfers take their own. */
  requestTimeoutMs: number;
  /**
   * Called with the address that completed a handshake, only AFTER its
   * certificate matched the pin, before any request is written. Lets the
   * caller put that address first for the next connect. Must not throw;
   * an error from it is ignored.
   */
  onConnected?: (address: string) => void;
}

export type PinnedClientErrorCode =
  | 'bad-options'
  /** No address completed a handshake. Nothing was sent. */
  | 'connect-failed'
  /** A host answered with a certificate other than the pinned one. Nothing was sent. */
  | 'fingerprint-mismatch'
  /** The request was written but no complete answer arrived in time. */
  | 'timeout'
  | 'aborted'
  /** The socket failed after the request was written. */
  | 'network'
  /** An answer arrived but is unusable (oversized, or a stream event that is not JSON). */
  | 'protocol'
  /** The stream route answered something other than 200. `status`/`json` carry the answer. */
  | 'http';

export class PinnedClientError extends Error {
  readonly code: PinnedClientErrorCode;
  /**
   * True once request bytes may have reached the peer. An outbox uses this to
   * tell "retry freely" (false) from "outcome unknown, resend idempotently" (true).
   */
  readonly sent: boolean;
  readonly status?: number;
  readonly json?: unknown;

  constructor(code: PinnedClientErrorCode, message: string, extra: { sent: boolean; status?: number; json?: unknown }) {
    super(message);
    this.name = 'PinnedClientError';
    this.code = code;
    this.sent = extra.sent;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.json !== undefined) this.json = extra.json;
  }
}

/** A streamed answer (`getStream`): its headers, and its body to read once. */
export interface PinnedStreamedBody {
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}

/** One server-sent event whose `data` was JSON. */
export interface PinnedSseEvent {
  /** The stream's last event id at dispatch (SSE semantics: it persists across events). */
  id?: string;
  /** SSE event type; `message` when the server sent none. */
  event: string;
  data: unknown;
}

/**
 * Cap, in UTF-8 bytes, on a buffered JSON answer, on one SSE line and on the
 * data of one SSE event — a misbehaving peer must not grow memory without bound.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Cap on an SSE event id, which is echoed back as the `Last-Event-ID` header. */
const MAX_EVENT_ID_LENGTH = 1024;

/** True iff `v` can travel as an HTTP header value: printable ASCII, no CR/LF/controls, bounded. */
function isHeaderSafeId(v: string): boolean {
  return v.length <= MAX_EVENT_ID_LENGTH && /^[\x20-\x7e]*$/.test(v);
}

/**
 * The first error a socket raised after its handshake succeeded but before a
 * request took it over. Recorded so the request fails at once instead of
 * waiting out `requestTimeoutMs` on a socket that is already dead.
 */
const earlyErrors = new WeakMap<tls.TLSSocket, Error>();

/**
 * Call `onFail` once if the socket errors or closes — at once (next microtask)
 * if that already happened. Returns a detach function.
 */
function watchSocket(socket: tls.TLSSocket, onFail: (err: Error) => void): () => void {
  const early = earlyErrors.get(socket);
  if (early || socket.destroyed) {
    queueMicrotask(() => onFail(early ?? new Error('socket closed before the request')));
    return () => undefined;
  }
  const onError = (err: Error): void => onFail(err);
  const onClose = (): void => onFail(new Error('socket closed before a response'));
  socket.on('error', onError);
  socket.on('close', onClose);
  return () => {
    socket.off('error', onError);
    socket.off('close', onClose);
  };
}

export class PinnedTlsClient {
  private readonly opts: PinnedClientOptions;
  /**
   * Dial order for this instance: the address that last got through moves
   * to the front, so a long-lived client (a stream's acks, a pump run) does
   * not wait out a dead address on every request.
   */
  private readonly addresses: string[];

  constructor(opts: PinnedClientOptions) {
    this.opts = opts;
    this.addresses = [...opts.addresses];
  }

  /** One JSON request. Resolves with any HTTP status; `json` is null when the body is empty or not JSON. */
  async requestJson(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    // Serialize before dialling: a body that cannot be encoded fails with nothing opened.
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const { status, body: answer } = await this.request(method, path, payload, { contentType: 'application/json', accept: 'application/json' });
    return { status, json: parseJsonOrNull(answer.toString('utf8')) };
  }

  /**
   * Upload raw bytes (`PUT`), answered in JSON like `requestJson`. The whole
   * exchange gets `timeoutMs` instead of the request budget: a body of
   * megabytes takes longer than a JSON message. Abandoned when `signal` aborts.
   */
  async putBytes(path: string, body: Buffer, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
    const { status, body: answer } = await this.request('PUT', path, body, {
      contentType: 'application/octet-stream',
      accept: 'application/json',
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return { status, json: parseJsonOrNull(answer.toString('utf8')) };
  }

  /** The status of a `HEAD` (no body), within `timeoutMs`, abandoned when `signal` aborts. */
  async headStatus(path: string, timeoutMs: number, signal?: AbortSignal): Promise<number> {
    const { status } = await this.request('HEAD', path, undefined, { accept: 'application/json', timeoutMs, ...(signal ? { signal } : {}) });
    return status;
  }

  /**
   * Download raw bytes (`GET`): at most `maxBytes`, within `timeoutMs`,
   * abandoned when `signal` aborts. A status other than 200 throws `http`
   * (with the JSON answer, if any).
   */
  async getBytes(path: string, opts: { maxBytes: number; timeoutMs: number; signal?: AbortSignal }): Promise<Buffer> {
    const { status, body } = await this.request('GET', path, undefined, { accept: 'application/octet-stream', ...opts });
    if (status !== 200) {
      throw new PinnedClientError('http', `HTTP ${status}`, { sent: true, status, json: parseJsonOrNull(body.toString('utf8')) });
    }
    return body;
  }

  /**
   * Download a body too large to hold (`GET`): `consume` reads it as it
   * arrives. The whole exchange gets `timeoutMs`; past it, on `signal`, or
   * on a failed socket, the body is destroyed with that error, so the read
   * in `consume` fails, and the call settles as `consume` does (which must
   * settle once its body ends or fails). A status other than 200 throws
   * `http` (with the JSON answer, if any) before `consume` is called.
   */
  async getStream<T>(
    path: string,
    opts: { timeoutMs: number; signal?: AbortSignal; acceptEncoding?: string },
    consume: (res: PinnedStreamedBody) => Promise<T>,
  ): Promise<T> {
    if (opts.signal?.aborted) throw new PinnedClientError('aborted', 'aborted', { sent: false });
    const { socket, address } = await this.connect(opts.signal);
    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        let res: http.IncomingMessage | undefined;
        const req = http.request({
          method: 'GET',
          path,
          host: address,
          port: this.opts.port,
          headers: this.headers({ Accept: 'application/octet-stream', ...(opts.acceptEncoding ? { 'Accept-Encoding': opts.acceptEncoding } : {}) }),
          createConnection: () => socket,
        });
        const finish = (err: Error | null, value?: T): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          detach();
          opts.signal?.removeEventListener('abort', onAbort);
          if (err) reject(err);
          else resolve(value as T);
        };
        // Before the answer the call fails at once; after it, its body does.
        const fail = (err: PinnedClientError): void => {
          if (res) res.destroy(err);
          else finish(err);
        };
        const onAbort = (): void => fail(new PinnedClientError('aborted', 'aborted', { sent: true }));
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => fail(new PinnedClientError('timeout', `not done within ${opts.timeoutMs}ms`, { sent: true })), opts.timeoutMs);
        const detach = watchSocket(socket, (err) => fail(new PinnedClientError('network', errMsg(err), { sent: true })));
        req.on('error', (err) => fail(asSentError(err)));
        req.on('response', (r) => {
          // From here the body owns failure reporting: a socket that closes after its last byte cuts nothing.
          detach();
          res = r;
          if (r.statusCode !== 200) {
            readCappedBytes(r, undefined, MAX_BODY_BYTES).then(
              (body) => finish(new PinnedClientError('http', `HTTP ${r.statusCode}`, { sent: true, status: r.statusCode ?? 0, json: parseJsonOrNull(body.toString('utf8')) })),
              (err: unknown) => finish(asSentError(err)),
            );
            return;
          }
          consume({ headers: r.headers, body: r }).then(
            (value) => finish(null, value),
            (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
          );
        });
        req.end();
      });
    } finally {
      socket.destroy();
    }
  }

  private async request(
    method: string,
    path: string,
    payload: Buffer | undefined,
    opts: { contentType?: string; accept: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal },
  ): Promise<{ status: number; body: Buffer }> {
    if (opts.signal?.aborted) throw new PinnedClientError('aborted', 'aborted', { sent: false });
    const { socket, address } = await this.connect(opts.signal);
    try {
      return await this.exchange(socket, address, method, path, payload, opts);
    } finally {
      // Covers a synchronous throw from http.request (e.g. an invalid header) too.
      socket.destroy();
    }
  }

  private exchange(
    socket: tls.TLSSocket,
    address: string,
    method: string,
    path: string,
    payload: Buffer | undefined,
    opts: { contentType?: string; accept: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal },
  ): Promise<{ status: number; body: Buffer }> {
    const budget = opts.timeoutMs ?? this.opts.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = http.request({
        method,
        path,
        host: address,
        port: this.opts.port,
        headers: this.headers({
          Accept: opts.accept,
          ...(payload ? { 'Content-Type': opts.contentType ?? 'application/json', 'Content-Length': String(payload.length) } : {}),
        }),
        createConnection: () => socket,
      });
      const finish = (outcome: PinnedClientError | { status: number; body: Buffer }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detach();
        opts.signal?.removeEventListener('abort', onAbort);
        req.destroy();
        socket.destroy();
        if (outcome instanceof PinnedClientError) reject(outcome);
        else resolve(outcome);
      };
      const onAbort = (): void => finish(new PinnedClientError('aborted', 'aborted', { sent: true }));
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () => finish(new PinnedClientError('timeout', `no answer within ${budget}ms`, { sent: true })),
        budget,
      );
      const detach = watchSocket(socket, (err) =>
        finish(new PinnedClientError('network', errMsg(err), { sent: true })),
      );
      req.on('error', (err) => finish(new PinnedClientError('network', errMsg(err), { sent: true })));
      req.on('response', (res) => {
        // From here the response stream owns failure reporting (readCapped).
        detach();
        readCappedBytes(res, undefined, opts.maxBytes ?? MAX_BODY_BYTES).then(
          (body) => finish({ status: res.statusCode ?? 0, body }),
          (err: unknown) => finish(asSentError(err)),
        );
      });
      req.end(payload);
    });
  }

  /**
   * Open a server-sent event stream. Iteration ends normally when the server
   * closes the stream or `signal` aborts; it throws on a non-200 answer
   * (`http`), a socket failure (`network`) or a non-JSON event (`protocol`).
   * Breaking out of the loop closes the connection.
   *
   * No idle timeout is applied once the stream is open — liveness is the
   * caller's call (abort on a missed heartbeat).
   */
  async *openStream(
    path: string,
    { signal, lastEventId, features }: { signal: AbortSignal; lastEventId?: string; features?: readonly string[] },
  ): AsyncGenerator<PinnedSseEvent, void, undefined> {
    if (lastEventId !== undefined && !isHeaderSafeId(lastEventId)) {
      throw new PinnedClientError('bad-options', 'lastEventId is not a valid header value', { sent: false });
    }
    // Only well-formed feature tokens go on the wire (the same rule the server parses by).
    const featureHeader = features && features.length > 0 ? parseA2aFeatures(features.join(',')).join(',') : '';
    if (signal.aborted) return;
    let conn: { socket: tls.TLSSocket; address: string };
    try {
      conn = await this.connect(signal);
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
    const { socket, address } = conn;
    // An abort that landed during the handshake fired no listener on this socket.
    if (signal.aborted) {
      socket.destroy();
      return;
    }
    let req: http.ClientRequest | undefined;
    const onAbort = (): void => {
      // With an error so a request still waiting for headers rejects at once.
      req?.destroy(new Error('aborted'));
      socket.destroy();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      req = http.request({
        method: 'GET',
        path,
        host: address,
        port: this.opts.port,
        headers: this.headers({
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...(lastEventId !== undefined ? { 'Last-Event-ID': lastEventId } : {}),
          ...(featureHeader ? { [A2A_FEATURES_HEADER]: featureHeader } : {}),
        }),
        createConnection: () => socket,
      });
      const res = await this.awaitResponse(req, socket);
      if (res.statusCode !== 200) {
        const text = await readCapped(res, this.opts.requestTimeoutMs).catch(() => '');
        throw new PinnedClientError('http', `stream refused: HTTP ${res.statusCode}`, {
          sent: true,
          status: res.statusCode ?? 0,
          json: parseJsonOrNull(text),
        });
      }
      const parser = new SseParser();
      const decoder = new StringDecoder('utf8');
      for await (const chunk of res as AsyncIterable<Buffer>) {
        const events = parser.feed(decoder.write(chunk));
        for (const ev of events) yield ev;
      }
      // Flush a multi-byte character split across the last chunk. A trailing
      // event without its blank line is still incomplete and dropped, as the
      // SSE spec says.
      for (const ev of parser.feed(decoder.end())) yield ev;
    } catch (err) {
      if (signal.aborted) return;
      throw asSentError(err);
    } finally {
      signal.removeEventListener('abort', onAbort);
      req?.destroy();
      socket.destroy();
    }
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      ...extra,
      ...(this.opts.credential ? { Authorization: `Bearer ${this.opts.credential}` } : {}),
    };
  }

  /** Resolve with response headers, or reject on socket error / `requestTimeoutMs`. */
  private awaitResponse(req: http.ClientRequest, socket: tls.TLSSocket): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: PinnedClientError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detach();
        req.destroy();
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new PinnedClientError('timeout', `no response within ${this.opts.requestTimeoutMs}ms`, { sent: true })),
        this.opts.requestTimeoutMs,
      );
      const detach = watchSocket(socket, (err) => fail(new PinnedClientError('network', errMsg(err), { sent: true })));
      req.once('response', (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detach();
        resolve(res);
      });
      req.on('error', (err) => fail(new PinnedClientError('network', errMsg(err), { sent: true })));
      req.end();
    });
  }

  /** Handshake with the first reachable address and verify the pin. Writes nothing. */
  private async connect(signal?: AbortSignal): Promise<{ socket: tls.TLSSocket; address: string }> {
    const pin = normalizeFingerprint256(this.opts.fingerprint256);
    if (!pin) throw new PinnedClientError('bad-options', 'pinned fingerprint is malformed', { sent: false });
    if (this.addresses.length === 0) throw new PinnedClientError('bad-options', 'no address to try', { sent: false });
    const failures: string[] = [];
    for (const address of [...this.addresses]) {
      let socket: tls.TLSSocket;
      try {
        socket = await this.handshake(address, signal);
      } catch (err) {
        if (err instanceof PinnedClientError) throw err; // aborted
        failures.push(`${address}: ${errMsg(err)}`);
        continue;
      }
      const presented = normalizeFingerprint256(socket.getPeerCertificate()?.fingerprint256);
      if (presented !== pin) {
        socket.destroy();
        throw new PinnedClientError(
          'fingerprint-mismatch',
          `${address} presented certificate ${presented ?? '(none)'}, expected the pinned ${pin}`,
          { sent: false },
        );
      }
      const at = this.addresses.indexOf(address);
      if (at > 0) this.addresses.unshift(...this.addresses.splice(at, 1));
      try {
        this.opts.onConnected?.(address);
      } catch {
        // Bookkeeping only: it never decides a connection.
      }
      return { socket, address };
    }
    throw new PinnedClientError('connect-failed', `no address reachable (${failures.join('; ')})`, { sent: false });
  }

  private handshake(address: string, signal?: AbortSignal): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new PinnedClientError('aborted', 'aborted', { sent: false }));
        return;
      }
      const socket = tls.connect({
        host: address,
        port: this.opts.port,
        // No CA verification: the fingerprint check in `connect` IS the identity check.
        rejectUnauthorized: false,
        // SNI must not carry an IP literal.
        ...(net.isIP(address) ? {} : { servername: address }),
      });
      let done = false;
      const finish = (err: Error | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (err) {
          socket.destroy();
          reject(err);
        } else {
          resolve(socket);
        }
      };
      const onAbort = (): void => finish(new PinnedClientError('aborted', 'aborted', { sent: false }));
      const timer = setTimeout(
        () => finish(new Error(`handshake timed out after ${this.opts.connectTimeoutMs}ms`)),
        this.opts.connectTimeoutMs,
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.once('secureConnect', () => finish(null));
      // Stays attached after success: an error in the gap before a request
      // takes the socket over is recorded (see `watchSocket`), never lost and
      // never an unhandled 'error' event.
      socket.on('error', (err) => {
        if (!done) finish(err);
        else if (!earlyErrors.has(socket)) earlyErrors.set(socket, err);
      });
    });
  }
}

/** Incremental SSE parser (WHATWG event-stream rules for the fields this protocol uses). */
const LINE_BREAK = /\r\n|\r|\n/g;

class SseParser {
  private pending = '';
  /** UTF-8 bytes of `pending`. */
  private pendingBytes = 0;
  /** Where the next newline search in `pending` starts. */
  private scanFrom = 0;
  private dataLines: string[] = [];
  /** UTF-8 bytes of `dataLines` joined with '\n'. */
  private dataBytes = 0;
  private eventType = '';
  private lastId: string | undefined;

  feed(text: string): PinnedSseEvent[] {
    this.pending += text;
    this.pendingBytes += Buffer.byteLength(text, 'utf8');
    const out: PinnedSseEvent[] = [];
    for (;;) {
      // Resume the newline search where the last one stopped, so a long line
      // arriving in many chunks is scanned once, not once per chunk.
      LINE_BREAK.lastIndex = this.scanFrom;
      const m = LINE_BREAK.exec(this.pending);
      if (!m) {
        this.scanFrom = this.pending.length;
        break;
      }
      // A lone trailing CR may be the first half of a CRLF split across chunks.
      if (m[0] === '\r' && m.index === this.pending.length - 1) {
        this.scanFrom = m.index;
        break;
      }
      const line = this.pending.slice(0, m.index);
      this.pending = this.pending.slice(m.index + m[0].length);
      this.scanFrom = 0;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      this.pendingBytes -= lineBytes + m[0].length;
      if (lineBytes > MAX_BODY_BYTES) throw lineTooLong();
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    if (this.pendingBytes > MAX_BODY_BYTES) throw lineTooLong();
    return out;
  }

  private line(line: string): PinnedSseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.dataBytes += Buffer.byteLength(value, 'utf8') + (this.dataLines.length > 0 ? 1 : 0);
      if (this.dataBytes > MAX_BODY_BYTES) {
        throw new PinnedClientError('protocol', 'stream event data exceeds the size cap', { sent: true });
      }
      this.dataLines.push(value);
    } else if (field === 'event') {
      this.eventType = value;
    } else if (field === 'id' && !value.includes('\0')) {
      // The id is echoed back as `Last-Event-ID` on reconnect, so it must be a
      // valid header value; anything else is a protocol violation, not a cursor.
      if (!isHeaderSafeId(value)) {
        throw new PinnedClientError('protocol', 'stream event id is not a valid header value', { sent: true });
      }
      this.lastId = value;
    }
    return null;
  }

  private dispatch(): PinnedSseEvent | null {
    const lines = this.dataLines;
    const event = this.eventType || 'message';
    this.dataLines = [];
    this.dataBytes = 0;
    this.eventType = '';
    if (lines.length === 0) return null;
    let data: unknown;
    try {
      data = JSON.parse(lines.join('\n'));
    } catch {
      throw new PinnedClientError('protocol', 'stream event data is not JSON', { sent: true });
    }
    return { ...(this.lastId !== undefined ? { id: this.lastId } : {}), event, data };
  }
}

function lineTooLong(): PinnedClientError {
  return new PinnedClientError('protocol', 'stream line exceeds the size cap', { sent: true });
}

/**
 * Buffer a response body (capped). With `timeoutMs`, a body that never ends is
 * destroyed — and the read rejected — once the budget runs out.
 */
function readCapped(res: http.IncomingMessage, timeoutMs?: number): Promise<string> {
  return readCappedBytes(res, timeoutMs, MAX_BODY_BYTES).then((b) => b.toString('utf8'));
}

function readCappedBytes(res: http.IncomingMessage, timeoutMs: number | undefined, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (err: Error | null, body?: Buffer): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) {
        res.destroy();
        reject(err);
      } else {
        resolve(body ?? Buffer.alloc(0));
      }
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => settle(new PinnedClientError('timeout', `response body incomplete after ${timeoutMs}ms`, { sent: true })),
            timeoutMs,
          );
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        settle(new PinnedClientError('protocol', 'response body exceeds the size cap', { sent: true }));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => settle(null, Buffer.concat(chunks)));
    res.on('error', (err) => settle(err));
    res.on('aborted', () => settle(new Error('response aborted')));
    // 'close' after 'end' is a no-op; 'close' without 'end' is a truncated body.
    res.on('close', () => settle(new Error('response closed before its end')));
  });
}

function parseJsonOrNull(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asSentError(err: unknown): PinnedClientError {
  return err instanceof PinnedClientError ? err : new PinnedClientError('network', errMsg(err), { sent: true });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

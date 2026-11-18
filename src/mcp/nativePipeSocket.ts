/**
 * A stream.Duplex over one accepted connection of the native named-pipe
 * listener (core/wmux-term, capability `pipe-listener-v2`; see nativePipe.ts).
 *
 * It behaves as the parts of net.Socket that the MCP broker and the SDK's
 * StdioServerTransport use: 'data'/'end'/'close'/'error', pause/resume,
 * unshift, write() returning false with a later 'drain', end(data, cb) and
 * destroy(). Flow control is the stream's own: a native read is requested only
 * when the readable side asks for data (_read), and at most one is
 * outstanding, so a paused socket stops reading from the pipe. A write's
 * callback fires only once the native side reports that write as done, so
 * 'drain' and end(data, cb) mean the bytes are in the pipe.
 *
 * end() closes the whole pipe, not only the sending side: once the native
 * close completes, the readable side ends too. Data already read into this
 * socket is still delivered (then 'end', then 'close', as on net.Socket), but
 * bytes the client sends later, or that are still unread in the pipe, are
 * not. Read everything you need before calling end().
 *
 * Errors from consumer callbacks ('data' handlers, write and end callbacks)
 * are not socket errors: they propagate out of pump(), as they would out of
 * a net.Socket's I/O callback.
 *
 * A connection has no wake of its own: every connection of a listener wakes
 * the listener's one callback ("something changed"), and the listener's owner
 * (listenNativePipe) then calls pump() on each live socket, which drains every
 * take*() result without blocking.
 */
import { Duplex } from 'node:stream';

/** What the OS says about the connected client, read at accept. */
export interface NativePipePeer {
  pid: number;
  sessionId: number;
  sameSession: boolean;
  /** null when `reason` says why the client could not be read. */
  sameUser: boolean | null;
  integrityRid: number | null;
  /** The client's creation time, Unix epoch ms. */
  created: number;
  ppid: number | null;
  /** 'token-unreadable', 'process-unreadable' or 'created-after-accept'; null when read in full. */
  reason: string | null;
}

/** The connected client's own token, read by impersonating the client. */
export type ClientTokenFacts =
  | { ok: true; sameUser: boolean; integrityRid: number; elevated: boolean }
  | { ok: false; reason: 'no-read-yet' | 'impersonation-failed' | 'token-unreadable' | 'closed' };

/** What NativePipeSocket.tokenFacts() settles with: the native answer, or why
 *  the wait ended without one. */
export type TokenFactsResult = ClientTokenFacts | { ok: false; reason: 'timed-out' | 'unsupported' };

/** One accepted connection of NativePipeListener (design: broker (b)). */
export interface NativePipeConn {
  peer(): NativePipePeer;
  /** pipe-listener-v2: ask for the client's token facts. Valid only after a
   *  read completed; at most one request outstanding; wakes when done. */
  requestTokenFacts?(): void;
  /** pipe-listener-v2: the result, once; null while pending or never asked. */
  takeTokenFacts?(): ClientTokenFacts | null;
  /** At most one outstanding read; wakes when it is done. */
  requestRead(max: number): void;
  /** null: the read is not done yet; 'eof': the client closed its end. */
  takeRead(): Buffer | null | 'eof';
  /** Queues the bytes and returns the write's id. */
  write(data: Buffer): number;
  /** Ids of the writes that completed. A failed write is not listed: it
   *  sets error(), and the socket then fails every pending write. */
  takeWritten(): number[];
  error(): string | null;
  /** Closes the pipe once the queued writes are done; wakes when closed. */
  end(): void;
  closed(): boolean;
  /** Idempotent. */
  destroy(): void;
}

/** The size of each native read. */
export const NATIVE_PIPE_READ_SIZE = 64 * 1024;

type Callback = (error?: Error | null) => void;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class NativePipeSocket extends Duplex {
  /** The client as the OS reported it at accept. */
  readonly peer: NativePipePeer;
  private readonly conn: NativePipeConn;
  /** A native read is outstanding. */
  private reading = false;
  /** EOF was pushed. */
  private readEnded = false;
  /** Write callbacks by native write id. */
  private readonly writes = new Map<number, Callback>();
  /** _final's callback while the native end() is in progress. */
  private finalCallback: Callback | null = null;
  /** Our end() completed natively. */
  private finalDone = false;
  private pumping = false;
  private pumpAgain = false;
  /** A native token read is outstanding. */
  private factsPending = false;
  /** Callers of tokenFacts() waiting for the outstanding read. */
  private readonly factsWaiters = new Set<(facts: TokenFactsResult) => void>();

  constructor(conn: NativePipeConn) {
    super({ allowHalfOpen: false });
    this.conn = conn;
    try {
      this.peer = conn.peer();
    } catch (error) {
      conn.destroy();
      throw error;
    }
  }

  /**
   * The client's own token facts (user, integrity, elevation), read natively
   * by impersonating the client. Call it after the first bytes from the client
   * were read: before that the answer is `no-read-yet`. Settles within
   * `timeoutMs` (`timed-out`), at once with `closed` once the socket is
   * destroyed, and with `unsupported` on a module without the read. Callers
   * that ask while a read is outstanding share its answer.
   */
  tokenFacts(timeoutMs: number): Promise<TokenFactsResult> {
    if (this.destroyed) return Promise.resolve({ ok: false, reason: 'closed' });
    const conn = this.conn;
    if (typeof conn.requestTokenFacts !== 'function' || typeof conn.takeTokenFacts !== 'function') {
      return Promise.resolve({ ok: false, reason: 'unsupported' });
    }
    return new Promise((resolve) => {
      const settle = (facts: TokenFactsResult): void => {
        clearTimeout(timer);
        this.factsWaiters.delete(settle);
        resolve(facts);
      };
      const timer = setTimeout(() => settle({ ok: false, reason: 'timed-out' }), timeoutMs);
      this.factsWaiters.add(settle);
      if (this.factsPending) return;
      this.factsPending = true;
      // A throw destroys the socket, which settles every waiter as closed.
      this.native(() => conn.requestTokenFacts!());
    });
  }

  private settleFacts(facts: TokenFactsResult): void {
    for (const settle of [...this.factsWaiters]) settle(facts);
  }

  /** Drain whatever the native side finished since the last call. Called on
   *  every wake of the connection; cheap when nothing changed. A consumer
   *  callback that throws propagates out of here; the socket stays as it is,
   *  and the rest of this drain runs on the next turn of the event loop. */
  pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        this.pumpOnce();
      } while (this.pumpAgain && !this.destroyed);
    } catch (error) {
      // No other wake may come for what this drain did not reach. A 'data'
      // handler that threw also cut the stream's own read-ahead short:
      // read(0) asks for the next native read if the stream still wants one.
      setImmediate(() => {
        this.pump();
        if (!this.destroyed && !this.readEnded) this.read(0);
      });
      throw error;
    } finally {
      this.pumping = false;
    }
  }

  /** One native call; a throw destroys the socket with it (undefined then). */
  private native<T>(call: () => T): T | undefined {
    try {
      return call();
    } catch (error) {
      this.destroy(asError(error));
      return undefined;
    }
  }

  /** Native calls are guarded one by one; consumer callbacks (push, write and
   *  final callbacks) run outside any try. */
  private pumpOnce(): void {
    if (this.destroyed) return;
    if (this.factsPending) {
      const facts = this.native(() => this.conn.takeTokenFacts!());
      if (facts === undefined) return;
      if (facts !== null) {
        this.factsPending = false;
        // Settles promises only: no consumer code runs from here.
        this.settleFacts(facts);
      }
    }
    if (this.reading) {
      const read = this.native(() => this.conn.takeRead());
      if (read === undefined) return;
      if (read !== null) {
        this.reading = false;
        if (read === 'eof') {
          this.endReadable();
        } else if (read.length > 0) {
          this.push(read);
        } else {
          // Nothing to hand on: ask the stream whether it still wants data.
          this.read(0);
        }
      }
      if (this.destroyed) return;
    }
    // Before acking writes: a failed write sets error() and is destroyed with
    // the rest (its callback fails in _destroy), never acked as done.
    const error = this.native(() => this.conn.error());
    if (error === undefined) return;
    if (error) {
      this.destroy(new Error(`native pipe: ${error}`));
      return;
    }
    const written = this.native(() => this.conn.takeWritten());
    if (written === undefined) return;
    for (const id of written) {
      const callback = this.writes.get(id);
      if (!callback) continue;
      this.writes.delete(id);
      callback();
      if (this.destroyed) return;
    }
    const closed = this.native(() => this.conn.closed());
    if (!closed) return;
    const callback = this.finalCallback;
    if (callback) {
      // Our end() completed: the pipe is closed, so the readable side ends
      // here. Buffered data is still delivered; autoDestroy closes the socket
      // after 'end' and 'finish'.
      this.finalCallback = null;
      this.finalDone = true;
      this.endReadable();
      callback();
    } else if (!this.finalDone) {
      // Closed without our end(): nothing more can move either way.
      this.destroy();
    }
  }

  /** No more data: push EOF once. */
  private endReadable(): void {
    if (this.readEnded) return;
    this.readEnded = true;
    this.reading = false;
    this.push(null);
  }

  override _read(): void {
    if (this.reading || this.readEnded || this.destroyed) return;
    this.reading = true;
    try {
      this.conn.requestRead(NATIVE_PIPE_READ_SIZE);
    } catch (error) {
      this.reading = false;
      this.destroy(asError(error));
    }
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: Callback): void {
    this.queueWrite(chunk, callback);
  }

  override _writev(chunks: Array<{ chunk: Buffer }>, callback: Callback): void {
    this.queueWrite(chunks.length === 1 ? chunks[0].chunk : Buffer.concat(chunks.map((c) => c.chunk)), callback);
  }

  private queueWrite(data: Buffer, callback: Callback): void {
    let id: number;
    try {
      id = this.conn.write(data);
    } catch (error) {
      callback(asError(error));
      return;
    }
    this.writes.set(id, callback);
  }

  override _final(callback: Callback): void {
    this.finalCallback = callback;
    try {
      this.conn.end();
    } catch (error) {
      this.finalCallback = null;
      callback(asError(error));
    }
  }

  override _destroy(error: Error | null, callback: Callback): void {
    this.reading = false;
    this.factsPending = false;
    this.settleFacts({ ok: false, reason: 'closed' });
    try {
      this.conn.destroy();
    } catch {
      // Already torn down natively.
    }
    const failure = error ?? new Error('native pipe: destroyed');
    const pending = [...this.writes.values()];
    this.writes.clear();
    const final = this.finalCallback;
    this.finalCallback = null;
    for (const write of pending) write(failure);
    final?.(failure);
    callback(error);
  }
}

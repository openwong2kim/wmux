/**
 * A stream.Duplex over one accepted connection of the native named-pipe
 * listener (core/wmux-term, capability `pipe-listener-v1`; see nativePipe.ts).
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

/** One accepted connection of NativePipeListener (design: broker (b)). */
export interface NativePipeConn {
  peer(): NativePipePeer;
  /** At most one outstanding read; wakes when it is done. */
  requestRead(max: number): void;
  /** null: the read is not done yet; 'eof': the client closed its end. */
  takeRead(): Buffer | null | 'eof';
  /** Queues the bytes and returns the write's id. */
  write(data: Buffer): number;
  /** Ids of the writes that completed (or failed: see error()). */
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
  private pumping = false;
  private pumpAgain = false;

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

  /** Drain whatever the native side finished since the last call. Called on
   *  every wake of the connection; cheap when nothing changed. */
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
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    if (this.destroyed) return;
    try {
      if (this.reading) {
        const read = this.conn.takeRead();
        if (read !== null) {
          this.reading = false;
          if (read === 'eof') {
            this.readEnded = true;
            this.push(null);
          } else if (read.length > 0) {
            this.push(read);
          } else {
            // Nothing to hand on: ask the stream whether it still wants data.
            this.read(0);
          }
        }
        if (this.destroyed) return;
      }
      // Before acking writes: a failed write's id is in takeWritten() too.
      const error = this.conn.error();
      if (error) {
        this.destroy(new Error(`native pipe: ${error}`));
        return;
      }
      for (const id of this.conn.takeWritten()) {
        const callback = this.writes.get(id);
        if (!callback) continue;
        this.writes.delete(id);
        callback();
        if (this.destroyed) return;
      }
      if (this.conn.closed()) {
        const callback = this.finalCallback;
        if (callback) {
          this.finalCallback = null;
          callback();
        } else {
          // Closed without our end(): nothing more can move either way.
          this.destroy();
        }
      }
    } catch (error) {
      this.destroy(asError(error));
    }
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
    // The handle is gone once end() completes, so nothing more can be read:
    // close the stream after 'finish' (autoDestroy would wait for 'end').
    this.once('finish', () => this.destroy());
    try {
      this.conn.end();
    } catch (error) {
      this.finalCallback = null;
      callback(asError(error));
    }
  }

  override _destroy(error: Error | null, callback: Callback): void {
    this.reading = false;
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

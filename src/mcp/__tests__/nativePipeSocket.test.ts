import { afterEach, describe, expect, it, vi } from 'vitest';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NativePipeSocket, NATIVE_PIPE_READ_SIZE, type NativePipeConn, type NativePipePeer } from '../nativePipeSocket';
import { listenNativePipe, type NativePipeListener, type NativePipeModule } from '../nativePipe';

// The Duplex adapter over a fake native connection. The fake keeps the native
// contract (one outstanding read, write ids acked through takeWritten, end()
// closing after the queued writes) and wakes asynchronously, as the native
// callback does, so these tests pin the stream semantics the broker and the
// SDK's StdioServerTransport rely on.

const PEER: NativePipePeer = {
  pid: 4242, sessionId: 1, sameSession: true, sameUser: true, integrityRid: 0x2000,
  created: 1_700_000_000_000, ppid: 4000, reason: null,
};

const noop = (): void => undefined;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function ticks(n: number): Promise<void> { for (let i = 0; i < n; i++) await tick(); }

class FakeConn implements NativePipeConn {
  /** Set by the owner: the shared wake. Called asynchronously. */
  wake: () => void = noop;
  /** Bytes the client sent and the server has not read yet. */
  private inbox: Buffer[] = [];
  private clientEof = false;
  private readOutstanding = false;
  private readDone: Buffer | 'eof' | null = null;
  readRequests = 0;
  maxOutstandingReads = 0;
  bytesRead = 0;
  /** Bytes the server wrote, in the order the pipe took them. */
  received: Buffer[] = [];
  private nextId = 1;
  private queued: Array<{ id: number; data: Buffer }> = [];
  private done: number[] = [];
  /** When true, writes stay queued until completeWrites(). */
  holdWrites = false;
  private failure: string | null = null;
  endCalled = false;
  private isClosed = false;
  holdEnd = false;
  destroyCalls = 0;
  peerImpl: () => NativePipePeer = () => PEER;
  requestReadImpl: (() => void) | null = null;

  private schedule(): void { setImmediate(() => this.wake()); }

  peer(): NativePipePeer { return this.peerImpl(); }

  requestRead(max: number): void {
    if (this.requestReadImpl) return this.requestReadImpl();
    if (this.readOutstanding || this.readDone !== null) throw new Error('a read is already outstanding');
    expect(max).toBe(NATIVE_PIPE_READ_SIZE);
    this.readRequests++;
    this.readOutstanding = true;
    this.maxOutstandingReads = Math.max(this.maxOutstandingReads, 1);
    this.completeRead(max);
  }

  private completeRead(max = NATIVE_PIPE_READ_SIZE): void {
    if (!this.readOutstanding || this.destroyCalls > 0) return;
    if (this.inbox.length > 0) {
      const all = Buffer.concat(this.inbox);
      const chunk = all.subarray(0, max);
      this.inbox = all.length > max ? [all.subarray(max)] : [];
      this.readDone = Buffer.from(chunk);
      this.bytesRead += chunk.length;
    } else if (this.clientEof) {
      this.readDone = 'eof';
    } else {
      return;
    }
    this.readOutstanding = false;
    this.schedule();
  }

  /** The client writes. */
  feed(data: Buffer | string): void {
    this.inbox.push(Buffer.from(data));
    this.completeRead();
  }

  /** The client closes its end. */
  clientEnd(): void {
    this.clientEof = true;
    this.completeRead();
  }

  takeRead(): Buffer | null | 'eof' {
    const r = this.readDone;
    this.readDone = null;
    return r;
  }

  write(data: Buffer): number {
    const id = this.nextId++;
    this.queued.push({ id, data: Buffer.from(data) });
    if (!this.holdWrites) this.completeWrites();
    return id;
  }

  completeWrites(): void {
    const batch = this.queued;
    this.queued = [];
    if (batch.length === 0) return;
    setImmediate(() => {
      for (const w of batch) { this.received.push(w.data); this.done.push(w.id); }
      this.maybeClose();
      this.wake();
    });
  }

  takeWritten(): number[] { const d = this.done; this.done = []; return d; }

  fail(message: string): void {
    this.failure = message;
    const batch = this.queued;
    this.queued = [];
    for (const w of batch) this.done.push(w.id);
    this.schedule();
  }

  error(): string | null { return this.failure; }

  end(): void {
    this.endCalled = true;
    this.maybeClose();
  }

  private maybeClose(): void {
    if (!this.endCalled || this.isClosed || this.queued.length > 0 || this.holdEnd) return;
    setImmediate(() => { this.isClosed = true; this.wake(); });
  }

  releaseEnd(): void { this.holdEnd = false; this.maybeClose(); }

  closed(): boolean { return this.isClosed; }

  destroy(): void { this.destroyCalls++; this.readOutstanding = false; }

  get receivedText(): string { return Buffer.concat(this.received).toString('utf8'); }
}

function socketOver(conn = new FakeConn()): { conn: FakeConn; socket: NativePipeSocket } {
  const socket = new NativePipeSocket(conn);
  conn.wake = () => socket.pump();
  return { conn, socket };
}

const closeOf = (socket: NativePipeSocket) => new Promise<void>((resolve) => {
  if (socket.closed) resolve(); else socket.once('close', () => resolve());
});

afterEach(() => { vi.restoreAllMocks(); });

describe('NativePipeSocket', () => {
  it('exposes the peer read at accept', () => {
    const { socket } = socketOver();
    expect(socket.peer).toEqual(PEER);
    socket.destroy();
  });

  it('a peer() that throws destroys the connection and the constructor throws', () => {
    const conn = new FakeConn();
    conn.peerImpl = () => { throw new Error('gone'); };
    expect(() => new NativePipeSocket(conn)).toThrow('gone');
    expect(conn.destroyCalls).toBe(1);
  });

  it('reads nothing until the readable side asks, then keeps one read outstanding', async () => {
    const { conn, socket } = socketOver();
    conn.feed('early');
    await ticks(5);
    expect(conn.readRequests).toBe(0);
    const chunks: string[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c.toString()));
    await ticks(5);
    expect(chunks.join('')).toBe('early');
    conn.feed('later');
    await ticks(5);
    expect(chunks.join('')).toBe('earlylater');
    expect(conn.maxOutstandingReads).toBe(1);
    socket.destroy();
  });

  it('a paused socket stops requesting native reads (bounded buffering)', async () => {
    const { conn, socket } = socketOver();
    conn.feed(Buffer.alloc(10 * 1024 * 1024, 0x61));
    socket.pause();
    socket.on('data', noop);
    socket.pause();
    socket.read(0);
    await ticks(50);
    const reads = conn.readRequests;
    await ticks(50);
    expect(conn.readRequests).toBe(reads);
    // At most the highWaterMark plus one native read buffered in memory.
    expect(conn.bytesRead).toBeLessThanOrEqual(socket.readableHighWaterMark + 2 * NATIVE_PIPE_READ_SIZE);
    let total = 0;
    socket.on('data', (c: Buffer) => { total += c.length; });
    socket.resume();
    await vi.waitFor(() => expect(total).toBe(10 * 1024 * 1024), { timeout: 10_000, interval: 5 });
    socket.destroy();
  });

  it('pause, unshift and a later data listener: the broker handshake sequence', async () => {
    const { conn, socket } = socketOver();
    let buffer = Buffer.alloc(0);
    const handshake = new Promise<Buffer>((resolve) => {
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const nl = buffer.indexOf(0x0a);
        if (nl === -1) return;
        socket.removeListener('data', onData);
        socket.pause();
        resolve(buffer.subarray(nl + 1));
      };
      socket.on('data', onData);
    });
    conn.feed('{"wmuxShim":1}\n{"jsonrpc":"2.0","id":1}\n');
    const rest = await handshake;
    expect(rest.toString()).toBe('{"jsonrpc":"2.0","id":1}\n');

    // The transport attaches its listener while the socket is paused, and more
    // bytes arrive meanwhile: none may flow before resume().
    const seen: string[] = [];
    socket.on('data', (c: Buffer) => seen.push(c.toString()));
    conn.feed('{"jsonrpc":"2.0","id":2}\n');
    await ticks(10);
    expect(seen).toEqual([]);
    expect(socket.isPaused()).toBe(true);

    socket.unshift(rest);
    socket.resume();
    await vi.waitFor(() => expect(seen.join('')).toBe('{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n'), { timeout: 5_000 });
    socket.destroy();
  });

  it('StdioServerTransport usage: on/off data and error, listenerCount, pause', async () => {
    const { conn, socket } = socketOver();
    const onData = vi.fn();
    const onError = vi.fn();
    socket.on('data', onData);
    socket.on('error', onError);
    expect(socket.listenerCount('data')).toBe(1);
    conn.feed('x');
    await vi.waitFor(() => expect(onData).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    socket.off('data', onData);
    socket.off('error', onError);
    expect(socket.listenerCount('data')).toBe(0);
    socket.pause();
    conn.feed('y');
    await ticks(10);
    expect(onData).toHaveBeenCalledTimes(1);
    socket.destroy();
  });

  it('carries the SDK StdioServerTransport both ways, with send() waiting out a drain', async () => {
    const { conn, socket } = socketOver();
    const transport = new StdioServerTransport(socket, socket);
    const messages: unknown[] = [];
    transport.onmessage = (m) => { messages.push(m); };
    await transport.start();
    conn.feed('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await vi.waitFor(() => expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }]), { timeout: 5_000 });
    conn.holdWrites = true;
    const big = 'x'.repeat(socket.writableHighWaterMark * 2);
    let sent = false;
    const send = transport.send({ jsonrpc: '2.0', id: 1, result: { big } }).then(() => { sent = true; });
    await ticks(10);
    expect(sent).toBe(false);
    conn.completeWrites();
    await send;
    expect(JSON.parse(conn.receivedText)).toEqual({ jsonrpc: '2.0', id: 1, result: { big } });
    await transport.close();
    expect(socket.listenerCount('data')).toBe(0);
    expect(socket.isPaused()).toBe(true);
    socket.destroy();
  });

  it('write() returns false past the high-water mark; drain and its callback wait for the native ack', async () => {
    const { conn, socket } = socketOver();
    conn.holdWrites = true;
    const big = Buffer.alloc(socket.writableHighWaterMark + 1, 0x62);
    const written = vi.fn();
    const drained = vi.fn();
    expect(socket.write(big, written)).toBe(false);
    socket.once('drain', drained);
    await ticks(10);
    expect(written).not.toHaveBeenCalled();
    expect(drained).not.toHaveBeenCalled();
    conn.completeWrites();
    await vi.waitFor(() => expect(drained).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(written).toHaveBeenCalledTimes(1);
    expect(written.mock.calls[0][0] ?? null).toBeNull();
    expect(conn.received.reduce((n, b) => n + b.length, 0)).toBe(big.length);
    socket.destroy();
  });

  it('writes buffered behind an outstanding one go out as one native write, in order', async () => {
    const { conn, socket } = socketOver();
    conn.holdWrites = true;
    socket.write('a');
    socket.write('b');
    socket.write('c');
    await tick();
    conn.completeWrites();
    await ticks(5);
    conn.completeWrites();
    await vi.waitFor(() => expect(conn.receivedText).toBe('abc'), { timeout: 5_000 });
    expect(conn.received.length).toBeLessThanOrEqual(2);
    socket.destroy();
  });

  it('end(data, cb) on a paused socket: cb after the native close, then close', async () => {
    const { conn, socket } = socketOver();
    socket.pause();
    conn.holdEnd = true;
    const order: string[] = [];
    const cb = vi.fn((err?: Error | null) => { order.push(`cb:${err ? err.message : 'ok'}`); socket.destroy(); });
    socket.on('close', () => order.push('close'));
    socket.end('{"wmuxBroker":1,"ok":false}\n', cb);
    await ticks(10);
    expect(conn.receivedText).toBe('{"wmuxBroker":1,"ok":false}\n');
    expect(conn.endCalled).toBe(true);
    expect(cb).not.toHaveBeenCalled();
    conn.releaseEnd();
    await closeOf(socket);
    expect(order).toEqual(['cb:ok', 'close']);
    expect(conn.destroyCalls).toBeGreaterThanOrEqual(1);
  });

  it('end() with no callback still closes the socket once the native side closed', async () => {
    const { conn, socket } = socketOver();
    socket.pause();
    socket.end('bye');
    await closeOf(socket);
    expect(conn.closed()).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it('EOF from the client: end, then (allowHalfOpen false) the socket ends and closes', async () => {
    const { conn, socket } = socketOver();
    const events: string[] = [];
    socket.on('data', () => events.push('data'));
    socket.on('end', () => events.push('end'));
    socket.on('close', () => events.push('close'));
    conn.feed('last');
    conn.clientEnd();
    await closeOf(socket);
    expect(events).toEqual(['data', 'end', 'close']);
    expect(conn.endCalled).toBe(true);
  });

  it('EOF while paused: end and close follow the resume', async () => {
    const { conn, socket } = socketOver();
    socket.on('data', noop);
    socket.pause();
    conn.clientEnd();
    await ticks(10);
    const end = vi.fn();
    socket.on('end', end);
    expect(end).not.toHaveBeenCalled();
    socket.resume();
    await closeOf(socket);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('a native error destroys the socket with it and fails the pending write callbacks', async () => {
    const { conn, socket } = socketOver();
    conn.holdWrites = true;
    const onError = vi.fn();
    socket.on('error', onError);
    const written = vi.fn();
    socket.write('lost', written);
    await tick();
    conn.fail('ERROR_NO_DATA');
    await closeOf(socket);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toContain('ERROR_NO_DATA');
    expect(written).toHaveBeenCalledTimes(1);
    expect(written.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(conn.destroyCalls).toBe(1);
  });

  it('a bare destroy() with a write in flight: the write fails, no error event, close', async () => {
    const { conn, socket } = socketOver();
    conn.holdWrites = true;
    const written = vi.fn();
    const onError = vi.fn();
    socket.write('x', written);
    await tick();
    socket.on('error', onError);
    socket.destroy();
    await closeOf(socket);
    await ticks(5);
    expect(onError).not.toHaveBeenCalled();
    expect(written).toHaveBeenCalledTimes(1);
    expect(written.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('a bare destroy() with end() in flight: no error event, close', async () => {
    const { conn, socket } = socketOver();
    conn.holdEnd = true;
    const onError = vi.fn();
    const ended = vi.fn();
    socket.end('x', ended);
    await ticks(5);
    expect(conn.endCalled).toBe(true);
    socket.on('error', onError);
    socket.destroy();
    await closeOf(socket);
    await ticks(5);
    expect(onError).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('a throwing requestRead destroys the socket with the error', async () => {
    const { conn, socket } = socketOver();
    conn.requestReadImpl = () => { throw new Error('read failed'); };
    const onError = vi.fn();
    socket.on('error', onError);
    socket.resume();
    await closeOf(socket);
    expect((onError.mock.calls[0][0] as Error).message).toBe('read failed');
  });

  it('destroy(): destroyed, the native destroy, close, and an idempotent second call', async () => {
    const { conn, socket } = socketOver();
    socket.on('data', noop);
    socket.destroy();
    socket.destroy();
    expect(socket.destroyed).toBe(true);
    await closeOf(socket);
    expect(conn.destroyCalls).toBe(1);
    // A late wake on a destroyed socket is a no-op.
    expect(() => socket.pump()).not.toThrow();
  });
});

class FakeListener implements NativePipeListener {
  pending: FakeConn[] = [];
  failed: string | null = null;
  closeCalls = 0;
  constructor(readonly notify: () => void) {}
  accept(conn = new FakeConn()): FakeConn {
    conn.wake = this.notify;
    this.pending.push(conn);
    setImmediate(this.notify);
    return conn;
  }
  takeAccepted(): FakeConn | null { return this.pending.shift() ?? null; }
  failure(): string | null { return this.failed; }
  close(): void { this.closeCalls++; }
}

function fakeModule(): { module: NativePipeModule; listeners: FakeListener[]; names: Array<[string, number]> } {
  const listeners: FakeListener[] = [];
  const names: Array<[string, number]> = [];
  const module: NativePipeModule = {
    NativePipeListener: function NativePipeListener(name: string, max: number, notify: () => void) {
      names.push([name, max]);
      const l = new FakeListener(notify);
      listeners.push(l);
      return l;
    } as unknown as NativePipeModule['NativePipeListener'],
  };
  return { module, listeners, names };
}

describe('listenNativePipe', () => {
  it('hands each accepted connection on as a socket, and one wake serves them all', async () => {
    const { module, listeners, names } = fakeModule();
    const sockets: NativePipeSocket[] = [];
    const server = listenNativePipe('\\\\.\\pipe\\test', { maxInstances: 4, module, onConnection: (s) => sockets.push(s) });
    expect(names).toEqual([['\\\\.\\pipe\\test', 4]]);
    const [listener] = listeners;
    const a = listener.accept();
    const b = listener.accept();
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 5_000 });
    const got: string[] = [];
    sockets[0].on('data', (c: Buffer) => got.push(`a:${c}`));
    sockets[1].on('data', (c: Buffer) => got.push(`b:${c}`));
    a.feed('1');
    b.feed('2');
    await vi.waitFor(() => expect(got.sort()).toEqual(['a:1', 'b:2']), { timeout: 5_000 });
    server.close();
    for (const s of sockets) s.destroy();
  });

  it('connections stay served after close(); un-handed ones close with it', async () => {
    const { module, listeners } = fakeModule();
    const sockets: NativePipeSocket[] = [];
    const server = listenNativePipe('p', { maxInstances: 2, module, onConnection: (s) => sockets.push(s) });
    const [listener] = listeners;
    const live = listener.accept();
    await vi.waitFor(() => expect(sockets).toHaveLength(1), { timeout: 5_000 });
    const orphan = new FakeConn();
    listener.pending.push(orphan);
    server.close();
    server.close();
    expect(listener.closeCalls).toBe(1);
    expect(orphan.destroyCalls).toBe(1);
    const got: string[] = [];
    sockets[0].on('data', (c: Buffer) => got.push(c.toString()));
    live.feed('after close');
    await vi.waitFor(() => expect(got.join('')).toBe('after close'), { timeout: 5_000 });
    sockets[0].destroy();
  });

  it('an onConnection that throws costs only its own socket: the wake drains and pumps the rest', async () => {
    const { module, listeners } = fakeModule();
    const delivered: NativePipeSocket[] = [];
    const errors: unknown[] = [];
    let throwNext = false;
    const server = listenNativePipe('p', {
      maxInstances: 4, module, onConnectionError: (e) => errors.push(e),
      onConnection: (s) => {
        if (throwNext) { throwNext = false; throw new Error('handler failed'); }
        delivered.push(s);
      },
    });
    const [listener] = listeners;
    const live = listener.accept();
    await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 5_000 });
    const got: string[] = [];
    delivered[0].on('data', (c: Buffer) => got.push(c.toString()));
    await ticks(5);

    // Everything below rides on ONE wake: the live read completes and two
    // connections are queued, none of them waking on their own.
    live.wake = noop;
    live.feed('pending read');
    const first = new FakeConn();
    const second = new FakeConn();
    first.wake = noop;
    second.wake = noop;
    listener.pending.push(first, second);
    throwNext = true;
    expect(() => listener.notify()).not.toThrow();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('handler failed');
    expect(first.destroyCalls).toBe(1);
    expect(delivered).toHaveLength(2);
    expect(delivered[1].peer).toEqual(PEER);
    expect(second.destroyCalls).toBe(0);
    expect(got.join('')).toBe('pending read');
    for (const s of delivered) s.destroy();
    server.close();
  });

  it('without onConnectionError a throwing onConnection is logged, not thrown', () => {
    const { module, listeners } = fakeModule();
    const log = vi.spyOn(console, 'error').mockImplementation(noop);
    const server = listenNativePipe('p', { maxInstances: 2, module, onConnection: () => { throw new Error('boom'); } });
    const conn = new FakeConn();
    conn.wake = noop;
    listeners[0].pending.push(conn);
    expect(() => listeners[0].notify()).not.toThrow();
    expect(conn.destroyCalls).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    server.close();
  });

  it('reports a failure once and exposes it', async () => {
    const { module, listeners } = fakeModule();
    const onFailure = vi.fn();
    const server = listenNativePipe('p', { maxInstances: 2, module, onConnection: noop, onFailure });
    const [listener] = listeners;
    listener.failed = 'next instance: ERROR_ACCESS_DENIED';
    listener.notify();
    listener.notify();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith('next instance: ERROR_ACCESS_DENIED');
    expect(server.failure).toBe('next instance: ERROR_ACCESS_DENIED');
    server.close();
  });

  it('skips a connection whose peer cannot be read', async () => {
    const { module, listeners } = fakeModule();
    const onConnection = vi.fn();
    const server = listenNativePipe('p', { maxInstances: 2, module, onConnection });
    const conn = new FakeConn();
    conn.peerImpl = () => { throw new Error('gone'); };
    listeners[0].accept(conn);
    listeners[0].accept();
    await vi.waitFor(() => expect(onConnection).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(conn.destroyCalls).toBe(1);
    (onConnection.mock.calls[0][0] as NativePipeSocket).destroy();
    server.close();
  });

  it('1,000 connections opened and closed leave no socket pumped and no listener behind', async () => {
    const { module, listeners } = fakeModule();
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on('warning', onWarning);
    try {
      let closed = 0;
      const server = listenNativePipe('p', {
        maxInstances: 8, module, onConnection: (s) => {
          s.on('data', noop);
          s.on('error', noop);
          s.once('close', () => { closed++; });
        },
      });
      const [listener] = listeners;
      for (let i = 0; i < 1000; i++) {
        const conn = listener.accept();
        conn.feed(`hello ${i}\n`);
        conn.clientEnd();
        if (i % 50 === 49) await vi.waitFor(() => expect(closed).toBe(i + 1), { timeout: 5_000, interval: 2 });
      }
      await vi.waitFor(() => expect(closed).toBe(1000), { timeout: 5_000, interval: 2 });
      const pump = vi.spyOn(NativePipeSocket.prototype, 'pump');
      listener.notify();
      expect(pump).not.toHaveBeenCalled();
      server.close();
      expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
  });
});

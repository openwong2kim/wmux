import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { SessionPipe } from '../SessionPipe';
import { generateSnapshotUnqueued } from '../HeadlessSnapshot';
import { createSessionPipeMarkers } from '../sessionPipeMarkers';
import type { RingBuffer } from '../RingBuffer';

/**
 * #3440: every full-ring read of the session pipe (attach flush, re-flush)
 * can be refused by the native ring (`ALLOC_FAILED: ...`). The pipe still
 * ends its replay with the flush-done marker, so the client goes live with
 * less history, and nothing escapes; a re-flush whose first read is refused
 * declines before it announces anything. Output the client lacks because a
 * re-read was refused is never lost: it is replayed from what the pipe holds,
 * or the pipe pauses live output and asks for a re-flush.
 */
vi.mock('../HeadlessSnapshot', async (importOriginal) => ({
  ...await importOriginal<typeof import('../HeadlessSnapshot')>(),
  generateSnapshotUnqueued: vi.fn(),
}));

const TOKEN = 'test-token';
const markers = createSessionPipeMarkers(TOKEN);
const refusal = () => new Error('ALLOC_FAILED: could not allocate 8388608 bytes for ring copy');

class FakeSocket {
  destroyed = false;
  writableLength = 0;
  writes: Buffer[] = [];
  write(data: Buffer): boolean { this.writes.push(Buffer.from(data)); return true; }
  destroy(): void { this.destroyed = true; }
  text(): string { return Buffer.concat(this.writes).toString('latin1'); }
}

type FakeRing = RingBuffer & { grow(n: number): void };

/**
 * A ring whose reads follow `reads`: a string is returned, an Error thrown.
 * `resized` adds a size change, which sends the attach flush through the
 * snapshot however small the ring is; `grow` counts live output.
 */
function fakeRing(reads: Array<string | Error>, resized = false): FakeRing {
  let written = 0;
  const geometry = resized ? { start: { cols: 80, rows: 24 }, changes: [{ offset: 0, cols: 100, rows: 30 }] } : undefined;
  return {
    size: 16,
    hasGeometryChanges: resized,
    get totalBytesWritten() { return written; },
    grow(n: number) { written += n; },
    settleGeometry: () => undefined,
    readAllWithGeometry: () => {
      const next = reads.shift() ?? '';
      if (next instanceof Error) throw next;
      written = Math.max(written, next.length);
      return { data: Buffer.from(next, 'latin1'), geometry, writtenAt: written };
    },
  } as unknown as FakeRing;
}

function connect(pipe: SessionPipe, socket: FakeSocket, flushed: boolean): void {
  const internal = pipe as unknown as { client: unknown; flushed: boolean };
  internal.client = socket as unknown as net.Socket;
  internal.flushed = flushed;
}

function flush(pipe: SessionPipe, socket: FakeSocket): Promise<void> {
  return (pipe as unknown as { flushRingBufferInSlot(s: net.Socket): Promise<void> }).flushRingBufferInSlot(socket as unknown as net.Socket);
}

const noTee = { on: () => undefined, removeListener: () => undefined };

describe('SessionPipe: a refused native ring read', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('attach flush: no history, but the flush-done marker, and the client goes live', async () => {
    const pipe = new SessionPipe('session-a', fakeRing([refusal()]), TOKEN);
    const socket = new FakeSocket();
    connect(pipe, socket, false);
    await expect(flush(pipe, socket)).resolves.toBeUndefined();
    expect(socket.text()).toBe(markers.flushDone.toString('latin1'));
    expect(pipe.isFlushed).toBe(true);
    expect(socket.destroyed).toBe(false);
    expect(String(errors.mock.calls[0]?.[0])).toMatch(/session-pipe session=session-a: ALLOC_FAILED: .*attach flush: ring not read/);
  });

  it('attach flush: with no history, the mode preamble still puts the client in the stream\'s modes', async () => {
    const preamble = vi.fn(() => '\x1b[?1049h\x1b[2J\x1b[H');
    const pipe = new SessionPipe('session-e', fakeRing([refusal()]), TOKEN, undefined, () => ({ preamble }));
    const socket = new FakeSocket();
    connect(pipe, socket, false);
    await flush(pipe, socket);
    expect(socket.text()).toBe('\x1b[?1049h\x1b[2J\x1b[H' + markers.flushDone.toString('latin1'));
    expect(pipe.isFlushed).toBe(true);
  });

  it('re-flush: a refused first read declines before announcing, and the client stays live', async () => {
    const pipe = new SessionPipe('session-b', fakeRing([refusal()]), TOKEN);
    const socket = new FakeSocket();
    connect(pipe, socket, true);
    const generate = vi.fn();
    await expect(pipe.reflush({ bridge: noTee, cols: 80, rows: 24, generate })).rejects.toThrow(/^ALLOC_FAILED: /);
    expect(generate).not.toHaveBeenCalled();
    expect(socket.writes).toEqual([]);
    expect(pipe.isFlushed).toBe(true);
  });

  it('re-flush: a refused raw re-read still ends the re-flush, keeping the client screen (no RIS)', async () => {
    const pipe = new SessionPipe('session-c', fakeRing(['history', refusal()]), TOKEN);
    const socket = new FakeSocket();
    connect(pipe, socket, true);
    const generate = vi.fn(async () => ({ ok: false as const, reason: 'budget' }));
    await expect(pipe.reflush({ bridge: noTee, cols: 80, rows: 24, generate })).resolves.toEqual({ mode: 'raw', fallbackReason: 'budget' });
    expect(socket.text()).toBe(markers.resyncBegin.toString('latin1') + markers.flushDone.toString('latin1'));
    expect(pipe.isFlushed).toBe(true);
  });

  it('re-flush: with the raw re-read refused, the bytes teed since T0 reach the client in order, drained or not', async () => {
    const pipe = new SessionPipe('session-f', fakeRing(['history', refusal()]), TOKEN);
    const socket = new FakeSocket();
    connect(pipe, socket, true);
    const bridge = new EventEmitter();
    const generate = vi.fn(async (req: { drainQueue: () => Buffer[] }) => {
      bridge.emit('data', Buffer.from('one '));
      bridge.emit('data', Buffer.from('two '));
      // The generator consumed these before it failed.
      expect(Buffer.concat(req.drainQueue()).toString()).toBe('one two ');
      bridge.emit('data', Buffer.from('three'));
      return { ok: false as const, reason: 'error' };
    });
    await expect(pipe.reflush({ bridge, cols: 80, rows: 24, generate })).resolves.toEqual({ mode: 'raw', fallbackReason: 'error' });
    expect(socket.text()).toBe(markers.resyncBegin.toString('latin1') + 'one two three' + markers.flushDone.toString('latin1'));
    expect(pipe.isFlushed).toBe(true);
    expect(pipe.isBehind).toBe(false);
    expect(bridge.listenerCount('data')).toBe(0);
    // Live output follows directly.
    pipe.writeToClient(Buffer.from(' four'));
    expect(socket.text().endsWith(markers.flushDone.toString('latin1') + ' four')).toBe(true);
  });

  it('re-flush of a pipe that was behind: a refused raw re-read stays behind and asks for another re-flush', async () => {
    const pipe = new SessionPipe('session-g', fakeRing(['history', refusal()]), TOKEN);
    const asks = vi.fn();
    pipe.onResyncNeeded = asks;
    const socket = new FakeSocket();
    connect(pipe, socket, true);
    (pipe as unknown as { behind: boolean }).behind = true;
    const generate = vi.fn(async () => ({ ok: false as const, reason: 'budget' }));
    await pipe.reflush({ bridge: noTee, cols: 80, rows: 24, generate });
    expect(pipe.isFlushed).toBe(true);
    expect(pipe.isBehind).toBe(true);
    expect(asks).toHaveBeenCalledWith(1);
    await pipe.stop();
  });

  describe('attach flush: a refused re-read after the parse', () => {
    const snapshot = vi.mocked(generateSnapshotUnqueued);
    const dims = () => ({ cols: 80, rows: 24 });
    afterEach(() => snapshot.mockReset());

    it.each([
      ['the snapshot came out (its live delta re-read refused)', { ok: true as const, payload: Buffer.from('SNAPSHOT'), bytesIn: 7, durationMs: 1 }, 'SNAPSHOT'],
      ['the snapshot failed (the raw re-read refused)', { ok: false as const, reason: 'error' as const, detail: 'x' }, 'history'],
    ])('when %s: ships what it holds, then pauses live output and asks for a re-flush', async (_what, outcome, shipped) => {
      const ring = fakeRing(['history', refusal()], true);
      const pipe = new SessionPipe('session-h', ring, TOKEN, dims);
      const asks = vi.fn();
      pipe.onResyncNeeded = asks;
      const socket = new FakeSocket();
      connect(pipe, socket, false);
      snapshot.mockImplementation(async () => {
        ring.grow(5); // output during the parse, which the client must not lose
        return outcome;
      });
      await flush(pipe, socket);
      const done = markers.flushDone.toString('latin1');
      expect(socket.text()).toBe(shipped + done);
      expect(pipe.isFlushed).toBe(true);
      expect(pipe.isBehind).toBe(true);
      expect(asks).toHaveBeenCalledWith(1);
      // Live output waits for the re-flush, which repaints from the ring.
      pipe.writeToClient(Buffer.from('live'));
      expect(socket.text()).toBe(shipped + done);
      ring.readAllWithGeometry = () => ({ data: Buffer.from('history+delta'), geometry: undefined, writtenAt: 12 });
      await pipe.reflush({ bridge: noTee, cols: 80, rows: 24, generate: async () => ({ ok: false, reason: 'budget' }) });
      expect(pipe.isBehind).toBe(false);
      expect(socket.text().endsWith('\x1bchistory+delta' + done)).toBe(true);
      await pipe.stop();
    });

    it.each([
      ['the snapshot came out', { ok: true as const, payload: Buffer.from('SNAPSHOT'), bytesIn: 7, durationMs: 1 }, 'SNAPSHOT'],
      ['the snapshot failed', { ok: false as const, reason: 'error' as const, detail: 'x' }, 'history'],
    ])('when %s and no output arrived during the parse: nothing was lost, so live output goes on', async (_what, outcome, shipped) => {
      const ring = fakeRing(['history', refusal()], true);
      const pipe = new SessionPipe('session-j', ring, TOKEN, dims);
      const asks = vi.fn();
      pipe.onResyncNeeded = asks;
      const socket = new FakeSocket();
      connect(pipe, socket, false);
      snapshot.mockResolvedValue(outcome);
      await flush(pipe, socket);
      expect(socket.text()).toBe(shipped + markers.flushDone.toString('latin1'));
      expect(pipe.isBehind).toBe(false);
      expect(asks).not.toHaveBeenCalled();
      pipe.writeToClient(Buffer.from('live'));
      expect(socket.text().endsWith('live')).toBe(true);
    });

    it('a re-read that succeeds asks for nothing', async () => {
      const ring = fakeRing(['history', 'history+delta'], true);
      const pipe = new SessionPipe('session-i', ring, TOKEN, dims);
      const asks = vi.fn();
      pipe.onResyncNeeded = asks;
      const socket = new FakeSocket();
      connect(pipe, socket, false);
      snapshot.mockResolvedValue({ ok: false, reason: 'error', detail: 'x' });
      await flush(pipe, socket);
      expect(socket.text()).toBe('history+delta' + markers.flushDone.toString('latin1'));
      expect(pipe.isBehind).toBe(false);
      expect(asks).not.toHaveBeenCalled();
    });
  });

  it('any other read error still propagates', async () => {
    const pipe = new SessionPipe('session-d', fakeRing([new Error('Ring disposed')]), TOKEN);
    const socket = new FakeSocket();
    connect(pipe, socket, false);
    await expect(flush(pipe, socket)).rejects.toThrow('Ring disposed');
  });
});

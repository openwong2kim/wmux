import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import { SessionPipe } from '../SessionPipe';
import { generateSnapshotUnqueued } from '../HeadlessSnapshot';
import { createSessionPipeMarkers } from '../sessionPipeMarkers';
import { RingBuffer } from '../RingBuffer';
import { ATTACH_SNAPSHOT_MIN_BYTES } from '../../shared/terminal/attachSnapshot';
import { nativeAllocError } from '../../shared/__tests__/_nativeAllocError';

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
const refusal = () => nativeAllocError('ALLOC_FAILED: could not allocate 8388608 bytes for ring copy');

class FakeSocket {
  destroyed = false;
  writableLength = 0;
  writes: Buffer[] = [];
  write(data: Buffer): boolean { this.writes.push(Buffer.from(data)); return true; }
  destroy(): void { this.destroyed = true; }
  text(): string { return Buffer.concat(this.writes).toString('latin1'); }
}

type FakeRing = RingBuffer & { grow(n: number): void; wipe(): void };

/**
 * A ring whose reads follow `reads`: a string is returned, an Error thrown.
 * `resized` adds a size change, which sends the attach flush through the
 * snapshot however small the ring is; `grow` counts live output, `wipe`
 * is a clear() (the history restarts, the lifetime counter stays).
 */
function fakeRing(reads: Array<string | Error>, resized = false): FakeRing {
  let written = 0;
  let clears = 0;
  const geometry = resized ? { start: { cols: 80, rows: 24 }, changes: [{ offset: 0, cols: 100, rows: 30 }] } : undefined;
  return {
    size: 16,
    hasGeometryChanges: resized,
    get totalBytesWritten() { return written; },
    grow(n: number) { written += n; },
    get clearGeneration() { return clears; },
    wipe() { clears++; },
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

  it('re-flush: a refused raw re-read with no output since T0 ends with an empty replay and goes live, asking for nothing', async () => {
    const pipe = new SessionPipe('session-c', fakeRing(['history', refusal()]), TOKEN);
    const asks = vi.fn();
    pipe.onResyncNeeded = asks;
    const socket = new FakeSocket();
    connect(pipe, socket, true);
    const generate = vi.fn(async () => ({ ok: false as const, reason: 'budget' }));
    await expect(pipe.reflush({ bridge: noTee, cols: 80, rows: 24, generate })).resolves.toEqual({ mode: 'raw', fallbackReason: 'budget' });
    // No bytes between the markers (an empty replay: the renderer keeps its screen).
    expect(socket.text()).toBe(markers.resyncBegin.toString('latin1') + markers.flushDone.toString('latin1'));
    expect(pipe.isFlushed).toBe(true);
    expect(pipe.isBehind).toBe(false);
    expect(asks).not.toHaveBeenCalled();
    pipe.writeToClient(Buffer.from('live'));
    expect(socket.text().endsWith(markers.flushDone.toString('latin1') + 'live')).toBe(true);
  });

  it('re-flush: a refused raw re-read with output since T0 writes no bytes before the flush-done marker, pauses live output and asks for a re-flush', async () => {
    const ring = fakeRing(['history', refusal()]);
    const pipe = new SessionPipe('session-f', ring, TOKEN);
    const asks = vi.fn();
    pipe.onResyncNeeded = asks;
    const socket = new FakeSocket();
    connect(pipe, socket, true);
    const bridge = new EventEmitter();
    const generate = vi.fn(async (req: { drainQueue: () => Buffer[] }) => {
      // Output while the generator runs: it reaches the ring and the tee.
      ring.grow(8);
      bridge.emit('data', Buffer.from('one two '));
      expect(Buffer.concat(req.drainQueue()).toString()).toBe('one two ');
      ring.grow(5);
      bridge.emit('data', Buffer.from('three'));
      return { ok: false as const, reason: 'error' };
    });
    await expect(pipe.reflush({ bridge, cols: 80, rows: 24, generate })).resolves.toEqual({ mode: 'raw', fallbackReason: 'error' });
    const done = markers.flushDone.toString('latin1');
    expect(socket.text()).toBe(markers.resyncBegin.toString('latin1') + done);
    expect(pipe.isFlushed).toBe(true);
    expect(pipe.isBehind).toBe(true);
    expect(asks).toHaveBeenCalledWith(1);
    expect(bridge.listenerCount('data')).toBe(0);
    // Live output waits for the re-flush, which repaints from the ring.
    pipe.writeToClient(Buffer.from('four'));
    expect(socket.text()).toBe(markers.resyncBegin.toString('latin1') + done);
    ring.readAllWithGeometry = () => ({ data: Buffer.from('history one two three'), geometry: undefined, writtenAt: 20 });
    await pipe.reflush({ bridge: noTee, cols: 80, rows: 24, generate: async () => ({ ok: false, reason: 'budget' }) });
    expect(pipe.isBehind).toBe(false);
    expect(socket.text().endsWith('\x1bchistory one two three' + done)).toBe(true);
    await pipe.stop();
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

    it.each([
      [true, 'output arrived during the parse: asks for a re-flush'],
      [false, 'nothing arrived during the parse: live output goes on'],
    ])('no-gain snapshot (a large ring, no size change), raw re-read refused, %s', async (grew) => {
      // Past the snapshot threshold, and a snapshot no smaller than the raw
      // bytes: the no-gain branch, which ships raw after a re-read.
      const history = 'h'.repeat(ATTACH_SNAPSHOT_MIN_BYTES);
      const ring = fakeRing([history, refusal()]);
      const pipe = new SessionPipe('session-k', ring, TOKEN, dims);
      const asks = vi.fn();
      pipe.onResyncNeeded = asks;
      const socket = new FakeSocket();
      connect(pipe, socket, false);
      snapshot.mockImplementation(async () => {
        if (grew) ring.grow(5);
        return { ok: true, payload: Buffer.alloc(ATTACH_SNAPSHOT_MIN_BYTES + 1, 0x73), bytesIn: history.length, durationMs: 1 };
      });
      await flush(pipe, socket);
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(socket.text()).toBe(history + markers.flushDone.toString('latin1'));
      expect(pipe.isBehind).toBe(grew);
      expect(asks).toHaveBeenCalledTimes(grew ? 1 : 0);
      await pipe.stop();
    });

    // A clear alone does not move the lifetime counter: the clear generation
    // tells the history changed, and a re-flush repaints the cleared ring.
    it.each([
      ['the snapshot came out (its live delta re-read refused)', { ok: true as const, payload: Buffer.from('SNAPSHOT'), bytesIn: 7, durationMs: 1 }, 'SNAPSHOT'],
      ['the snapshot failed (the raw re-read refused)', { ok: false as const, reason: 'error' as const, detail: 'x' }, 'history'],
    ])('when %s and the ring was cleared during the parse: asks for a re-flush', async (_what, outcome, shipped) => {
      const ring = fakeRing(['history', refusal()], true);
      const pipe = new SessionPipe('session-m', ring, TOKEN, dims);
      const asks = vi.fn();
      pipe.onResyncNeeded = asks;
      const socket = new FakeSocket();
      connect(pipe, socket, false);
      snapshot.mockImplementation(async () => {
        ring.wipe();
        return outcome;
      });
      await flush(pipe, socket);
      expect(socket.text()).toBe(shipped + markers.flushDone.toString('latin1'));
      expect(pipe.isBehind).toBe(true);
      expect(asks).toHaveBeenCalledWith(1);
      await pipe.stop();
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

  it('re-flush: a refused raw re-read after the ring was cleared since T0 asks for a re-flush', async () => {
    const ring = fakeRing(['history', refusal()]);
    const pipe = new SessionPipe('session-n', ring, TOKEN);
    const asks = vi.fn();
    pipe.onResyncNeeded = asks;
    const socket = new FakeSocket();
    connect(pipe, socket, true);
    const generate = vi.fn(async () => { ring.wipe(); return { ok: false as const, reason: 'budget' }; });
    await pipe.reflush({ bridge: noTee, cols: 80, rows: 24, generate });
    expect(socket.text()).toBe(markers.resyncBegin.toString('latin1') + markers.flushDone.toString('latin1'));
    expect(pipe.isBehind).toBe(true);
    expect(asks).toHaveBeenCalledWith(1);
    await pipe.stop();
  });

  it('any other read error still propagates', async () => {
    const pipe = new SessionPipe('session-d', fakeRing([new Error('Ring disposed')]), TOKEN);
    const socket = new FakeSocket();
    connect(pipe, socket, false);
    await expect(flush(pipe, socket)).rejects.toThrow('Ring disposed');
  });
});

/**
 * #3440: the bridge clears the ring after a chunk the ring refused (its
 * history restarts after the hole) without moving the lifetime counter. An
 * attach flush that locates the bytes that arrived during its parse by that
 * counter must not splice a snapshot of the history before the clear onto
 * bytes written after it.
 */
describe('SessionPipe attach flush: the ring cleared during the parse', () => {
  const snapshot = vi.mocked(generateSnapshotUnqueued);
  const dims = () => ({ cols: 80, rows: 24 });
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { snapshot.mockReset(); vi.restoreAllMocks(); });

  it.each([
    [true, 'ships the fresh full read, no splice'],
    [false, 'splices the live delta onto the snapshot as before'],
  ])('cleared=%s: %s', async (cleared) => {
    const history = 'h'.repeat(ATTACH_SNAPSHOT_MIN_BYTES);
    const ring = new RingBuffer(ATTACH_SNAPSHOT_MIN_BYTES * 4, 'node');
    ring.write(Buffer.from(history));
    const pipe = new SessionPipe('session-l', ring, TOKEN, dims);
    const asks = vi.fn();
    pipe.onResyncNeeded = asks;
    const socket = new FakeSocket();
    connect(pipe, socket, false);
    snapshot.mockImplementation(async () => {
      if (cleared) ring.clear(); // a dropped chunk: the history restarts here
      ring.write(Buffer.from('post'));
      return { ok: true, payload: Buffer.from('SNAPSHOT'), bytesIn: history.length, durationMs: 1 };
    });
    await flush(pipe, socket);
    const done = markers.flushDone.toString('latin1');
    expect(socket.text()).toBe((cleared ? 'post' : 'SNAPSHOTpost') + done);
    expect(pipe.isBehind).toBe(false);
    expect(asks).not.toHaveBeenCalled();
    await pipe.stop();
    ring.dispose();
  });
});

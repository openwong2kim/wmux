import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type net from 'node:net';
import { SessionPipe } from '../SessionPipe';
import { createSessionPipeMarkers } from '../sessionPipeMarkers';
import type { RingBuffer } from '../RingBuffer';

/**
 * #3440: every full-ring read of the session pipe (attach flush, re-flush)
 * can be refused by the native ring (`ALLOC_FAILED: ...`). The pipe still
 * ends its replay with the flush-done marker, so the client goes live with
 * less history, and nothing escapes; a re-flush whose first read is refused
 * declines before it announces anything.
 */
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

/** A ring whose reads follow `reads`: a string is returned, an Error thrown. */
function fakeRing(reads: Array<string | Error>): RingBuffer {
  let written = 0;
  return {
    size: 16,
    hasGeometryChanges: false,
    get totalBytesWritten() { return written; },
    settleGeometry: () => undefined,
    readAllWithGeometry: () => {
      const next = reads.shift() ?? '';
      if (next instanceof Error) throw next;
      written = Math.max(written, next.length);
      return { data: Buffer.from(next, 'latin1'), geometry: undefined, writtenAt: written };
    },
  } as unknown as RingBuffer;
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

  it('any other read error still propagates', async () => {
    const pipe = new SessionPipe('session-d', fakeRing([new Error('Ring disposed')]), TOKEN);
    const socket = new FakeSocket();
    connect(pipe, socket, false);
    await expect(flush(pipe, socket)).rejects.toThrow('Ring disposed');
  });
});

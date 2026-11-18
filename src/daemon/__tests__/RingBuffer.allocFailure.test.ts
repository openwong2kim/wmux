import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RingBuffer } from '../RingBuffer';
import { fakeRingModule, refuseNext, resetFakeRing } from './_fakeNativeRing';

/**
 * #3440: a native ring call that refuses an allocation throws
 * `ALLOC_FAILED: ...` and leaves the ring as it was. Output it refuses is
 * counted and dropped for that session only; nothing escapes to the PTY
 * data callback, and no offset moves for the dropped bytes.
 */
vi.mock('../../shared/nativeTerminalCore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../shared/nativeTerminalCore')>(),
  loadNativeTerminalCore: vi.fn(() => fakeRingModule),
}));

describe('RingBuffer (rust): a refused native allocation', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetFakeRing();
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    resetFakeRing();
    vi.restoreAllMocks();
  });

  it('drops a refused write: counted, logged once with the session, offsets unmoved, next write lands', () => {
    const ring = new RingBuffer(1024, 'rust', { label: 'session-a' });
    expect(ring.backend).toBe('rust');
    ring.write(Buffer.from('one '));
    const droppedBefore = RingBuffer.allocDroppedBytes;
    refuseNext('write', 2);
    expect(() => ring.write(Buffer.from('lost-1 '))).not.toThrow();
    expect(() => ring.write(Buffer.from('lost-2 '))).not.toThrow();
    expect(ring.totalBytesWritten).toBe(4);
    expect(ring.readAll().toString()).toBe('one ');
    expect(ring.droppedBytes).toBe(14);
    expect(RingBuffer.allocDroppedBytes - droppedBefore).toBe(14);
    ring.write(Buffer.from('two'));
    expect(ring.readAll().toString()).toBe('one two');
    expect(ring.totalBytesWritten).toBe(7);
    // Rate-limited: two refusals, one line, naming the session and the bytes.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toMatch(/ring session=session-a: ALLOC_FAILED: could not allocate \d+ bytes.*7 bytes of output not stored/);
  });

  it('drops a refused native chunk the same way', () => {
    const ring = new RingBuffer(1024, 'rust');
    const chunk = { text: 'abc', byteLength: 3, readBytes: () => Buffer.from('abc'), dispose: () => undefined };
    refuseNext('writeChunk');
    expect(() => ring.writeNativeChunk(chunk)).not.toThrow();
    expect(ring.droppedBytes).toBe(3);
    expect(ring.size).toBe(0);
    ring.writeNativeChunk(chunk);
    expect(ring.readAll().toString()).toBe('abc');
  });

  it('keeps the previous size when a size mark is refused', () => {
    const ring = new RingBuffer(1024, 'rust');
    ring.noteGeometry(80, 24);
    refuseNext('noteGeometry');
    expect(() => ring.noteGeometry(100, 30)).not.toThrow();
    ring.write(Buffer.from('x'));
    expect(ring.readAllWithGeometry().geometry).toEqual({ start: { cols: 80, rows: 24 }, changes: [] });
  });

  it('makes no frozen copy when freezing is refused, so the caller takes its plain read path', () => {
    const ring = new RingBuffer(1024, 'rust');
    ring.write(Buffer.from('history'));
    refuseNext('freeze');
    expect(ring.freezeNative()).toBeUndefined();
    expect(ring.freezeNative()?.readAll().toString()).toBe('history');
  });

  it('still throws a refused full read: a reader never gets an empty ring for a full one', () => {
    const ring = new RingBuffer(1024, 'rust');
    ring.write(Buffer.from('history'));
    refuseNext('readAll');
    expect(() => ring.readAll()).toThrow(/^ALLOC_FAILED: /);
    refuseNext('readAllWithGeometry');
    expect(() => ring.readAllWithGeometry()).toThrow(/^ALLOC_FAILED: /);
    expect(ring.readAll().toString()).toBe('history');
  });

  it('still throws any other native error from a write', () => {
    const ring = new RingBuffer(1024, 'rust');
    refuseNext('write', new Error('Ring storage poisoned'));
    expect(() => ring.write(Buffer.from('x'))).toThrow('Ring storage poisoned');
    expect(ring.droppedBytes).toBe(0);
  });
});

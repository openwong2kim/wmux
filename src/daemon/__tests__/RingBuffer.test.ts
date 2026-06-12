import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RingBuffer } from '../RingBuffer';

/** Temp files created during tests — cleaned up in afterEach */
const tempFiles: string[] = [];

afterEach(() => {
  for (const f of tempFiles) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // ignore cleanup errors
    }
  }
  tempFiles.length = 0;
});

describe('RingBuffer', () => {
  // 1. Basic write + readAll
  it('stores data and returns it via readAll', () => {
    const rb = new RingBuffer(16);
    const data = Buffer.from('hello');
    rb.write(data);

    const result = rb.readAll();
    expect(result.toString()).toBe('hello');
  });

  // 2. Circular behavior after buffer is full
  it('overwrites oldest data when buffer is full', () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from('ABCDEFGH')); // fills exactly
    expect(rb.size).toBe(8);

    rb.write(Buffer.from('XY')); // overwrites A, B
    const result = rb.readAll();
    expect(result.toString()).toBe('CDEFGHXY');
    expect(rb.size).toBe(8);
  });

  // 3. Write data larger than capacity
  it('keeps only the last capacity bytes when data exceeds capacity', () => {
    const rb = new RingBuffer(4);
    rb.write(Buffer.from('ABCDEFGHIJ')); // 10 bytes, capacity 4
    const result = rb.readAll();
    expect(result.toString()).toBe('GHIJ');
    expect(rb.size).toBe(4);
  });

  // 4. Multiple writes — readAll returns correct order
  it('returns data in correct order after multiple writes', () => {
    const rb = new RingBuffer(10);
    rb.write(Buffer.from('AAA'));
    rb.write(Buffer.from('BBB'));
    rb.write(Buffer.from('CCC'));
    // Total 9 bytes, fits in 10
    expect(rb.readAll().toString()).toBe('AAABBBCCC');

    rb.write(Buffer.from('DDD'));
    // Total would be 12, but capacity is 10 -> wraps
    // Oldest 2 bytes ("AA") lost
    expect(rb.readAll().toString()).toBe('ABBBCCCDDD');
    expect(rb.size).toBe(10);
  });

  // 5. Clear resets state
  it('resets to empty state after clear()', () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from('data'));
    expect(rb.size).toBe(4);

    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.readAll().length).toBe(0);
  });

  // 6. size / totalCapacity properties
  it('reports correct size and totalCapacity', () => {
    const rb = new RingBuffer(32);
    expect(rb.totalCapacity).toBe(32);
    expect(rb.size).toBe(0);

    rb.write(Buffer.from('12345'));
    expect(rb.size).toBe(5);
    expect(rb.totalCapacity).toBe(32);
  });

  // 7. dumpToFile writes buffer contents to disk
  it('dumps buffer contents to a file', async () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from('dump-test-content'));

    const tmpFile = path.join(os.tmpdir(), `wmux-rb-test-${Date.now()}.bin`);
    tempFiles.push(tmpFile);

    await rb.dumpToFile(tmpFile);
    const ondisk = fs.readFileSync(tmpFile);
    expect(ondisk.toString()).toBe('dump-test-content');
  });

  // 8. Empty buffer readAll returns empty Buffer
  it('returns an empty Buffer when nothing has been written', () => {
    const rb = new RingBuffer(16);
    const result = rb.readAll();
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  // Edge: writing zero-length data is a no-op
  it('ignores zero-length writes', () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.alloc(0));
    expect(rb.size).toBe(0);
  });

  // Edge: preserves raw bytes including ANSI escapes
  it('preserves raw bytes including ANSI escape sequences', () => {
    const rb = new RingBuffer(64);
    const ansi = Buffer.from('\x1b[31mRED\x1b[0m');
    rb.write(ansi);
    const result = rb.readAll();
    expect(result.equals(ansi)).toBe(true);
  });

  // Edge: wrap-around with multiple small writes
  it('handles wrap-around correctly with many small writes', () => {
    const rb = new RingBuffer(5);
    // Write one byte at a time: A B C D E F G
    for (const ch of 'ABCDEFG') {
      rb.write(Buffer.from(ch));
    }
    // Last 5 bytes should be CDEFG
    expect(rb.readAll().toString()).toBe('CDEFG');
  });

  // Constructor validation
  it('throws on invalid capacity', () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
    expect(() => new RingBuffer(1.5)).toThrow();
  });

  // readAll returns a copy, not a reference
  it('readAll returns a copy that is independent of internal state', () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from('ABCD'));
    const snapshot = rb.readAll();

    rb.write(Buffer.from('EFGH'));
    // Snapshot should still be 'ABCD'
    expect(snapshot.toString()).toBe('ABCD');
    expect(rb.readAll().toString()).toBe('ABCDEFGH');
  });

  // loadFromFile: round-trip dump → load
  it('loadFromFile restores buffer contents from a dump', async () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from('hello-from-dump'));

    const tmpFile = path.join(os.tmpdir(), `wmux-rb-load-${Date.now()}.bin`);
    tempFiles.push(tmpFile);

    await rb.dumpToFile(tmpFile);

    const restored = RingBuffer.loadFromFile(tmpFile, 64);
    expect(restored.readAll().toString()).toBe('hello-from-dump');
    expect(restored.size).toBe(15);
  });

  // loadFromFile: data larger than capacity keeps only tail
  it('loadFromFile truncates to capacity when file is larger', async () => {
    const rb = new RingBuffer(32);
    rb.write(Buffer.from('A'.repeat(32)));

    const tmpFile = path.join(os.tmpdir(), `wmux-rb-load-big-${Date.now()}.bin`);
    tempFiles.push(tmpFile);

    await rb.dumpToFile(tmpFile);

    const restored = RingBuffer.loadFromFile(tmpFile, 8);
    expect(restored.readAll().toString()).toBe('A'.repeat(8));
    expect(restored.size).toBe(8);
  });

  // ── Lazy growth (idle-memory optimization) ──

  // A large-capacity buffer must NOT commit its full ceiling upfront.
  it('allocates far below the ceiling for a large empty buffer', () => {
    const eightMb = 8 * 1024 * 1024;
    const rb = new RingBuffer(eightMb);
    // Ceiling is reported as the configured capacity...
    expect(rb.totalCapacity).toBe(eightMb);
    // ...but actual committed memory starts tiny (well under 1 MB).
    expect(rb.allocatedBytes).toBeLessThan(1024 * 1024);
    expect(rb.size).toBe(0);
  });

  // Growth kicks in only as data demands it, and never exceeds the ceiling.
  it('grows allocation on demand up to but not beyond the ceiling', () => {
    const cap = 1024 * 1024; // 1 MB ceiling
    const rb = new RingBuffer(cap);
    const initial = rb.allocatedBytes;
    expect(initial).toBeLessThan(cap);

    // Write 300 KB — should force at least one growth step.
    rb.write(Buffer.alloc(300 * 1024, 0x41));
    expect(rb.allocatedBytes).toBeGreaterThan(initial);
    expect(rb.allocatedBytes).toBeLessThanOrEqual(cap);
    expect(rb.size).toBe(300 * 1024);

    // Fill past the ceiling — allocation caps at the ceiling, ring wraps.
    rb.write(Buffer.alloc(cap, 0x42));
    expect(rb.allocatedBytes).toBe(cap);
    expect(rb.size).toBe(cap);
  });

  // Growth must preserve byte order across the reallocation boundary.
  it('preserves data order and content across a growth reallocation', () => {
    const rb = new RingBuffer(1024 * 1024);
    // First chunk fits in the initial allocation.
    rb.write(Buffer.from('HEAD'));
    // Force growth with a chunk larger than the initial allocation.
    const big = Buffer.alloc(200 * 1024, 0x5a); // 'Z' * 200K
    rb.write(big);
    rb.write(Buffer.from('TAIL'));

    const all = rb.readAll();
    expect(all.subarray(0, 4).toString()).toBe('HEAD');
    expect(all.subarray(all.length - 4).toString()).toBe('TAIL');
    expect(all.length).toBe(4 + big.length + 4);
    // Middle is all 'Z'.
    expect(all.subarray(4, 4 + big.length).every((b) => b === 0x5a)).toBe(true);
  });

  // A grown buffer still round-trips through dump → load correctly.
  it('dump/load round-trips a grown buffer by logical contents', async () => {
    const rb = new RingBuffer(1024 * 1024);
    const payload = Buffer.alloc(250 * 1024, 0x37); // '7' * 250K
    rb.write(payload);
    expect(rb.allocatedBytes).toBeGreaterThan(64 * 1024);

    const tmpFile = path.join(os.tmpdir(), `wmux-rb-grow-${Date.now()}.bin`);
    tempFiles.push(tmpFile);
    await rb.dumpToFile(tmpFile);

    const restored = RingBuffer.loadFromFile(tmpFile, 1024 * 1024);
    expect(restored.size).toBe(payload.length);
    expect(restored.readAll().equals(payload)).toBe(true);
  });

  // loadFromFile: empty file produces empty buffer
  it('loadFromFile with empty file produces empty buffer', () => {
    const tmpFile = path.join(os.tmpdir(), `wmux-rb-load-empty-${Date.now()}.bin`);
    tempFiles.push(tmpFile);
    fs.writeFileSync(tmpFile, '');

    const restored = RingBuffer.loadFromFile(tmpFile, 16);
    expect(restored.size).toBe(0);
    expect(restored.readAll().length).toBe(0);
  });
});

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

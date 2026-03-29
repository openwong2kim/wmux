import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../RingBuffer';

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

  // 7. Empty buffer readAll returns empty Buffer
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

});

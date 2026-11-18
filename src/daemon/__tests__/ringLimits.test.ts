// #3351 — a session ring's size in whole bytes, whatever bufferSizeMb says.
import { describe, it, expect } from 'vitest';
import { RING_HARD_CAP_MB, RING_MIN_BYTES, ringBytes } from '../ringLimits';
import { RingBuffer } from '../RingBuffer';

describe('ringBytes', () => {
  it('floors a fraction of a megabyte to whole bytes, which RingBuffer takes', () => {
    expect(ringBytes(0.3, 1)).toBe(314_572);
    expect(() => new RingBuffer(ringBytes(0.3, 1), 'node')).not.toThrow();
    expect(ringBytes(8, 1)).toBe(8 * 1024 * 1024);
  });

  it('keeps it between the smallest ring and the hard cap, and gives a value that is not a finite number the fallback', () => {
    expect(ringBytes(0, 1)).toBe(RING_MIN_BYTES);
    expect(ringBytes(-1, 1)).toBe(RING_MIN_BYTES);
    expect(ringBytes(0.00001, 1)).toBe(RING_MIN_BYTES);
    expect(ringBytes(Number.NaN, 512)).toBe(512);
    expect(ringBytes(Number.POSITIVE_INFINITY, 512)).toBe(512);
    expect(ringBytes(10_000, 1)).toBe(RING_HARD_CAP_MB * 1024 * 1024);
  });
});

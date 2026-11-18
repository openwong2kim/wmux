// #3351 — a session ring's size in whole bytes, whatever bufferSizeMb says.
import { describe, it, expect } from 'vitest';
import { RING_HARD_CAP_MB, RING_MIN_BYTES, ringBytes } from '../ringLimits';
import { RingBuffer } from '../RingBuffer';

describe('ringBytes', () => {
  it('floors a fraction of a megabyte to whole bytes, which RingBuffer takes', () => {
    expect(ringBytes(0.3)).toBe(314_572);
    expect(() => new RingBuffer(ringBytes(0.3), 'node')).not.toThrow();
    expect(ringBytes(8)).toBe(8 * 1024 * 1024);
  });

  it('keeps it between the smallest ring and the hard cap, and gives a value that is not a number the smallest', () => {
    expect(ringBytes(0)).toBe(RING_MIN_BYTES);
    expect(ringBytes(-1)).toBe(RING_MIN_BYTES);
    expect(ringBytes(0.00001)).toBe(RING_MIN_BYTES);
    expect(ringBytes(Number.NaN)).toBe(RING_MIN_BYTES);
    expect(ringBytes(Number.POSITIVE_INFINITY)).toBe(RING_MIN_BYTES);
    expect(ringBytes(10_000)).toBe(RING_HARD_CAP_MB * 1024 * 1024);
  });
});

/**
 * The largest ring a session may have, whatever bufferMaxMb says: config.ts
 * caps bufferSizeMb at it, and the native snapshot takes a ring up to it
 * (nativeSnapshotLimits.ts).
 */
export const RING_HARD_CAP_MB = 256;

/** The smallest ring a session gets: a smaller bufferSizeMb is raised to it. */
export const RING_MIN_BYTES = 64 * 1024;

const MIB = 1024 * 1024;

/**
 * A session ring's size in bytes for a `bufferSizeMb` setting: whole bytes
 * (a fractional megabyte such as 0.3 is not a whole number of bytes, which
 * RingBuffer refuses, and every session create then failed: #3351), at least
 * RING_MIN_BYTES and at most RING_HARD_CAP_MB. A value that is not a finite
 * number gets `fallbackBytes`.
 */
export function ringBytes(bufferSizeMb: number, fallbackBytes: number): number {
  if (!Number.isFinite(bufferSizeMb)) return fallbackBytes;
  return Math.min(RING_HARD_CAP_MB * MIB, Math.max(RING_MIN_BYTES, Math.floor(bufferSizeMb * MIB)));
}

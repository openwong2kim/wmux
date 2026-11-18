/**
 * The largest ring a session may have, whatever bufferMaxMb says: config.ts
 * caps bufferSizeMb at it, and the native snapshot takes a ring up to it
 * (nativeSnapshotLimits.ts).
 */
export const RING_HARD_CAP_MB = 256;

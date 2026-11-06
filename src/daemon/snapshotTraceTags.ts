// BASELINE TRACE (local only, never committed to main): which ring and
// lifetime byte offset a buffer or frozen ring handed to a snapshot came from.
export const snapshotTraceTags = new WeakMap<object, { ring: number; at: number }>();
let nextRing = 0;
export function nextTraceRingId(): number { return ++nextRing; }

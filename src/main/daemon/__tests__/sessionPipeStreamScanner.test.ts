import { describe, it, expect } from 'vitest';
import {
  SessionPipeStreamScanner,
  type ScanEvent,
} from '../sessionPipeStreamScanner';
import { FLUSH_DONE_MARKER, RESYNC_BEGIN_MARKER } from '../../../daemon/SessionPipe';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const b = (s: string): Buffer => Buffer.from(s, 'binary');
const identityStrip = (buf: Buffer): Buffer => buf;

interface Collected {
  /** All 'data' event payloads concatenated, in order. */
  data: Buffer;
  /** recoveredBytes of each flushComplete, in order. */
  flushes: number[];
  /** Event type sequence, e.g. ['data', 'flushComplete', 'data']. */
  order: Array<ScanEvent['type']>;
}

function collect(events: ScanEvent[]): Collected {
  const parts: Buffer[] = [];
  const flushes: number[] = [];
  const order: Array<ScanEvent['type']> = [];
  for (const ev of events) {
    order.push(ev.type);
    if (ev.type === 'data') parts.push(ev.data);
    else flushes.push(ev.recoveredBytes);
  }
  return { data: Buffer.concat(parts), flushes, order };
}

function newScanner(opts?: { maxPendingBytes?: number; stripReplay?: (b: Buffer) => Buffer }) {
  return new SessionPipeStreamScanner({
    stripReplay: opts?.stripReplay ?? identityStrip,
    maxPendingBytes: opts?.maxPendingBytes,
  });
}

// ---------------------------------------------------------------------------
// Initial flush — accumulate until FLUSH_DONE_MARKER
// ---------------------------------------------------------------------------

describe('initial flush', () => {
  it('single chunk [replay][DONE][live] — emit order and recoveredBytes', () => {
    const s = newScanner();
    const replay = b('scrollback-bytes');
    const live = b('live-tail');
    const events = s.feed(Buffer.concat([replay, FLUSH_DONE_MARKER, live]));
    const c = collect(events);

    expect(c.order).toEqual(['data', 'flushComplete', 'data']);
    expect(c.flushes).toEqual([replay.length]);
    expect(collect([events[0]]).data.equals(replay)).toBe(true);
    expect(collect([events[2]]).data.equals(live)).toBe(true);
    expect(s.mode).toBe('live');
  });

  it('no live tail in the flush chunk — only replay + flushComplete', () => {
    const s = newScanner();
    const replay = b('abc');
    const c = collect(s.feed(Buffer.concat([replay, FLUSH_DONE_MARKER])));
    expect(c.order).toEqual(['data', 'flushComplete']);
    expect(c.flushes).toEqual([3]);
    expect(c.data.equals(replay)).toBe(true);
  });

  it('empty ring (recoveredBytes=0) — flushComplete first, no pre-marker data', () => {
    const s = newScanner();
    const live = b('hello');
    const events = s.feed(Buffer.concat([FLUSH_DONE_MARKER, live]));
    const c = collect(events);
    expect(c.order).toEqual(['flushComplete', 'data']);
    expect(c.flushes).toEqual([0]);
    expect(c.data.equals(live)).toBe(true);
  });

  it('replay across several chunks then DONE — accumulates, preserves total bytes', () => {
    const s = newScanner();
    expect(s.feed(b('part1-'))).toEqual([]);
    expect(s.feed(b('part2-'))).toEqual([]);
    const c = collect(s.feed(Buffer.concat([b('part3'), FLUSH_DONE_MARKER])));
    expect(c.order).toEqual(['data', 'flushComplete']);
    expect(c.data.equals(b('part1-part2-part3'))).toBe(true);
    expect(c.flushes).toEqual([b('part1-part2-part3').length]);
  });

  it('DONE marker split across a chunk boundary — found once the buffer joins', () => {
    const s = newScanner();
    const replay = b('xy');
    const half = Math.floor(FLUSH_DONE_MARKER.length / 2);
    // chunk 1: replay + first half of the marker — no marker yet
    expect(s.feed(Buffer.concat([replay, FLUSH_DONE_MARKER.subarray(0, half)]))).toEqual([]);
    // chunk 2: rest of the marker + a live byte
    const c = collect(s.feed(Buffer.concat([FLUSH_DONE_MARKER.subarray(half), b('L')])));
    expect(c.order).toEqual(['data', 'flushComplete', 'data']);
    expect(c.flushes).toEqual([replay.length]); // pre-strip length across the boundary
    expect(c.data.equals(b('xyL'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stripReplay is applied to the pre-marker replay only
// ---------------------------------------------------------------------------

describe('stripReplay', () => {
  it('sanitizes the replay while recoveredBytes stays the PRE-strip length', () => {
    // strip removes the literal token "<Q>" (stand-in for a stored CPR query)
    const strip = (buf: Buffer): Buffer => b(buf.toString('binary').split('<Q>').join(''));
    const s = newScanner({ stripReplay: strip });
    const replay = b('aa<Q>bb');
    const live = b('LIVE');
    const events = s.feed(Buffer.concat([replay, FLUSH_DONE_MARKER, live]));
    const c = collect(events);

    // data before marker is the STRIPPED replay
    expect(collect([events[0]]).data.equals(b('aabb'))).toBe(true);
    // recoveredBytes is the ORIGINAL (pre-strip) replay length
    expect(c.flushes).toEqual([replay.length]);
    // live tail is never sanitized
    expect(collect([events[2]]).data.equals(live)).toBe(true);
  });

  it('replay that strips to empty emits no data event, still flushComplete', () => {
    const strip = (): Buffer => Buffer.alloc(0);
    const s = newScanner({ stripReplay: strip });
    const replay = b('\x1b[6n'); // pure query, sanitized away
    const c = collect(s.feed(Buffer.concat([replay, FLUSH_DONE_MARKER])));
    expect(c.order).toEqual(['flushComplete']);
    expect(c.flushes).toEqual([replay.length]); // still reports authoritative scrollback
  });
});

// ---------------------------------------------------------------------------
// Live, unarmed — zero-scan passthrough
// ---------------------------------------------------------------------------

describe('live unarmed passthrough', () => {
  function toLive(s: SessionPipeStreamScanner) {
    s.feed(FLUSH_DONE_MARKER); // fast-forward to live mode
  }

  it('passes chunks through verbatim', () => {
    const s = newScanner();
    toLive(s);
    const c = collect(s.feed(b('echo output')));
    expect(c.order).toEqual(['data']);
    expect(c.data.equals(b('echo output'))).toBe(true);
  });

  it('marker-lookalike bytes are NOT intercepted when unarmed', () => {
    const s = newScanner();
    toLive(s);
    // A byte run that looks like the RESYNC marker but arrives while disarmed.
    const c = collect(s.feed(RESYNC_BEGIN_MARKER));
    expect(c.order).toEqual(['data']);
    expect(c.data.equals(RESYNC_BEGIN_MARKER)).toBe(true);
    expect(s.mode).toBe('live');
  });

  it('empty chunk yields no events', () => {
    const s = newScanner();
    toLive(s);
    expect(s.feed(Buffer.alloc(0))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Armed — cross-chunk RESYNC_BEGIN detection + re-flush cycle
// ---------------------------------------------------------------------------

describe('armed resync scan', () => {
  function armedLive(opts?: Parameters<typeof newScanner>[0]) {
    const s = newScanner(opts);
    s.feed(FLUSH_DONE_MARKER); // → live
    s.armResync();
    return s;
  }

  it('BEGIN in a single chunk — pre-marker data emitted, then accumulates residual', () => {
    const s = armedLive();
    const pre = b('tail-of-live');
    // residual after BEGIN is the start of the re-flush replay (no DONE yet)
    const events = s.feed(Buffer.concat([pre, RESYNC_BEGIN_MARKER, b('snap-start')]));
    const c = collect(events);
    expect(c.order).toEqual(['data']); // only the pre-marker live bytes
    expect(c.data.equals(pre)).toBe(true);
    expect(s.mode).toBe('accumulating');
  });

  it('BEGIN split across two chunks (tail is a strict prefix)', () => {
    const s = armedLive();
    const cut = 8;
    // chunk 1: live bytes + first part of BEGIN → live bytes emitted, prefix held
    const c1 = collect(s.feed(Buffer.concat([b('LIVE'), RESYNC_BEGIN_MARKER.subarray(0, cut)])));
    expect(c1.data.equals(b('LIVE'))).toBe(true);
    expect(s.mode).toBe('live'); // not yet switched — marker incomplete
    // chunk 2: rest of BEGIN + residual → switch to accumulating, no data
    const c2 = collect(s.feed(Buffer.concat([RESYNC_BEGIN_MARKER.subarray(cut), b('resid')])));
    expect(c2.order).toEqual([]);
    expect(s.mode).toBe('accumulating');
  });

  it('BEGIN split across three chunks', () => {
    const s = armedLive();
    const a = 5, bcut = 13;
    collect(s.feed(RESYNC_BEGIN_MARKER.subarray(0, a)));
    collect(s.feed(RESYNC_BEGIN_MARKER.subarray(a, bcut)));
    expect(s.mode).toBe('live');
    const c = collect(s.feed(RESYNC_BEGIN_MARKER.subarray(bcut)));
    expect(c.order).toEqual([]);
    expect(s.mode).toBe('accumulating');
  });

  it('tail looked like a marker prefix but was not — held bytes released, total preserved', () => {
    const s = armedLive();
    // chunk 1 ends with a genuine BEGIN prefix
    const prefix = RESYNC_BEGIN_MARKER.subarray(0, 9);
    const c1 = collect(s.feed(Buffer.concat([b('AAA'), prefix])));
    expect(c1.data.equals(b('AAA'))).toBe(true); // prefix held back
    // chunk 2 breaks the marker (does not continue it)
    const c2 = collect(s.feed(b('X-more')));
    // the held prefix + the new bytes are all released as live data
    const total = Buffer.concat([c1.data, c2.data]);
    expect(total.equals(Buffer.concat([b('AAA'), prefix, b('X-more')]))).toBe(true);
    expect(s.mode).toBe('live');
  });

  it('full re-flush round trip: BEGIN → snapshot → DONE → live tail', () => {
    const s = armedLive();
    const preLive = b('before-resync');
    const snapshot = b('rendered-snapshot-payload');
    const postLive = b('after-reflush');

    // Everything in one stream write (the daemon writes these back-to-back).
    const events = s.feed(
      Buffer.concat([preLive, RESYNC_BEGIN_MARKER, snapshot, FLUSH_DONE_MARKER, postLive]),
    );
    const c = collect(events);

    expect(c.order).toEqual(['data', 'data', 'flushComplete', 'data']);
    // pre-marker live, then the snapshot replay, then the live tail
    expect(collect([events[0]]).data.equals(preLive)).toBe(true);
    expect(collect([events[1]]).data.equals(snapshot)).toBe(true);
    expect(c.flushes).toEqual([snapshot.length]); // recoveredBytes = snapshot length
    expect(collect([events[3]]).data.equals(postLive)).toBe(true);
    expect(s.mode).toBe('live');

    // Back to steady state — a subsequent chunk is a plain passthrough.
    const after = collect(s.feed(b('normal')));
    expect(after.order).toEqual(['data']);
    expect(after.data.equals(b('normal'))).toBe(true);
  });

  it('re-flush spread across multiple chunks', () => {
    const s = armedLive();
    // BEGIN alone
    expect(collect(s.feed(RESYNC_BEGIN_MARKER)).order).toEqual([]);
    expect(s.mode).toBe('accumulating');
    // snapshot in pieces
    expect(s.feed(b('snap-'))).toEqual([]);
    expect(s.feed(b('more'))).toEqual([]);
    // DONE + tail
    const c = collect(s.feed(Buffer.concat([FLUSH_DONE_MARKER, b('T')])));
    expect(c.order).toEqual(['data', 'flushComplete', 'data']);
    expect(c.flushes).toEqual([b('snap-more').length]);
    expect(c.data.equals(b('snap-moreT'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// disarm
// ---------------------------------------------------------------------------

describe('disarmResync', () => {
  it('releases a held carry as a data event', () => {
    const s = newScanner();
    s.feed(FLUSH_DONE_MARKER);
    s.armResync();
    const prefix = RESYNC_BEGIN_MARKER.subarray(0, 7);
    const c1 = collect(s.feed(Buffer.concat([b('D'), prefix])));
    expect(c1.data.equals(b('D'))).toBe(true); // prefix withheld

    const released = collect(s.disarmResync());
    expect(released.order).toEqual(['data']);
    expect(released.data.equals(prefix)).toBe(true);
  });

  it('no carry → no events', () => {
    const s = newScanner();
    s.feed(FLUSH_DONE_MARKER);
    s.armResync();
    expect(s.disarmResync()).toEqual([]);
  });

  it('after disarm, marker-lookalikes pass straight through again', () => {
    const s = newScanner();
    s.feed(FLUSH_DONE_MARKER);
    s.armResync();
    s.disarmResync();
    const c = collect(s.feed(RESYNC_BEGIN_MARKER));
    expect(c.order).toEqual(['data']);
    expect(c.data.equals(RESYNC_BEGIN_MARKER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MAX_PENDING overflow — must mirror the original DaemonClient closure exactly
// ---------------------------------------------------------------------------

describe('max pending overflow', () => {
  it('drops the buffer and flips to live, emitting nothing (initial flush)', () => {
    const s = newScanner({ maxPendingBytes: 10 });
    // 6 bytes, no marker — still accumulating, no events
    expect(s.feed(b('123456'))).toEqual([]);
    expect(s.mode).toBe('accumulating');
    // +6 bytes → 12 > 10 cap → overflow: drop everything, go live, no events
    expect(s.feed(b('789012'))).toEqual([]);
    expect(s.mode).toBe('live');
    // subsequent bytes now pass straight through (buffered bytes were dropped)
    const c = collect(s.feed(b('after')));
    expect(c.order).toEqual(['data']);
    expect(c.data.equals(b('after'))).toBe(true);
  });

  it('a marker arriving in the SAME overflowing chunk is still dropped (cap wins)', () => {
    const s = newScanner({ maxPendingBytes: 5 });
    // one chunk that exceeds the cap AND contains the marker — original behavior
    // is overflow-wins: nothing emitted, straight to live.
    const c = collect(s.feed(Buffer.concat([b('bigreplay'), FLUSH_DONE_MARKER])));
    expect(c.order).toEqual([]);
    expect(s.mode).toBe('live');
  });
});

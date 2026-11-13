import { describe, it, expect } from 'vitest';
import {
  SessionPipeStreamScanner,
  type ScanEvent,
} from '../sessionPipeStreamScanner';
import { createSessionPipeMarkers } from '../../../daemon/SessionPipe';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const b = (s: string): Buffer => Buffer.from(s, 'binary');
const identityStrip = (buf: Buffer): Buffer => buf;
const MARKERS = createSessionPipeMarkers('scanner-test-auth-token');
const FLUSH_DONE_MARKER = MARKERS.flushDone;
const RESYNC_BEGIN_MARKER = MARKERS.resyncBegin;

interface Collected {
  /** All 'data' event payloads concatenated, in order. */
  data: Buffer;
  /** recoveredBytes of each flushComplete, in order. */
  flushes: number[];
  /** Event type sequence, e.g. ['data', 'flushComplete', 'data']. */
  order: Array<ScanEvent['type']>;
  /** Replay provenance for each data event, in order. */
  replay: boolean[];
}

function collect(events: ScanEvent[]): Collected {
  const parts: Buffer[] = [];
  const flushes: number[] = [];
  const order: Array<ScanEvent['type']> = [];
  const replay: boolean[] = [];
  for (const ev of events) {
    order.push(ev.type);
    if (ev.type === 'data') {
      parts.push(ev.data);
      replay.push(ev.replay);
    }
    else flushes.push(ev.recoveredBytes);
  }
  return { data: Buffer.concat(parts), flushes, order, replay };
}

function newScanner(opts?: { maxPendingBytes?: number; stripReplay?: (b: Buffer) => Buffer }) {
  return new SessionPipeStreamScanner({
    markers: MARKERS,
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
    expect(c.replay).toEqual([true, false]);
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

  it('does not let PTY output forged with another token impersonate the boundary', () => {
    const s = newScanner();
    const forged = createSessionPipeMarkers('attacker-does-not-know-real-token').flushDone;
    const replay = Buffer.concat([b('before'), forged, b('\x1b]52;c;Zm9yZ2Vk\x07after')]);
    const c = collect(s.feed(Buffer.concat([replay, FLUSH_DONE_MARKER])));

    expect(c.order).toEqual(['data', 'flushComplete']);
    expect(c.replay).toEqual([true]);
    expect(c.flushes).toEqual([replay.length]);
    expect(c.data.equals(replay)).toBe(true);
  });
});

describe('createSessionPipeMarkers', () => {
  const token = '6f1c2a9e-3b4d-4e5f-8a7b-0c1d2e3f4a5b';

  it('derives stable markers that do not contain the auth token', () => {
    const a = createSessionPipeMarkers(token);
    const again = createSessionPipeMarkers(token);
    expect(a.flushDone.equals(again.flushDone)).toBe(true);
    expect(a.resyncBegin.equals(again.resyncBegin)).toBe(true);
    for (const marker of [a.flushDone, a.resyncBegin]) {
      expect(marker.includes(token)).toBe(false);
    }
    const shape = (m: Buffer): string => m.toString('latin1').split('\x00').join('|');
    expect(shape(a.flushDone)).toMatch(/^\|WMUX_FLUSH_DONE:[0-9a-f]{32}\|$/);
    expect(shape(a.resyncBegin)).toMatch(/^\|WMUX_RESYNC_BEGIN:[0-9a-f]{32}\|$/);
  });

  it('gives each marker and each token a distinct value', () => {
    const a = createSessionPipeMarkers(token);
    const other = createSessionPipeMarkers(`${token}x`);
    const tag = (m: Buffer): string => m.toString('latin1').split(':')[1];
    expect(tag(a.flushDone)).not.toBe(tag(a.resyncBegin));
    expect(other.flushDone.equals(a.flushDone)).toBe(false);
    expect(other.resyncBegin.equals(a.resyncBegin)).toBe(false);
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
    expect(c.replay).toEqual([false]);
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

  it('marks the replay of a re-flush, and only that replay, as reflush', () => {
    const s = newScanner();
    const attach = s.feed(Buffer.concat([b('history'), FLUSH_DONE_MARKER]));
    expect(attach.find((e) => e.type === 'data')).toEqual({ type: 'data', data: b('history'), replay: true });
    s.armResync();
    const events = s.feed(Buffer.concat([b('live'), RESYNC_BEGIN_MARKER, b('again'), FLUSH_DONE_MARKER, b('after')]));
    const data = events.filter((e) => e.type === 'data');
    expect(data).toEqual([
      { type: 'data', data: b('live'), replay: false },
      { type: 'data', data: b('again'), replay: true, reflush: true },
      { type: 'data', data: b('after'), replay: false },
    ]);
  });

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
    expect(c.replay).toEqual([false, true, false]);
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
// MAX_PENDING overflow — drop replay safely, resume only at FLUSH_DONE
// ---------------------------------------------------------------------------

describe('max pending overflow', () => {
  it('drops replay until the marker, then resumes with a live tail', () => {
    const s = newScanner({ maxPendingBytes: 10 });
    // 6 bytes, no marker — still accumulating, no events
    expect(s.feed(b('123456'))).toEqual([]);
    expect(s.mode).toBe('accumulating');
    // +6 bytes → 12 > 10 cap → drop replay and scan for the real boundary.
    expect(s.feed(b('789012'))).toEqual([]);
    expect(s.mode).toBe('live');
    expect(s.armResync()).toBe(false);
    // More pre-marker history is dropped, never relabelled as live.
    expect(s.feed(b('more-history'))).toEqual([]);
    const c = collect(s.feed(Buffer.concat([FLUSH_DONE_MARKER, b('after')])));
    expect(c.order).toEqual(['flushComplete', 'data']);
    expect(c.flushes).toEqual([0]);
    expect(c.replay).toEqual([false]);
    expect(c.data.equals(b('after'))).toBe(true);
    expect(s.armResync()).toBe(true);
    s.disarmResync();
  });

  it('settles safely when the marker arrives in the same overflowing chunk', () => {
    const s = newScanner({ maxPendingBytes: 5 });
    // The replay is still dropped, but the marker settles the flush instead of
    // leaking through as ordinary PTY bytes.
    const c = collect(s.feed(Buffer.concat([b('bigreplay'), FLUSH_DONE_MARKER])));
    expect(c.order).toEqual(['flushComplete']);
    expect(c.flushes).toEqual([0]);
    expect(s.mode).toBe('live');
  });

  it('recognizes a flush marker split after overflow', () => {
    const s = newScanner({ maxPendingBytes: 5 });
    expect(s.feed(b('too-large'))).toEqual([]);
    const cut = Math.floor(FLUSH_DONE_MARKER.length / 2);
    expect(s.feed(FLUSH_DONE_MARKER.subarray(0, cut))).toEqual([]);
    const c = collect(s.feed(Buffer.concat([
      FLUSH_DONE_MARKER.subarray(cut),
      b('live'),
    ])));
    expect(c.order).toEqual(['flushComplete', 'data']);
    expect(c.flushes).toEqual([0]);
    expect(c.replay).toEqual([false]);
    expect(c.data.equals(b('live'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy marker form (an older daemon kept running)
// ---------------------------------------------------------------------------

describe('legacy marker form', () => {
  // A UUID token makes the legacy form longer than the current one, so the
  // split cases below only pass if the hold covers the longer form.
  const UUID_MARKERS = createSessionPipeMarkers('6f1c2a9e-3b4d-4e5f-8a7b-0c1d2e3f4a5b');
  const CURRENT = { flush: UUID_MARKERS.flushDone, resync: UUID_MARKERS.resyncBegin };
  const LEGACY = { flush: UUID_MARKERS.legacy.flushDone, resync: UUID_MARKERS.legacy.resyncBegin };

  const scanner = (maxPendingBytes?: number) => new SessionPipeStreamScanner({
    markers: UUID_MARKERS,
    stripReplay: identityStrip,
    maxPendingBytes,
  });

  /** Feed `wire` one byte at a time, arming before each resync episode. */
  function feedBytewise(s: SessionPipeStreamScanner, wire: Buffer): ScanEvent[] {
    const events: ScanEvent[] = [];
    for (let i = 0; i < wire.length; i++) {
      if (s.mode === 'live') s.armResync();
      events.push(...s.feed(wire.subarray(i, i + 1)));
    }
    return events;
  }

  it('the legacy form is the longer one with this token', () => {
    expect(LEGACY.flush.length).toBeGreaterThan(CURRENT.flush.length);
    expect(LEGACY.resync.length).toBeGreaterThan(CURRENT.resync.length);
  });

  for (const [name, form] of [['current', CURRENT], ['legacy', LEGACY]] as const) {
    it(`${name} form ends the initial flush, whole and split byte by byte`, () => {
      const wire = Buffer.concat([b('replay'), form.flush, b('live')]);
      for (const events of [scanner().feed(wire), feedBytewise(scanner(), wire)]) {
        const c = collect(events);
        expect(c.flushes).toEqual([6]);
        expect(c.data.equals(b('replaylive'))).toBe(true);
      }
    });

    it(`${name} form starts a resync and ends its re-flush`, () => {
      const wire = Buffer.concat([
        form.flush, b('live1'), form.resync, b('replay2'), form.flush, b('live2'),
      ]);
      const s = scanner();
      const c = collect(feedBytewise(s, wire));
      expect(c.flushes).toEqual([0, 7]);
      expect(c.data.equals(b('live1replay2live2'))).toBe(true);
      expect(s.mode).toBe('live');
    });

    it(`${name} form ends a discarded overflow`, () => {
      const s = scanner(5);
      expect(s.feed(b('too-large'))).toEqual([]);
      const c = collect(feedBytewise(s, Buffer.concat([form.flush, b('L')])));
      expect(c.flushes).toEqual([0]);
      expect(c.data.equals(b('L'))).toBe(true);
    });
  }

  it('a stream that mixes both forms keeps every boundary', () => {
    const segments = [
      Buffer.concat([b('r1'), LEGACY.flush, b('l1')]),
      Buffer.concat([CURRENT.resync, b('r2'), LEGACY.flush, b('l2')]),
      Buffer.concat([LEGACY.resync, b('r3'), CURRENT.flush, b('l3')]),
    ];
    const wholeSegments = (s: SessionPipeStreamScanner): ScanEvent[] => segments.flatMap((seg) => {
      if (s.mode === 'live') s.armResync();
      return s.feed(seg);
    });
    const bytewise = (s: SessionPipeStreamScanner): ScanEvent[] => feedBytewise(s, Buffer.concat(segments));
    for (const feed of [wholeSegments, bytewise]) {
      const events = feed(scanner());
      const c = collect(events);
      const replayed = Buffer.concat(events.flatMap((e) => (e.type === 'data' && e.replay ? [e.data] : [])));
      expect(c.flushes).toEqual([2, 2, 2]);
      expect(c.data.equals(b('r1l1r2l2r3l3'))).toBe(true);
      expect(replayed.equals(b('r1r2r3'))).toBe(true);
    }
  });
});

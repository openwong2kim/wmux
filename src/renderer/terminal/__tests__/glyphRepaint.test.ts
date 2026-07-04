import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  createGlyphRepaintScheduler,
  ACTIVITY_BYTES_DEFAULT,
  BURST_QUIET_MS_DEFAULT,
  FOCUS_THROTTLE_MS_DEFAULT,
  BURST_STREAM_FLUSH_MS_DEFAULT,
  type RepaintReason,
} from '../glyphRepaint';

describe('glyphRepaint scheduler', () => {
  let repaints: RepaintReason[];
  const repaint = (reason: RepaintReason) => repaints.push(reason);

  beforeEach(() => {
    vi.useFakeTimers();
    repaints = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The `burst` gate is an activity-based TIME cadence (issue #318). `activityBytes`
  // is only a noise floor (default 256) — enough NEW output since the last flush to
  // be worth a refresh — NOT a "big burst" size. Once cleared, we repaint every
  // burstStreamFlushMs while output flows, and once more at the trailing settle.
  describe('trailing settle flush', () => {
    it('fires once after an over-threshold stream settles', () => {
      // burstStreamFlushMs Infinity isolates the trailing path (no mid-stream).
      const s = createGlyphRepaintScheduler({ repaint, burstStreamFlushMs: Infinity });
      s.onData(ACTIVITY_BYTES_DEFAULT);
      expect(repaints).toEqual([]); // not before the quiet gap
      vi.advanceTimersByTime(BURST_QUIET_MS_DEFAULT);
      expect(repaints).toEqual(['burst']);
    });

    it('does not fire for a tail below the noise floor', () => {
      const s = createGlyphRepaintScheduler({ repaint, burstStreamFlushMs: Infinity });
      s.onData(ACTIVITY_BYTES_DEFAULT - 1);
      vi.advanceTimersByTime(BURST_QUIET_MS_DEFAULT * 2);
      expect(repaints).toEqual([]);
    });

    it('accumulates chunks within one stream toward the floor', () => {
      const s = createGlyphRepaintScheduler({
        repaint, activityBytes: 100, burstQuietMs: 50, burstStreamFlushMs: Infinity,
      });
      s.onData(40);
      vi.advanceTimersByTime(20); // still inside the quiet window
      s.onData(40);
      vi.advanceTimersByTime(20);
      s.onData(40); // total 120 >= 100
      vi.advanceTimersByTime(50);
      expect(repaints).toEqual(['burst']);
    });

    it('keeps deferring the trailing repaint while writes keep arriving, fires once at the end', () => {
      const s = createGlyphRepaintScheduler({
        repaint, activityBytes: 10, burstQuietMs: 50, burstStreamFlushMs: Infinity,
      });
      for (let i = 0; i < 20; i++) {
        s.onData(1000);
        vi.advanceTimersByTime(49); // never quiet long enough
      }
      expect(repaints).toEqual([]); // mid-stream disabled by Infinity cadence
      vi.advanceTimersByTime(50);
      expect(repaints).toEqual(['burst']);
    });

    it('ignores zero/negative sizes', () => {
      const s = createGlyphRepaintScheduler({ repaint, activityBytes: 1, burstQuietMs: 50 });
      s.onData(0);
      s.onData(-5);
      vi.advanceTimersByTime(100);
      expect(repaints).toEqual([]);
    });
  });

  // Issue #318 — a full-screen TUI (Claude Code) drips output continuously during a
  // long answer, so the quiet gap that ends a stream never arrives. The old #319
  // gate required a 32KB contiguous burst before ANY repaint fired; a real Claude
  // stream is ~48-unit chunks with frequent 300ms+ pauses, so it almost never
  // qualified (~18% coverage). The activity-based cadence repaints on a fixed
  // interval while output flows. These tests advance the injected clock AND the
  // fake quiet timer together (writes spaced under burstQuietMs) so the stream
  // stays open the way it does in production — not as an artifact of a frozen timer.
  describe('mid-stream cadence (issue #318)', () => {
    it('flushes about every burstStreamFlushMs during a genuine Claude-style drip', () => {
      // The old 32KB gate's PRIMARY blind spot: this whole stream is 100*50 = 5000
      // UTF-16 units — 6.5x below the 32KB qualification — so the old gate fired 0.
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, activityBytes: 256, burstQuietMs: 300, burstStreamFlushMs: 500, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      s.onData(50); // t=0, accum 50
      for (let i = 0; i < 99; i++) { tick(40); s.onData(50); } // 50 units every 40ms → ~4s stream
      // cadence 500ms over ~4000ms of continuous drip → ~8 flushes.
      expect(repaints.length).toBeGreaterThanOrEqual(6);
      expect(repaints.every((r) => r === 'burst')).toBe(true);
    });

    it('rate-limits continuous heavy flow to at most one flush per burstStreamFlushMs', () => {
      let t = 0;
      const flushT: number[] = [];
      const s = createGlyphRepaintScheduler({
        repaint: () => flushT.push(t),
        activityBytes: 256, burstQuietMs: 300, burstStreamFlushMs: 500, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      s.onData(10000); // t=0 first flush (lastFlushAt seeded -Infinity)
      for (let i = 0; i < 300; i++) { tick(10); s.onData(10000); } // 3000ms of 10ms writes
      // at most ceil(3000/500)+1 flushes, and no two flushes closer than 500ms.
      expect(flushT.length).toBeLessThanOrEqual(Math.ceil(3000 / 500) + 1);
      for (let i = 1; i < flushT.length; i++) {
        expect(flushT[i] - flushT[i - 1]).toBeGreaterThanOrEqual(500);
      }
    });

    it('trailing settle fires a short over-threshold burst that never mid-flushed, ignoring the rate limit', () => {
      let t = 0;
      const flushT: number[] = [];
      const s = createGlyphRepaintScheduler({
        repaint: () => flushT.push(t),
        activityBytes: 256, burstQuietMs: 300, burstStreamFlushMs: 500, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      s.onData(1000);          // t=0 first flush → lastFlushAt=0
      tick(100);               // t=100
      s.onData(300);           // accum 300 >= 256 BUT t-lastFlushAt=100 < 500 → no mid flush
      tick(300);               // t=400: quiet settle
      // trailing fired despite only 400ms since the last flush (< 500 rate limit).
      expect(flushT).toEqual([0, 400]);
    });

    it('guarantees a post-parse settle flush when the final chunk itself mid-flushed (review P2)', () => {
      // A mid flush runs synchronously inside pty.onData — AFTER terminal.write
      // was called but BEFORE xterm parsed it (write is async). If the stream's
      // last chunk mid-flushes, that flush repaints the previous frame and
      // windowAccum is 0 at settle — without flushedSinceSettle the final
      // chunk's rendering would never be repaired.
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, activityBytes: 256, burstQuietMs: 300, burstStreamFlushMs: 500, now: () => t,
      });
      s.onData(300);           // t=0: single over-floor chunk → immediate mid flush (pre-parse)
      expect(repaints).toEqual(['burst']);
      t += 300; vi.advanceTimersByTime(300); // settle at +burstQuietMs: post-parse
      expect(repaints).toEqual(['burst', 'burst']); // guaranteed final repaint
    });

    it('settle still fires when a drip stream ends exactly on a mid flush', () => {
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, activityBytes: 256, burstQuietMs: 300, burstStreamFlushMs: 500, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      // 100 units every 100ms: mid flushes at t=200 (accum 300 >= 256, first
      // flush) and t=700 (accum 500, cadence satisfied). The t=700 write is the
      // FINAL chunk — its own flush consumed the accumulation (windowAccum=0).
      s.onData(100);
      for (let i = 0; i < 7; i++) { tick(100); s.onData(100); }
      expect(repaints).toEqual(['burst', 'burst']);
      tick(300);               // settle: windowAccum=0 but flushedSinceSettle → fires
      expect(repaints).toEqual(['burst', 'burst', 'burst']);
    });

    it('resets both the window and the settle flag so the next sub-floor stream stays silent', () => {
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, activityBytes: 256, burstQuietMs: 300, burstStreamFlushMs: 500, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      s.onData(1000);          // t=0 mid flush → windowAccum=0, flushedSinceSettle=true
      tick(100);
      s.onData(100);           // sub-floor tail (100 < 256)
      tick(300);               // settle: flushedSinceSettle → guaranteed post-parse flush
      expect(repaints).toEqual(['burst', 'burst']);
      // Next unrelated stream: 200 sub-floor units, no mid flush. If either the
      // 100-unit tail or the settle flag had leaked past the settle, this would
      // flush. Clean window + cleared flag means total silence.
      tick(1600);              // t=2000, well past the 500ms cadence
      s.onData(200);
      tick(300);               // settle: 200 < 256 and nothing flushed this stream → silent
      expect(repaints).toEqual(['burst', 'burst']); // unchanged → nothing leaked
    });

    it('Infinity cadence disables mid-stream flushes but the trailing settle still fires', () => {
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, activityBytes: 10, burstQuietMs: 50, burstStreamFlushMs: Infinity, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      s.onData(1000);
      for (let i = 0; i < 9; i++) { tick(40); s.onData(1000); } // continuous, never quiet
      expect(repaints).toEqual([]);   // Math.max(1, Infinity) = Infinity → no mid flush
      tick(50);                       // settle
      expect(repaints).toEqual(['burst']); // trailing still repairs the stream
    });

    it('clamps a non-positive burstStreamFlushMs to a 1ms floor (no every-write churn)', () => {
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, activityBytes: 10, burstQuietMs: 50, burstStreamFlushMs: 0, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      s.onData(1000);                 // t=0 first write fires (lastFlushAt -Infinity)
      expect(repaints).toEqual(['burst']);
      s.onData(1000);                 // same tick t=0 → 0 - 0 >= 1 is false → no churn
      expect(repaints).toEqual(['burst']);
      tick(1); s.onData(1000);        // 1ms later → floor satisfied → flush
      expect(repaints).toEqual(['burst', 'burst']);
    });

    it('uses a sane default cadence and noise floor', () => {
      expect(BURST_STREAM_FLUSH_MS_DEFAULT).toBeGreaterThan(0);
      expect(BURST_STREAM_FLUSH_MS_DEFAULT).toBeLessThanOrEqual(1000);
      expect(ACTIVITY_BYTES_DEFAULT).toBe(256);
    });
  });

  describe('noise suppression', () => {
    it('never flushes for sub-threshold keystroke echoes 1s apart (mid or trailing)', () => {
      let t = 0;
      const s = createGlyphRepaintScheduler({ repaint, now: () => t });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      for (let i = 0; i < 20; i++) { s.onData(30); tick(1000); } // 30 units < 256, 1s apart
      vi.advanceTimersByTime(BURST_QUIET_MS_DEFAULT);
      expect(repaints).toEqual([]);
    });
  });

  describe('focus repaint', () => {
    it('fires immediately on first focus', () => {
      const t = 0;
      const s = createGlyphRepaintScheduler({ repaint, now: () => t });
      s.onFocus();
      expect(repaints).toEqual(['focus']);
    });

    it('throttles rapid refocus', () => {
      let t = 0;
      const s = createGlyphRepaintScheduler({ repaint, now: () => t });
      s.onFocus();
      t += FOCUS_THROTTLE_MS_DEFAULT - 1;
      s.onFocus(); // inside throttle window — dropped
      expect(repaints).toEqual(['focus']);
      t += 1; // exactly at the boundary
      s.onFocus();
      expect(repaints).toEqual(['focus', 'focus']);
    });
  });

  describe('visible repaint', () => {
    it('fires on every visibility regain (workspace switches are infrequent)', () => {
      const s = createGlyphRepaintScheduler({ repaint });
      s.onVisible();
      s.onVisible();
      expect(repaints).toEqual(['visible', 'visible']);
    });
  });

  describe('dispose', () => {
    it('cancels a pending trailing repaint', () => {
      const s = createGlyphRepaintScheduler({ repaint, activityBytes: 1, burstQuietMs: 50 });
      s.onData(100);
      s.dispose();
      vi.advanceTimersByTime(100);
      // the immediate first-write mid flush already fired; dispose must cancel the
      // still-pending trailing timer so no further repaint runs.
      const afterDispose = repaints.length;
      vi.advanceTimersByTime(1000);
      expect(repaints.length).toBe(afterDispose);
    });

    it('turns all entry points into no-ops', () => {
      const s = createGlyphRepaintScheduler({ repaint, activityBytes: 1, burstQuietMs: 50 });
      s.dispose();
      s.onData(100);
      s.onFocus();
      s.onVisible();
      vi.advanceTimersByTime(100);
      expect(repaints).toEqual([]);
    });
  });

  // Real captured Claude Code TUI stream (141s, 1907 chunks, mean 47.6 UTF-16
  // units/chunk, 34 pauses >= 300ms). Replayed through the real scheduler under
  // fake timers: `now` is the DEFAULT Date.now, which vitest fake timers alias to
  // the same virtual clock the setTimeout callbacks run on — so advancing the
  // fake clock advances both `now()` and the quiet-timer fires together, and each
  // trailing callback reads the exact time it fired (faithful, no clock skew).
  //
  // The old #319 32KB-size gate scored on THIS trace: 38 flushes, ~17% of active
  // streaming time covered, longest flush-free active window carried 5470 units
  // over a 39-second blind ramp. Both assertions below FAIL against that gate.
  describe('real Claude stream trace regression (issue #318)', () => {
    const rows: Array<[number, number]> = fs
      .readFileSync(path.join(__dirname, 'fixtures', 'claude-stream-trace.jsonl'), 'utf8')
      .split(/\r?\n/) // tolerate CRLF from git autocrlf checkouts
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as [number, number]);
    if (rows.length === 0) {
      throw new Error('claude-stream-trace.jsonl fixture is empty or failed to parse');
    }

    // Assertion thresholds, tuned to what the trace actually yields:
    // - MIN_FLUSHES: the old 32KB gate scored 38 on this trace; the activity
    //   cadence measured 231 (incl. the guaranteed post-parse settle flushes),
    //   so 100 cleanly separates the two while leaving headroom for tuning.
    const MIN_FLUSHES = 100;
    // - ACTIVE_WINDOW_MS / ACTIVE_WINDOW_MIN_UNITS: a span counts as "active"
    //   when it sustains >= 512 units/s (1024 units over 2s) — real streaming,
    //   not keystroke echo noise.
    const ACTIVE_WINDOW_MS = 2000;
    const ACTIVE_WINDOW_MIN_UNITS = 1024;

    it('covers the whole active stream — the drip the old 32KB gate went blind on', () => {
      const flushTimes: number[] = [];
      vi.setSystemTime(0);
      const s = createGlyphRepaintScheduler({
        repaint: () => flushTimes.push(Date.now()),
      });
      for (const [t, len] of rows) {
        vi.advanceTimersByTime(t - Date.now()); // advance shared virtual clock to this chunk
        s.onData(len);
      }
      vi.advanceTimersByTime(rows[rows.length - 1][0] + 5000 - Date.now()); // drain trailing timer
      s.dispose();

      // (a) The old gate fired 38; the activity cadence fires >= MIN_FLUSHES
      // (measured 231).
      expect(flushTimes.length).toBeGreaterThanOrEqual(MIN_FLUSHES);

      // (b) No blind active phase: every active window contains at least one
      // flush. The old gate left a 39s ramp (5470 units in its worst 2s window)
      // with zero flushes — this fails there.
      let worstUnflushedUnits = 0;
      let worstAt = -1;
      for (let i = 0; i < rows.length; i++) {
        const a = rows[i][0];
        const b = a + ACTIVE_WINDOW_MS;
        let units = 0;
        for (let j = i; j < rows.length && rows[j][0] < b; j++) units += rows[j][1];
        if (units < ACTIVE_WINDOW_MIN_UNITS) continue; // not an "active" window
        const covered = flushTimes.some((f) => f >= a && f < b);
        if (!covered && units > worstUnflushedUnits) {
          worstUnflushedUnits = units;
          worstAt = a;
        }
      }
      expect(
        worstUnflushedUnits,
        `active 2s window at t=${worstAt}ms carried ${worstUnflushedUnits} units with no flush`,
      ).toBe(0);
    });
  });
});

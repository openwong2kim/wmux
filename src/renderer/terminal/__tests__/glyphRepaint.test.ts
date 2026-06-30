import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createGlyphRepaintScheduler,
  BURST_BYTES_DEFAULT,
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

  describe('burst repaint', () => {
    it('fires once after a qualifying burst settles', () => {
      const s = createGlyphRepaintScheduler({ repaint });
      s.onData(BURST_BYTES_DEFAULT);
      expect(repaints).toEqual([]); // not before the quiet gap
      vi.advanceTimersByTime(BURST_QUIET_MS_DEFAULT);
      expect(repaints).toEqual(['burst']);
    });

    it('does not fire for a burst below the threshold', () => {
      const s = createGlyphRepaintScheduler({ repaint });
      s.onData(BURST_BYTES_DEFAULT - 1);
      vi.advanceTimersByTime(BURST_QUIET_MS_DEFAULT * 2);
      expect(repaints).toEqual([]);
    });

    it('accumulates chunks within one burst', () => {
      const s = createGlyphRepaintScheduler({ repaint, burstBytes: 100, burstQuietMs: 50 });
      s.onData(40);
      vi.advanceTimersByTime(20); // still inside the quiet window
      s.onData(40);
      vi.advanceTimersByTime(20);
      s.onData(40); // total 120 >= 100
      vi.advanceTimersByTime(50);
      expect(repaints).toEqual(['burst']);
    });

    it('keeps deferring the trailing repaint while writes keep arriving, fires once at the end', () => {
      // burstStreamFlushMs: Infinity isolates the trailing-settle path (mid-stream
      // flush disabled) so this asserts only the quiet-gap behavior.
      const s = createGlyphRepaintScheduler({ repaint, burstBytes: 10, burstQuietMs: 50, burstStreamFlushMs: Infinity });
      for (let i = 0; i < 20; i++) {
        s.onData(1000);
        vi.advanceTimersByTime(49); // never quiet long enough
      }
      expect(repaints).toEqual([]);
      vi.advanceTimersByTime(50);
      expect(repaints).toEqual(['burst']);
    });

    it('resets accumulation between bursts — a slow trickle never qualifies', () => {
      const s = createGlyphRepaintScheduler({ repaint, burstBytes: 100, burstQuietMs: 50 });
      // 10 separate "bursts" of 60 each (each settles below threshold).
      for (let i = 0; i < 10; i++) {
        s.onData(60);
        vi.advanceTimersByTime(51);
      }
      expect(repaints).toEqual([]);
    });

    it('fires again for a second qualifying burst', () => {
      const s = createGlyphRepaintScheduler({ repaint, burstBytes: 100, burstQuietMs: 50 });
      s.onData(150);
      vi.advanceTimersByTime(50);
      s.onData(150);
      vi.advanceTimersByTime(50);
      expect(repaints).toEqual(['burst', 'burst']);
    });

    it('ignores zero/negative sizes', () => {
      const s = createGlyphRepaintScheduler({ repaint, burstBytes: 1, burstQuietMs: 50 });
      s.onData(0);
      s.onData(-5);
      vi.advanceTimersByTime(100);
      expect(repaints).toEqual([]);
    });
  });

  // Issue #318 — a full-screen TUI (Claude Code) repaints continuously during a
  // long answer, so the quiet gap that ends a burst never arrives. Without the
  // mid-stream flush the trailing repaint never fires and stale glyphs sit on
  // screen for the whole stream. These tests advance the injected clock AND the
  // fake quiet timer together (writes spaced under burstQuietMs) so the burst
  // stays open the way it does in production — not as an artifact of a frozen
  // quiet timer.
  describe('mid-stream flush (issue #318)', () => {
    it('flushes about every burstStreamFlushMs during a genuinely continuous stream', () => {
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, burstBytes: 10, burstQuietMs: 50, burstStreamFlushMs: 100, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      s.onData(1000);                                          // t=0 burst start — no flush on the first write
      for (let i = 0; i < 9; i++) { tick(40); s.onData(1000); } // 40ms apart (< 50 quiet) keeps the burst open through ~360ms
      // cadence 100ms from burst start → flushes near t=120, 240, 360.
      expect(repaints.length).toBeGreaterThanOrEqual(2);
      expect(repaints.every((r) => r === 'burst')).toBe(true);
    });

    it('still fires the trailing settle repaint after a mid-stream flush (burstAccum not reset)', () => {
      // Load-bearing invariant: the mid-stream flush must NOT reset burstAccum,
      // or a stream ending with a sub-burstBytes tail after the last flush would
      // never get its final repaint — the #318 corruption, regressed silently.
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, burstBytes: 10, burstQuietMs: 50, burstStreamFlushMs: 100, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      s.onData(1000);
      for (let i = 0; i < 4; i++) { tick(40); s.onData(1000); } // a mid-stream flush fires near t=120
      const mid = repaints.length;
      expect(mid).toBeGreaterThanOrEqual(1);                    // at least one mid-stream flush
      tick(50);                                                  // quiet gap → trailing settle
      expect(repaints.length).toBe(mid + 1);                    // trailing repaint fired too
    });

    it('does not mid-stream flush while the open burst is below burstBytes', () => {
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, burstBytes: 1000, burstQuietMs: 50, burstStreamFlushMs: 100, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      s.onData(300);                 // t=0 accum=300
      tick(40); s.onData(300);       // accum=600, burst open, past cadence but <1000 → no flush
      tick(40); s.onData(300);       // accum=900 <1000 → no flush
      expect(repaints).toEqual([]);
      tick(40); s.onData(300);       // accum=1200 >=1000 and past cadence → flush
      expect(repaints).toEqual(['burst']);
    });

    it('does not mid-stream flush a short burst that settles before the cadence', () => {
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, burstBytes: 10, burstQuietMs: 50, burstStreamFlushMs: 500, now: () => t,
      });
      s.onData(1000);             // single chunk at t=0
      t = 50; vi.advanceTimersByTime(50); // settle before the 500ms cadence → trailing only
      expect(repaints).toEqual(['burst']);
    });

    it('clamps a non-positive burstStreamFlushMs to a 1ms floor (no every-write churn)', () => {
      let t = 0;
      const s = createGlyphRepaintScheduler({
        repaint, burstBytes: 10, burstQuietMs: 50, burstStreamFlushMs: 0, now: () => t,
      });
      const tick = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
      s.onData(1000);                 // t=0 — floor still means t-lastFlush(0) >= 1 is false → no flush
      expect(repaints).toEqual([]);
      tick(1); s.onData(1000);        // 1ms later → floor satisfied → flush
      expect(repaints).toEqual(['burst']);
    });

    it('uses a sane default cadence', () => {
      expect(BURST_STREAM_FLUSH_MS_DEFAULT).toBeGreaterThan(0);
      expect(BURST_STREAM_FLUSH_MS_DEFAULT).toBeLessThanOrEqual(1000);
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
    it('cancels a pending burst repaint', () => {
      const s = createGlyphRepaintScheduler({ repaint, burstBytes: 1, burstQuietMs: 50 });
      s.onData(100);
      s.dispose();
      vi.advanceTimersByTime(100);
      expect(repaints).toEqual([]);
    });

    it('turns all entry points into no-ops', () => {
      const s = createGlyphRepaintScheduler({ repaint, burstBytes: 1, burstQuietMs: 50 });
      s.dispose();
      s.onData(100);
      s.onFocus();
      s.onVisible();
      vi.advanceTimersByTime(100);
      expect(repaints).toEqual([]);
    });
  });
});

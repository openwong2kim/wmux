import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createGlyphRepaintScheduler,
  BURST_BYTES_DEFAULT,
  BURST_QUIET_MS_DEFAULT,
  FOCUS_THROTTLE_MS_DEFAULT,
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

    it('keeps deferring while writes keep arriving, fires once at the end', () => {
      const s = createGlyphRepaintScheduler({ repaint, burstBytes: 10, burstQuietMs: 50 });
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

// PR-9 row windowing — pure slicing math, including variable heights.
import { describe, it, expect } from 'vitest';
import { computeRowWindow, ROW_OVERSCAN, ESTIMATED_ROW_HEIGHT } from '../useRowWindow';

/** n rows of a uniform height. */
const uniform = (n: number, h: number): number[] => Array.from({ length: n }, () => h);

describe('computeRowWindow — degradation rules', () => {
  it('is empty for zero rows', () => {
    expect(computeRowWindow([], 0, 500)).toEqual({ startIndex: 0, endIndex: 0, padTop: 0, padBottom: 0 });
  });

  it('renders the FULL list while the viewport is unmeasured (first paint, display:none, jsdom)', () => {
    const w = computeRowWindow(uniform(500, 40), 0, 0);
    expect(w).toEqual({ startIndex: 0, endIndex: 500, padTop: 0, padBottom: 0 });
  });

  it('renders the full list for a short conversation (overscan covers it)', () => {
    const w = computeRowWindow(uniform(10, 40), 0, 400, ROW_OVERSCAN);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(10);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe(0);
  });
});

describe('computeRowWindow — uniform heights', () => {
  // 1000 rows × 40px = 40000px of content, 400px viewport = 10 visible rows.
  const heights = uniform(1000, 40);

  it('at the top: visible rows + overscan below, no top pad', () => {
    const w = computeRowWindow(heights, 0, 400, 20);
    expect(w.startIndex).toBe(0);
    // rows 0..9 intersect; last visible 9 + 1 + 20 overscan
    expect(w.endIndex).toBe(30);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe((1000 - 30) * 40);
  });

  it('mid-scroll: overscan on both sides and pads that account for every skipped row', () => {
    const w = computeRowWindow(heights, 40 * 500, 400, 20);
    expect(w.startIndex).toBe(480); // first visible 500 − 20
    expect(w.endIndex).toBe(530); // last visible 509 + 1 + 20
    expect(w.padTop).toBe(480 * 40);
    expect(w.padBottom).toBe((1000 - 530) * 40);
    // The rendered slice plus both pads is the full content height — the
    // scrollbar must not move when the window changes.
    const rendered = (w.endIndex - w.startIndex) * 40;
    expect(w.padTop + rendered + w.padBottom).toBe(1000 * 40);
  });

  it('at the bottom: clamps endIndex to the row count and pads nothing below', () => {
    const w = computeRowWindow(heights, 40 * 1000 - 400, 400, 20);
    expect(w.endIndex).toBe(1000);
    expect(w.padBottom).toBe(0);
    expect(w.startIndex).toBe(970);
  });

  it('anchors on the tail when scrollTop is past the content (rows shrank under a stale scroll)', () => {
    const w = computeRowWindow(uniform(100, 40), 99_999, 400, 20);
    expect(w.endIndex).toBe(100);
    expect(w.startIndex).toBe(79);
    expect(w.padBottom).toBe(0);
  });

  it('a zero overscan renders exactly the intersecting rows', () => {
    const w = computeRowWindow(heights, 40 * 500, 400, 0);
    expect(w.startIndex).toBe(500);
    expect(w.endIndex).toBe(510);
  });
});

describe('computeRowWindow — variable heights', () => {
  it('uses each row’s own height to decide intersection', () => {
    // row0 500px, row1 20px, row2 20px, row3 1000px, row4 20px
    const heights = [500, 20, 20, 1000, 20];
    // Viewport [505, 515) → only row1 (500..520) intersects.
    const narrow = computeRowWindow(heights, 505, 10, 0);
    expect(narrow.startIndex).toBe(1);
    expect(narrow.endIndex).toBe(2);
    expect(narrow.padTop).toBe(500);
    expect(narrow.padBottom).toBe(20 + 1000 + 20);

    // Viewport [510, 610) reaches into the 1000px row3 (540..1540) too, so the
    // window grows to rows 1..3 — one tall row cannot be skipped by row count.
    const wide = computeRowWindow(heights, 510, 100, 0);
    expect(wide.startIndex).toBe(1);
    expect(wide.endIndex).toBe(4);
    expect(wide.padTop).toBe(500);
    expect(wide.padBottom).toBe(20);
  });

  it('one tall row can be the entire window', () => {
    const heights = [50, 50, 3000, 50];
    const w = computeRowWindow(heights, 1000, 400, 0);
    expect(w.startIndex).toBe(2);
    expect(w.endIndex).toBe(3);
    expect(w.padTop).toBe(100);
    expect(w.padBottom).toBe(50);
  });

  it('pads sum to the skipped content height with mixed measured/estimated rows', () => {
    // A realistic mix: measured rows near the viewport, estimates elsewhere.
    const heights = [
      ...uniform(200, ESTIMATED_ROW_HEIGHT),
      ...[120, 40, 300, 40, 80],
      ...uniform(200, ESTIMATED_ROW_HEIGHT),
    ];
    const total = heights.reduce((a, b) => a + b, 0);
    const w = computeRowWindow(heights, ESTIMATED_ROW_HEIGHT * 150, 500, 20);
    const rendered = heights.slice(w.startIndex, w.endIndex).reduce((a, b) => a + b, 0);
    expect(w.padTop + rendered + w.padBottom).toBe(total);
  });

  it('treats a negative or missing height as zero rather than shifting the geometry', () => {
    const heights = [40, -100, 40];
    const w = computeRowWindow(heights, 0, 60, 0);
    expect(w.startIndex).toBe(0);
    expect(w.padTop).toBe(0);
    expect(w.padTop + w.padBottom).toBeLessThanOrEqual(80);
  });
});

describe('windowing constants', () => {
  it('overscans 20 rows above and below, per the plan', () => {
    expect(ROW_OVERSCAN).toBe(20);
  });

  it('has a positive height estimate for unmeasured rows', () => {
    expect(ESTIMATED_ROW_HEIGHT).toBeGreaterThan(0);
  });
});

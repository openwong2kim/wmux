import { describe, it, expect } from 'vitest';
import { multiviewColumnCount, multiviewGridStyle, MULTIVIEW_ARRANGEMENTS } from '../multiviewGrid';

describe('multiviewColumnCount', () => {
  // The whole point of this helper is that the grid CSS and
  // uiSlice.focusMultiviewDirection can no longer disagree about the column
  // count. `auto` must stay bit-identical to the pre-#746 inline ternary, or
  // every existing user's layout silently changes on upgrade.
  it('auto reproduces the historical 2/2/3 progression', () => {
    expect(multiviewColumnCount(2, 'auto')).toBe(2);
    expect(multiviewColumnCount(3, 'auto')).toBe(2);
    expect(multiviewColumnCount(4, 'auto')).toBe(2);
    expect(multiviewColumnCount(5, 'auto')).toBe(3);
    expect(multiviewColumnCount(9, 'auto')).toBe(3);
  });

  it('rows is always a single column', () => {
    for (const n of [2, 4, 5, 12]) {
      expect(multiviewColumnCount(n, 'rows')).toBe(1);
    }
  });

  it('columns is always one column per tile', () => {
    for (const n of [2, 4, 5, 12]) {
      expect(multiviewColumnCount(n, 'columns')).toBe(n);
    }
  });

  it('never returns a count below 1', () => {
    // The grid only renders at >=2 tiles, but a helper that can emit
    // `repeat(0, ...)` is a CSS foot-gun waiting for the next caller.
    for (const arrangement of MULTIVIEW_ARRANGEMENTS) {
      expect(multiviewColumnCount(0, arrangement)).toBeGreaterThanOrEqual(1);
    }
  });

  it('falls back to auto for an unrecognized arrangement', () => {
    // A session file written by a future build naming a fourth mode must
    // degrade to the old grid, not blank it.
    // @ts-expect-error — deliberately outside the union
    expect(multiviewColumnCount(4, 'masonry')).toBe(2);
  });
});

describe('multiviewGridStyle', () => {
  // Counting columns is only half of "the default is unchanged". A floor or a
  // scroll container on `auto` changes the rendered layout — and the PTY size —
  // for anyone whose terminal area is narrower than cols x 320px, purely by
  // upgrading. These assertions pin the exact tracks, not just the count.
  it('auto emits bare 1fr tracks and never scrolls', () => {
    for (const n of [2, 3, 4, 5, 9]) {
      const style = multiviewGridStyle(n, 'auto');
      expect(style.gridTemplateColumns).toBe(`repeat(${n <= 4 ? 2 : 3}, 1fr)`);
      expect(style.gridAutoRows).toBe('1fr');
      expect(style.overflow).toBeUndefined();
    }
  });

  it('columns floors the track width and scrolls', () => {
    const style = multiviewGridStyle(6, 'columns');
    expect(style.gridTemplateColumns).toBe('repeat(6, minmax(320px, 1fr))');
    expect(style.overflow).toBe('auto');
  });

  it('rows is a single floored column that scrolls', () => {
    const style = multiviewGridStyle(6, 'rows');
    expect(style.gridTemplateColumns).toBe('repeat(1, minmax(320px, 1fr))');
    expect(style.gridAutoRows).toBe('minmax(200px, 1fr)');
    expect(style.overflow).toBe('auto');
  });
});

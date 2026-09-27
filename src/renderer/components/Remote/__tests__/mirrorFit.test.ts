// The arithmetic behind the remote mirror's fit. Pure — no DOM — because jsdom
// reports every layout box as 0×0, so the numbers cannot be checked through the
// component.
//
// The bug this guards: the mirror renders the REMOTE's grid at the LOCAL font
// size, so a remote pane bigger than its cell overflowed and was cropped
// top-left. A TUI's input box lives on the last rows, so the crop took the
// prompt. Every case below is one of the ways that fit can go wrong.

import { describe, it, expect } from 'vitest';
import {
  computeMirrorFontSize, computeMirrorGeometry, mirrorFitKey, mirrorResizeRequestKey,
  shouldRequestRemoteResize, MAX_FIT_PASSES, MIN_MIRROR_FONT_SIZE, type MirrorFitInput,
} from '../mirrorFit';

/** A 80×24 remote grid rendered at 14px into a box that comfortably holds it. */
function fitting(over: Partial<MirrorFitInput> = {}): MirrorFitInput {
  return {
    boxWidth: 1000,
    boxHeight: 600,
    cols: 80,
    rows: 24,
    renderedWidth: 700,   // 80 cols × 8.75px
    renderedHeight: 400,  // 24 rows × ~16.7px
    currentFontSize: 14,
    maxFontSize: 14,
    ...over,
  };
}

describe('computeMirrorFontSize', () => {
  it('leaves the user font alone when the remote grid already fits', () => {
    expect(computeMirrorFontSize(fitting()).fontSize).toBe(14);
  });

  it('never grows past the user setting, even in a huge box', () => {
    const { fontSize } = computeMirrorFontSize(fitting({ boxWidth: 99999, boxHeight: 99999 }));
    expect(fontSize).toBe(14);
  });

  // The reported symptom: a wide remote pane in a narrower local cell. Before
  // the fit this cropped the right-hand columns.
  it('shrinks to fit a grid that is too wide', () => {
    const { fontSize } = computeMirrorFontSize(fitting({ boxWidth: 350 }));
    // 350/700 of 14px = 7px, and the result must not exceed that.
    expect(fontSize).toBe(7);
    // The predicted render at the new size fits the box.
    expect((700 / 14) * fontSize!).toBeLessThanOrEqual(350);
  });

  // The other half of the same symptom: the rows carrying the TUI's input box.
  it('shrinks to fit a grid that is too tall', () => {
    const { fontSize } = computeMirrorFontSize(fitting({ boxHeight: 200 }));
    expect(fontSize).toBe(7);
    expect((400 / 14) * fontSize!).toBeLessThanOrEqual(200);
  });

  it('takes the tighter of the two axes', () => {
    // Width alone would allow 7px, height alone 3.5px. Height wins.
    const { fontSize } = computeMirrorFontSize(fitting({ boxWidth: 350, boxHeight: 100 }));
    expect(fontSize).toBe(MIN_MIRROR_FONT_SIZE);
  });

  it('floors at MIN_MIRROR_FONT_SIZE rather than shrinking into illegibility', () => {
    const { fontSize } = computeMirrorFontSize(fitting({ boxWidth: 70 }));
    expect(fontSize).toBe(MIN_MIRROR_FONT_SIZE);
  });

  // A settings value restored from a corrupt session is not validated on its
  // way into the store. Taking a zero ceiling literally would pin the fit below
  // its own floor and disable it for good, with no symptom but the old crop.
  it('treats a nonsense maxFontSize as the floor, not as a disabled fit', () => {
    const { fontSize } = computeMirrorFontSize(fitting({ boxWidth: 350, maxFontSize: 0 }));
    expect(fontSize).toBe(MIN_MIRROR_FONT_SIZE);
  });

  it('declines on non-finite measurements instead of assigning NaN', () => {
    expect(computeMirrorFontSize(fitting({ boxWidth: NaN })).fontSize).toBeNull();
    expect(computeMirrorFontSize(fitting({ renderedWidth: Infinity })).fontSize).toBeNull();
  });

  it('quantises DOWN — rounding up would put the overflow back', () => {
    // 999/700 × 14 = 19.98 → capped by maxFontSize, so raise the cap to see it.
    const { fontSize } = computeMirrorFontSize(fitting({ boxWidth: 699, maxFontSize: 100 }));
    expect(fontSize! % 0.5).toBe(0);
    expect((700 / 14) * fontSize!).toBeLessThanOrEqual(699);
  });

  // A mirror in a non-active workspace sits inside `display:none`, where every
  // measurement is 0. Deciding from those numbers would assign NaN or 0.
  it.each([
    ['hidden box', { boxWidth: 0, boxHeight: 0 }],
    ['unrendered terminal', { renderedWidth: 0, renderedHeight: 0 }],
    ['degenerate grid', { cols: 0 }],
    ['no current font size', { currentFontSize: 0 }],
  ] as Array<[string, Partial<MirrorFitInput>]>)('declines to decide: %s', (_label, over) => {
    expect(computeMirrorFontSize(fitting(over)).fontSize).toBeNull();
  });

  // Termination. Cell metrics are a staircase in font size (xterm rounds through
  // ceil/floor and the DPR), so a second pass measured at the smaller font can
  // predict that a LARGER font would fit. Accepting that is an infinite
  // shrink/grow cycle; refusing it is what makes the loop settle.
  it('refuses to grow again on a later pass for the same box', () => {
    const settled = computeMirrorFontSize(fitting({ boxWidth: 350 })).fontSize!;
    expect(settled).toBe(7);
    // Re-measured at 7px the grid now looks small, so the naive prediction is
    // "14px fits". With settledFontSize present that answer is rejected.
    const second = computeMirrorFontSize(fitting({
      boxWidth: 350,
      renderedWidth: 340,
      renderedHeight: 195,
      currentFontSize: 7,
      settledFontSize: settled,
    }));
    expect(second.fontSize).toBeNull();
  });

  // The "nothing to change" pass still has to arm the guard. If the caller only
  // recorded a settled size when it actually assigned one, the pass that agrees
  // with the current size would leave the next one unguarded and free to grow.
  it('returns the current size (not null) when it is already correct, so the caller can settle it', () => {
    const { fontSize } = computeMirrorFontSize(fitting({
      boxWidth: 700,
      renderedWidth: 700,
      renderedHeight: 400,
      boxHeight: 400,
    }));
    expect(fontSize).toBe(14);
  });

  it('still shrinks further on a later pass when the grid overflows', () => {
    const second = computeMirrorFontSize(fitting({
      boxWidth: 350,
      renderedWidth: 380, // the staircase overshot — still too wide at 7px
      renderedHeight: 200,
      currentFontSize: 7,
      settledFontSize: 7,
    }));
    expect(second.fontSize).toBeLessThan(7);
  });
});

// #1322 — the geometry a real PTY resize should target, as opposed to the
// font-shrink `computeMirrorFontSize` falls back to when the daemon refuses
// (or a request cannot be made at all). Same 80×24-at-14px baseline as above,
// but the box is pinned to the RENDERED size (700×400 — `fitting()`'s default
// 1000×600 box is deliberately roomier, which is exactly what
// `computeMirrorFontSize`'s own tests exploit; pinning it here isolates cols
// from rows in each case): renderedWidth 700 / 80 cols = 8.75px/cell,
// renderedHeight 400 / 24 rows = 16.667px/cell.
describe('computeMirrorGeometry', () => {
  it('answers the current grid when the box already matches its natural render size', () => {
    const geometry = computeMirrorGeometry(fitting({ boxWidth: 700, boxHeight: 400 }));
    expect(geometry).toEqual({ cols: 80, rows: 24 });
  });

  it('grows past the current grid when the box has more room than the grid uses', () => {
    // Width doubled: 1400 / 8.75 = 160.
    const geometry = computeMirrorGeometry(fitting({ boxWidth: 1400, boxHeight: 400 }));
    expect(geometry).toEqual({ cols: 160, rows: 24 });
  });

  it('shrinks the TARGET GRID (not the font) when the box is smaller than the remote grid', () => {
    // 350 / 8.75 = 40.
    const geometry = computeMirrorGeometry(fitting({ boxWidth: 350, boxHeight: 400 }));
    expect(geometry).toEqual({ cols: 40, rows: 24 });
  });

  it('extrapolates cell size to maxFontSize, not to the current (already-shrunk) font', () => {
    // Rendered at a shrunk 7px (half the 14px baseline cell), so cells here are
    // half as large — extrapolating to maxFontSize=14 should land back on the
    // same per-cell size as the unshrunk baseline.
    const geometry = computeMirrorGeometry(fitting({
      boxWidth: 700,
      boxHeight: 400,
      renderedWidth: 350,
      renderedHeight: 200,
      currentFontSize: 7,
      maxFontSize: 14,
    }));
    expect(geometry).toEqual({ cols: 80, rows: 24 });
  });

  it('declines when the box cannot fit even one cell', () => {
    expect(computeMirrorGeometry(fitting({ boxWidth: 5, boxHeight: 400 }))).toBeNull();
  });

  it.each([
    ['hidden box', { boxWidth: 0, boxHeight: 0 }],
    ['unrendered terminal', { renderedWidth: 0, renderedHeight: 0 }],
    ['degenerate grid', { cols: 0 }],
    ['no current font size', { currentFontSize: 0 }],
  ] as Array<[string, Partial<MirrorFitInput>]>)('declines to decide: %s', (_label, over) => {
    expect(computeMirrorGeometry(fitting(over))).toBeNull();
  });
});

// The key is the fit's restart signal: while it holds, growing is forbidden.
// Anything missing from it is an input whose change the fit silently ignores.
describe('mirrorFitKey', () => {
  const base = { boxWidth: 800, boxHeight: 400, cols: 80, rows: 24, maxFontSize: 14, fontFamily: 'Cascadia Code' };

  it.each([
    ['box width', { boxWidth: 801 }],
    ['box height', { boxHeight: 401 }],
    ['remote cols', { cols: 120 }],
    ['remote rows', { rows: 40 }],
    ['the user font size', { maxFontSize: 16 }],
    // The regression this exists for: a different face has different cell
    // metrics, so without it a switch to a wider font keeps the shrink guard
    // holding the old answer and the grid overflows its box again.
    ['the user font family', { fontFamily: 'IBM Plex Mono' }],
  ] as Array<[string, Partial<typeof base>]>)('changes when %s changes', (_label, over) => {
    expect(mirrorFitKey({ ...base, ...over })).not.toBe(mirrorFitKey(base));
  });

  it('is stable for identical inputs', () => {
    expect(mirrorFitKey({ ...base })).toBe(mirrorFitKey({ ...base }));
  });
});

// The resize request's de-dup key. Unlike `mirrorFitKey` it must NOT carry the
// remote grid: a grant changes the remote grid, and a key that moved with it
// re-armed the request on every grant — a mirror asking again for the answer
// it had just been given, against a slightly different font each time.
describe('mirrorResizeRequestKey', () => {
  const base = { boxWidth: 800, boxHeight: 400, maxFontSize: 14, fontFamily: 'Cascadia Code' };

  it.each([
    ['box width', { boxWidth: 801 }],
    ['box height', { boxHeight: 401 }],
    ['the user font size', { maxFontSize: 16 }],
    ['the user font family', { fontFamily: 'IBM Plex Mono' }],
  ] as Array<[string, Partial<typeof base>]>)('changes when %s changes', (_label, over) => {
    expect(mirrorResizeRequestKey({ ...base, ...over })).not.toBe(mirrorResizeRequestKey(base));
  });

  it('has no remote-grid input at all', () => {
    // Structural: a caller cannot make it depend on cols/rows by accident.
    expect(mirrorResizeRequestKey({ ...base, ...({ cols: 120, rows: 40 } as object) }))
      .toBe(mirrorResizeRequestKey(base));
  });
});

describe('shouldRequestRemoteResize', () => {
  it('ignores a one-cell difference in either axis', () => {
    expect(shouldRequestRemoteResize({ cols: 81, rows: 25 }, 80, 24)).toBe(false);
    expect(shouldRequestRemoteResize({ cols: 79, rows: 23 }, 80, 24)).toBe(false);
  });

  it('asks when either axis is off by more than one cell', () => {
    expect(shouldRequestRemoteResize({ cols: 82, rows: 24 }, 80, 24)).toBe(true);
    expect(shouldRequestRemoteResize({ cols: 80, rows: 21 }, 80, 24)).toBe(true);
  });
});

// The live bug (remote mirror "breathing"): xterm's cell size is a staircase in
// the font size — `ceil(charWidth × dpr)`, `floor(charHeight × lineHeight)` —
// so a cell size extrapolated linearly from a SHRUNK font lands a cell or two
// away from the real cell size at the user's font. Each grant changed the grid,
// the font fit then changed the font, and the next extrapolation (from the new
// font) asked for the previous grid. Model: dpr 1, a 0.6021em-wide face at
// line-height 1.0 — shapes measured from a real mirror, not tuned to the test.
describe('remote resize loop (stepped cell model)', () => {
  const cellW = (f: number) => Math.ceil(0.6021 * f);
  const cellH = (f: number) => Math.floor(Math.ceil(1.1719 * f));
  const box = { boxWidth: 448, boxHeight: 726 };
  const ceiling = 12.5;

  /** What `runFit`'s font half does to one grid: pass → measure → pass. */
  function fitFont(cols: number, rows: number, font: number): number {
    let settled: number | undefined;
    for (let pass = 0; pass < MAX_FIT_PASSES; pass++) {
      const { fontSize } = computeMirrorFontSize({
        ...box, cols, rows,
        renderedWidth: cols * cellW(font), renderedHeight: rows * cellH(font),
        currentFontSize: font, maxFontSize: ceiling, settledFontSize: settled,
      });
      if (fontSize === null) break;
      settled = fontSize;
      if (fontSize === font) break;
      font = fontSize;
    }
    return font;
  }

  it('a font-extrapolated ideal depends on the current font; the ceiling cell does not', () => {
    const at = (font: number, ceilingCell?: { width: number; height: number }) => computeMirrorGeometry({
      ...box, cols: 53, rows: 46,
      renderedWidth: 53 * cellW(font), renderedHeight: 46 * cellH(font),
      currentFontSize: font, maxFontSize: ceiling, ceilingCell,
    });
    // Two fonts, two different "ideal" grids for one unchanged box — the seed
    // of the oscillation.
    expect(at(12)).not.toEqual(at(12.5));
    // Measured at the ceiling, the answer is a property of the box alone.
    const real = { width: cellW(ceiling), height: cellH(ceiling) };
    expect(at(12, real)).toEqual(at(12.5, real));
    expect(at(12, real)).toEqual({ cols: 56, rows: 48 });
  });

  it('settles after at most one request per box, where a per-grant re-request oscillated', () => {
    // Replays runFit's request policy against a remote that grants every ask
    // (the daemon does when the host's own pane is not visible).
    function simulate(policy: 'per-grant' | 'per-box'): string[] {
      let cols = 36;
      let rows = 44;
      let font = fitFont(cols, rows, ceiling);
      let lastKey: string | null = null;
      let ceilingCell: { width: number; height: number } | undefined;
      const asked: string[] = [];
      for (let i = 0; i < 10; i++) {
        if (font === ceiling) ceilingCell = { width: cellW(font), height: cellH(font) };
        const key = policy === 'per-grant'
          ? mirrorFitKey({ ...box, cols, rows, maxFontSize: ceiling, fontFamily: 'f' })
          : mirrorResizeRequestKey({ ...box, maxFontSize: ceiling, fontFamily: 'f' });
        if (key === lastKey) break;
        lastKey = key;
        const ideal = computeMirrorGeometry({
          ...box, cols, rows,
          renderedWidth: cols * cellW(font), renderedHeight: rows * cellH(font),
          currentFontSize: font, maxFontSize: ceiling,
          ceilingCell: policy === 'per-box' ? ceilingCell : undefined,
        });
        const wants = policy === 'per-box'
          ? ideal !== null && shouldRequestRemoteResize(ideal, cols, rows)
          : ideal !== null && (ideal.cols !== cols || ideal.rows !== rows);
        if (!ideal || !wants) break;
        asked.push(`${ideal.cols}x${ideal.rows}`);
        cols = ideal.cols; // granted → the remote grid changes …
        rows = ideal.rows;
        font = fitFont(cols, rows, font); // … and the font refits to it
      }
      return asked;
    }

    // The pre-fix policy never stops: it alternates between two grids.
    const before = simulate('per-grant');
    expect(before.length).toBe(10);
    expect(new Set(before.slice(-4)).size).toBe(2);
    // The fix: one request for this box, for the grid the box really holds.
    expect(simulate('per-box')).toEqual(['56x48']);
  });
});

// The arithmetic behind the remote mirror's fit. Pure — no DOM — because jsdom
// reports every layout box as 0×0, so the numbers cannot be checked through the
// component.
//
// The bug this guards: the mirror renders the REMOTE's grid at the LOCAL font
// size, so a remote pane bigger than its cell overflowed and was cropped
// top-left. A TUI's input box lives on the last rows, so the crop took the
// prompt. Every case below is one of the ways that fit can go wrong.

import { describe, it, expect } from 'vitest';
import { computeMirrorFontSize, MIN_MIRROR_FONT_SIZE, type MirrorFitInput } from '../mirrorFit';

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
    const { fontSize, clamped } = computeMirrorFontSize(fitting({ boxWidth: 350 }));
    // 350/700 of 14px = 7px, and the result must not exceed that.
    expect(fontSize).toBe(7);
    expect(clamped).toBe(false);
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

  it('floors at MIN_MIRROR_FONT_SIZE and reports the overflow as clamped', () => {
    const { fontSize, clamped } = computeMirrorFontSize(fitting({ boxWidth: 70 }));
    expect(fontSize).toBe(MIN_MIRROR_FONT_SIZE);
    expect(clamped).toBe(true);
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

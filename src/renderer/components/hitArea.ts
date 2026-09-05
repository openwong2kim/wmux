/**
 * Minimum pointer target for chrome controls.
 *
 * The chrome is drawn with small glyphs on purpose (DESIGN.md: 10–13px meta
 * type, tight radii, "chrome recedes and frames"), but a glyph is not a target:
 * a 2026-09 audit of the packaged app at 1280x800 found 66 interactive elements
 * whose box was under 24px in one dimension — the pane tab close (7px wide),
 * the workspace row's hover actions (13px), the dock toggle (20px). WCAG 2.2
 * SC 2.5.8 ("Target Size (Minimum)") puts the floor at 24px.
 *
 * These two class recipes raise the BOX without touching the glyph, so nothing
 * about the drawing changes — only what the pointer can land on.
 */

/**
 * A full 24x24 target. Use where the row has the room to spend (a 36px chrome
 * strip, a footer, a right-aligned cluster).
 *
 * Arbitrary values rather than the `min-w-6` scale utility so the recipe does
 * not depend on which Tailwind minor is installed.
 */
export const HIT_TARGET_24 =
  'inline-flex items-center justify-center min-w-[24px] min-h-[24px]';

/**
 * The same 24x24 box in a dense row that cannot spend 11 extra pixels per
 * control — the 240px sidebar row, where the name column already lost half its
 * width once (#997). The growth is paid back with a -6px margin on all four
 * sides, so the control's LAYOUT footprint stays 12px plus whatever gap the row
 * already had, while its hit box is the full 24.
 *
 * Consequence, accepted: with an 8px row gap two neighbouring boxes overlap by
 * 4px, and the later sibling wins that strip — so an inner control of a cluster
 * is reliably clickable across 20px rather than 24. That is still every pixel
 * the row has to give, and it beats the 13px it was.
 *
 * A call site adopting this must DROP its own margin utilities (`mt-0.5`,
 * `ml-1`, …): they are the same specificity as `-m-1.5` and would silently win
 * or lose depending on stylesheet order.
 */
export const HIT_TARGET_24_TIGHT = `${HIT_TARGET_24} -m-1.5`;

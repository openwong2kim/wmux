/**
 * Geometry shared between the pane's absolutely-positioned corner controls
 * (Pane.tsx) and the header strip that has to leave room for them
 * (SurfaceTabs.tsx).
 *
 * These numbers used to be hand-mirrored in three places — the control's own
 * `style`, the strip's clearance arithmetic, and the test's restatement of
 * both. Three copies of one measurement is three chances to drift, and the
 * drift is invisible until something lands on top of something else. One
 * export, imported by everyone who needs it, is the whole point of this file.
 */

/** Gutter every corner control keeps from the pane's right edge. */
export const PANE_CORNER_GUTTER = 6;

/** Rendered width of a corner icon button (the ⤢ maximize / ⤡ un-zoom pair):
 *  a 12px glyph in 5px side padding, plus its 1px border on each side. */
export const PANE_CORNER_BTN_WIDTH = 24;

/**
 * How much room the header strip's LAST flow item must leave to its right.
 *
 * The corner zoom/maximize button is the only control still drawn absolutely
 * over the strip, and it exists only when the action cluster is hidden — with
 * a cluster (full or overflow) the zoom verb lives inside it, so the strip's
 * own flow content runs all the way to the edge and needs no reservation.
 *
 * Everything else that used to sit in that corner — the supervision badge, the
 * role-enforced model badge — is laid out in the strip's flow now, precisely so
 * that this function does not have to know about it.
 */
export function paneHeaderTailGap(opts: { clusterShown: boolean }): number {
  return opts.clusterShown ? 0 : PANE_CORNER_GUTTER + PANE_CORNER_BTN_WIDTH;
}

/**
 * Minimum pointer target for chrome controls.
 *
 * The chrome is drawn with small glyphs on purpose (DESIGN.md: 10-13px meta
 * type, tight radii, "chrome recedes and frames"), but a glyph is not a target:
 * a 2026-09 audit of the packaged app at 1280x800 found 66 interactive elements
 * whose box was under 24px in one dimension — the pane tab close (7px wide),
 * the workspace row's hover actions (13px), the dock toggle (20px). WCAG 2.2
 * SC 2.5.8 ("Target Size (Minimum)") puts the floor at 24px.
 *
 * These recipes raise the BOX without touching the glyph.
 *
 * ─── The rule that shapes all of them ───────────────────────────────────────
 * A box wider than the space it reserves reaches OVER whatever sits beside it,
 * and the later sibling wins the pointer. The first cut of this file refunded
 * the extra width with a symmetric `-m-1.5` on every control, which meant the
 * workspace row's destructive close button silently owned the right 4px of the
 * copy button next to it. So:
 *
 *   - vertical refunds are fine — a row is short, and nothing interactive lives
 *     directly above or below a control inside one;
 *   - a horizontal refund is only legal when something gives the width back at
 *     the same time. That is what HIT_TARGET_24_CLUSTER does, and it is the
 *     only place HIT_TARGET_24_IN_CLUSTER may be used.
 *
 * Arbitrary values rather than the `min-w-6` scale utility so the recipes do
 * not depend on which Tailwind minor is installed.
 */

/** A full 24x24 target, costing its full 24px. The default; prefer it. */
export const HIT_TARGET_24 =
  'inline-flex items-center justify-center min-w-[24px] min-h-[24px]';

/**
 * 24x24 in a row shorter than 24px. The extra HEIGHT is refunded so the row
 * keeps the height it had; the width is paid in full, so the box never reaches
 * over a neighbour.
 *
 * `self-center` is part of the recipe, not a call-site decision: these rows are
 * `items-start` (the name column can wrap to two lines), and a taller box
 * pinned to the top puts the glyph above the text it belongs to. Centred, the
 * 12px margin box lands the glyph exactly on the 15.4px caption line's middle.
 */
export const HIT_TARGET_24_ROW = `${HIT_TARGET_24} self-center -my-1.5`;

/**
 * Wrapper for a run of adjacent 24px controls in a row too narrow for three of
 * them side by side (the 240px sidebar row, whose name column already lost half
 * its width once — #997).
 *
 * The `gap-3` is load-bearing: 12px is exactly the width the two `-mx-1.5`
 * refunds on each member give back, so consecutive boxes TILE — edge to edge,
 * never overlapping. Change one of the two numbers and you must change the
 * other; hitArea.test.ts asserts the identity rather than trusting a comment.
 */
export const HIT_TARGET_24_CLUSTER = 'flex items-center self-center gap-3 -my-1.5';

/**
 * A member of HIT_TARGET_24_CLUSTER, and valid nowhere else — outside one, the
 * side refunds are exactly the overlap this file exists to prevent.
 */
export const HIT_TARGET_24_IN_CLUSTER = `${HIT_TARGET_24} -mx-1.5`;

/** Refund width, in px, that one clustered member takes off each of its sides. */
export const CLUSTER_SIDE_REFUND_PX = 6;
/** Gap the cluster puts back between two members. Must be twice the refund. */
export const CLUSTER_GAP_PX = 12;

/**
 * The one piece of pane-header geometry that is still arithmetic.
 *
 * Everything that used to be absolutely positioned over the header's right end
 * — the supervision badge, the role-enforced model badge — is laid out in the
 * strip's flow now, so nothing has to compute a `right` for it. What survives
 * is the corner zoom/maximize button, which really is drawn over the strip, and
 * only when the action cluster is hidden.
 */
import { describe, it, expect } from 'vitest';
import {
  PANE_CORNER_BTN_WIDTH,
  PANE_CORNER_GUTTER,
  paneHeaderTailGap,
} from '../paneChrome';

describe('paneHeaderTailGap', () => {
  it('reserves nothing when the action cluster is shown', () => {
    // The cluster is a flow sibling and it owns the zoom verb, so there is no
    // absolute control over the strip at all in this case.
    expect(paneHeaderTailGap({ clusterShown: true })).toBe(0);
  });

  it('clears the whole corner button, gutter included, when the cluster is hidden', () => {
    expect(paneHeaderTailGap({ clusterShown: false }))
      .toBe(PANE_CORNER_GUTTER + PANE_CORNER_BTN_WIDTH);
  });

  it('leaves the button fully clear of the strip, not merely touching it', () => {
    // The button's own box is [right: GUTTER, GUTTER + WIDTH] from the edge.
    // The gap has to cover all of it — an off-by-the-gutter here is exactly how
    // the old badge ended up sitting on a control.
    const gap = paneHeaderTailGap({ clusterShown: false });
    expect(gap).toBeGreaterThanOrEqual(PANE_CORNER_GUTTER + PANE_CORNER_BTN_WIDTH);
  });
});

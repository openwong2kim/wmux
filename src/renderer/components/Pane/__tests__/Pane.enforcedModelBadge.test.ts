/**
 * D2 — the pane's role-enforced model badge.
 *
 * The badge originally rendered at `top:4; right:6; zIndex:20` — the exact
 * coordinates of the zoom/maximize control and the supervision badge — with
 * `pointerEvents:'none'`, so it made those buttons invisible but still
 * clickable. It also rendered on non-terminal surfaces. Both gates are pure
 * helpers so they can be asserted without a DOM (same pattern as
 * composePaneClassName).
 *
 * The badge is laid out in the header flow now — see
 * SurfaceTabs.enforcedModelBadge.test.tsx for the toggle overlap those absolute
 * coordinates caused. The two gates below decide only WHETHER it is drawn,
 * which is unchanged, and the arithmetic survives as the margin it reserves for
 * the corner controls flow layout still cannot see.
 */
import { describe, it, expect } from 'vitest';
import {
  enforcedModelBadgeGap,
  isTerminalSurfaceType,
  showsEnforcedModelBadge,
  PANE_ACTIONS_CLUSTER_WIDTH,
} from '../SurfaceTabs';

describe('isTerminalSurfaceType — the badge only claims a terminal', () => {
  it('accepts a terminal surface and the legacy undefined shape', () => {
    expect(isTerminalSurfaceType('terminal')).toBe(true);
    expect(isTerminalSurfaceType(undefined)).toBe(true);
  });

  it('rejects every non-terminal surface type', () => {
    for (const st of ['browser', 'editor', 'diff', 'git', 'review']) {
      expect(isTerminalSurfaceType(st)).toBe(false);
    }
  });
});

// P2-B — the badge used to render whenever a model was CONFIGURED, so a binding
// the launch path deliberately ignores (model with no agent; an agent with no
// verified --model grammar) told the operator a pane was pinned while it
// launched on the default.
describe('showsEnforcedModelBadge — only claims a model wmux really injects', () => {
  it('shows for a binding the rewrite actually applies', () => {
    expect(showsEnforcedModelBadge({
      binding: { agent: 'claude', model: 'haiku' },
      surfaceType: 'terminal',
    })).toBe(true);
    expect(showsEnforcedModelBadge({
      binding: { agent: 'codex', model: 'gpt-5.5' },
      surfaceType: undefined,
    })).toBe(true);
  });

  it('stays silent for a model with no agent', () => {
    expect(showsEnforcedModelBadge({ binding: { model: 'haiku' }, surfaceType: 'terminal' }))
      .toBe(false);
  });

  it('stays silent for an agent whose --model grammar is unverified', () => {
    for (const agent of ['opencode', 'gemini', 'aider']) {
      expect(showsEnforcedModelBadge({ binding: { agent, model: 'x' }, surfaceType: 'terminal' }))
        .toBe(false);
    }
  });

  it('stays silent when there is no model to claim at all', () => {
    expect(showsEnforcedModelBadge({ binding: undefined, surfaceType: 'terminal' })).toBe(false);
    expect(showsEnforcedModelBadge({ binding: { agent: 'claude' }, surfaceType: 'terminal' }))
      .toBe(false);
    // Args-only IS enforced, but the badge shows a model — and there is none.
    expect(showsEnforcedModelBadge({
      binding: { agent: 'claude', args: '--verbose' },
      surfaceType: 'terminal',
    })).toBe(false);
  });

  it('stays silent on a surface that cannot launch an agent', () => {
    for (const surfaceType of ['browser', 'editor', 'diff']) {
      expect(showsEnforcedModelBadge({ binding: { agent: 'claude', model: 'haiku' }, surfaceType }))
        .toBe(false);
    }
  });
});

// The badge sits in the header flow now, so it no longer computes its own
// `right`. What survived the move is the reason the arithmetic existed: the
// strip's top-right corner still carries ABSOLUTELY-positioned controls that
// flow layout cannot see (the supervision ⟳ badge, the corner zoom/maximize
// button), and the badge has to leave room for whichever is present. These are
// the old offset assertions, restated against the margin — the numbers drop by
// the action cluster's width, which is a flow sibling the badge no longer has
// to step over.
describe('enforcedModelBadgeGap — always clears the absolute corner controls', () => {
  /** The `right` each absolute control claims, mirrored from Pane.tsx. */
  const zoomBtn = 6;
  const maximizeBtn = (supervised: boolean) => (supervised ? 32 : 6);
  /** Same, relative to the cluster's left edge when the cluster is shown. */
  const supervisionBadge = (clusterShown: boolean, isZoomed: boolean) =>
    clusterShown ? 6 : isZoomed ? 54 : 6;

  it('reserves nothing for the action cluster — that one is a flow sibling', () => {
    expect(enforcedModelBadgeGap({ mode: 'full', isZoomed: false, supervised: false }))
      .toBeLessThan(PANE_ACTIONS_CLUSTER_WIDTH);
  });

  it('clears the supervision badge parked beside the action cluster', () => {
    const gap = enforcedModelBadgeGap({ mode: 'full', isZoomed: false, supervised: true });
    expect(gap).toBeGreaterThan(supervisionBadge(true, false));
  });

  it('clears the corner zoom/maximize button when the cluster is hidden', () => {
    for (const isZoomed of [true, false]) {
      const gap = enforcedModelBadgeGap({ mode: 'none', isZoomed, supervised: false });
      expect(gap).toBeGreaterThan(isZoomed ? zoomBtn : maximizeBtn(false));
    }
  });

  it('clears BOTH the button and the supervision badge when supervised', () => {
    const zoomedGap = enforcedModelBadgeGap({ mode: 'none', isZoomed: true, supervised: true });
    expect(zoomedGap).toBeGreaterThan(supervisionBadge(false, true));
    expect(zoomedGap).toBeGreaterThan(zoomBtn);

    const unzoomedGap = enforcedModelBadgeGap({ mode: 'none', isZoomed: false, supervised: true });
    expect(unzoomedGap).toBeGreaterThan(maximizeBtn(true));
    expect(unzoomedGap).toBeGreaterThan(supervisionBadge(false, false));
  });

  // The old absolute version asserted `right` was never the bare corner (6),
  // because 6 meant "on top of the zoom button". As a MARGIN, 6 is the correct
  // answer whenever nothing absolute is in the way — it is just the gutter. So
  // the invariant is restated: leave more than the gutter exactly when a
  // control is actually there to clear, and never less than the gutter.
  it('reserves more than the gutter exactly when an absolute control is present', () => {
    for (const mode of ['full', 'overflow', 'none'] as const) {
      for (const isZoomed of [true, false]) {
        for (const supervised of [true, false]) {
          const gap = enforcedModelBadgeGap({ mode, isZoomed, supervised });
          // Supervised → the ⟳ badge. Cluster hidden → the corner zoom/maximize.
          const hasAbsoluteNeighbour = supervised || mode === 'none';
          expect(gap).toBeGreaterThanOrEqual(6);
          expect(gap > 6).toBe(hasAbsoluteNeighbour);
        }
      }
    }
  });
});

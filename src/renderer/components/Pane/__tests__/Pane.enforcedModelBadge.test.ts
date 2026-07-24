/**
 * D2 — the pane's role-enforced model badge.
 *
 * The badge originally rendered at `top:4; right:6; zIndex:20` — the exact
 * coordinates of the zoom/maximize control and the supervision badge — with
 * `pointerEvents:'none'`, so it made those buttons invisible but still
 * clickable. It also rendered on non-terminal surfaces. Both gates are pure
 * helpers so they can be asserted without a DOM (same pattern as
 * composePaneClassName).
 */
import { describe, it, expect } from 'vitest';
import { enforcedModelBadgeOffset, isTerminalSurfaceType, showsEnforcedModelBadge } from '../Pane';
import { PANE_ACTIONS_CLUSTER_WIDTH } from '../SurfaceTabs';

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

describe('enforcedModelBadgeOffset — never lands on a corner control', () => {
  /** The `right` each existing control claims, mirrored from Pane.tsx. */
  const zoomBtn = 6;
  const maximizeBtn = (supervised: boolean) => (supervised ? 32 : 6);
  const supervisionBadge = (paneActionsVisible: boolean, isZoomed: boolean) =>
    paneActionsVisible ? PANE_ACTIONS_CLUSTER_WIDTH + 6 : isZoomed ? 54 : 6;

  it('clears the action cluster when it is visible', () => {
    expect(enforcedModelBadgeOffset({ paneActionsVisible: true, isZoomed: false, supervised: false }))
      .toBeGreaterThan(PANE_ACTIONS_CLUSTER_WIDTH);
  });

  it('clears the supervision badge parked beside the action cluster', () => {
    const offset = enforcedModelBadgeOffset({
      paneActionsVisible: true,
      isZoomed: false,
      supervised: true,
    });
    expect(offset).toBeGreaterThan(supervisionBadge(true, false));
  });

  it('clears the corner zoom/maximize button when the cluster is hidden', () => {
    for (const isZoomed of [true, false]) {
      const offset = enforcedModelBadgeOffset({ paneActionsVisible: false, isZoomed, supervised: false });
      expect(offset).toBeGreaterThan(isZoomed ? zoomBtn : maximizeBtn(false));
    }
  });

  it('clears BOTH the button and the supervision badge when supervised', () => {
    const zoomedOffset = enforcedModelBadgeOffset({
      paneActionsVisible: false,
      isZoomed: true,
      supervised: true,
    });
    expect(zoomedOffset).toBeGreaterThan(supervisionBadge(false, true));
    expect(zoomedOffset).toBeGreaterThan(zoomBtn);

    const unzoomedOffset = enforcedModelBadgeOffset({
      paneActionsVisible: false,
      isZoomed: false,
      supervised: true,
    });
    expect(unzoomedOffset).toBeGreaterThan(maximizeBtn(true));
    expect(unzoomedOffset).toBeGreaterThan(supervisionBadge(false, false));
  });

  it('never returns the bare corner (right: 6) — the original collision', () => {
    for (const paneActionsVisible of [true, false]) {
      for (const isZoomed of [true, false]) {
        for (const supervised of [true, false]) {
          expect(
            enforcedModelBadgeOffset({ paneActionsVisible, isZoomed, supervised }),
          ).toBeGreaterThan(6);
        }
      }
    }
  });
});

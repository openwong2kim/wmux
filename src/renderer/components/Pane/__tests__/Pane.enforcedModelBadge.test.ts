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
 * coordinates caused, and paneChrome.test.ts for the one clearance that is
 * still arithmetic. The two gates below decide only WHETHER the badge is drawn,
 * which is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { isTerminalSurfaceType, showsEnforcedModelBadge } from '../SurfaceTabs';

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

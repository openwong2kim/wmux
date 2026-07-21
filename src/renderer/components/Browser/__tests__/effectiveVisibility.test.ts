import { describe, it, expect } from 'vitest';
import { computeEffectiveVisibility } from '../BrowserPanel';

// #517: effective visibility = shown ∧ workspace-visible ∧ window-shown ∧
// not zoom-hidden (tree-scoped, codex P2) ∧ not overlay-occluded (codex P3).
describe('computeEffectiveVisibility (#517)', () => {
  const base = {
    shown: true,
    isWorkspaceVisible: true,
    windowVisible: true,
    isZoomHidden: false,
    occluded: false,
  };

  it('all-visible → true', () => {
    expect(computeEffectiveVisibility(base)).toBe(true);
  });

  it('hidden workspace → false (the multi-workspace case the issue is about)', () => {
    expect(computeEffectiveVisibility({ ...base, isWorkspaceVisible: false })).toBe(false);
  });

  it('minimized/hidden window → false', () => {
    expect(computeEffectiveVisibility({ ...base, windowVisible: false })).toBe(false);
  });

  it('not the shown surface in its pane → false', () => {
    expect(computeEffectiveVisibility({ ...base, shown: false })).toBe(false);
  });

  it('zoom-hidden within its own tree → false; zoom elsewhere leaves it visible', () => {
    // isZoomHidden is tree-scoped (PaneContainer computes it): a zoom in a
    // DIFFERENT workspace's tree never sets it, so this browser stays visible.
    expect(computeEffectiveVisibility({ ...base, isZoomHidden: true })).toBe(false);
    expect(computeEffectiveVisibility({ ...base, isZoomHidden: false })).toBe(true);
  });

  it('occluded by an active diff/editor overlay → false', () => {
    expect(computeEffectiveVisibility({ ...base, occluded: true })).toBe(false);
  });

  it('missing optional flags default to visible (fail open)', () => {
    expect(
      computeEffectiveVisibility({ shown: true, isWorkspaceVisible: true, windowVisible: true }),
    ).toBe(true);
  });
});

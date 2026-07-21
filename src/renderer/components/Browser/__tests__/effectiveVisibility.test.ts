import { describe, it, expect } from 'vitest';
import { computeEffectiveVisibility } from '../BrowserPanel';

// #517: effective visibility = shown ∧ workspace-visible ∧ window-shown ∧
// not hidden behind another pane's zoom.
describe('computeEffectiveVisibility (#517)', () => {
  const base = {
    shown: true,
    isWorkspaceVisible: true,
    windowVisible: true,
    zoomedPaneId: null as string | null,
    paneId: 'pane-1',
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

  it('another pane zoomed → false; own pane zoomed → true', () => {
    expect(computeEffectiveVisibility({ ...base, zoomedPaneId: 'pane-2' })).toBe(false);
    expect(computeEffectiveVisibility({ ...base, zoomedPaneId: 'pane-1' })).toBe(true);
  });

  it('zoom with unknown paneId → false (fail toward hidden only on explicit zoom)', () => {
    expect(
      computeEffectiveVisibility({ ...base, paneId: undefined, zoomedPaneId: 'pane-2' }),
    ).toBe(false);
  });
});

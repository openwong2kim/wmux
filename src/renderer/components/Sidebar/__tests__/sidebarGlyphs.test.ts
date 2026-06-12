/**
 * Regression for issue #151: the sidebar hide/expand button directions must
 * follow the sidebar's physical position. Left-docked points one way,
 * right-docked mirrors it. Tested as a pure helper because vitest runs in the
 * node env with no DOM (same constraint as the SettingsPanel suites).
 */
import { describe, it, expect } from 'vitest';
import { collapseDirection, expandDirection } from '../sidebarGlyphs';

describe('sidebar collapse/expand directions (issue #151)', () => {
  it('collapse arrow points toward the docked edge', () => {
    expect(collapseDirection('left')).toBe('left');
    expect(collapseDirection('right')).toBe('right');
  });

  it('expand arrow points inward toward the content area', () => {
    expect(expandDirection('left')).toBe('right');
    expect(expandDirection('right')).toBe('left');
  });

  it('collapse and expand always point in opposite directions', () => {
    for (const pos of ['left', 'right'] as const) {
      expect(collapseDirection(pos)).not.toBe(expandDirection(pos));
    }
  });

  it('flipping the position mirrors both directions', () => {
    expect(collapseDirection('left')).toBe(expandDirection('right'));
    expect(collapseDirection('right')).toBe(expandDirection('left'));
  });
});

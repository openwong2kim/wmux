/**
 * Regression for issue #151: the sidebar hide/expand button glyphs must follow
 * the sidebar's physical position. Left-docked points one way, right-docked
 * mirrors it. Tested as a pure helper because vitest runs in the node env with
 * no DOM (same constraint as the SettingsPanel suites).
 */
import { describe, it, expect } from 'vitest';
import { collapseGlyph, expandGlyph } from '../sidebarGlyphs';

describe('sidebar glyphs (issue #151)', () => {
  it('collapse arrow points toward the docked edge', () => {
    // Left sidebar collapses toward the left edge; right toward the right edge.
    expect(collapseGlyph('left')).toBe('◀');
    expect(collapseGlyph('right')).toBe('▶');
  });

  it('expand arrow points inward toward the content area', () => {
    // Mini sidebar on the left expands rightward; on the right expands leftward.
    expect(expandGlyph('left')).toBe('▶');
    expect(expandGlyph('right')).toBe('◀');
  });

  it('collapse and expand always point in opposite directions', () => {
    // The two buttons swap places visually, so their arrows must never match.
    for (const pos of ['left', 'right'] as const) {
      expect(collapseGlyph(pos)).not.toBe(expandGlyph(pos));
    }
  });

  it('flipping the position mirrors both glyphs', () => {
    expect(collapseGlyph('left')).toBe(expandGlyph('right'));
    expect(collapseGlyph('right')).toBe(expandGlyph('left'));
  });
});

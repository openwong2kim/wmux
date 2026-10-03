import { describe, expect, it } from 'vitest';
import { cssColorToHex } from '../titlebarOverlay';

describe('cssColorToHex', () => {
  it('reads the forms getComputedStyle returns', () => {
    expect(cssColorToHex('#121015')).toBe('#121015');
    expect(cssColorToHex('#ABC')).toBe('#aabbcc');
    expect(cssColorToHex('rgb(18, 16, 21)')).toBe('#121015');
    // A frame colour defined with color-mix computes to color(srgb …).
    expect(cssColorToHex('color(srgb 0.0705882 0.0627451 0.0823529)')).toBe('#121015');
  });

  it('gives nothing for a transparent or unknown paint', () => {
    expect(cssColorToHex('rgba(0, 0, 0, 0)')).toBeNull();
    expect(cssColorToHex('color(srgb 0 0 0 / 0)')).toBeNull();
    expect(cssColorToHex('var(--x)')).toBeNull();
    expect(cssColorToHex('')).toBeNull();
  });
});

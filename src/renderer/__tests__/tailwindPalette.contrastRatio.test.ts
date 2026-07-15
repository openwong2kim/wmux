// 2026-07-15 dogfood report: "Amber 테마에서 클로드 사용중에 글씨가 검정으로
// 나올 때가 있다" (text sometimes renders black while using Claude, in the
// Amber theme). Root cause: Claude Code (and other TUI apps) emit true-color
// RGB foreground text that bypasses the xterm indexed ANSI palette entirely —
// the same mechanism #74 fixed for light themes (literal white on a cream
// background), just in the opposite direction (literal near-black on a
// near-black background). See resolveMinimumContrastRatio in
// tailwindPalette.ts for the fix and its rationale.
import { describe, it, expect } from 'vitest';
import {
  resolveMinimumContrastRatio,
  getContrastRatio,
  XTERM_MIN_CONTRAST_LIGHT,
  XTERM_MIN_CONTRAST_DARK,
} from '../tailwindPalette';
import { XTERM_PALETTES } from '../themes';

describe('resolveMinimumContrastRatio', () => {
  it('no background → xterm default (1, no enforcement)', () => {
    expect(resolveMinimumContrastRatio(undefined)).toBe(1);
  });

  it('light background → WCAG AA body text (4.5)', () => {
    expect(resolveMinimumContrastRatio('#FAF8F5')).toBe(XTERM_MIN_CONTRAST_LIGHT);
  });

  it('dark background → the lower dark-theme floor (2.5), NOT 1 (the pre-fix behavior)', () => {
    expect(resolveMinimumContrastRatio('#121214')).toBe(XTERM_MIN_CONTRAST_DARK);
  });

  it('dark floor stays well under the light floor (preserves intentionally-muted dark-theme text)', () => {
    expect(XTERM_MIN_CONTRAST_DARK).toBeLessThan(XTERM_MIN_CONTRAST_LIGHT);
    expect(XTERM_MIN_CONTRAST_DARK).toBeGreaterThan(1);
  });
});

describe('resolveMinimumContrastRatio — every built-in xterm palette', () => {
  const DARK_PALETTES = [
    'amber-graphite', 'catppuccin-mocha', 'tokyo-night', 'one-dark',
    'gruvbox-dark', 'solarized-dark', 'nord', 'monochrome',
  ] as const;
  const LIGHT_PALETTES = ['sandstone-light', 'paper-light'] as const;

  it.each(DARK_PALETTES)('%s resolves to the dark floor', (id) => {
    expect(resolveMinimumContrastRatio(XTERM_PALETTES[id].background)).toBe(XTERM_MIN_CONTRAST_DARK);
  });

  it.each(LIGHT_PALETTES)('%s resolves to the light (AA) floor', (id) => {
    expect(resolveMinimumContrastRatio(XTERM_PALETTES[id].background)).toBe(XTERM_MIN_CONTRAST_LIGHT);
  });

  // The actual bug: every dark palette's indexed ANSI black is, on its own,
  // near-invisible against its own background — confirming the floor is
  // necessary (not just theoretical) for the class of text that DOES use
  // indexed ANSI black (SGR 30) rather than true-color.
  it.each(DARK_PALETTES)('%s: ansi black is under the dark floor pre-enforcement (regression fixture)', (id) => {
    const p = XTERM_PALETTES[id];
    const ratio = getContrastRatio(p.black, p.background);
    expect(ratio).toBeLessThan(XTERM_MIN_CONTRAST_DARK);
  });

  it('amber-graphite specifically: ansi black is barely above 1:1 (the reported case)', () => {
    const p = XTERM_PALETTES['amber-graphite'];
    const ratio = getContrastRatio(p.black, p.background);
    expect(ratio).toBeLessThan(1.5);
  });
});

// Windows window glass coverage (DESIGN.md "Window glass"), derived from the
// theme's own tokens so the frame and the sidebar stay legible whatever is
// behind the window (owner decision 2026-10-21: legibility wins).
//
// The page paints `--glass-frame` of the frame colour over the acrylic, and
// the sheet adds `--glass-sheet` of the mantle under the sidebar (globals.css),
// so on screen:
//   frame   = f·frameBg + (1 − f)·B
//   sidebar = s·mantle + (1 − s)·frame
// where B is what shows through the material. B is modelled as the worst
// backdrop seen fully through: pure white behind a dark look, pure black
// behind a light one. Real acrylic blurs and tints what is behind it, so it
// never lets that much through; the bound is conservative on purpose. With a
// white window behind the dark Tint look, the old fixed 30%/6% measured
// #666668 under the sidebar and secondary text at about 2.3:1.

import { getContrastRatio, mixHex } from '../tailwindPalette';
import type { WindowGlassLevel } from '../../shared/windowGlass';

/** The theme colours the coverage depends on, each `#rrggbb`. */
export interface GlassTokens {
  frameBg: string;
  mantle: string;
  textMain: string;
  textSub: string;
  textMuted: string;
}

/** `--glass-frame` and `--glass-sheet`, in percent. */
export interface GlassCoverage {
  frame: number;
  sheet: number;
}

/**
 * The most of its own colour the frame may paint. Above
 * it so little of the material shows that the window no longer reads as
 * glass, only as a slightly uneven opaque frame; a look that needs more than
 * this to stay legible is opaque instead.
 */
export const GLASS_MAX_COVERAGE = 90;

/** WCAG contrast each text level keeps against the frame and the sidebar. */
export const GLASS_MIN_CONTRAST = { main: 4.5, sub: 4.5, muted: 3 } as const;

/**
 * Each level's floor: the fixed numbers Windows glass shipped with before the
 * coverage was derived. The search only ever raises them, so Soft stays at or
 * above Clear. (The strongly hued looks had a higher floor so their colour
 * survived the grey material; a legible frame paints far more than that
 * anyway.)
 */
export const WINDOWS_GLASS_FLOOR: Record<'dark' | 'light', Record<'soft' | 'clear', GlassCoverage>> = {
  dark: { soft: { frame: 30, sheet: 6 }, clear: { frame: 12, sheet: 5 } },
  light: { soft: { frame: 55, sheet: 10 }, clear: { frame: 35, sheet: 8 } },
};

/** The backdrop that costs a look the most contrast: white behind dark, black behind light. */
export function worstBackdrop(appearance: 'dark' | 'light'): string {
  return appearance === 'dark' ? '#FFFFFF' : '#000000';
}

/** The frame and sidebar colours on screen for a coverage over a backdrop. */
export function glassComposite(
  tokens: GlassTokens,
  backdrop: string,
  coverage: GlassCoverage,
): { frame: string; sidebar: string } {
  const frame = mixHex(backdrop, tokens.frameBg, coverage.frame / 100);
  const sidebar = mixHex(frame, tokens.mantle, coverage.sheet / 100);
  return { frame, sidebar };
}

/** The lowest contrast each text level gets across the frame and the sidebar. */
export function glassContrast(
  tokens: GlassTokens,
  backdrop: string,
  coverage: GlassCoverage,
): { main: number; sub: number; muted: number } {
  const { frame, sidebar } = glassComposite(tokens, backdrop, coverage);
  const min = (text: string) => Math.min(getContrastRatio(text, frame), getContrastRatio(text, sidebar));
  return { main: min(tokens.textMain), sub: min(tokens.textSub), muted: min(tokens.textMuted) };
}

function legible(tokens: GlassTokens, backdrop: string, coverage: GlassCoverage): boolean {
  const c = glassContrast(tokens, backdrop, coverage);
  return c.main >= GLASS_MIN_CONTRAST.main && c.sub >= GLASS_MIN_CONTRAST.sub && c.muted >= GLASS_MIN_CONTRAST.muted;
}

/**
 * The Windows coverage for a look and a level: the smallest frame, in 1%
 * steps from the level's floor up to GLASS_MAX_COVERAGE, that keeps every
 * text level legible over the worst backdrop in both the frame and the
 * sidebar. Null when none is: that look is opaque on Windows, as if glass
 * were Off.
 *
 * The sheet stays at its floor. The sidebar's colour lies between the
 * frame's and the mantle's, so a larger sheet step only moves it towards the
 * mantle: that helps only when the mantle reads better than the frame, and
 * then the sidebar already passes whenever the frame does. Only the frame
 * can make a look legible.
 */
export function windowsGlassCoverage(
  tokens: GlassTokens,
  appearance: 'dark' | 'light',
  level: Exclude<WindowGlassLevel, 'off'>,
): GlassCoverage | null {
  const floor = WINDOWS_GLASS_FLOOR[appearance][level];
  const backdrop = worstBackdrop(appearance);
  for (let frame = floor.frame; frame <= GLASS_MAX_COVERAGE; frame++) {
    const coverage = { frame, sheet: floor.sheet };
    if (legible(tokens, backdrop, coverage)) return coverage;
  }
  return null;
}

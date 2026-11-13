// Window glass coverage (DESIGN.md "Window glass"), derived from the theme's
// own tokens so the frame and the sidebar stay legible whatever is behind the
// window: on Windows since the owner decision of 2026-10-21 (legibility wins),
// on macOS since #3283, where the fixed numbers left the dark Tint sidebar
// unreadable over a white window.
//
// The page paints `--glass-frame` of the frame colour over the material, and
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
  textSub2: string;
  textSub: string;
  textSubtle: string;
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

/** WCAG contrast each text level keeps against the frame and the sidebar: the
 *  floors every tier keeps on the opaque surfaces (themeTextContrast). */
export const GLASS_MIN_CONTRAST = { main: 4.5, sub2: 4.5, sub: 4.5, subtle: 3, muted: 3 } as const;

type GlassTier = keyof typeof GLASS_MIN_CONTRAST;
const TIER_TOKEN: Record<GlassTier, keyof GlassTokens> = {
  main: 'textMain', sub2: 'textSub2', sub: 'textSub', subtle: 'textSubtle', muted: 'textMuted',
};

/** The platforms that show window glass (shared/windowGlass.ts). */
export type GlassPlatform = 'win32' | 'darwin';

type GlassFloor = Record<'dark' | 'light', Record<'soft' | 'clear', GlassCoverage>>;

/**
 * Each level's floor: the fixed numbers each platform shipped with before its
 * coverage was derived. The search only ever raises them, so Soft stays at or
 * above Clear and no look shows more of the desktop than it used to.
 */
export const GLASS_FLOOR: Record<GlassPlatform, GlassFloor> = {
  win32: {
    dark: { soft: { frame: 30, sheet: 6 }, clear: { frame: 12, sheet: 5 } },
    light: { soft: { frame: 55, sheet: 10 }, clear: { frame: 35, sheet: 8 } },
  },
  // The light material is milkier than the dark one, so a light look painted
  // less over it to read as see-through as a dark look does.
  darwin: {
    dark: { soft: { frame: 25, sheet: 6 }, clear: { frame: 10, sheet: 5 } },
    light: { soft: { frame: 10, sheet: 4 }, clear: { frame: 0, sheet: 3 } },
  },
};

/**
 * The strongly hued looks (navy, red, violet) kept more of their own colour
 * over the grey macOS material, or their frame turned a neutral grey beside a
 * hued sheet; their old numbers stay their floor there.
 */
export const MACOS_HUED_GLASS_FLOOR: { themes: readonly string[]; floor: Record<'soft' | 'clear', GlassCoverage> } = {
  themes: ['stars-and-stripes', 'red-dynasty', 'catppuccin-mocha'],
  floor: { soft: { frame: 55, sheet: 20 }, clear: { frame: 35, sheet: 12 } },
};

/** The floor for a look on a platform; `theme` is the `data-theme` id. */
export function glassFloor(
  platform: GlassPlatform,
  appearance: 'dark' | 'light',
  level: Exclude<WindowGlassLevel, 'off'>,
  theme?: string | null,
): GlassCoverage {
  if (platform === 'darwin' && theme && MACOS_HUED_GLASS_FLOOR.themes.includes(theme)) {
    return MACOS_HUED_GLASS_FLOOR.floor[level];
  }
  return GLASS_FLOOR[platform][appearance][level];
}

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
): Record<GlassTier, number> {
  const { frame, sidebar } = glassComposite(tokens, backdrop, coverage);
  const min = (text: string) => Math.min(getContrastRatio(text, frame), getContrastRatio(text, sidebar));
  const out = {} as Record<GlassTier, number>;
  for (const tier of Object.keys(TIER_TOKEN) as GlassTier[]) out[tier] = min(tokens[TIER_TOKEN[tier]]);
  return out;
}

function legible(tokens: GlassTokens, backdrop: string, coverage: GlassCoverage): boolean {
  const c = glassContrast(tokens, backdrop, coverage);
  return (Object.keys(GLASS_MIN_CONTRAST) as GlassTier[]).every((tier) => c[tier] >= GLASS_MIN_CONTRAST[tier]);
}

/**
 * The coverage for a look and a level on a platform: the smallest frame, in
 * 1% steps from the level's floor up to GLASS_MAX_COVERAGE, that keeps every
 * text level legible over the worst backdrop in both the frame and the
 * sidebar. Null when none is: that look is opaque there, as if glass were
 * Off.
 *
 * The sheet stays at its floor. The sidebar's colour lies between the
 * frame's and the mantle's, so a larger sheet step only moves it towards the
 * mantle: that helps only when the mantle reads better than the frame, and
 * then the sidebar already passes whenever the frame does. Only the frame
 * can make a look legible.
 */
export function glassCoverage(
  tokens: GlassTokens,
  appearance: 'dark' | 'light',
  level: Exclude<WindowGlassLevel, 'off'>,
  platform: GlassPlatform = 'win32',
  theme?: string | null,
): GlassCoverage | null {
  const floor = glassFloor(platform, appearance, level, theme);
  const backdrop = worstBackdrop(appearance);
  for (let frame = floor.frame; frame <= GLASS_MAX_COVERAGE; frame++) {
    const coverage = { frame, sheet: floor.sheet };
    if (legible(tokens, backdrop, coverage)) return coverage;
  }
  return null;
}

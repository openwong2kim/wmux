// @wmux-lane unit
// Pure functions over the theme tokens: "win32" appears only in a regex that
// reads globals.css as text, so Windows cannot change the result.
// Windows glass coverage is derived from each look's tokens so its text stays
// legible over the worst backdrop (owner decision 2026-10-21). These run the
// real built-in tokens through the same composite the page paints.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { THEME_STYLES, UI_THEME_TOKENS, deriveBuiltinPalette, type BuiltinThemeId } from '../../themes';
import { isLight, mixHex } from '../../tailwindPalette';
import {
  GLASS_MAX_COVERAGE,
  GLASS_MIN_CONTRAST,
  WINDOWS_GLASS_FLOOR,
  glassContrast,
  windowsGlassCoverage,
  worstBackdrop,
  type GlassCoverage,
  type GlassTokens,
} from '../glassCoverage';

const THEMES = Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[];

/** `--frame-bg` as globals.css resolves it: the look's frame knob, else `--app-bg` (84% / 97% of the base over black). */
function frameOf(id: BuiltinThemeId): string {
  const { bgBase } = deriveBuiltinPalette(id);
  return THEME_STYLES[id]?.frame ?? mixHex('#000000', bgBase, isLight(bgBase) ? 0.97 : 0.84);
}

function tokensOf(id: BuiltinThemeId): GlassTokens {
  const p = deriveBuiltinPalette(id);
  return { frameBg: frameOf(id), mantle: p.bgMantle, textMain: p.textMain, textSub: p.textSub, textMuted: p.textMuted };
}

function appearanceOf(id: BuiltinThemeId): 'dark' | 'light' {
  return isLight(deriveBuiltinPalette(id).bgBase) ? 'light' : 'dark';
}

// Invariants, not per-look outcomes: a token edit may move a look in or out of
// glass, and these still hold.
function meets(tokens: GlassTokens, appearance: 'dark' | 'light', coverage: GlassCoverage): boolean {
  const c = glassContrast(tokens, worstBackdrop(appearance), coverage);
  return c.main >= GLASS_MIN_CONTRAST.main && c.sub >= GLASS_MIN_CONTRAST.sub && c.muted >= GLASS_MIN_CONTRAST.muted;
}

describe('windowsGlassCoverage over every built-in look', () => {
  for (const id of THEMES) {
    for (const level of ['soft', 'clear'] as const) {
      it(`${id} ${level}: glass is legible and minimal over the worst backdrop, or no coverage in range is`, () => {
        const appearance = appearanceOf(id);
        const tokens = tokensOf(id);
        const floor = WINDOWS_GLASS_FLOOR[appearance][level];
        const coverage = windowsGlassCoverage(tokens, appearance, level);
        if (coverage) {
          expect(coverage.sheet).toBe(floor.sheet);
          expect(coverage.frame).toBeGreaterThanOrEqual(floor.frame);
          expect(coverage.frame).toBeLessThanOrEqual(GLASS_MAX_COVERAGE);
          // Every target, in the frame and the sidebar.
          const c = glassContrast(tokens, worstBackdrop(appearance), coverage);
          expect(c.main).toBeGreaterThanOrEqual(GLASS_MIN_CONTRAST.main);
          expect(c.sub).toBeGreaterThanOrEqual(GLASS_MIN_CONTRAST.sub);
          expect(c.muted).toBeGreaterThanOrEqual(GLASS_MIN_CONTRAST.muted);
          // The smallest such frame: one step less misses a target.
          if (coverage.frame > floor.frame) {
            expect(meets(tokens, appearance, { ...coverage, frame: coverage.frame - 1 })).toBe(false);
          }
        } else {
          for (let frame = floor.frame; frame <= GLASS_MAX_COVERAGE; frame++) {
            expect(meets(tokens, appearance, { frame, sheet: floor.sheet }), `${frame}%`).toBe(false);
          }
        }
      });
    }
  }

  it('Soft never covers less than Clear', () => {
    for (const id of THEMES) {
      const soft = windowsGlassCoverage(tokensOf(id), appearanceOf(id), 'soft');
      const clear = windowsGlassCoverage(tokensOf(id), appearanceOf(id), 'clear');
      if (!soft || !clear) continue;
      expect(soft.frame).toBeGreaterThanOrEqual(clear.frame);
      expect(soft.sheet).toBeGreaterThanOrEqual(clear.sheet);
    }
  });
});

describe('windowsGlassCoverage on fixed tokens', () => {
  // The dark Tint look's colours as of 2026-10-21, pinned here so the
  // numbers do not move with the theme tokens.
  const fixed: GlassTokens = { frameBg: '#121015', mantle: '#18151C', textMain: '#F4F2F7', textSub: '#C2BDC9', textMuted: '#8A8492' };

  it('raises the frame to the smallest legible value and keeps the sheet at its floor', () => {
    expect(windowsGlassCoverage(fixed, 'dark', 'soft')).toEqual({ frame: 82, sheet: 6 });
    expect(windowsGlassCoverage(fixed, 'dark', 'clear')).toEqual({ frame: 82, sheet: 5 });
  });

  it('measures the old fixed 30%/6% as illegible over a white window', () => {
    expect(glassContrast(fixed, '#FFFFFF', { frame: 30, sheet: 6 }).sub).toBeLessThan(GLASS_MIN_CONTRAST.sub);
  });
});

describe('windowsGlassCoverage fallback', () => {
  it('is null (opaque) for a look whose text no coverage in the range keeps legible', () => {
    // Mid-grey text on a near-black frame: even the full 90% leaves it under 3:1 over white.
    const murky: GlassTokens = { frameBg: '#101010', mantle: '#101010', textMain: '#FFFFFF', textSub: '#BBBBBB', textMuted: '#444444' };
    expect(windowsGlassCoverage(murky, 'dark', 'soft')).toBeNull();
    expect(windowsGlassCoverage(murky, 'dark', 'clear')).toBeNull();
  });
});

describe('macOS glass numbers stay in globals.css', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    const body = css.slice(at, css.indexOf('}', at));
    return { frame: /--glass-frame:\s*([^;]+);/.exec(body)?.[1], sheet: /--glass-sheet:\s*([^;]+);/.exec(body)?.[1] };
  };
  const hued = ':is([data-theme="stars-and-stripes"], [data-theme="red-dynasty"], [data-theme="catppuccin-mocha"])';

  it('keeps every macOS rule at its number', () => {
    expect(rule('html[data-glass]')).toEqual({ frame: '25%', sheet: '6%' });
    expect(rule('html[data-glass][data-glass-level="clear"]')).toEqual({ frame: '10%', sheet: '5%' });
    expect(rule(`html[data-glass]${hued}`)).toEqual({ frame: '55%', sheet: '20%' });
    expect(rule(`html[data-glass]${hued}[data-glass-level="clear"]`)).toEqual({ frame: '35%', sheet: '12%' });
    expect(rule('html[data-glass="light"]')).toEqual({ frame: '10%', sheet: '4%' });
    expect(rule('html[data-glass="light"][data-glass-level="clear"]')).toEqual({ frame: '0%', sheet: '3%' });
  });

  it('has no fixed Windows numbers left: the renderer derives them', () => {
    expect(css).not.toMatch(/html\[data-glass[^\]]*\]\[data-platform="win32"\]/);
  });
});

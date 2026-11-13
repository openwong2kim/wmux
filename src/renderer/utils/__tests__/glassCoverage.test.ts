// @wmux-lane unit
// Pure functions over the theme tokens: "win32" and "darwin" are only
// arguments to them, so the host OS cannot change the result.
// Window glass coverage is derived from each look's tokens so its text stays
// legible over the worst backdrop (owner decision 2026-10-21; macOS since #3283). These run the
// real built-in tokens through the same composite the page paints.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { THEME_STYLES, UI_THEME_TOKENS, deriveBuiltinPalette, type BuiltinThemeId } from '../../themes';
import { isLight, mixHex } from '../../tailwindPalette';
import {
  GLASS_MAX_COVERAGE,
  GLASS_MIN_CONTRAST,
  GLASS_FLOOR,
  glassContrast,
  glassCoverage,
  glassFloor,
  worstBackdrop,
  type GlassCoverage,
  type GlassPlatform,
  type GlassTokens,
} from '../glassCoverage';

const THEMES = Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[];

/** `--frame-bg` as globals.css resolves it: the look's frame knob, else `--app-bg` (84% / 97% of the base over black). */
function frameOf(id: BuiltinThemeId): string {
  const { bgBase } = deriveBuiltinPalette(id);
  return THEME_STYLES[id]?.frame ?? mixHex('#000000', bgBase, isLight(bgBase) ? 0.97 : 0.84);
}

/** The tokens the renderer's gate reads: the look's own, the same text glass draws. */
function tokensOf(id: BuiltinThemeId): GlassTokens {
  const p = deriveBuiltinPalette(id);
  return {
    frameBg: frameOf(id), mantle: p.bgMantle,
    textMain: p.textMain, textSub2: p.textSub2, textSub: p.textSub, textSubtle: p.textSubtle, textMuted: p.textMuted,
  };
}

/** Fixed tokens with the in-between tiers derived as deriveFullPalette does. */
function derived(t: Omit<GlassTokens, 'textSub2' | 'textSubtle'>): GlassTokens {
  return { ...t, textSub2: mixHex(t.textMain, t.textSub, 0.5), textSubtle: mixHex(t.textSub, t.textMuted, 0.5) };
}

function appearanceOf(id: BuiltinThemeId): 'dark' | 'light' {
  return isLight(deriveBuiltinPalette(id).bgBase) ? 'light' : 'dark';
}

// Invariants, not per-look outcomes: a token edit may move a look in or out of
// glass, and these still hold.
function meets(tokens: GlassTokens, appearance: 'dark' | 'light', coverage: GlassCoverage): boolean {
  const c = glassContrast(tokens, worstBackdrop(appearance), coverage);
  return (Object.keys(GLASS_MIN_CONTRAST) as Array<keyof typeof GLASS_MIN_CONTRAST>).every((tier) => c[tier] >= GLASS_MIN_CONTRAST[tier]);
}

const PLATFORMS: GlassPlatform[] = ['win32', 'darwin'];

describe('glassCoverage over every built-in look', () => {
  for (const platform of PLATFORMS) for (const id of THEMES) {
    for (const level of ['soft', 'clear'] as const) {
      it(`${platform} ${id} ${level}: glass is legible and minimal over the worst backdrop, or no coverage in range is`, () => {
        const appearance = appearanceOf(id);
        const tokens = tokensOf(id);
        const floor = glassFloor(platform, appearance, level, id);
        const coverage = glassCoverage(tokens, appearance, level, platform, id);
        if (coverage) {
          expect(coverage.sheet).toBe(floor.sheet);
          expect(coverage.frame).toBeGreaterThanOrEqual(floor.frame);
          expect(coverage.frame).toBeLessThanOrEqual(GLASS_MAX_COVERAGE);
          // Every target, in the frame and the sidebar.
          const c = glassContrast(tokens, worstBackdrop(appearance), coverage);
          for (const [tier, floor] of Object.entries(GLASS_MIN_CONTRAST) as Array<[keyof typeof GLASS_MIN_CONTRAST, number]>) {
            expect(c[tier], `${id} ${level} ${tier}`).toBeGreaterThanOrEqual(floor);
          }
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

  // The outcome per look, pinned so a token edit that moves a look in or out
  // of glass shows up here, along with the list DESIGN.md and the changelog
  // give. null: opaque on Windows. Otherwise [frame, Soft sheet, Clear sheet].
  const EXPECTED: Record<BuiltinThemeId, [number, number, number] | null> = {
    tint: [82, 6, 5],
    zinc: [84, 6, 5],
    graphite: [85, 6, 5],
    paper: null,
    'amber-line': [82, 6, 5],
    mono: [90, 6, 5],
    'mono-light': null,
    amber: [88, 6, 5],
    'catppuccin-mocha': [90, 6, 5],
    monochrome: null,
    'stars-and-stripes': null,
    'red-dynasty': null,
    nightowl: null,
    'gruvbox-dark-hard': [90, 6, 5],
    void: null,
    hinomaru: [80, 10, 8],
    taegeuk: [81, 10, 8],
  };

  it('pins each look: these seven are opaque on Windows, the rest keep their coverage', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...THEMES].sort());
    for (const id of THEMES) {
      const want = EXPECTED[id];
      for (const [level, sheet] of [['soft', want?.[1]], ['clear', want?.[2]]] as const) {
        const got = glassCoverage(tokensOf(id), appearanceOf(id), level, 'win32', id);
        expect(got, `${id} ${level}`).toEqual(want ? { frame: want[0], sheet } : null);
      }
    }
    expect(THEMES.filter((id) => EXPECTED[id] === null)).toEqual(
      ['paper', 'mono-light', 'monochrome', 'stars-and-stripes', 'red-dynasty', 'nightowl', 'void'],
    );
  });

  it('Soft never covers less than Clear', () => {
    for (const platform of PLATFORMS) for (const id of THEMES) {
      const soft = glassCoverage(tokensOf(id), appearanceOf(id), 'soft', platform, id);
      const clear = glassCoverage(tokensOf(id), appearanceOf(id), 'clear', platform, id);
      if (!soft || !clear) continue;
      expect(soft.frame).toBeGreaterThanOrEqual(clear.frame);
      expect(soft.sheet).toBeGreaterThanOrEqual(clear.sheet);
    }
  });

  it('on macOS, keeps a look opaque exactly where Windows does', () => {
    // Same backdrop model and cap, and the macOS floors sit at or under the
    // Windows ones except the hued sheet, which the frame decides nothing on.
    for (const id of THEMES) {
      for (const level of ['soft', 'clear'] as const) {
        const win = glassCoverage(tokensOf(id), appearanceOf(id), level, 'win32', id);
        const mac = glassCoverage(tokensOf(id), appearanceOf(id), level, 'darwin', id);
        expect(mac === null, `${id} ${level}`).toBe(win === null);
      }
    }
  });
});

describe('windowsGlassCoverage on fixed tokens', () => {
  // The dark Tint look's colours as of 2026-10-21, pinned here so the
  // numbers do not move with the theme tokens.
  const fixed: GlassTokens = derived({ frameBg: '#121015', mantle: '#18151C', textMain: '#F4F2F7', textSub: '#C2BDC9', textMuted: '#8A8492' });

  it('raises the frame to the smallest legible value and keeps the sheet at its floor', () => {
    expect(glassCoverage(fixed, 'dark', 'soft')).toEqual({ frame: 82, sheet: 6 });
    expect(glassCoverage(fixed, 'dark', 'clear')).toEqual({ frame: 82, sheet: 5 });
  });

  it('measures the old fixed 30%/6% as illegible over a white window', () => {
    expect(glassContrast(fixed, '#FFFFFF', { frame: 30, sheet: 6 }).sub).toBeLessThan(GLASS_MIN_CONTRAST.sub);
  });

  it('judges the in-between tiers too: a sub2 or subtle the cap cannot keep legible makes the look opaque', () => {
    // The same look with one in-between tier set to its sub or muted neighbour's
    // colour dimmed past the floor: main, sub and muted alone would still pass.
    expect(glassCoverage({ ...fixed, textSub2: '#6E6A73' }, 'dark', 'soft')).toBeNull();
    expect(glassCoverage({ ...fixed, textSubtle: '#4A4650' }, 'dark', 'soft')).toBeNull();
  });
});

describe('windowsGlassCoverage fallback', () => {
  it('is null (opaque) for a look whose text no coverage in the range keeps legible', () => {
    // Mid-grey text on a near-black frame: even the full 90% leaves it under 3:1 over white.
    const murky: GlassTokens = derived({ frameBg: '#101010', mantle: '#101010', textMain: '#FFFFFF', textSub: '#BBBBBB', textMuted: '#444444' });
    expect(glassCoverage(murky, 'dark', 'soft')).toBeNull();
    expect(glassCoverage(murky, 'dark', 'clear')).toBeNull();
  });
});

describe('glass floors', () => {
  it('keeps each platform\'s old fixed numbers as its floor', () => {
    expect(GLASS_FLOOR.darwin).toEqual({
      dark: { soft: { frame: 25, sheet: 6 }, clear: { frame: 10, sheet: 5 } },
      light: { soft: { frame: 10, sheet: 4 }, clear: { frame: 0, sheet: 3 } },
    });
    expect(glassFloor('darwin', 'dark', 'soft', 'red-dynasty')).toEqual({ frame: 55, sheet: 20 });
    expect(glassFloor('darwin', 'dark', 'clear', 'catppuccin-mocha')).toEqual({ frame: 35, sheet: 12 });
    // The hued floor is a macOS one only.
    expect(glassFloor('win32', 'dark', 'soft', 'red-dynasty')).toEqual(GLASS_FLOOR.win32.dark.soft);
  });

  it('leaves no fixed coverage in globals.css: the renderer derives it on both platforms', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/--glass-(frame|sheet)\s*:/);
  });
});

// Owner decision 2026-10-22: Windows glass draws its text the way macOS glass
// does, from the look's own tiers, with the same row fills. No platform rule
// may restate a text colour, so glass and glass Off, on either platform, draw
// the same text.
describe("glass draws the look's own text", () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8');

  it('no rule outside the theme blocks restates a text colour tier', () => {
    const themeBlock = /^(:root,\s*)?(:root)?\[data-theme="[^"]+"\]$/;
    const offenders: string[] = [];
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim();
      // The text colour tiers (not the --text-<size> type scale).
      if (/--text-(?:main|sub2|sub|subtle|muted)\s*:/.test(m[2]) && !themeBlock.test(selector)) offenders.push(selector);
    }
    expect(offenders).toEqual([]);
  });
});

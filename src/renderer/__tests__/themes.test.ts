import { describe, it, expect } from 'vitest';
import {
  builtinToCustom,
  deriveFullPalette,
  extractXtermColors,
  migrateCustomThemeColors,
  UI_THEME_TOKENS,
  XTERM_PALETTES,
  XTERM_PALETTE_OPTIONS,
  BUILTIN_XTERM_PALETTE,
  type BuiltinThemeId,
} from '../themes';
import { luminance, getContrastRatio } from '../tailwindPalette';

describe('themes — 10-token system', () => {
  const builtinIds: BuiltinThemeId[] = [
    'catppuccin-mocha', 'monochrome', 'stars-and-stripes', 'red-dynasty',
    'nightowl', 'void', 'hinomaru', 'taegeuk',
  ];

  describe('UI_THEME_TOKENS — 10 manual tokens per built-in', () => {
    it('defines all 10 tokens for every built-in theme', () => {
      for (const id of builtinIds) {
        const tokens = UI_THEME_TOKENS[id];
        expect(tokens.bgBase).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(tokens.bgSurface).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(tokens.bgMantle).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(tokens.textMain).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(tokens.textSub).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(tokens.textMuted).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(tokens.accent).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(tokens.success).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(tokens.danger).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(tokens.warning).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    });
  });

  describe('getContrastRatio — WCAG contrast utility', () => {
    it('returns ≈21 for pure black on pure white', () => {
      // Spec maximum: (1 + 0.05) / (0 + 0.05) = 21.
      expect(getContrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    });

    it('is order-independent (fg/bg swap)', () => {
      expect(getContrastRatio('#000000', '#FFFFFF'))
        .toBeCloseTo(getContrastRatio('#FFFFFF', '#000000'), 5);
    });

    it('returns exactly 1.0 for identical colors', () => {
      expect(getContrastRatio('#3B82F6', '#3B82F6')).toBe(1);
    });

    it('is NaN-safe for malformed hex (matches parseHex tolerance)', () => {
      // parseHex coerces garbage to a finite RGB rather than throwing, so the
      // ratio stays a finite number in [1, 21] — never NaN.
      const r = getContrastRatio('not-a-color', '#FFFFFF');
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(1);
    });
  });

  describe('hinomaru / taegeuk light themes — text contrast', () => {
    // Regression: pre-refactor textMuted #A8A098 had luminance 0.388 on bg
    // 0.911 — a 2.4:1 contrast that read as "invisible white" against the
    // cream background. New textMuted must keep at least ~4:1 against bgBase.
    // Uses the shared getContrastRatio (formerly a local copy here — kept DRY).

    it('hinomaru textMuted is readable on bgBase', () => {
      const { textMuted, bgBase } = UI_THEME_TOKENS.hinomaru;
      expect(getContrastRatio(textMuted, bgBase)).toBeGreaterThanOrEqual(3.5);
    });

    it('taegeuk textMuted is readable on bgBase', () => {
      const { textMuted, bgBase } = UI_THEME_TOKENS.taegeuk;
      expect(getContrastRatio(textMuted, bgBase)).toBeGreaterThanOrEqual(3.5);
    });

    it('hinomaru textMain meets WCAG AA on bgBase', () => {
      const { textMain, bgBase } = UI_THEME_TOKENS.hinomaru;
      expect(getContrastRatio(textMain, bgBase)).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe('deriveFullPalette — 10 → 17 expansion', () => {
    it('preserves manual tokens and derives the rest', () => {
      const ui = UI_THEME_TOKENS['catppuccin-mocha'];
      const full = deriveFullPalette(ui);

      // Manual tokens passed through unchanged
      expect(full.bgBase).toBe(ui.bgBase);
      expect(full.bgSurface).toBe(ui.bgSurface);
      expect(full.bgMantle).toBe(ui.bgMantle);
      expect(full.textMain).toBe(ui.textMain);
      expect(full.textSub).toBe(ui.textSub);
      expect(full.textMuted).toBe(ui.textMuted);

      // Semantic accents pass through
      expect(full.accentBlue).toBe(ui.accent);
      expect(full.accentGreen).toBe(ui.success);
      expect(full.accentRed).toBe(ui.danger);
      expect(full.accentYellow).toBe(ui.warning);
      expect(full.accentCursor).toBe(ui.accent);

      // Derived tokens are valid hex
      expect(full.bgOverlay).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(full.textSubtle).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(full.textSub2).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });

    it('accentBlue derives from accentSecondary, not accent', () => {
      // Secondary accent was split out of the brand accent. deriveFullPalette
      // must now source --accent-blue from accentSecondary so a theme can make
      // links diverge from the brand hue.
      const custom = { ...UI_THEME_TOKENS['catppuccin-mocha'], accentSecondary: '#123456' };
      const full = deriveFullPalette(custom);
      expect(full.accentBlue).toBe('#123456');
      // accentCursor still tracks the primary accent, unaffected by the split.
      expect(full.accentCursor).toBe(custom.accent);
    });

    it('accentSecondary defaults to accent except themes that ship a distinct link blue', () => {
      // Most built-ins keep --accent-blue == the brand accent (the split is
      // visually inert for them). red-dynasty and hinomaru intentionally diverge:
      // their shipped globals.css uses a separate blue for links/info so links
      // don't vanish into a red / light base. themeParity.test.ts locks these
      // values against globals.css.
      const DISTINCT_LINK_ACCENT: Record<string, string> = {
        'red-dynasty': '#6AA0CC',
        hinomaru: '#1C4D6A',
        nightowl: '#7FA6C9',
      };
      for (const id of builtinIds) {
        const tokens = UI_THEME_TOKENS[id];
        const expected = DISTINCT_LINK_ACCENT[id] ?? tokens.accent;
        expect(tokens.accentSecondary, `${id} accentSecondary`).toBe(expected);
        expect(deriveFullPalette(tokens).accentBlue, `${id} --accent-blue`).toBe(expected);
      }
    });

    it('bgOverlay shifts lighter on dark themes and darker on light themes', () => {
      const dark = deriveFullPalette(UI_THEME_TOKENS['catppuccin-mocha']);
      const light = deriveFullPalette(UI_THEME_TOKENS.hinomaru);
      // Dark theme: bgOverlay should be LIGHTER than bgSurface (more visible
      // elevation). Light theme: DARKER (more visible depression).
      expect(luminance(dark.bgOverlay)).toBeGreaterThan(luminance(dark.bgSurface));
      expect(luminance(light.bgOverlay)).toBeLessThan(luminance(light.bgSurface));
    });
  });

  describe('builtinToCustom — preset → CustomThemeColors', () => {
    it('produces a CustomThemeColors with paletteId for every built-in', () => {
      for (const id of builtinIds) {
        const custom = builtinToCustom(id);
        expect(custom.bgBase).toBe(UI_THEME_TOKENS[id].bgBase);
        expect(custom.accent).toBe(UI_THEME_TOKENS[id].accent);
        expect(custom.xtermPaletteId).toBe(BUILTIN_XTERM_PALETTE[id]);
      }
    });
  });

  describe('extractXtermColors', () => {
    it('returns the palette for the colors object', () => {
      const custom = builtinToCustom('catppuccin-mocha');
      expect(extractXtermColors(custom)).toBe(XTERM_PALETTES['catppuccin-mocha']);
    });

    it('falls back to catppuccin-mocha when palette id is invalid', () => {
      const custom = { ...builtinToCustom('catppuccin-mocha'), xtermPaletteId: 'bogus' };
      expect(extractXtermColors(custom)).toBe(XTERM_PALETTES['catppuccin-mocha']);
    });
  });

  // A palette is only as good as the output it has to render. These lock the
  // two decisions that keep `matrix` usable rather than merely green: the error
  // channel stays warm, and the cool slots stay apart from green.
  describe('matrix palette — readable, not just green', () => {
    const P = XTERM_PALETTES.matrix;
    const hue = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      if (d === 0) return 0;
      const h = max === r ? 60 * (((g - b) / d) % 6)
        : max === g ? 60 * ((b - r) / d + 2)
          : 60 * ((r - g) / d + 4);
      return (h + 360) % 360;
    };

    it('is offered in the palette picker', () => {
      expect(XTERM_PALETTE_OPTIONS.some((o) => o.value === 'matrix')).toBe(true);
    });

    it('every slot is valid hex', () => {
      for (const [slot, value] of Object.entries(P)) {
        expect(value, slot).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    });

    it('foreground and cursor clear WCAG AA on the background', () => {
      expect(getContrastRatio(P.foreground, P.background)).toBeGreaterThanOrEqual(4.5);
      expect(getContrastRatio(P.cursor, P.background)).toBeGreaterThanOrEqual(4.5);
    });

    it('dim text (brightBlack) stays legible — the reason bg is not pure black', () => {
      expect(getContrastRatio(P.brightBlack, P.background)).toBeGreaterThanOrEqual(3);
    });

    it('every colour slot is readable on the background', () => {
      const slots = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta',
        'brightCyan', 'brightWhite'] as const;
      for (const slot of slots) {
        expect(getContrastRatio(P[slot], P.background), slot).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('keeps red in the red family — the error channel is not decorative', () => {
      const h = hue(P.red);
      expect(h < 25 || h > 335).toBe(true);
      expect(hue(P.brightRed) < 25 || hue(P.brightRed) > 335).toBe(true);
    });

    it('keeps yellow out of the green band, so warnings do not read as success', () => {
      expect(hue(P.yellow)).toBeLessThan(100);
    });

    it('separates blue and cyan from green by hue, not only by lightness', () => {
      const green = hue(P.green);
      // A directory (blue) must not look like an executable (green) in `ls`.
      expect(Math.abs(hue(P.blue) - green)).toBeGreaterThanOrEqual(30);
      expect(Math.abs(hue(P.cyan) - green)).toBeGreaterThanOrEqual(25);
    });
  });

  describe('migrateCustomThemeColors — legacy 37-field shape', () => {
    it('migrates the legacy shape by mapping accentBlue→accent etc.', () => {
      const legacy = {
        bgBase: '#1E1E2E', bgMantle: '#181825', bgSurface: '#313244', bgOverlay: '#45475A',
        textMuted: '#585B70', textSubtle: '#6C7086', textSub: '#BAC2DE', textSub2: '#A6ADC8',
        textMain: '#CDD6F4', accentCursor: '#F5E0DC',
        accentBlue: '#89B4FA', accentGreen: '#A6E3A1', accentRed: '#F38BA8',
        accentYellow: '#F9E2AF', accentPink: '#F5C2E7', accentTeal: '#94E2D5', accentPurple: '#CBA6F7',
        xtermBackground: '#1E1E2E', xtermForeground: '#CDD6F4', xtermCursor: '#F5E0DC',
        xtermSelection: '#585B70',
        xtermBlack: '#45475A', xtermRed: '#F38BA8', xtermGreen: '#A6E3A1', xtermYellow: '#F9E2AF',
        xtermBlue: '#89B4FA', xtermMagenta: '#F5C2E7', xtermCyan: '#94E2D5', xtermWhite: '#BAC2DE',
        xtermBrightBlack: '#585B70', xtermBrightRed: '#F38BA8', xtermBrightGreen: '#A6E3A1',
        xtermBrightYellow: '#F9E2AF', xtermBrightBlue: '#89B4FA', xtermBrightMagenta: '#F5C2E7',
        xtermBrightCyan: '#94E2D5', xtermBrightWhite: '#A6ADC8',
      };
      const migrated = migrateCustomThemeColors(legacy);
      expect(migrated.bgBase).toBe('#1E1E2E');
      expect(migrated.accent).toBe('#89B4FA');   // from accentBlue
      expect(migrated.success).toBe('#A6E3A1');  // from accentGreen
      expect(migrated.danger).toBe('#F38BA8');   // from accentRed
      expect(migrated.warning).toBe('#F9E2AF');  // from accentYellow
      expect(migrated.xtermPaletteId).toBe('catppuccin-mocha'); // detected by bg match
      // Should NOT have legacy fields
      expect((migrated as unknown as Record<string, unknown>).accentBlue).toBeUndefined();
      expect((migrated as unknown as Record<string, unknown>).xtermBackground).toBeUndefined();
    });

    it('is idempotent on already-migrated shape', () => {
      const fresh = builtinToCustom('catppuccin-mocha');
      const migrated = migrateCustomThemeColors(fresh);
      expect(migrated).toEqual(fresh);
    });

    // The test above passed while the bug was live: `builtinToCustom` produces
    // no `xtermOverrides`, so the one field the migrated branch dropped was
    // absent from the fixture asserting idempotence. loadSession runs this on
    // every load, so a user's terminal colour overrides survived until the
    // next launch and no further.
    it('is idempotent on an already-migrated shape THAT CARRIES overrides', () => {
      const withOverrides = {
        ...builtinToCustom('catppuccin-mocha'),
        xtermPaletteId: 'tokyo-night' as const,
        xtermOverrides: { background: '#000000', foreground: '#4AFF00', cursor: '#4AFF00' },
      };
      const migrated = migrateCustomThemeColors(withOverrides);
      expect(migrated).toEqual(withOverrides);
      // And a second pass must not erode it either.
      expect(migrateCustomThemeColors(migrated)).toEqual(withOverrides);
    });

    it('keeps only real palette slots with string values', () => {
      const migrated = migrateCustomThemeColors({
        ...builtinToCustom('catppuccin-mocha'),
        xtermOverrides: {
          background: '#101010',
          notAPaletteSlot: '#ffffff',
          foreground: 42,
          cursor: '',
        },
      });
      expect(migrated.xtermOverrides).toEqual({ background: '#101010' });
    });

    it('omits the key entirely when no override survives', () => {
      const migrated = migrateCustomThemeColors({
        ...builtinToCustom('catppuccin-mocha'),
        xtermOverrides: { nope: 'x', alsoNope: 1 },
      });
      expect('xtermOverrides' in migrated).toBe(false);
    });

    it('the legacy shape still produces no overrides (it had no such concept)', () => {
      const migrated = migrateCustomThemeColors({
        bgBase: '#1E1E2E', textMain: '#CDD6F4', accentBlue: '#89B4FA',
        xtermBackground: '#1E1E2E',
      });
      expect(migrated.xtermOverrides).toBeUndefined();
    });

    it('falls back to default on null / invalid input', () => {
      const fallback = migrateCustomThemeColors(null);
      expect(fallback.bgBase).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(fallback.xtermPaletteId).toBe('catppuccin-mocha');
    });
  });
});

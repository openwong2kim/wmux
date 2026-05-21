import { describe, it, expect } from 'vitest';
import {
  builtinToCustom,
  deriveFullPalette,
  extractXtermColors,
  migrateCustomThemeColors,
  UI_THEME_TOKENS,
  XTERM_PALETTES,
  BUILTIN_XTERM_PALETTE,
  type BuiltinThemeId,
} from '../themes';
import { luminance } from '../tailwindPalette';

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

  describe('hinomaru / taegeuk light themes — text contrast', () => {
    // Regression: pre-refactor textMuted #A8A098 had luminance 0.388 on bg
    // 0.911 — a 2.4:1 contrast that read as "invisible white" against the
    // cream background. New textMuted must keep at least ~4:1 against bgBase.
    function contrastRatio(a: string, b: string): number {
      const l1 = luminance(a) + 0.05;
      const l2 = luminance(b) + 0.05;
      return l1 > l2 ? l1 / l2 : l2 / l1;
    }

    it('hinomaru textMuted is readable on bgBase', () => {
      const { textMuted, bgBase } = UI_THEME_TOKENS.hinomaru;
      expect(contrastRatio(textMuted, bgBase)).toBeGreaterThanOrEqual(3.5);
    });

    it('taegeuk textMuted is readable on bgBase', () => {
      const { textMuted, bgBase } = UI_THEME_TOKENS.taegeuk;
      expect(contrastRatio(textMuted, bgBase)).toBeGreaterThanOrEqual(3.5);
    });

    it('hinomaru textMain meets WCAG AA on bgBase', () => {
      const { textMain, bgBase } = UI_THEME_TOKENS.hinomaru;
      expect(contrastRatio(textMain, bgBase)).toBeGreaterThanOrEqual(4.5);
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

    it('falls back to default on null / invalid input', () => {
      const fallback = migrateCustomThemeColors(null);
      expect(fallback.bgBase).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(fallback.xtermPaletteId).toBe('catppuccin-mocha');
    });
  });
});

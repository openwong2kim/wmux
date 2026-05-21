import type { CustomThemeColors, XtermThemeColors } from '../shared/types';
import { shiftLightness, mixHex, hexToRgbString, isLight } from './tailwindPalette';

// Re-export so existing renderer-side imports keep working.
export type { XtermThemeColors };

// ─── Theme IDs ─────────────────────────────────────────────────────────────

export type BuiltinThemeId =
  | 'catppuccin-mocha' | 'monochrome' | 'stars-and-stripes'
  | 'red-dynasty' | 'nightowl' | 'void'
  | 'hinomaru' | 'taegeuk';

export type ThemeId = BuiltinThemeId | 'custom';

// Curated xterm palettes. Built-in themes pick one of these; users can also
// override their custom theme palette independently of the UI tokens.
export type XtermPaletteId =
  | 'catppuccin-mocha'
  | 'tokyo-night'
  | 'one-dark'
  | 'gruvbox-dark'
  | 'solarized-dark'
  | 'nord'
  | 'monochrome'
  | 'sandstone-light'
  | 'paper-light';

export const XTERM_PALETTES: Record<XtermPaletteId, XtermThemeColors> = {
  'catppuccin-mocha': {
    background: '#1E1E2E', foreground: '#CDD6F4', cursor: '#F5E0DC', selectionBackground: '#585B70',
    black: '#45475A', red: '#F38BA8', green: '#A6E3A1', yellow: '#F9E2AF',
    blue: '#89B4FA', magenta: '#F5C2E7', cyan: '#94E2D5', white: '#BAC2DE',
    brightBlack: '#585B70', brightRed: '#F38BA8', brightGreen: '#A6E3A1', brightYellow: '#F9E2AF',
    brightBlue: '#89B4FA', brightMagenta: '#F5C2E7', brightCyan: '#94E2D5', brightWhite: '#A6ADC8',
  },
  'tokyo-night': {
    background: '#1A1B26', foreground: '#C0CAF5', cursor: '#C0CAF5', selectionBackground: '#33467C',
    black: '#15161E', red: '#F7768E', green: '#9ECE6A', yellow: '#E0AF68',
    blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', white: '#A9B1D6',
    brightBlack: '#414868', brightRed: '#F7768E', brightGreen: '#9ECE6A', brightYellow: '#E0AF68',
    brightBlue: '#7AA2F7', brightMagenta: '#BB9AF7', brightCyan: '#7DCFFF', brightWhite: '#C0CAF5',
  },
  'one-dark': {
    background: '#282C34', foreground: '#ABB2BF', cursor: '#528BFF', selectionBackground: '#3E4451',
    black: '#3F4451', red: '#E06C75', green: '#98C379', yellow: '#E5C07B',
    blue: '#61AFEF', magenta: '#C678DD', cyan: '#56B6C2', white: '#ABB2BF',
    brightBlack: '#4F5666', brightRed: '#E06C75', brightGreen: '#98C379', brightYellow: '#E5C07B',
    brightBlue: '#61AFEF', brightMagenta: '#C678DD', brightCyan: '#56B6C2', brightWhite: '#E6E6E6',
  },
  'gruvbox-dark': {
    background: '#282828', foreground: '#EBDBB2', cursor: '#EBDBB2', selectionBackground: '#504945',
    black: '#3C3836', red: '#FB4934', green: '#B8BB26', yellow: '#FABD2F',
    blue: '#83A598', magenta: '#D3869B', cyan: '#8EC07C', white: '#A89984',
    brightBlack: '#665C54', brightRed: '#FB4934', brightGreen: '#B8BB26', brightYellow: '#FABD2F',
    brightBlue: '#83A598', brightMagenta: '#D3869B', brightCyan: '#8EC07C', brightWhite: '#EBDBB2',
  },
  'solarized-dark': {
    background: '#002B36', foreground: '#93A1A1', cursor: '#93A1A1', selectionBackground: '#073642',
    black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900',
    blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
    brightBlack: '#586E75', brightRed: '#DC322F', brightGreen: '#859900', brightYellow: '#B58900',
    brightBlue: '#268BD2', brightMagenta: '#D33682', brightCyan: '#2AA198', brightWhite: '#FDF6E3',
  },
  nord: {
    background: '#2E3440', foreground: '#D8DEE9', cursor: '#D8DEE9', selectionBackground: '#434C5E',
    black: '#3B4252', red: '#BF616A', green: '#A3BE8C', yellow: '#EBCB8B',
    blue: '#81A1C1', magenta: '#B48EAD', cyan: '#88C0D0', white: '#E5E9F0',
    brightBlack: '#4C566A', brightRed: '#BF616A', brightGreen: '#A3BE8C', brightYellow: '#EBCB8B',
    brightBlue: '#81A1C1', brightMagenta: '#B48EAD', brightCyan: '#8FBCBB', brightWhite: '#ECEFF4',
  },
  monochrome: {
    background: '#080808', foreground: '#E0E0E0', cursor: '#FFFFFF', selectionBackground: '#2A2A2A',
    black: '#2A2A2A', red: '#FF5555', green: '#909090', yellow: '#C0C0C0',
    blue: '#A0A0A0', magenta: '#999999', cyan: '#888888', white: '#B0B0B0',
    brightBlack: '#404040', brightRed: '#FF5555', brightGreen: '#B0B0B0', brightYellow: '#D0D0D0',
    brightBlue: '#B0B0B0', brightMagenta: '#AAAAAA', brightCyan: '#999999', brightWhite: '#888888',
  },
  'sandstone-light': {
    background: '#FAF8F5', foreground: '#2A2522', cursor: '#2A2522', selectionBackground: '#D4CFC6',
    black: '#2A2522', red: '#BC002D', green: '#3D6750', yellow: '#A06A1A',
    blue: '#1C4D6A', magenta: '#8A3A4C', cyan: '#2F6A5C', white: '#5A5048',
    brightBlack: '#A8A098', brightRed: '#D02040', brightGreen: '#4E7C66', brightYellow: '#B47A24',
    brightBlue: '#2E5F7C', brightMagenta: '#A04E60', brightCyan: '#4A8270', brightWhite: '#6A655E',
  },
  'paper-light': {
    background: '#F8F8FA', foreground: '#1A1A2E', cursor: '#1A1A2E', selectionBackground: '#CCCCD6',
    black: '#1A1A2E', red: '#C60C30', green: '#1F6940', yellow: '#9B6A07',
    blue: '#003478', magenta: '#82264C', cyan: '#0E5C5C', white: '#3A3A50',
    brightBlack: '#9A9AA8', brightRed: '#DA2848', brightGreen: '#2D8A56', brightYellow: '#B58817',
    brightBlue: '#1A4A90', brightMagenta: '#9A3464', brightCyan: '#1F7878', brightWhite: '#6A6A7A',
  },
};

// Legacy export — kept so useTerminal.ts can resolve a builtin theme's xterm
// palette directly. Built from BUILTIN_XTERM_PALETTE + XTERM_PALETTES.
export const XTERM_THEMES: Record<BuiltinThemeId, XtermThemeColors> = {} as Record<BuiltinThemeId, XtermThemeColors>;

// ─── 10-token UI palette per built-in theme ─────────────────────────────────

export interface UIThemeTokens {
  bgBase: string;    // main window background
  bgSurface: string; // elevated surface (sidebar, settings cards)
  bgMantle: string;  // recessed background (header, secondary)
  textMain: string;  // primary text
  textSub: string;   // secondary text (descriptions, labels)
  textMuted: string; // tertiary / disabled text
  accent: string;    // brand / selection / focus
  success: string;   // green family (running OK, complete)
  danger: string;    // red family (errors, destructive)
  warning: string;   // yellow/amber family (waiting, caution)
}

export const UI_THEME_TOKENS: Record<BuiltinThemeId, UIThemeTokens> = {
  'catppuccin-mocha': {
    bgBase: '#1E1E2E', bgSurface: '#313244', bgMantle: '#181825',
    textMain: '#CDD6F4', textSub: '#BAC2DE', textMuted: '#7F849C',
    accent: '#89B4FA', success: '#A6E3A1', danger: '#F38BA8', warning: '#F9E2AF',
  },
  monochrome: {
    bgBase: '#080808', bgSurface: '#1A1A1A', bgMantle: '#050505',
    textMain: '#E0E0E0', textSub: '#B0B0B0', textMuted: '#707070',
    accent: '#A0A0A0', success: '#909090', danger: '#FF5555', warning: '#C0C0C0',
  },
  'stars-and-stripes': {
    bgBase: '#0C1428', bgSurface: '#1E2E4A', bgMantle: '#091020',
    textMain: '#C8D6E8', textSub: '#A0B0C8', textMuted: '#6A7A98',
    accent: '#5B8DEF', success: '#4EBF8B', danger: '#E8554E', warning: '#F2C85B',
  },
  'red-dynasty': {
    bgBase: '#1A0A0A', bgSurface: '#3A1A1A', bgMantle: '#140808',
    textMain: '#E8D0C0', textSub: '#C0A898', textMuted: '#8A6A5A',
    accent: '#E84040', success: '#5AAE6A', danger: '#E84040', warning: '#F2C744',
  },
  nightowl: {
    bgBase: '#1E1B16', bgSurface: '#2E2A22', bgMantle: '#161310',
    textMain: '#C8BFA8', textSub: '#9A9080', textMuted: '#6B6350',
    accent: '#C4A055', success: '#8AAA70', danger: '#CC6B5A', warning: '#C89060',
  },
  void: {
    bgBase: '#000000', bgSurface: '#0A0A0A', bgMantle: '#000000',
    textMain: '#C0C0C0', textSub: '#909090', textMuted: '#606060',
    accent: '#C0C0C0', success: '#909090', danger: '#FF4444', warning: '#A0A0A0',
  },
  hinomaru: {
    // Light theme — text colors must be DARK against #FAF8F5 background.
    // Previous textMuted #A8A098 / textSubtle #8A827A were too pale → invisible.
    bgBase: '#FAF8F5', bgSurface: '#E2DDD4', bgMantle: '#F0ECE6',
    textMain: '#2A2522', textSub: '#4A4540', textMuted: '#6E6862',
    accent: '#BC002D', success: '#3D6750', danger: '#BC002D', warning: '#A06A1A',
  },
  taegeuk: {
    bgBase: '#F8F8FA', bgSurface: '#DDDDE4', bgMantle: '#EEEEF2',
    textMain: '#1A1A2E', textSub: '#3A3A50', textMuted: '#6A6A7A',
    accent: '#003478', success: '#1F6940', danger: '#C60C30', warning: '#9B6A07',
  },
};

// Which xterm palette each built-in theme uses for terminal rendering.
export const BUILTIN_XTERM_PALETTE: Record<BuiltinThemeId, XtermPaletteId> = {
  'catppuccin-mocha': 'catppuccin-mocha',
  monochrome: 'monochrome',
  'stars-and-stripes': 'one-dark',
  'red-dynasty': 'gruvbox-dark',
  nightowl: 'gruvbox-dark',
  void: 'monochrome',
  hinomaru: 'sandstone-light',
  taegeuk: 'paper-light',
};

// Populate XTERM_THEMES from the palette map (for legacy consumers).
for (const id of Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[]) {
  XTERM_THEMES[id] = XTERM_PALETTES[BUILTIN_XTERM_PALETTE[id]];
}

// ─── Full 14-var CSS palette (derived from 10 manual tokens) ────────────────

export interface FullCssPalette {
  bgBase: string;
  bgMantle: string;
  bgSurface: string;
  bgOverlay: string;       // derived
  textMuted: string;
  textSubtle: string;      // derived
  textSub: string;
  textSub2: string;        // derived
  textMain: string;
  accentCursor: string;    // derived (= accent) — kept separate so builtin themes can override
  accentBlue: string;      // derived (= accent)
  accentGreen: string;     // = success
  accentRed: string;       // = danger
  accentYellow: string;    // = warning
}

/** Expand 10 manual UI tokens to the 14 CSS variables we ship at runtime. */
export function deriveFullPalette(tokens: UIThemeTokens): FullCssPalette {
  const lightTheme = isLight(tokens.bgBase);
  const shadeDir = lightTheme ? -1 : 1;
  return {
    bgBase: tokens.bgBase,
    bgMantle: tokens.bgMantle,
    bgSurface: tokens.bgSurface,
    bgOverlay: shiftLightness(tokens.bgSurface, shadeDir * 0.06),
    textMain: tokens.textMain,
    textSub: tokens.textSub,
    textSub2: mixHex(tokens.textMain, tokens.textSub, 0.5),
    textSubtle: mixHex(tokens.textSub, tokens.textMuted, 0.5),
    textMuted: tokens.textMuted,
    accentCursor: tokens.accent,
    accentBlue: tokens.accent,
    accentGreen: tokens.success,
    accentRed: tokens.danger,
    accentYellow: tokens.warning,
  };
}

// ─── Built-in CssThemeVars (legacy export — kept for backwards compat) ──────

export interface CssThemeVars {
  bgBase: string;
  bgMantle: string;
  bgSurface: string;
  bgOverlay: string;
  textMuted: string;
  textSubtle: string;
  textSub: string;
  textSub2: string;
  textMain: string;
  accentCursor: string;
  accentBlue: string;
  accentGreen: string;
  accentRed: string;
  accentYellow: string;
}

export const CSS_THEME_VARS: Record<BuiltinThemeId, CssThemeVars> = {} as Record<BuiltinThemeId, CssThemeVars>;
for (const id of Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[]) {
  CSS_THEME_VARS[id] = deriveFullPalette(UI_THEME_TOKENS[id]);
}

// ─── Theme options for UI picker ────────────────────────────────────────────

export const THEME_OPTIONS: Array<{ value: ThemeId; label: string; preview: [string, string, string, string] }> = [
  { value: 'catppuccin-mocha',  label: 'Catppuccin',       preview: ['#1E1E2E', '#89B4FA', '#A6E3A1', '#F38BA8'] },
  { value: 'stars-and-stripes', label: 'Stars & Stripes',  preview: ['#0C1428', '#5B8DEF', '#4EBF8B', '#E8554E'] },
  { value: 'red-dynasty',       label: 'Red Dynasty',      preview: ['#1A0A0A', '#E84040', '#F2C744', '#6AA0CC'] },
  { value: 'nightowl',          label: 'Nightowl',         preview: ['#1E1B16', '#C4A055', '#8AAA70', '#CC6B5A'] },
  { value: 'void',              label: 'Void',             preview: ['#000000', '#C0C0C0', '#909090', '#FF4444'] },
  { value: 'monochrome',        label: 'Monochrome',       preview: ['#080808', '#A0A0A0', '#909090', '#FF5555'] },
  { value: 'hinomaru',          label: 'Hinomaru',         preview: ['#FAF8F5', '#BC002D', '#2C5F7C', '#3D6750'] },
  { value: 'taegeuk',           label: 'Taegeuk',          preview: ['#F8F8FA', '#C60C30', '#003478', '#1F6940'] },
  { value: 'custom',            label: 'Custom',           preview: ['#1E1E2E', '#89B4FA', '#A6E3A1', '#F38BA8'] },
];

export const XTERM_PALETTE_OPTIONS: Array<{ value: XtermPaletteId; label: string }> = [
  { value: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { value: 'tokyo-night',      label: 'Tokyo Night' },
  { value: 'one-dark',         label: 'One Dark' },
  { value: 'gruvbox-dark',     label: 'Gruvbox Dark' },
  { value: 'solarized-dark',   label: 'Solarized Dark' },
  { value: 'nord',             label: 'Nord' },
  { value: 'monochrome',       label: 'Monochrome' },
  { value: 'sandstone-light',  label: 'Sandstone (light)' },
  { value: 'paper-light',      label: 'Paper (light)' },
];

// ─── Custom theme helpers ───────────────────────────────────────────────────

/** Build a fresh CustomThemeColors from a built-in theme. */
export function builtinToCustom(themeId: BuiltinThemeId): CustomThemeColors {
  const ui = UI_THEME_TOKENS[themeId];
  return {
    ...ui,
    xtermPaletteId: BUILTIN_XTERM_PALETTE[themeId],
  };
}

export const DEFAULT_CUSTOM_THEME: CustomThemeColors = builtinToCustom('catppuccin-mocha');

/**
 * Resolve the effective xterm palette for a custom theme: preset values, then
 * per-slot overrides layered on top. Unknown override keys are ignored — only
 * keys that actually exist on XtermThemeColors get applied.
 */
export function extractXtermColors(colors: CustomThemeColors): XtermThemeColors {
  const id = colors.xtermPaletteId as XtermPaletteId;
  const base = XTERM_PALETTES[id] ?? XTERM_PALETTES['catppuccin-mocha'];
  if (!colors.xtermOverrides) return base;
  const merged: XtermThemeColors = { ...base };
  for (const k of Object.keys(base) as (keyof XtermThemeColors)[]) {
    const v = colors.xtermOverrides[k];
    if (typeof v === 'string' && v.length > 0) merged[k] = v;
  }
  return merged;
}

/** CSS variable name mapping. */
const CSS_VAR_MAP: Record<keyof FullCssPalette, string> = {
  bgBase: '--bg-base', bgMantle: '--bg-mantle', bgSurface: '--bg-surface', bgOverlay: '--bg-overlay',
  textMuted: '--text-muted', textSubtle: '--text-subtle', textSub: '--text-sub', textSub2: '--text-sub2',
  textMain: '--text-main', accentCursor: '--accent-cursor',
  accentBlue: '--accent-blue', accentGreen: '--accent-green', accentRed: '--accent-red',
  accentYellow: '--accent-yellow',
};

/** Apply a custom theme to document root — derives the 7 secondary tokens. */
export function applyCustomCssVars(colors: CustomThemeColors): void {
  const root = document.documentElement;
  const full = deriveFullPalette(colors);
  for (const [key, varName] of Object.entries(CSS_VAR_MAP)) {
    root.style.setProperty(varName, full[key as keyof FullCssPalette]);
  }
  root.style.setProperty('--accent-blue-rgb', hexToRgbString(full.accentBlue));
  root.style.setProperty('--bg-surface-rgb', hexToRgbString(full.bgSurface));
  root.style.setProperty('--bg-base-rgb', hexToRgbString(full.bgBase));
}

/** Clear custom CSS variables so [data-theme] rules in globals.css take over. */
export function clearCustomCssVars(): void {
  const root = document.documentElement;
  for (const varName of Object.values(CSS_VAR_MAP)) {
    root.style.removeProperty(varName);
  }
  root.style.removeProperty('--accent-blue-rgb');
  root.style.removeProperty('--bg-surface-rgb');
  root.style.removeProperty('--bg-base-rgb');
}

/** Legacy theme ID migration — maps old IDs to new ones. */
export function migrateThemeId(id: string): ThemeId {
  const LEGACY_MAP: Record<string, ThemeId> = {
    catppuccin: 'catppuccin-mocha',
    sandstone: 'hinomaru',
    dracula: 'catppuccin-mocha',
    nord: 'stars-and-stripes',
    'tokyo-night': 'catppuccin-mocha',
    'solarized-dark': 'stars-and-stripes',
    'gruvbox-dark': 'nightowl',
    'rose-pine': 'catppuccin-mocha',
  };
  return LEGACY_MAP[id] ?? (id as ThemeId);
}

/**
 * Migrate a legacy CustomThemeColors (37 fields: 17 UI + 20 xterm) to the new
 * shape (10 UI + xtermPaletteId). Detects the xterm palette by matching the
 * stored xtermBackground. Idempotent on already-migrated shapes.
 */
export function migrateCustomThemeColors(input: unknown): CustomThemeColors {
  if (!input || typeof input !== 'object') return DEFAULT_CUSTOM_THEME;
  const obj = input as Record<string, unknown>;

  // Already in new shape (has xtermPaletteId, no xtermBackground)?
  if (typeof obj.xtermPaletteId === 'string' && typeof obj.xtermBackground !== 'string') {
    const ui: UIThemeTokens = {
      bgBase: String(obj.bgBase ?? DEFAULT_CUSTOM_THEME.bgBase),
      bgSurface: String(obj.bgSurface ?? DEFAULT_CUSTOM_THEME.bgSurface),
      bgMantle: String(obj.bgMantle ?? DEFAULT_CUSTOM_THEME.bgMantle),
      textMain: String(obj.textMain ?? DEFAULT_CUSTOM_THEME.textMain),
      textSub: String(obj.textSub ?? DEFAULT_CUSTOM_THEME.textSub),
      textMuted: String(obj.textMuted ?? DEFAULT_CUSTOM_THEME.textMuted),
      accent: String(obj.accent ?? DEFAULT_CUSTOM_THEME.accent),
      success: String(obj.success ?? DEFAULT_CUSTOM_THEME.success),
      danger: String(obj.danger ?? DEFAULT_CUSTOM_THEME.danger),
      warning: String(obj.warning ?? DEFAULT_CUSTOM_THEME.warning),
    };
    return { ...ui, xtermPaletteId: obj.xtermPaletteId as XtermPaletteId };
  }

  // Legacy 37-field shape. Map old keys to new tokens.
  const ui: UIThemeTokens = {
    bgBase: String(obj.bgBase ?? DEFAULT_CUSTOM_THEME.bgBase),
    bgSurface: String(obj.bgSurface ?? DEFAULT_CUSTOM_THEME.bgSurface),
    bgMantle: String(obj.bgMantle ?? DEFAULT_CUSTOM_THEME.bgMantle),
    textMain: String(obj.textMain ?? DEFAULT_CUSTOM_THEME.textMain),
    textSub: String(obj.textSub ?? DEFAULT_CUSTOM_THEME.textSub),
    textMuted: String(obj.textMuted ?? DEFAULT_CUSTOM_THEME.textMuted),
    accent: String(obj.accentBlue ?? DEFAULT_CUSTOM_THEME.accent),
    success: String(obj.accentGreen ?? DEFAULT_CUSTOM_THEME.success),
    danger: String(obj.accentRed ?? DEFAULT_CUSTOM_THEME.danger),
    warning: String(obj.accentYellow ?? DEFAULT_CUSTOM_THEME.warning),
  };

  // Detect xterm palette by background match (best-effort).
  let xtermPaletteId: XtermPaletteId = 'catppuccin-mocha';
  const legacyBg = typeof obj.xtermBackground === 'string' ? obj.xtermBackground.toUpperCase() : '';
  if (legacyBg) {
    for (const [pid, palette] of Object.entries(XTERM_PALETTES)) {
      if (palette.background.toUpperCase() === legacyBg) {
        xtermPaletteId = pid as XtermPaletteId;
        break;
      }
    }
  }
  return { ...ui, xtermPaletteId };
}

// ─── Backwards-compat re-export of hexToRgb (legacy callers may import it) ──
export { hexToRgbString as hexToRgb } from './tailwindPalette';

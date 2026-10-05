import type { CustomThemeColors, XtermThemeColors } from '../shared/types';
import { shiftLightness, mixHex, hexToRgbString, isLight } from './tailwindPalette';

// Re-export so existing renderer-side imports keep working.
export type { XtermThemeColors };

// ─── Theme IDs ─────────────────────────────────────────────────────────────

export type BuiltinThemeId =
  | 'tint' | 'zinc' | 'graphite' | 'paper' | 'amber-line'
  | 'mono' | 'mono-light'
  | 'amber'
  | 'catppuccin-mocha' | 'monochrome' | 'stars-and-stripes'
  | 'red-dynasty' | 'nightowl' | 'void'
  | 'hinomaru' | 'taegeuk';

export type ThemeId = BuiltinThemeId | 'custom';

// Curated xterm palettes. Built-in themes pick one of these; users can also
// override their custom theme palette independently of the UI tokens.
export type XtermPaletteId =
  | 'tint-dark'
  | 'zinc-dark'
  | 'graphite-dark'
  | 'paper-white'
  | 'amber-line-dark'
  | 'mono-dark'
  | 'mono-light'
  | 'amber-graphite'
  | 'catppuccin-mocha'
  | 'tokyo-night'
  | 'one-dark'
  | 'gruvbox-dark'
  | 'solarized-dark'
  | 'nord'
  | 'monochrome'
  | 'matrix'
  | 'sandstone-light'
  | 'paper-light';

export const XTERM_PALETTES: Record<XtermPaletteId, XtermThemeColors> = {
  // Terminal palettes for the five looks (2026-10-03). Each background is the
  // look's opaque main surface — the terminal never goes translucent — and the
  // cursor is the look's accent.
  'tint-dark': {
    background: '#1A171D', foreground: '#E9E6EE', cursor: '#9B8CFF', selectionBackground: '#3A3542',
    black: '#24202A', red: '#FF7B7B', green: '#5FD39A', yellow: '#F2B25C',
    blue: '#8AB4FF', magenta: '#C9A6FF', cyan: '#6FD6E0', white: '#E9E6EE',
    brightBlack: '#6E6878', brightRed: '#FF9C9C', brightGreen: '#86E2B4', brightYellow: '#F6C987',
    brightBlue: '#A9C8FF', brightMagenta: '#DCC2FF', brightCyan: '#97E4EB', brightWhite: '#F4F2F7',
  },
  'zinc-dark': {
    background: '#09090B', foreground: '#E4E4E7', cursor: '#FAFAFA', selectionBackground: '#27272A',
    black: '#18181B', red: '#F87171', green: '#4ADE80', yellow: '#FBBF24',
    blue: '#60A5FA', magenta: '#C084FC', cyan: '#22D3EE', white: '#E4E4E7',
    brightBlack: '#71717A', brightRed: '#FCA5A5', brightGreen: '#86EFAC', brightYellow: '#FDE68A',
    brightBlue: '#93C5FD', brightMagenta: '#D8B4FE', brightCyan: '#67E8F9', brightWhite: '#FAFAFA',
  },
  'graphite-dark': {
    background: '#0B0C0E', foreground: '#DFE3EA', cursor: '#4C8DFF', selectionBackground: '#1B2433',
    black: '#1A1C21', red: '#FF6B6B', green: '#3FCF8E', yellow: '#F5A524',
    blue: '#4C8DFF', magenta: '#B48CFF', cyan: '#3CC6D6', white: '#DFE3EA',
    brightBlack: '#6F7682', brightRed: '#FF9191', brightGreen: '#6FDDAA', brightYellow: '#F8BD5A',
    brightBlue: '#7AAAFF', brightMagenta: '#CBADFF', brightCyan: '#6BD5E1', brightWhite: '#EEF0F3',
  },
  'paper-white': {
    background: '#FFFFFF', foreground: '#24242B', cursor: '#5B5BD6', selectionBackground: '#E4E4EA',
    black: '#3F3F48', red: '#DC2626', green: '#16A34A', yellow: '#A16207',
    blue: '#4F46E5', magenta: '#A21CAF', cyan: '#0E7490', white: '#ECECF0',
    brightBlack: '#6B6B76', brightRed: '#B91C1C', brightGreen: '#15803D', brightYellow: '#854D0E',
    brightBlue: '#4338CA', brightMagenta: '#86198F', brightCyan: '#155E75', brightWhite: '#17171C',
  },
  'amber-line-dark': {
    background: '#121212', foreground: '#E8E4DC', cursor: '#E8A33D', selectionBackground: '#33302B',
    black: '#212020', red: '#E8736B', green: '#7FC98A', yellow: '#E8A33D',
    blue: '#8AAEE0', magenta: '#C79BC7', cyan: '#8FBFB2', white: '#E8E4DC',
    brightBlack: '#6E6A63', brightRed: '#EE958F', brightGreen: '#A3D9AB', brightYellow: '#EFBD70',
    brightBlue: '#A6C3EA', brightMagenta: '#D7B3D7', brightCyan: '#A8D1C6', brightWhite: '#F2F0EC',
  },
  // Adapted from MonoCode (hardbeat920/monocode@6bd432ca,
  // src/features/terminal/ui/TerminalView.tsx), MIT License, Copyright (c) 2026 Nick
  // ANSI_DARK / ANSI_LIGHT with the theme's own content colour as foreground.
  // The background is the opaque theme base: the terminal grid never goes
  // translucent, even when window glass is on.
  'mono-dark': {
    background: '#1A171B', foreground: '#E8E9ED', cursor: '#4DA3F5', selectionBackground: '#3E3A41',
    black: '#1D2428', red: '#F87171', green: '#4ADE80', yellow: '#FBBF24',
    blue: '#60A5FA', magenta: '#C084FC', cyan: '#22D3EE', white: '#E8EEF2',
    brightBlack: '#64748B', brightRed: '#FCA5A5', brightGreen: '#86EFAC', brightYellow: '#FDE68A',
    brightBlue: '#93C5FD', brightMagenta: '#D8B4FE', brightCyan: '#67E8F9', brightWhite: '#F8FAFC',
  },
  'mono-light': {
    background: '#F7F7F7', foreground: '#2E2E2E', cursor: '#4078F2', selectionBackground: '#CFCFCF',
    black: '#383A42', red: '#E45649', green: '#50A14F', yellow: '#C18401',
    blue: '#4078F2', magenta: '#A626A4', cyan: '#0184BC', white: '#FAFAFA',
    brightBlack: '#7C8591', brightRed: '#DF6B60', brightGreen: '#68B567', brightYellow: '#D19A2F',
    brightBlue: '#5C89F5', brightMagenta: '#B54BB3', brightCyan: '#1F9CC9', brightWhite: '#FFFFFF',
  },
  // Amber design system (designs/design-system-20260711): warm graphite base,
  // muted low-saturation ANSI hues so terminal output stays quiet next to the
  // single amber accent. Cursor is the amber — the one colored thing.
  'amber-graphite': {
    background: '#121214', foreground: '#BDBAB4', cursor: '#E8A33D', selectionBackground: '#3A3833',
    black: '#28282D', red: '#D96C6C', green: '#8FBF7F', yellow: '#D4B36A',
    blue: '#8AAEE0', magenta: '#C79BC7', cyan: '#8FBFB2', white: '#BDBAB4',
    brightBlack: '#5C5A55', brightRed: '#E28A8A', brightGreen: '#A8D19A', brightYellow: '#E2C687',
    brightBlue: '#A6C3EA', brightMagenta: '#D7B3D7', brightCyan: '#A8D1C6', brightWhite: '#EFEEEC',
  },
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
  // Phosphor green on a green-tinted black. Two deliberate departures from
  // "make everything green", both about output staying readable:
  //   1. red and yellow keep their warmth. A palette where a failing test, a
  //      `git diff -` line and a warning all render green destroys the one job
  //      colour does in a terminal. Red is the error channel; it stays red.
  //   2. blue / cyan / magenta are pulled apart on the hue wheel (185° teal,
  //      168° aqua, 150° pale mint) instead of all landing on green. The first
  //      draft had blue and green separated only by lightness, which makes `ls`
  //      unable to distinguish a directory from an executable.
  // background is #080D08 rather than pure black so `brightBlack` (dim text:
  // comments, timestamps) still clears 3.9:1 instead of vanishing.
  matrix: {
    background: '#080D08', foreground: '#33FF66', cursor: '#00FF41', selectionBackground: '#163D24',
    black: '#0E1A12', red: '#FF5F56', green: '#00FF41', yellow: '#C8FF64',
    blue: '#009E8F', magenta: '#B9FFD8', cyan: '#5FFFE0', white: '#A8E8BC',
    brightBlack: '#4A7A5C', brightRed: '#FF8A80', brightGreen: '#7CFF9B', brightYellow: '#E4FF8F',
    brightBlue: '#22D4BE', brightMagenta: '#DFFFEE', brightCyan: '#8FFFEE', brightWhite: '#E8FFF0',
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

// ─── 11-token UI palette per built-in theme ─────────────────────────────────

export interface UIThemeTokens {
  bgBase: string;    // main window background
  bgSurface: string; // elevated surface (sidebar, settings cards)
  bgMantle: string;  // recessed background (header, secondary)
  textMain: string;  // primary text
  textSub: string;   // secondary text (descriptions, labels)
  textMuted: string; // tertiary / disabled text
  accent: string;    // brand / selection / focus (primary accent)
  accentSecondary: string; // link/info accent (--accent-blue) — split from
                           // `accent` so links can diverge from the brand hue.
                           // Defaults to `accent` per theme (visually inert
                           // until a theme opts into a distinct value).
  success: string;   // green family (running OK, complete)
  danger: string;    // red family (errors, destructive)
  warning: string;   // yellow/amber family (waiting, caution)
}

export const UI_THEME_TOKENS: Record<BuiltinThemeId, UIThemeTokens> = {
  // The five looks (owner decision 2026-10-03; tint is the default). Colour
  // values follow the approved look sheet; bgSurface is the look's fill and
  // bgMantle its sidebar. Style knobs live in THEME_STYLES below.
  tint: {
    bgBase: '#1A171D', bgSurface: '#25222A', bgMantle: '#18151C',
    textMain: '#F4F2F7', textSub: '#C2BDC9', textMuted: '#8A8492',
    accent: '#9B8CFF', accentSecondary: '#9B8CFF', success: '#5FD39A', danger: '#FF7B7B', warning: '#F2B25C',
  },
  zinc: {
    bgBase: '#09090B', bgSurface: '#18181B', bgMantle: '#0C0C0E',
    textMain: '#FAFAFA', textSub: '#D4D4D8', textMuted: '#71717A',
    accent: '#FAFAFA', accentSecondary: '#FAFAFA', success: '#4ADE80', danger: '#F87171', warning: '#FBBF24',
  },
  graphite: {
    bgBase: '#0B0C0E', bgSurface: '#1A1C21', bgMantle: '#111215',
    textMain: '#EEF0F3', textSub: '#B9BEC7', textMuted: '#6F7682',
    accent: '#4C8DFF', accentSecondary: '#4C8DFF', success: '#3FCF8E', danger: '#FF6B6B', warning: '#F5A524',
  },
  paper: {
    bgBase: '#FFFFFF', bgSurface: '#ECECF0', bgMantle: '#F3F3F5',
    textMain: '#17171C', textSub: '#3F3F48', textMuted: '#8A8A96',
    accent: '#5B5BD6', accentSecondary: '#5B5BD6', success: '#16A34A', danger: '#DC2626', warning: '#C2700A',
  },
  'amber-line': {
    bgBase: '#121212', bgSurface: '#212020', bgMantle: '#161616',
    textMain: '#F2F0EC', textSub: '#C9C5BD', textMuted: '#85817A',
    accent: '#E8A33D', accentSecondary: '#E8A33D', success: '#7FC98A', danger: '#E8736B', warning: '#E8A33D',
  },
  // The mono look. Adapted from MonoCode
  // (hardbeat920/monocode@6bd432ca, src/styles/index.css), MIT License,
  // Copyright (c) 2026 Nick. Zero-saturation greys from one lightness pair
  // (base 9% / content 92%, light 97% / 18%); surface = content 7% over the
  // base, sub = content 60%, muted = content 40% (45% in light). One accent,
  // hsl(211 92% 62%), for selection, focus, primary actions and "needs you";
  // done emerald-400 and error red-400 (Tailwind palette, as the source uses)
  // stay for diffs and failures. Running is muted (agentStatusIcon.ts).
  // Dark carries a faint warm-violet cast (base ≈ rgb(26,23,27)) and three
  // text levels: bright primary, mid-grey secondary, dim tertiary.
  mono: {
    bgBase: '#1A171B', bgSurface: '#2A272C', bgMantle: '#171419',
    textMain: '#E8E9ED', textSub: '#85868B', textMuted: '#626167',
    accent: '#459BF7', accentSecondary: '#459BF7', success: '#34D399', danger: '#F87171', warning: '#FBBF24',
  },
  'mono-light': {
    bgBase: '#F7F7F7', bgSurface: '#EBEBEB', bgMantle: '#F7F7F7',
    textMain: '#2E2E2E', textSub: '#7E7E7E', textMuted: '#9C9C9C',
    accent: '#459BF7', accentSecondary: '#459BF7', success: '#059669', danger: '#DC2626', warning: '#B45309',
  },
  // The redesign default (designs/design-system-20260711/wmux-FINAL-amber.html).
  // Three decisions: ONE amber for action/focus/attention; warm graphite (not
  // blue-ink) neutrals for everything else; hierarchy from typography, not
  // decoration. accentSecondary deliberately equals accent — links and jumps
  // are amber too, so amber on screen always means "where meaning is".
  // warning is ALSO amber (attention is the accent's third job in the design).
  // bgMantle is the mock's PANEL surface (#19191C — slightly lighter than the
  // base): the dock, tab strips, and toolbar all sit on it, which is what
  // makes the three regions read as one piece of chrome.
  amber: {
    bgBase: '#151517', bgSurface: '#202024', bgMantle: '#19191C',
    textMain: '#EFEEEC', textSub: '#A5A29C', textMuted: '#66645F',
    accent: '#E8A33D', accentSecondary: '#6E9BC4', success: '#8FBF7F', danger: '#D96C6C', warning: '#E8A33D', // 2-accent (owner 2026-07-15): amber = alive/attention, steel-blue --accent-blue = navigation/interactive
  },
  'catppuccin-mocha': {
    bgBase: '#1E1E2E', bgSurface: '#313244', bgMantle: '#181825',
    textMain: '#CDD6F4', textSub: '#BAC2DE', textMuted: '#585B70', // SSOT: authentic Catppuccin Surface2 (matches shipped globals.css)
    accent: '#89B4FA', accentSecondary: '#89B4FA', success: '#A6E3A1', danger: '#F38BA8', warning: '#F9E2AF',
  },
  monochrome: {
    bgBase: '#080808', bgSurface: '#1A1A1A', bgMantle: '#050505',
    textMain: '#E0E0E0', textSub: '#B0B0B0', textMuted: '#404040', // SSOT: matches shipped globals.css
    accent: '#A0A0A0', accentSecondary: '#A0A0A0', success: '#909090', danger: '#FF5555', warning: '#C0C0C0',
  },
  'stars-and-stripes': {
    bgBase: '#0C1428', bgSurface: '#1E2E4A', bgMantle: '#091020',
    textMain: '#C8D6E8', textSub: '#A0B0C8', textMuted: '#3A5070', // SSOT: matches shipped globals.css
    accent: '#5B8DEF', accentSecondary: '#5B8DEF', success: '#4EBF8B', danger: '#E8554E', warning: '#F2C85B',
  },
  'red-dynasty': {
    bgBase: '#1A0A0A', bgSurface: '#3A1A1A', bgMantle: '#140808',
    textMain: '#E8D0C0', textSub: '#C0A898', textMuted: '#5A3A30', // SSOT: matches shipped globals.css
    accent: '#E84040', accentSecondary: '#6AA0CC', success: '#5AAE6A', danger: '#E84040', warning: '#F2C744', // accentSecondary (--accent-blue) is a distinct blue for links, per shipped globals.css
  },
  nightowl: {
    bgBase: '#1E1B16', bgSurface: '#2E2A22', bgMantle: '#161310',
    textMain: '#C8BFA8', textSub: '#9A9080', textMuted: '#5A5340', // SSOT: matches shipped globals.css
    accent: '#C4A055', accentSecondary: '#7FA6C9', success: '#8AAA70', danger: '#CC6B5A', warning: '#C89060', // 2-accent: gold alive / cool-blue nav (--accent-blue)
  },
  void: {
    bgBase: '#000000', bgSurface: '#0A0A0A', bgMantle: '#000000',
    textMain: '#C0C0C0', textSub: '#909090', textMuted: '#333333', // SSOT: matches shipped globals.css
    accent: '#C0C0C0', accentSecondary: '#C0C0C0', success: '#909090', danger: '#FF4444', warning: '#A0A0A0',
  },
  hinomaru: {
    // Light theme — text colors must be DARK against #FAF8F5 background.
    // Previous textMuted #A8A098 / textSubtle #8A827A were too pale → invisible.
    bgBase: '#FAF8F5', bgSurface: '#E2DDD4', bgMantle: '#F0ECE6',
    textMain: '#2A2522', textSub: '#4A4540', textMuted: '#6E6862',
    accent: '#BC002D', accentSecondary: '#1C4D6A', success: '#3D6750', danger: '#BC002D', warning: '#A06A1A', // accentSecondary (--accent-blue) is a distinct blue for links, per shipped globals.css
  },
  taegeuk: {
    bgBase: '#F8F8FA', bgSurface: '#DDDDE4', bgMantle: '#EEEEF2',
    textMain: '#1A1A2E', textSub: '#3A3A50', textMuted: '#6A6A7A',
    accent: '#003478', accentSecondary: '#003478', success: '#1F6940', danger: '#C60C30', warning: '#9B6A07',
  },
};

// ─── Attention orange (needs you) ───────────────────────────────────────────
//
// The one colour that means "an agent is waiting on you" (owner decision
// 2026-10-06): the sidebar's dash, mark and label, the rail badge and dot,
// Fleet's Needs you chip and dot, and the titlebar count. One orange hue
// family (≈21–29°), tuned per look so it stays vivid there; never the
// caution yellow (`warning`) and never the error red (`danger`).
//   fill — dashes, marks, dots, badge fill (≥ 3:1 on the page and sidebar)
//   text — words and counts (≥ 4.5:1 on page, sidebar, fill and frame); on
//          light looks a darker orange of the same hue
//   ink  — badge digits on the fill (≥ 4.5:1)
// globals.css carries these as --attention / --attention-text /
// --attention-ink in each look's block (locked by attentionColors.test.ts).

export interface AttentionColors { fill: string; text: string; ink: string }

export const ATTENTION_COLORS: Record<BuiltinThemeId, AttentionColors> = {
  tint: { fill: '#FF8A4C', text: '#FF9A62', ink: '#1A171D' },
  zinc: { fill: '#FB8A3C', text: '#FB923C', ink: '#09090B' },
  graphite: { fill: '#FF8A3D', text: '#FF9550', ink: '#0B0C0E' },
  paper: { fill: '#CE560D', text: '#A8400A', ink: '#000000' },
  'amber-line': { fill: '#FF7A26', text: '#FF8A3D', ink: '#121212' },
  mono: { fill: '#FF8A3D', text: '#FF9550', ink: '#1A171B' },
  'mono-light': { fill: '#D8580B', text: '#A33F09', ink: '#141414' },
  amber: { fill: '#FF7A2E', text: '#FF8A45', ink: '#151517' },
  'catppuccin-mocha': { fill: '#FAB387', text: '#FAB387', ink: '#1E1E2E' },
  monochrome: { fill: '#FF8A3D', text: '#FF9550', ink: '#080808' },
  'stars-and-stripes': { fill: '#FF9248', text: '#FF9C5A', ink: '#0C1428' },
  'red-dynasty': { fill: '#FF9A3C', text: '#FFA552', ink: '#1A0A0A' },
  nightowl: { fill: '#F08A3E', text: '#F59A55', ink: '#1E1B16' },
  void: { fill: '#FF8A3D', text: '#FF9550', ink: '#000000' },
  hinomaru: { fill: '#CA5510', text: '#9A3B08', ink: '#000000' },
  taegeuk: { fill: '#CE530B', text: '#983A08', ink: '#000000' },
};

/** The CSS custom properties a look's block sets for the attention orange. */
export function attentionCssVars(id: BuiltinThemeId): Record<string, string> {
  const c = ATTENTION_COLORS[id];
  return { '--attention': c.fill, '--attention-text': c.text, '--attention-ink': c.ink };
}

// Which xterm palette each built-in theme uses for terminal rendering.
export const BUILTIN_XTERM_PALETTE: Record<BuiltinThemeId, XtermPaletteId> = {
  tint: 'tint-dark',
  zinc: 'zinc-dark',
  graphite: 'graphite-dark',
  paper: 'paper-white',
  'amber-line': 'amber-line-dark',
  mono: 'mono-dark',
  'mono-light': 'mono-light',
  amber: 'amber-graphite',
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

// ─── Per-theme style knobs ──────────────────────────────────────────────────
//
// A theme is more than colour: its UI face, how round a chip is, how a
// selected row is marked, whether group labels are uppercase and tracked,
// whether an active tab is underlined, and whether the window may go
// translucent. Every knob is optional; a theme without an entry (all the
// themes that shipped before the five looks) keeps exactly today's look,
// because the CSS defaults in globals.css are today's values.

export type SelectionStyle = 'fill' | 'fill-ring' | 'left-bar';

export interface ThemeStyle {
  /** UI font stack (CSS `font-family`). Default: the platform UI face. */
  uiFont?: string;
  /** Chip / picker radius in px; 999 = full round. Default 6. */
  chipRadius?: number;
  /** How a selected row is drawn. Default 'fill'. */
  selection?: SelectionStyle;
  /** Selected-row fill. Default: the content-mix --selection. */
  selectionFill?: string;
  /** Ring colour for 'fill-ring' (defaults to `stroke`). */
  selectionRing?: string;
  /** Group labels (sidebar section heads): uppercase + letter-spacing. */
  groupLabel?: { uppercase: boolean; tracking: string };
  /** Active tab marker: a fill only, or a fill plus an accent underline. */
  tabIndicator?: 'fill' | 'underline';
  /** May the window chrome go translucent (macOS, dark)? Default true. */
  glass?: boolean;
  /** Hairline colour. Default: the content-mix --stroke. */
  stroke?: string;
  /** The solid primary action. Default: white / ink by polarity. */
  primary?: { fill: string; ink: string };
  /** Title weight (row titles). Default 600. */
  titleWeight?: number;
  /** The window frame around the floating sheet (titlebar, margins), hex.
   *  Default: --app-bg, a step darker than the base. */
  frame?: string;
  /** The sheet's 1px edge against the frame. Default: --stroke. */
  sheetEdge?: string;
}

const GEIST = "'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif";

export const THEME_STYLES: Partial<Record<BuiltinThemeId, ThemeStyle>> = {
  tint: {
    uiFont: GEIST, chipRadius: 7, selection: 'fill', selectionFill: 'color-mix(in srgb, var(--text-main) 9%, transparent)',
    groupLabel: { uppercase: false, tracking: 'normal' }, tabIndicator: 'fill', glass: true,
    stroke: 'color-mix(in srgb, var(--text-main) 7%, transparent)', primary: { fill: '#F4F2F7', ink: '#1A171D' }, titleWeight: 500,
    frame: '#121015', sheetEdge: 'color-mix(in srgb, var(--text-main) 10%, transparent)',
  },
  zinc: {
    uiFont: GEIST, chipRadius: 6, selection: 'fill-ring', selectionFill: '#18181B', selectionRing: '#27272A',
    groupLabel: { uppercase: false, tracking: 'normal' }, tabIndicator: 'fill', glass: false,
    stroke: '#27272A', primary: { fill: '#FAFAFA', ink: '#09090B' }, titleWeight: 500,
    frame: '#000000', sheetEdge: '#27272A',
  },
  graphite: {
    uiFont: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif", chipRadius: 999,
    selection: 'fill', selectionFill: '#1B2433',
    groupLabel: { uppercase: true, tracking: '0.06em' }, tabIndicator: 'underline', glass: false,
    stroke: '#1D1F24', primary: { fill: '#4C8DFF', ink: '#FFFFFF' }, titleWeight: 500,
    frame: '#060708', sheetEdge: '#23262C',
  },
  paper: {
    uiFont: "'Figtree', system-ui, -apple-system, 'Segoe UI', sans-serif", chipRadius: 7,
    selection: 'fill', selectionFill: '#E4E4EA',
    groupLabel: { uppercase: false, tracking: 'normal' }, tabIndicator: 'fill', glass: false,
    stroke: '#E6E6EA', primary: { fill: '#17171C', ink: '#FFFFFF' }, titleWeight: 500,
    frame: '#ECECEF', sheetEdge: '#DADAE0',
  },
  'amber-line': {
    uiFont: GEIST, chipRadius: 6, selection: 'left-bar', selectionFill: '#24221F',
    groupLabel: { uppercase: false, tracking: 'normal' }, tabIndicator: 'underline', glass: false,
    stroke: '#262523', primary: { fill: '#E8A33D', ink: '#1A1408' }, titleWeight: 500,
    frame: '#0B0B0B', sheetEdge: '#2C2B29',
  },
};

/**
 * The CSS custom properties a theme's style knobs set on its [data-theme]
 * block. Knobs left unset emit nothing, so the :root defaults (today's look)
 * apply. globals.css carries exactly this output (locked by
 * themeStyles.test.ts).
 */
export function themeStyleCssVars(style: ThemeStyle | undefined, accent: string): Record<string, string> {
  if (!style) return {};
  const out: Record<string, string> = {};
  if (style.uiFont) out['--font-ui'] = style.uiFont;
  if (style.chipRadius !== undefined) out['--chip-radius'] = `${style.chipRadius}px`;
  if (style.selectionFill) out['--selection'] = style.selectionFill;
  if (style.selection) {
    const ring = style.selectionRing ?? style.stroke ?? 'transparent';
    out['--select-ring'] = style.selection === 'fill-ring'
      ? `inset 0 0 0 1px ${ring}`
      : style.selection === 'left-bar' ? `inset 2px 0 0 ${accent}` : 'none';
  }
  if (style.groupLabel) {
    out['--group-case'] = style.groupLabel.uppercase ? 'uppercase' : 'none';
    out['--group-track'] = style.groupLabel.tracking;
  }
  if (style.tabIndicator) out['--tab-underline'] = style.tabIndicator === 'underline' ? '2px' : '0px';
  if (style.glass !== undefined) out['--theme-glass'] = style.glass ? '1' : '0';
  if (style.stroke) out['--stroke'] = style.stroke;
  if (style.primary) {
    out['--primary-fill'] = style.primary.fill;
    out['--primary-ink'] = style.primary.ink;
  }
  if (style.titleWeight !== undefined) out['--title-weight'] = String(style.titleWeight);
  if (style.frame) out['--frame-bg'] = style.frame;
  if (style.sheetEdge) out['--sheet-edge'] = style.sheetEdge;
  return out;
}

// ─── Full 14-var CSS palette (derived from 11 manual tokens) ────────────────

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
  accent: string;          // brand/action warm accent (--accent) — passthrough of tokens.accent
  accentCursor: string;    // derived (= accent) — kept separate so builtin themes can override
  accentBlue: string;      // derived (= accent)
  accentGreen: string;     // = success
  accentRed: string;       // = danger
  accentYellow: string;    // = warning
  overlayScrim: string;    // derived — modal/dialog scrim
  surfaceHighlight: string; // derived — specular top-inset on filled surfaces
}

/** Expand the 11 manual UI tokens to the 14 CSS variables we ship at runtime. */
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
    accent: tokens.accent,
    accentCursor: tokens.accent,
    accentBlue: tokens.accentSecondary,
    accentGreen: tokens.success,
    accentRed: tokens.danger,
    accentYellow: tokens.warning,
    // The scrim is a neutral black veil, not a themed hue: it has to darken
    // whatever the theme paints underneath so a dialog reads as modal. A light
    // theme needs less of it — 0.55 over a near-white page reads as a blackout
    // rather than a dimming — so the veil follows the theme's polarity.
    overlayScrim: lightTheme ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.55)',
    // The specular top-inset highlight on a FILLED surface (accent CTA, danger
    // CTA, toast, colour swatch). It models a light source above the control,
    // so it is white on every theme INCLUDING the light ones: those fills are
    // saturated accent colours, not the page background, and a dark inset there
    // reads as a groove pressed into the button rather than a raised edge.
    // This is why it cannot be a --text-main mix — on hinomaru/taegeuk
    // --text-main is near-black and inverts the whole "machined" affordance.
    surfaceHighlight: '#FFFFFF',
  };
}

// ─── Built-in derived-var overrides (SSOT completion) ───────────────────────
//
// A few built-in themes ship hand-tuned values for DERIVED CSS vars that
// deriveFullPalette's formulas cannot reproduce — authentic upstream palettes
// (Catppuccin's rosewater cursor / Subtext0), pure-white cursors (monochrome /
// void), and per-theme bgOverlay/textSubtle/textSub2 that were nudged by hand.
// Historically these lived ONLY in globals.css, so themes.ts and globals.css
// drifted silently (a built-in theme rendered differently from "custom based on
// that built-in"). Capturing them here makes themes.ts the single source of
// truth: deriveBuiltinPalette() reproduces every shipped [data-theme] block
// EXACTLY (locked by themeParity.test.ts). The values are byte-identical to what
// already ships — this changes NO built-in's on-screen appearance.
//
// These apply to BUILT-IN rendering only. Custom themes intentionally derive
// purely from their 11 editable tokens (deriveFullPalette) so a user's live
// edits are never pinned to a stale override.
export const BUILTIN_CSS_OVERRIDES: Partial<Record<BuiltinThemeId, Partial<FullCssPalette>>> = {
  amber: { bgOverlay: '#28282D', textSubtle: '#85827B' },
  'catppuccin-mocha': { bgOverlay: '#45475A', textSubtle: '#6C7086', textSub2: '#A6ADC8', accentCursor: '#F5E0DC' },
  monochrome: { bgOverlay: '#2A2A2A', textSubtle: '#606060', textSub2: '#888888', accentCursor: '#FFFFFF' },
  'stars-and-stripes': { bgOverlay: '#2A3E5A', textSubtle: '#4A6080', textSub2: '#8090A8', accentCursor: '#E89B4A' }, // 2-accent: orange-gold alive, distinct from pale-gold warning (accent stays blue = nav)
  'red-dynasty': { bgOverlay: '#4A2A2A', textSubtle: '#6A4A3E', textSub2: '#A08878' },
  nightowl: { bgOverlay: '#38332A', textSubtle: '#6B6350', textSub2: '#847A68' },
  void: { bgOverlay: '#141414', textSubtle: '#505050', textSub2: '#707070', accentCursor: '#FFFFFF' },
  hinomaru: { bgOverlay: '#D4CFC6', textSubtle: '#5C5651' },
  taegeuk: { textSubtle: '#4F4F62', textSub2: '#2A2A40', accentCursor: '#B87500' }, // 2-accent: rich gold alive, distinct from dark-gold warning (accent stays navy = nav)
};

/**
 * The exact 14-var CSS palette a BUILT-IN theme ships: deriveFullPalette() plus
 * that theme's hand-tuned overrides. This is what globals.css encodes; the
 * parity test asserts they match so the two can never drift again.
 */
export function deriveBuiltinPalette(id: BuiltinThemeId): FullCssPalette {
  return { ...deriveFullPalette(UI_THEME_TOKENS[id]), ...(BUILTIN_CSS_OVERRIDES[id] ?? {}) };
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
  // Use the override-aware builtin palette so this table equals the shipped
  // globals.css blocks (not the raw formula output).
  CSS_THEME_VARS[id] = deriveBuiltinPalette(id);
}

// ─── Theme options for UI picker ────────────────────────────────────────────

// The picker renders each theme as a mini-UI thumbnail from its REAL derived
// palette (deriveBuiltinPalette / deriveFullPalette), so options carry only an
// id + label. (The old `preview` 4-tuple was hand-maintained, drifted from the
// SSOT, and its `custom` entry was a frozen snapshot — removed once the picker,
// its only consumer, stopped reading it.)
export const THEME_OPTIONS: Array<{ value: ThemeId; label: string }> = [
  { value: 'tint',              label: 'Tint' },
  { value: 'zinc',              label: 'Zinc' },
  { value: 'graphite',          label: 'Graphite' },
  { value: 'paper',             label: 'Paper' },
  { value: 'amber-line',        label: 'Amber Line' },
  { value: 'mono',              label: 'Mono' },
  { value: 'mono-light',        label: 'Mono Light' },
  { value: 'amber',             label: 'Amber' },
  { value: 'catppuccin-mocha',  label: 'Catppuccin' },
  { value: 'stars-and-stripes', label: 'Stars & Stripes' },
  { value: 'red-dynasty',       label: 'Red Dynasty' },
  { value: 'nightowl',          label: 'Nightowl' },
  { value: 'void',              label: 'Void' },
  { value: 'monochrome',        label: 'Monochrome' },
  { value: 'hinomaru',          label: 'Hinomaru' },
  { value: 'taegeuk',           label: 'Taegeuk' },
  { value: 'custom',            label: 'Custom' },
];

export const XTERM_PALETTE_OPTIONS: Array<{ value: XtermPaletteId; label: string }> = [
  { value: 'tint-dark',        label: 'Tint' },
  { value: 'zinc-dark',        label: 'Zinc' },
  { value: 'graphite-dark',    label: 'Graphite' },
  { value: 'paper-white',      label: 'Paper (white)' },
  { value: 'amber-line-dark',  label: 'Amber Line' },
  { value: 'mono-dark',        label: 'Mono' },
  { value: 'mono-light',       label: 'Mono (light)' },
  { value: 'amber-graphite',   label: 'Amber Graphite' },
  { value: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { value: 'tokyo-night',      label: 'Tokyo Night' },
  { value: 'one-dark',         label: 'One Dark' },
  { value: 'gruvbox-dark',     label: 'Gruvbox Dark' },
  { value: 'solarized-dark',   label: 'Solarized Dark' },
  { value: 'nord',             label: 'Nord' },
  { value: 'monochrome',       label: 'Monochrome' },
  { value: 'matrix',           label: 'Matrix' },
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

/** CSS variable name mapping (FullCssPalette key → CSS custom property). */
export const CSS_VAR_MAP: Record<keyof FullCssPalette, string> = {
  bgBase: '--bg-base', bgMantle: '--bg-mantle', bgSurface: '--bg-surface', bgOverlay: '--bg-overlay',
  textMuted: '--text-muted', textSubtle: '--text-subtle', textSub: '--text-sub', textSub2: '--text-sub2',
  textMain: '--text-main', accent: '--accent', accentCursor: '--accent-cursor',
  accentBlue: '--accent-blue', accentGreen: '--accent-green', accentRed: '--accent-red',
  accentYellow: '--accent-yellow', overlayScrim: '--bg-overlay-scrim',
  surfaceHighlight: '--surface-highlight',
};

/** Apply a custom theme to document root — derives the 7 secondary tokens. */
export function applyCustomCssVars(colors: CustomThemeColors): void {
  const root = document.documentElement;
  const full = deriveFullPalette(colors);
  for (const [key, varName] of Object.entries(CSS_VAR_MAP)) {
    root.style.setProperty(varName, full[key as keyof FullCssPalette]);
  }
  root.style.setProperty('--accent-rgb', hexToRgbString(full.accent));
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
  root.style.removeProperty('--accent-rgb');
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
 * Keep only the override slots that exist on XtermThemeColors and carry a
 * string value — the same rule `extractXtermColors` applies at render time
 * ("unknown override keys are ignored"), enforced once here at the load
 * boundary so a hand-edited session.json cannot smuggle junk into the store.
 * Returns undefined when nothing survives, so callers can omit the key rather
 * than persist an empty object.
 */
function sanitizeXtermOverrides(input: unknown): Partial<XtermThemeColors> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const src = input as Record<string, unknown>;
  const reference = XTERM_PALETTES['catppuccin-mocha'];
  const out: Partial<XtermThemeColors> = {};
  let kept = 0;
  for (const key of Object.keys(reference) as (keyof XtermThemeColors)[]) {
    const value = src[key];
    if (typeof value === 'string' && value) {
      out[key] = value;
      kept += 1;
    }
  }
  return kept > 0 ? out : undefined;
}

/**
 * Migrate a legacy CustomThemeColors (37 fields: 17 UI + 20 xterm) to the new
 * shape (10 UI + xtermPaletteId + optional per-slot xtermOverrides). Detects
 * the xterm palette by matching the stored xtermBackground. Idempotent on
 * already-migrated shapes — including their overrides.
 */
export function migrateCustomThemeColors(input: unknown): CustomThemeColors {
  if (!input || typeof input !== 'object') return DEFAULT_CUSTOM_THEME;
  const obj = input as Record<string, unknown>;

  // Already in new shape (has xtermPaletteId, no xtermBackground)?
  if (typeof obj.xtermPaletteId === 'string' && typeof obj.xtermBackground !== 'string') {
    const accent = String(obj.accent ?? DEFAULT_CUSTOM_THEME.accent);
    const ui: UIThemeTokens = {
      bgBase: String(obj.bgBase ?? DEFAULT_CUSTOM_THEME.bgBase),
      bgSurface: String(obj.bgSurface ?? DEFAULT_CUSTOM_THEME.bgSurface),
      bgMantle: String(obj.bgMantle ?? DEFAULT_CUSTOM_THEME.bgMantle),
      textMain: String(obj.textMain ?? DEFAULT_CUSTOM_THEME.textMain),
      textSub: String(obj.textSub ?? DEFAULT_CUSTOM_THEME.textSub),
      textMuted: String(obj.textMuted ?? DEFAULT_CUSTOM_THEME.textMuted),
      accent,
      // Older custom themes predate the split — fall back to `accent` so the
      // link accent stays identical to what they saw before.
      accentSecondary: String(obj.accentSecondary ?? accent),
      success: String(obj.success ?? DEFAULT_CUSTOM_THEME.success),
      danger: String(obj.danger ?? DEFAULT_CUSTOM_THEME.danger),
      warning: String(obj.warning ?? DEFAULT_CUSTOM_THEME.warning),
    };
    // Carry the per-slot overrides through. This branch rebuilds the object
    // from a fixed whitelist, so anything not named here was silently dropped —
    // and since loadSession runs this on EVERY load, a user's terminal colour
    // overrides survived only until the next launch. The doc comment above
    // already promised idempotence on migrated shapes; this makes it true.
    const overrides = sanitizeXtermOverrides(obj.xtermOverrides);
    return {
      ...ui,
      xtermPaletteId: obj.xtermPaletteId as XtermPaletteId,
      ...(overrides ? { xtermOverrides: overrides } : {}),
    };
  }

  // Legacy 37-field shape. Map old keys to new tokens.
  const legacyAccent = String(obj.accentBlue ?? DEFAULT_CUSTOM_THEME.accent);
  const ui: UIThemeTokens = {
    bgBase: String(obj.bgBase ?? DEFAULT_CUSTOM_THEME.bgBase),
    bgSurface: String(obj.bgSurface ?? DEFAULT_CUSTOM_THEME.bgSurface),
    bgMantle: String(obj.bgMantle ?? DEFAULT_CUSTOM_THEME.bgMantle),
    textMain: String(obj.textMain ?? DEFAULT_CUSTOM_THEME.textMain),
    textSub: String(obj.textSub ?? DEFAULT_CUSTOM_THEME.textSub),
    textMuted: String(obj.textMuted ?? DEFAULT_CUSTOM_THEME.textMuted),
    accent: legacyAccent,
    // Legacy had a single blue accent — the split starts unified.
    accentSecondary: legacyAccent,
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

// ─── Inspect-mode reverse mapping (PR2 foundation) ──────────────────────────
//
// The color "inspect mode" lets users click a region on the live app and edit
// the token that paints it. Per design decision D-revmap, `data-token-<role>`
// attributes on production elements are the ONLY source of truth for the
// element→token reverse map — there is no separate registry constant that could
// drift. The single piece of derived knowledge we mirror here is the small
// static derived→source map below (D-revmap), which encodes the same facts as
// deriveFullPalette so a click on a derived region routes to its editable
// source token.

/** The 10 editable UI token keys. Marker helpers type-check token names against
 *  this so a typo in a `data-token-*` attribute fails to compile (D-attrs). */
export type UIThemeTokenKey = keyof UIThemeTokens;

/** Visual roles a single element can paint with one of the 10 tokens. A card
 *  may use one token for its fill, another for its text, another for its
 *  border, so the role disambiguates which slot a click targets. */
export type TokenRole = 'bg' | 'text' | 'border' | 'accent';

/** Priority order used to pick a multi-role element's representative role for
 *  the hover preview (D-hover): background first, then accent, text, border. */
const ROLE_PRIORITY: readonly TokenRole[] = ['bg', 'accent', 'text', 'border'];

/**
 * Typed marker-attribute emitter (D-attrs). Production components spread the
 * result onto an element to declare which editable token paints which role:
 *   <div {...tokenAttrs('bgSurface', 'bg')} />  →  data-token-bg="bgSurface"
 * The `token` param is constrained to UIThemeTokenKey so a misspelled token
 * name is a compile error rather than a silently dead marker.
 */
export function tokenAttrs(token: UIThemeTokenKey, role: TokenRole): Record<string, string> {
  return { [`data-token-${role}`]: token };
}

/**
 * Derived CSS var → editable source token (D-revmap). Mirrors deriveFullPalette:
 *   bgOverlay   = shiftLightness(bgSurface)  → bgSurface
 *   textSub2    = mix(textMain, textSub)     → textMain
 *   textSubtle  = mix(textSub, textMuted)    → textSub
 *   accentCursor= accent                     → accent
 * A region painted with a derived var carries `data-derived="<derivedKey>"` so
 * findTokenForElement can label it ("follows Surface") and route edits to the
 * source token rather than dead-ending on a non-editable derived value.
 */
export const DERIVED_TO_SOURCE: Record<string, UIThemeTokenKey> = {
  bgOverlay: 'bgSurface',
  textSub2: 'textMain',
  textSubtle: 'textSub',
  accentCursor: 'accent',
};

/** Result of resolving an element to its editable token(s). */
export interface ResolvedRegion {
  /** The nearest marked ancestor (or the element itself) that carries tokens. */
  el: Element;
  /** Every role this element marks, keyed by role. A card with fill + text +
   *  border yields up to 3 entries; the click menu lists exactly these. */
  tokens: Partial<Record<TokenRole, UIThemeTokenKey>>;
  /** The single role/token shown in the hover preview (D-hover): bg if present,
   *  else the next role by ROLE_PRIORITY. Guaranteed non-null because a region
   *  with zero roles resolves to null instead. */
  representative: { role: TokenRole; token: UIThemeTokenKey };
  /** When the matched element is painted by a derived var (data-derived), the
   *  editable source token it follows — for the "follows {source}" label. */
  derivedNote?: UIThemeTokenKey;
}

const TOKEN_ROLE_SELECTOR =
  '[data-token-bg],[data-token-text],[data-token-border],[data-token-accent]';

/**
 * Reverse-map an element to its editable token(s) (D-revmap, D-hover). Walks up
 * from `el` via closest() to the nearest marked ancestor, collects every
 * `data-token-<role>` it declares, and picks a representative role for the hover
 * preview (bg > accent > text > border). Returns null when nothing in the
 * ancestor chain is marked (the overlay shows a "not customizable yet" hint).
 *
 * Token-name validation against UIThemeTokenKey is enforced at write time by
 * tokenAttrs; at read time we trust the attribute string and surface it as
 * UIThemeTokenKey, since the CI invariant (separate task) guards the DOM.
 */
export function findTokenForElement(el: Element): ResolvedRegion | null {
  const marked = el.closest(TOKEN_ROLE_SELECTOR);
  if (!marked) return null;

  const tokens: Partial<Record<TokenRole, UIThemeTokenKey>> = {};
  for (const role of ROLE_PRIORITY) {
    const value = marked.getAttribute(`data-token-${role}`);
    if (value) tokens[role] = value as UIThemeTokenKey;
  }

  // Pick representative by priority. The selector guarantees ≥1 role matched,
  // so this loop always finds one — but guard defensively for type narrowing.
  let representative: ResolvedRegion['representative'] | null = null;
  for (const role of ROLE_PRIORITY) {
    const token = tokens[role];
    if (token) {
      representative = { role, token };
      break;
    }
  }
  if (!representative) return null;

  const region: ResolvedRegion = { el: marked, tokens, representative };

  const derivedKey = marked.getAttribute('data-derived');
  if (derivedKey && derivedKey in DERIVED_TO_SOURCE) {
    region.derivedNote = DERIVED_TO_SOURCE[derivedKey];
  }

  return region;
}

/**
 * Forward count for the "applies to N places" chip (D-chip). Returns every
 * element marked with the given token/role under `root` (default: document).
 * Only marked consumers are counted — the chip says "marked N places", an
 * honest subset of the ~799 raw var() consumers (D-chip).
 */
export function regionsForToken(
  token: UIThemeTokenKey,
  role: TokenRole,
  root: ParentNode = document,
): Element[] {
  return Array.from(root.querySelectorAll(`[data-token-${role}="${token}"]`));
}

// ─── Backwards-compat re-export of hexToRgb (legacy callers may import it) ──
export { hexToRgbString as hexToRgb } from './tailwindPalette';

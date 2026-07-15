// Tailwind CSS color palette data + color manipulation utilities.
// Used by the custom theme editor (swatch picker) and the theme system
// (derive UI tokens like bgOverlay / textSubtle from the 10 manual tokens).

export const TAILWIND_SHADES = [
  '50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950',
] as const;
export type TailwindShade = (typeof TAILWIND_SHADES)[number];

export const TAILWIND_NEUTRAL_HUES = ['slate', 'gray', 'zinc', 'neutral', 'stone'] as const;
export const TAILWIND_COLOR_HUES = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
] as const;
export const TAILWIND_HUES = [...TAILWIND_NEUTRAL_HUES, ...TAILWIND_COLOR_HUES] as const;
export type TailwindHue = (typeof TAILWIND_HUES)[number];

export const TAILWIND_PALETTE: Record<TailwindHue, Record<TailwindShade, string>> = {
  slate: { '50': '#f8fafc', '100': '#f1f5f9', '200': '#e2e8f0', '300': '#cbd5e1', '400': '#94a3b8', '500': '#64748b', '600': '#475569', '700': '#334155', '800': '#1e293b', '900': '#0f172a', '950': '#020617' },
  gray: { '50': '#f9fafb', '100': '#f3f4f6', '200': '#e5e7eb', '300': '#d1d5db', '400': '#9ca3af', '500': '#6b7280', '600': '#4b5563', '700': '#374151', '800': '#1f2937', '900': '#111827', '950': '#030712' },
  zinc: { '50': '#fafafa', '100': '#f4f4f5', '200': '#e4e4e7', '300': '#d4d4d8', '400': '#a1a1aa', '500': '#71717a', '600': '#52525b', '700': '#3f3f46', '800': '#27272a', '900': '#18181b', '950': '#09090b' },
  neutral: { '50': '#fafafa', '100': '#f5f5f5', '200': '#e5e5e5', '300': '#d4d4d4', '400': '#a3a3a3', '500': '#737373', '600': '#525252', '700': '#404040', '800': '#262626', '900': '#171717', '950': '#0a0a0a' },
  stone: { '50': '#fafaf9', '100': '#f5f5f4', '200': '#e7e5e4', '300': '#d6d3d1', '400': '#a8a29e', '500': '#78716c', '600': '#57534e', '700': '#44403c', '800': '#292524', '900': '#1c1917', '950': '#0c0a09' },
  red: { '50': '#fef2f2', '100': '#fee2e2', '200': '#fecaca', '300': '#fca5a5', '400': '#f87171', '500': '#ef4444', '600': '#dc2626', '700': '#b91c1c', '800': '#991b1b', '900': '#7f1d1d', '950': '#450a0a' },
  orange: { '50': '#fff7ed', '100': '#ffedd5', '200': '#fed7aa', '300': '#fdba74', '400': '#fb923c', '500': '#f97316', '600': '#ea580c', '700': '#c2410c', '800': '#9a3412', '900': '#7c2d12', '950': '#431407' },
  amber: { '50': '#fffbeb', '100': '#fef3c7', '200': '#fde68a', '300': '#fcd34d', '400': '#fbbf24', '500': '#f59e0b', '600': '#d97706', '700': '#b45309', '800': '#92400e', '900': '#78350f', '950': '#451a03' },
  yellow: { '50': '#fefce8', '100': '#fef9c3', '200': '#fef08a', '300': '#fde047', '400': '#facc15', '500': '#eab308', '600': '#ca8a04', '700': '#a16207', '800': '#854d0e', '900': '#713f12', '950': '#422006' },
  lime: { '50': '#f7fee7', '100': '#ecfccb', '200': '#d9f99d', '300': '#bef264', '400': '#a3e635', '500': '#84cc16', '600': '#65a30d', '700': '#4d7c0f', '800': '#3f6212', '900': '#365314', '950': '#1a2e05' },
  green: { '50': '#f0fdf4', '100': '#dcfce7', '200': '#bbf7d0', '300': '#86efac', '400': '#4ade80', '500': '#22c55e', '600': '#16a34a', '700': '#15803d', '800': '#166534', '900': '#14532d', '950': '#052e16' },
  emerald: { '50': '#ecfdf5', '100': '#d1fae5', '200': '#a7f3d0', '300': '#6ee7b7', '400': '#34d399', '500': '#10b981', '600': '#059669', '700': '#047857', '800': '#065f46', '900': '#064e3b', '950': '#022c22' },
  teal: { '50': '#f0fdfa', '100': '#ccfbf1', '200': '#99f6e4', '300': '#5eead4', '400': '#2dd4bf', '500': '#14b8a6', '600': '#0d9488', '700': '#0f766e', '800': '#115e59', '900': '#134e4a', '950': '#042f2e' },
  cyan: { '50': '#ecfeff', '100': '#cffafe', '200': '#a5f3fc', '300': '#67e8f9', '400': '#22d3ee', '500': '#06b6d4', '600': '#0891b2', '700': '#0e7490', '800': '#155e75', '900': '#164e63', '950': '#083344' },
  sky: { '50': '#f0f9ff', '100': '#e0f2fe', '200': '#bae6fd', '300': '#7dd3fc', '400': '#38bdf8', '500': '#0ea5e9', '600': '#0284c7', '700': '#0369a1', '800': '#075985', '900': '#0c4a6e', '950': '#082f49' },
  blue: { '50': '#eff6ff', '100': '#dbeafe', '200': '#bfdbfe', '300': '#93c5fd', '400': '#60a5fa', '500': '#3b82f6', '600': '#2563eb', '700': '#1d4ed8', '800': '#1e40af', '900': '#1e3a8a', '950': '#172554' },
  indigo: { '50': '#eef2ff', '100': '#e0e7ff', '200': '#c7d2fe', '300': '#a5b4fc', '400': '#818cf8', '500': '#6366f1', '600': '#4f46e5', '700': '#4338ca', '800': '#3730a3', '900': '#312e81', '950': '#1e1b4b' },
  violet: { '50': '#f5f3ff', '100': '#ede9fe', '200': '#ddd6fe', '300': '#c4b5fd', '400': '#a78bfa', '500': '#8b5cf6', '600': '#7c3aed', '700': '#6d28d9', '800': '#5b21b6', '900': '#4c1d95', '950': '#2e1065' },
  purple: { '50': '#faf5ff', '100': '#f3e8ff', '200': '#e9d5ff', '300': '#d8b4fe', '400': '#c084fc', '500': '#a855f7', '600': '#9333ea', '700': '#7e22ce', '800': '#6b21a8', '900': '#581c87', '950': '#3b0764' },
  fuchsia: { '50': '#fdf4ff', '100': '#fae8ff', '200': '#f5d0fe', '300': '#f0abfc', '400': '#e879f9', '500': '#d946ef', '600': '#c026d3', '700': '#a21caf', '800': '#86198f', '900': '#701a75', '950': '#4a044e' },
  pink: { '50': '#fdf2f8', '100': '#fce7f3', '200': '#fbcfe8', '300': '#f9a8d4', '400': '#f472b6', '500': '#ec4899', '600': '#db2777', '700': '#be185d', '800': '#9d174d', '900': '#831843', '950': '#500724' },
  rose: { '50': '#fff1f2', '100': '#ffe4e6', '200': '#fecdd3', '300': '#fbb6ce', '400': '#fb7185', '500': '#f43f5e', '600': '#e11d48', '700': '#be123c', '800': '#9f1239', '900': '#881337', '950': '#4c0519' },
};

// ─── Color manipulation utilities ────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const mx = Math.max(rN, gN, bN), mn = Math.min(rN, gN, bN);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === rN) h = ((gN - bN) / d + (gN < bN ? 6 : 0)) / 6;
  else if (mx === gN) h = ((bN - rN) / d + 2) / 6;
  else h = ((rN - gN) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tN = t;
    if (tN < 0) tN += 1;
    if (tN > 1) tN -= 1;
    if (tN < 1 / 6) return p + (q - p) * 6 * tN;
    if (tN < 1 / 2) return q;
    if (tN < 2 / 3) return p + (q - p) * (2 / 3 - tN) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

/** Relative luminance (WCAG). 0 = black, 1 = white. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  const lin = (c: number) => {
    const cN = c / 255;
    return cN <= 0.03928 ? cN / 12.92 : Math.pow((cN + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function isLight(hex: string): boolean {
  return luminance(hex) > 0.5;
}

// WCAG AA body text (4.5:1) — same bar useTerminal.ts already enforces on
// light xterm themes (#74: Claude Code emits true-color white that bypasses
// the palette and goes invisible on a cream background).
export const XTERM_MIN_CONTRAST_LIGHT = 4.5;

// Dark xterm themes get a lower floor, not zero. The SAME true-color-bypass
// mechanism as #74 runs in reverse: Claude Code (and other TUI apps) also
// emit near-black true-color foreground for de-emphasized/secondary text,
// and it renders exactly as literally specified — invisible against a near-
// black background, regardless of how the theme's INDEXED ansi black is
// tuned (true-color escapes never consult the palette at all). Every
// built-in dark xterm palette's indexed ANSI black also independently sits
// at ~1.0–1.8:1 against its own background (verified 2026-07-15), because
// ANSI black is conventionally reserved for cell backgrounds / reverse
// video, not literal readable foreground — so the same failure mode is
// reachable via plain SGR 30 too, not just true-color.
//
// 2.5 is deliberately well under the light-theme's 4.5: it rescues
// genuinely-invisible text (the ~1.0–1.8 range above) without forcing every
// dark theme's intentionally-muted secondary/comment-like text up to full
// body-text contrast — it lands close to where each theme's own "bright
// black" dim tier already sits, not brighter.
export const XTERM_MIN_CONTRAST_DARK = 2.5;

/**
 * Resolve xterm's `minimumContrastRatio` option for a given xterm theme
 * background. Extracted from useTerminal.ts so the light/dark split (and
 * its rationale) is unit-testable without mounting a Terminal instance.
 */
export function resolveMinimumContrastRatio(background: string | undefined): number {
  if (!background) return 1; // xterm default — no theme background to compare against.
  return isLight(background) ? XTERM_MIN_CONTRAST_LIGHT : XTERM_MIN_CONTRAST_DARK;
}

/**
 * WCAG contrast ratio between two colors. Order-independent: returns the same
 * value whether `fg`/`bg` are swapped. Range is 1 (identical luminance) to 21
 * (pure black on pure white). Formula: (Lmax + 0.05) / (Lmin + 0.05).
 */
export function getContrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const lo = Math.min(l1, l2);
  const hi = Math.max(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Shift HSL lightness by delta (0–1 range). Positive = lighter. */
export function shiftLightness(hex: string, delta: number): string {
  const [r, g, b] = parseHex(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [r2, g2, b2] = hslToRgb(h, s, clamp(l + delta, 0, 1));
  return toHex(r2, g2, b2);
}

/** Rotate HSL hue by `degrees` (0–360). Keeps saturation/lightness. */
export function shiftHue(hex: string, degrees: number): string {
  const [r, g, b] = parseHex(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const hNew = (((h * 360 + degrees) % 360) + 360) % 360 / 360;
  const [r2, g2, b2] = hslToRgb(hNew, s, l);
  return toHex(r2, g2, b2);
}

/** Linear RGB interpolation. t=0 → a, t=1 → b. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const tC = clamp(t, 0, 1);
  return toHex(ar + (br - ar) * tC, ag + (bg - ag) * tC, ab + (bb - ab) * tC);
}

/** Hex (#rrggbb) → "r, g, b" string for CSS rgb() usage. */
export function hexToRgbString(hex: string): string {
  const [r, g, b] = parseHex(hex);
  return `${r}, ${g}, ${b}`;
}

/** Find the nearest Tailwind swatch for a hex value. Returns { hue, shade }. */
export function nearestTailwindSwatch(hex: string): { hue: TailwindHue; shade: TailwindShade } | null {
  const target = parseHex(hex);
  let best: { hue: TailwindHue; shade: TailwindShade; dist: number } | null = null;
  for (const hue of TAILWIND_HUES) {
    for (const shade of TAILWIND_SHADES) {
      const [r, g, b] = parseHex(TAILWIND_PALETTE[hue][shade]);
      const dist = (r - target[0]) ** 2 + (g - target[1]) ** 2 + (b - target[2]) ** 2;
      if (!best || dist < best.dist) best = { hue, shade, dist };
    }
  }
  return best ? { hue: best.hue, shade: best.shade } : null;
}

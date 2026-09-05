/**
 * Token discipline guard (DESIGN.md Color + Spacing & Geometry).
 *
 * Three literals had been re-typed at call sites instead of resolving through a
 * token, so a theme change could not reach them:
 *   - `rgba(255,255,255,.NN)` top-inset highlights and hairlines — white is only
 *     correct on a dark theme; the two light themes got a wrong-direction edge.
 *   - `var(--token, #hex)` fallbacks — the hex is a foreign palette (Catppuccin /
 *     Tailwind) that silently wins whenever the token is missing, so a theme bug
 *     shows up as another product's color rather than as a visible failure.
 *   - the modal scrim `rgba(0,0,0,0.55)` — now `--bg-overlay-scrim`, a real
 *     per-theme token (themes.ts FullCssPalette → CSS_VAR_MAP), which
 *     themeParity.test.ts pins into every [data-theme] block.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CSS_VAR_MAP, deriveFullPalette, UI_THEME_TOKENS, type BuiltinThemeId } from '../themes';
import { isLight } from '../tailwindPalette';

const RENDERER = path.join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'assets') continue;
      walk(p, out);
    } else if (/\.(tsx?|css)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

// Forward slashes on every platform: the exemption lists below are written POSIX-style.
const files = walk(RENDERER).map((p) => [path.relative(RENDERER, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8')] as const);

function hits(re: RegExp): string[] {
  const found: string[] = [];
  for (const [rel, src] of files) {
    src.split('\n').forEach((line, i) => {
      if (re.test(line)) found.push(`${rel}:${i + 1}`);
      re.lastIndex = 0;
    });
  }
  return found;
}

describe('token discipline', () => {
  it('has no literal white highlight/hairline left in the renderer', () => {
    expect(hits(/rgba\(\s*255\s*,\s*255\s*,\s*255/)).toEqual([]);
  });

  it('has no foreign colour fallback inside a var() reference', () => {
    // Hex, rgb(a) and hsl(a) all sneak a second palette in behind the token.
    // The one sanctioned fallback is the scrim: it repeats the token's OWN
    // definitional value, and without it an undefined --bg-overlay-scrim makes
    // `background-color: var(...)` invalid — a fully transparent backdrop that
    // still swallows clicks, and in OnboardingHighlight a spotlight with no
    // surround at all.
    const SCRIM_FALLBACK = /var\(--bg-overlay-scrim,\s*rgba\(0, 0, 0, 0\.55\)\)/;
    const found: string[] = [];
    for (const [rel, src] of files) {
      src.split('\n').forEach((line, i) => {
        if (!/var\(--[a-z0-9-]+,\s*(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/.test(line)) return;
        if (SCRIM_FALLBACK.test(line)) return;
        found.push(`${rel}:${i + 1}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('has no hand-typed modal scrim outside the token definition', () => {
    // themes.ts declares the value once and globals.css writes it into each
    // [data-theme] block; every consumer must go through the variable.
    const DEFINITIONS = /^(themes\.ts|styles\/globals\.css):/;
    const raw: string[] = [];
    for (const [rel, src] of files) {
      src.split('\n').forEach((line, i) => {
        if (!/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.55\s*\)/.test(line)) return;
        // The defensive `var(--bg-overlay-scrim, …)` fallback is allowed; a
        // bare literal is not.
        if (/var\(--bg-overlay-scrim,\s*rgba\(0, 0, 0, 0\.55\)\)/.test(line)) return;
        raw.push(`${rel}:${i + 1}`);
      });
    }
    expect(raw.filter((h) => !DEFINITIONS.test(h))).toEqual([]);
  });

  it('ships --bg-overlay-scrim as a real palette token that varies by polarity', () => {
    expect(CSS_VAR_MAP.overlayScrim).toBe('--bg-overlay-scrim');
    for (const [id, tokens] of Object.entries(UI_THEME_TOKENS) as [BuiltinThemeId, typeof UI_THEME_TOKENS['amber']][]) {
      const scrim = deriveFullPalette(tokens).overlayScrim;
      // A near-white page needs a lighter veil; 0.55 there is a blackout.
      expect(scrim, `${id} scrim`).toBe(isLight(tokens.bgBase) ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.55)');
    }
  });

  it('keeps --surface-highlight light on every theme, light ones included', () => {
    // The specular inset sits on a SATURATED ACCENT FILL, not on the page, so
    // it models a light source above the control in every theme. A --text-main
    // mix would invert it on hinomaru/taegeuk (near-black text) and press a
    // groove into the button instead of raising its top edge.
    expect(CSS_VAR_MAP.surfaceHighlight).toBe('--surface-highlight');
    for (const [id, tokens] of Object.entries(UI_THEME_TOKENS) as [BuiltinThemeId, typeof UI_THEME_TOKENS['amber']][]) {
      expect(isLight(deriveFullPalette(tokens).surfaceHighlight), `${id} highlight`).toBe(true);
    }
  });

  it('never mixes --text-main into a highlight that sits on an accent fill', () => {
    expect(hits(/inset 0 1px 0 color-mix\(in srgb, var\(--text-main\) (1[3-9]|[2-9][0-9])%/)).toEqual([]);
    expect(hits(/inset_0_1px_0_color-mix\(in_srgb,var\(--text-main\)_(1[3-9]|[2-9][0-9])%/)).toEqual([]);
  });
});

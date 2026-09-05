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
import { CSS_VAR_MAP, deriveFullPalette, UI_THEME_TOKENS } from '../themes';

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

const files = walk(RENDERER).map((p) => [path.relative(RENDERER, p), fs.readFileSync(p, 'utf8')] as const);

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

  it('has no foreign hex fallback inside a var() reference', () => {
    expect(hits(/var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/)).toEqual([]);
  });

  it('has no hand-typed modal scrim outside the token definition', () => {
    // themes.ts declares the value once and globals.css writes it into each
    // [data-theme] block; every consumer must go through the variable.
    const DEFINITIONS = /^(themes\.ts|styles\/globals\.css):/;
    const raw = hits(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.55\s*\)/);
    expect(raw.filter((h) => !DEFINITIONS.test(h))).toEqual([]);
  });

  it('ships --bg-overlay-scrim as a real palette token in every theme', () => {
    expect(CSS_VAR_MAP.overlayScrim).toBe('--bg-overlay-scrim');
    for (const tokens of Object.values(UI_THEME_TOKENS)) {
      expect(deriveFullPalette(tokens).overlayScrim).toMatch(/^rgba\(/);
    }
  });
});

// The needs-you attention orange (owner decision 2026-10-06): one orange hue
// family, tuned per look, carried by every look's globals.css block, readable
// on every look, and never confused with the error red.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ATTENTION_COLORS, THEME_STYLES, UI_THEME_TOKENS, attentionCssVars, deriveBuiltinPalette, type BuiltinThemeId } from '../themes';
import { getContrastRatio } from '../tailwindPalette';

const css = readFileSync(path.join(__dirname, '..', 'styles', 'globals.css'), 'utf8');
const ids = Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[];

function blockVars(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(`\\[data-theme="${id}"\\][^{]*\\{([^}]*)\\}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    for (const v of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[v[1]] = v[2].trim().toUpperCase();
  }
  return out;
}

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('attention orange', () => {
  it.each(ids)('%s: globals.css carries the look\'s attention colours', (id) => {
    const vars = blockVars(id);
    for (const [name, value] of Object.entries(attentionCssVars(id))) {
      expect(vars[name], `${id} ${name}`).toBe(value.toUpperCase());
    }
  });

  it.each(ids)('%s: words read at 4.5:1, badge digits at 4.5:1, the dash at 3:1', (id) => {
    const p = deriveBuiltinPalette(id);
    const c = ATTENTION_COLORS[id];
    const frame = THEME_STYLES[id]?.frame;
    for (const bg of [p.bgBase, p.bgMantle, p.bgSurface, ...(frame ? [frame] : [])]) {
      expect(getContrastRatio(c.text, bg), `${id} text on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(getContrastRatio(c.ink, c.fill), `${id} badge digits`).toBeGreaterThanOrEqual(4.5);
    for (const bg of [p.bgBase, p.bgMantle]) {
      expect(getContrastRatio(c.fill, bg), `${id} fill on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(ids)('%s: one orange hue family, apart from the error red', (id) => {
    const c = ATTENTION_COLORS[id];
    for (const v of [c.fill, c.text]) {
      expect(hue(v), `${id} ${v}`).toBeGreaterThanOrEqual(18);
      expect(hue(v), `${id} ${v}`).toBeLessThanOrEqual(32);
    }
    const danger = hue(UI_THEME_TOKENS[id].danger);
    const gap = Math.min(Math.abs(hue(c.fill) - danger), 360 - Math.abs(hue(c.fill) - danger));
    expect(gap, `${id} attention vs danger`).toBeGreaterThanOrEqual(15);
    expect(c.fill.toUpperCase()).not.toBe(UI_THEME_TOKENS[id].warning.toUpperCase());
  });
});

// Owner decision 2026-10-21: on every built-in theme, muted text reads at
// 3:1 and secondary text at 4.5:1 on the theme's own opaque surfaces.
import { describe, expect, it } from 'vitest';
import { THEME_STYLES, UI_THEME_TOKENS, deriveBuiltinPalette, type BuiltinThemeId, type FullCssPalette } from '../themes';
import { getContrastRatio, isLight, mixHex } from '../tailwindPalette';

const ids = Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[];

// The surfaces text is drawn on: the sheet (--bg-base), the sidebar column
// (--bg-mantle), the window frame and rail (--frame-bg, which defaults to
// --app-bg: the base mixed 16% toward black on dark themes, 3% on light ones),
// and the row hover (--hover-fill, text-main 5%) over the sheet and the column.
function surfaces(id: BuiltinThemeId, p: FullCssPalette): Record<string, string> {
  const frame = THEME_STYLES[id]?.frame ?? mixHex(p.bgBase, '#000000', isLight(p.bgBase) ? 0.03 : 0.16);
  return {
    base: p.bgBase,
    mantle: p.bgMantle,
    frame,
    'hover on base': mixHex(p.bgBase, p.textMain, 0.05),
    'hover on mantle': mixHex(p.bgMantle, p.textMain, 0.05),
  };
}

const FLOORS: Array<[keyof FullCssPalette, number]> = [
  ['textMuted', 3],
  ['textSubtle', 3],
  ['textSub', 4.5],
  ['textSub2', 4.5],
  ['textMain', 4.5],
];

describe('theme text contrast', () => {
  it.each(ids)('%s: muted text reads at 3:1 and secondary text at 4.5:1 on every surface', (id) => {
    const p = deriveBuiltinPalette(id);
    for (const [token, floor] of FLOORS) {
      for (const [name, bg] of Object.entries(surfaces(id, p))) {
        expect(getContrastRatio(p[token], bg), `${id} ${token} ${p[token]} on ${name} ${bg}`).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  // The tiers stay a ladder: lifting muted must not leave subtle at or below it,
  // nor subtle at or above sub2.
  it.each(ids)('%s: on the sheet, contrast rises from muted to subtle to sub and sub2', (id) => {
    const p = deriveBuiltinPalette(id);
    const on = (c: string) => getContrastRatio(c, p.bgBase);
    expect(on(p.textSubtle), `${id} subtle vs muted`).toBeGreaterThan(on(p.textMuted));
    expect(on(p.textSub), `${id} sub vs subtle`).toBeGreaterThan(on(p.textSubtle));
    expect(on(p.textSub2), `${id} sub2 vs subtle`).toBeGreaterThan(on(p.textSubtle));
  });
});

// Fleet's small text clears WCAG AA (4.5:1) on every look: the key hints,
// the search placeholder and the detail headings use --text-subtle, never
// --text-muted, and the rail's needs-you badge keeps page-colour digits at
// 4.5:1 on every look (light looks deepen the yellow fill).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveBuiltinPalette, UI_THEME_TOKENS, type BuiltinThemeId } from '../../../themes';
import { getContrastRatio, mixHex } from '../../../tailwindPalette';

const LOOKS = ['tint', 'zinc', 'graphite', 'paper', 'amber-line'] as const;
const css = readFileSync(path.join(__dirname, '..', '..', '..', 'styles', 'ui.css'), 'utf8');

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

describe('Fleet text contrast', () => {
  it('--text-subtle reads at 4.5:1 on the page, the detail and the fill on every look', () => {
    for (const id of LOOKS) {
      const p = deriveBuiltinPalette(id);
      for (const bg of [p.bgBase, p.bgMantle, p.bgSurface]) {
        expect(getContrastRatio(p.textSubtle, bg), `${id} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('the hint, placeholder and heading rules use --text-subtle', () => {
    expect(rule('.wmux-board-keys')).toContain('color: var(--text-subtle)');
    expect(rule('.wmux-board-search::placeholder')).toContain('color: var(--text-subtle)');
    expect(rule('.wmux-fleet-ticket-detail h3')).toContain('color: var(--text-subtle)');
    expect(rule('.wmux-fleet-request h3')).toContain('color: var(--text-subtle)');
  });

  it('the rail badge is needs-you yellow with page-colour digits at 4.5:1 on every built-in look', () => {
    expect(rule('.wmux-rail .wmux-nav-badge')).toContain('color: var(--bg-base)');
    expect(rule('.wmux-rail .wmux-nav-count')).toContain('background: var(--accent-yellow)');
    const lightSelector = ':root:is([data-theme="mono-light"], [data-theme="paper"], [data-theme="hinomaru"], [data-theme="taegeuk"]) .wmux-rail .wmux-nav-badge';
    expect(rule(lightSelector)).toContain('background: color-mix(in srgb, var(--accent-yellow) 80%, var(--text-main))');
    const light = new Set(['mono-light', 'paper', 'hinomaru', 'taegeuk']);
    for (const id of Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[]) {
      const p = deriveBuiltinPalette(id);
      // color-mix in srgb is a channel-wise mix: mixHex(a, b, t) = a + (b - a) * t.
      const fill = light.has(id) ? mixHex(p.accentYellow, p.textMain, 0.2) : p.accentYellow;
      expect(getContrastRatio(p.bgBase, fill), id).toBeGreaterThanOrEqual(4.5);
    }
  });
});

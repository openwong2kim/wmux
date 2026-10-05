// Fleet's small text clears WCAG AA (4.5:1) on every look: the key hints,
// the search placeholder and the detail headings use --text-subtle, never
// --text-muted, and the rail's needs-you badge is the attention orange with
// each look's own ink at 4.5:1.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ATTENTION_COLORS, deriveBuiltinPalette, UI_THEME_TOKENS, type BuiltinThemeId } from '../../../themes';
import { getContrastRatio } from '../../../tailwindPalette';

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

  it('the rail badge is the attention orange with its own ink at 4.5:1 on every built-in look', () => {
    expect(rule('.wmux-rail .wmux-nav-badge')).toContain('color: var(--attention-ink)');
    expect(rule('.wmux-rail .wmux-nav-count')).toContain('background: var(--attention)');
    // No muddy deepening mix: each look picks its own orange.
    expect(css).not.toContain('color-mix(in srgb, var(--accent-yellow) 80%, var(--text-main));\n}\n.wmux-rail');
    for (const id of Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[]) {
      const c = ATTENTION_COLORS[id];
      expect(getContrastRatio(c.ink, c.fill), id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the Needs you chip, section dot and row word use the attention colours', () => {
    expect(rule('.wmux-fleet-filters button[data-filter="attention"]')).toContain('color: var(--attention-text)');
    expect(rule('.wmux-board-col-dot.is-needsYou')).toContain('background: var(--attention)');
    expect(rule('.wmux-fleet-status[style*="var(--attention)"]')).toContain('color: var(--attention-text)');
  });
});

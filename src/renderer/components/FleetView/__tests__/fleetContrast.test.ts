// Fleet's small text clears WCAG AA (4.5:1) on every look: the key hints,
// the search placeholder and the detail headings use --text-subtle, never
// --text-muted, and the rail's needs-you badge draws a dark ink on its
// --accent-yellow fill (white on Paper's warning is 3.7:1).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveBuiltinPalette } from '../../../themes';
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

  it('the rail badge is needs-you yellow with an ink that reads on every look', () => {
    const badge = rule('.wmux-rail .wmux-nav-badge');
    expect(badge).toContain('color: color-mix(in srgb, var(--accent-yellow) 15%, #000)');
    expect(rule('.wmux-rail .wmux-nav-count')).toContain('background: var(--accent-yellow)');
    for (const id of LOOKS) {
      const yellow = deriveBuiltinPalette(id).accentYellow;
      expect(getContrastRatio(mixHex(yellow, '#000000', 0.85), yellow), id).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// Moa's needs-you rows wear the sidebar's attention grammar: words in
// --attention-text, a 1px --attention-hairline border (2026-10-07; its own
// per-look contrast test is in attentionColors.test.ts), over --selection-subtle (the
// text colour mixed into the panel, 8% on dark looks, 5% on light ones). The
// words must read at 4.5:1 and the dash at 3:1 on that fill, in every look.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ATTENTION_COLORS, UI_THEME_TOKENS, deriveBuiltinPalette, type BuiltinThemeId } from '../../../themes';
import { getContrastRatio, isLight, mixHex } from '../../../tailwindPalette';
import { NEEDS_YOU_ROW, NEEDS_YOU_TEXT } from '../panel/MoaWaitingOnYou';

const ids = Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[];

describe('Moa needs-you contrast', () => {
  it.each(ids)('%s: the row\'s words read at 4.5:1 and its dash at 3:1 on its fill', (id) => {
    const p = deriveBuiltinPalette(id);
    const c = ATTENTION_COLORS[id];
    const fill = mixHex(p.bgBase, p.textMain, isLight(p.bgBase) ? 0.05 : 0.08);
    expect(getContrastRatio(c.text, fill), `${id} text on ${fill}`).toBeGreaterThanOrEqual(4.5);
    expect(getContrastRatio(c.fill, fill), `${id} dash on ${fill}`).toBeGreaterThanOrEqual(3);
  });

  it('the rows use the attention tokens, never the caution yellow', () => {
    expect(NEEDS_YOU_TEXT).toBe('text-[var(--attention-text)]');
    expect(NEEDS_YOU_ROW).toContain('border-[var(--attention-hairline,var(--attention))]');
    expect(NEEDS_YOU_ROW).toContain('bg-[var(--selection-subtle)]');
    const dir = path.join(__dirname, '..');
    for (const file of ['MoaMemoryCard.tsx', 'MoaBubble.tsx', 'MoaMascot.tsx', 'MoaTitlebarButton.tsx',
      'panel/MoaWaitingOnYou.tsx', 'panel/MoaHandoffCard.tsx', 'panel/MoaPurposeCard.tsx', 'panel/MoaTaskCards.tsx']) {
      expect(readFileSync(path.join(dir, file), 'utf8'), file).not.toContain('--accent-yellow');
    }
  });
});

// Theme style knobs (THEME_STYLES) ⇄ globals.css. A look's knobs are emitted
// as CSS custom properties on its [data-theme] block; a theme without knobs
// emits none, so it keeps the :root defaults (its earlier look).
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  THEME_STYLES,
  UI_THEME_TOKENS,
  THEME_OPTIONS,
  BUILTIN_XTERM_PALETTE,
  XTERM_PALETTES,
  themeStyleCssVars,
  type BuiltinThemeId,
} from '../themes';

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'globals.css'), 'utf8');

function blockVars(id: string): Record<string, string> {
  const m = new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const vm of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[vm[1]] = vm[2].trim();
  return out;
}

const LOOKS: BuiltinThemeId[] = ['tint', 'zinc', 'graphite', 'paper', 'amber-line'];

describe('theme style knobs', () => {
  it.each(LOOKS)('%s: its globals.css block carries exactly its knob variables', (id) => {
    const vars = blockVars(id);
    const expected = themeStyleCssVars(THEME_STYLES[id], UI_THEME_TOKENS[id].accent);
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(expected)) {
      expect(vars[name], `${id} ${name}`).toBe(value);
    }
  });

  it('a theme without knobs emits nothing, so it keeps the :root defaults', () => {
    expect(themeStyleCssVars(THEME_STYLES.amber, UI_THEME_TOKENS.amber.accent)).toEqual({});
    expect(themeStyleCssVars(undefined, '#000000')).toEqual({});
  });

  it('draws each selection style from the right colour', () => {
    expect(themeStyleCssVars({ selection: 'fill' }, '#E8A33D')['--select-ring']).toBe('none');
    expect(themeStyleCssVars({ selection: 'fill-ring', selectionRing: '#27272A' }, '#000')['--select-ring'])
      .toBe('inset 0 0 0 1px #27272A');
    expect(themeStyleCssVars({ selection: 'left-bar' }, '#E8A33D')['--select-ring']).toBe('inset 2px 0 0 #E8A33D');
  });

  it('maps the label, tab, chip and glass knobs', () => {
    const vars = themeStyleCssVars(
      { groupLabel: { uppercase: true, tracking: '0.06em' }, tabIndicator: 'underline', chipRadius: 999, glass: false },
      '#4C8DFF',
    );
    expect(vars).toMatchObject({
      '--group-case': 'uppercase',
      '--group-track': '0.06em',
      '--tab-underline': '2px',
      '--chip-radius': '999px',
      '--theme-glass': '0',
    });
  });

  it('offers the five looks first in the picker, each with its own terminal palette', () => {
    expect(THEME_OPTIONS.slice(0, 5).map((o) => o.value)).toEqual(LOOKS);
    for (const id of LOOKS) {
      const palette = XTERM_PALETTES[BUILTIN_XTERM_PALETTE[id]];
      // The terminal stays opaque: its background is a solid hex colour.
      expect(palette.background, id).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('only the tint look allows window glass', () => {
    expect(LOOKS.filter((id) => THEME_STYLES[id]?.glass)).toEqual(['tint']);
  });
});

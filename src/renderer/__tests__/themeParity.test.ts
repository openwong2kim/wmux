// SSOT parity guard: every built-in theme's [data-theme] block in globals.css
// MUST equal deriveBuiltinPalette(id) mapped through CSS_VAR_MAP (+ the three
// -rgb vars). This is what keeps themes.ts the single source of truth — if
// someone edits a token/override or a globals.css theme block without the other,
// this test fails. See BUILTIN_CSS_OVERRIDES in themes.ts for the rationale.
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  UI_THEME_TOKENS,
  deriveBuiltinPalette,
  CSS_VAR_MAP,
  type BuiltinThemeId,
  type FullCssPalette,
} from '../themes';
import { hexToRgbString } from '../tailwindPalette';

function parseGlobals(css: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const re = /\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const vars: Record<string, string> = {};
    const vre = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let vm: RegExpExecArray | null;
    while ((vm = vre.exec(m[2]))) vars[vm[1].trim()] = vm[2].trim().toUpperCase();
    out[m[1]] = vars;
  }
  return out;
}

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'globals.css'), 'utf8');
const globals = parseGlobals(css);
const ids = Object.keys(UI_THEME_TOKENS) as BuiltinThemeId[];

describe('theme SSOT parity (themes.ts ⇄ globals.css)', () => {
  it.each(ids)('%s: every [data-theme] block matches deriveBuiltinPalette()', (id) => {
    const block = globals[id];
    expect(block, `globals.css has no [data-theme="${id}"] block`).toBeDefined();
    const full = deriveBuiltinPalette(id);

    for (const [key, varName] of Object.entries(CSS_VAR_MAP)) {
      const expected = String(full[key as keyof FullCssPalette]).toUpperCase();
      expect(block[varName], `${id} ${varName}`).toBe(expected);
    }

    const rgb: Array<[string, string]> = [
      ['--accent-rgb', hexToRgbString(full.accent)],
      ['--accent-blue-rgb', hexToRgbString(full.accentBlue)],
      ['--bg-surface-rgb', hexToRgbString(full.bgSurface)],
      ['--bg-base-rgb', hexToRgbString(full.bgBase)],
    ];
    for (const [varName, expected] of rgb) {
      const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
      expect(norm(block[varName] ?? ''), `${id} ${varName}`).toBe(norm(expected));
    }
  });

  it('every built-in theme has a globals.css block', () => {
    for (const id of ids) expect(globals[id], id).toBeDefined();
  });

  it('uses Forge for first paint without overriding an explicit theme', () => {
    expect(css).toContain(':root:not([data-theme]), [data-theme="forge"]');
    expect(css).not.toMatch(/:root\s*,\s*\[data-theme="forge"\]/);
  });
});

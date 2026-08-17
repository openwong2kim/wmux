import { describe, expect, it } from 'vitest';
import { SETTINGS_CATALOG } from '../catalog';
import { matchSettings, tabHitCount } from '../searchSettings';

const LABELS: Record<string, string> = {
  'settings.cursorShape': 'Cursor shape',
  'settings.cursorShapeDesc': 'Block, underline, or bar. Block is the default.',
  'settings.language': 'Language',
  'settings.mcpServers': 'MCP Servers',
  'settings.scrollbackLines': 'Scrollback lines',
  'settings.scrollbackDesc': 'Lines retained in terminal buffer',
};

function t(key: string): string {
  return LABELS[key] ?? key;
}

describe('matchSettings', () => {
  it('returns nothing for a blank query', () => {
    expect(matchSettings('   ', t)).toEqual([]);
  });

  it('finds cursor shape by the official label', () => {
    const hits = matchSettings('cursor', t);
    expect(hits.map((h) => h.entry.id)).toContain('cursorshape');
  });

  it('finds cursor shape by a Korean synonym while labels stay English', () => {
    const hits = matchSettings('커서', t);
    expect(hits.map((h) => h.entry.id)).toEqual(['cursorshape']);
  });

  it('finds Language by 언어', () => {
    const hits = matchSettings('언어', t);
    expect(hits.map((h) => h.entry.id)).toEqual(['language']);
  });

  it('counts hits per tab so the nav can show a badge', () => {
    const hits = matchSettings('cursor', t);
    expect(tabHitCount('appearance', hits)).toBeGreaterThan(0);
    expect(tabHitCount('general', hits)).toBe(0);
  });

  it('indexes every catalog entry against a translator without throwing', () => {
    expect(() => matchSettings('a', t, SETTINGS_CATALOG)).not.toThrow();
  });

  // The reported failure: the label is "Auto-update", so a query typed with a
  // space had a hyphen sitting exactly where the space was and matched nothing.
  it('finds a hyphenated setting when the query uses a space', () => {
    const label = (key: string) =>
      key === 'settings.autoUpdate' ? 'Auto-update'
      : key === 'settings.autoUpdateDesc' ? 'Automatically check for and install updates'
      : key;
    const hits = matchSettings('auto update', label, SETTINGS_CATALOG);
    expect(hits.map((h) => h.entry.id)).toContain('autoupdate');
  });

  it('requires every term, in any order', () => {
    const both = matchSettings('shape cursor', t);
    expect(both.map((h) => h.entry.id)).toContain('cursorshape');
    // "cursor" hits, "zzz" cannot — so the pair must not.
    expect(matchSettings('cursor zzz', t)).toEqual([]);
  });
});

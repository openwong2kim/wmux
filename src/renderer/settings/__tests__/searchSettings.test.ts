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
});

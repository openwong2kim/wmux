import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { pl } from '../locales/pl';
import { zh } from '../locales/zh';

// The Bots page's folders copy: en, ko, pl and zh each own every key, and no
// translation drops or invents a {placeholder}.
const KEYS = Object.keys(en).filter((k) => k.startsWith('botsPage.folders.'));
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('botsPage.folders.* copy', () => {
  it('has keys', () => {
    expect(KEYS.length).toBeGreaterThan(0);
  });
  it('carries the multi-select copy, with the count in the selected line', () => {
    for (const key of ['selected', 'clearSelection', 'moveSelected']) expect(KEYS).toContain(`botsPage.folders.${key}`);
    for (const dict of [en, ko, pl, zh] as Record<string, string>[]) expect(dict['botsPage.folders.selected']).toContain('{count}');
  });
  for (const [name, dict] of Object.entries({ ko, pl, zh }) as [string, Record<string, string>][]) {
    it(`${name}: every key, same placeholders as en`, () => {
      for (const key of KEYS) {
        expect(dict[key], key).toBeTruthy();
        expect(placeholders(dict[key]), key).toEqual(placeholders((en as Record<string, string>)[key]));
      }
    });
    it(`${name}: no extra folder keys`, () => {
      expect(Object.keys(dict).filter((k) => k.startsWith('botsPage.folders.')).sort()).toEqual([...KEYS].sort());
    });
  }
});

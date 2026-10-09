import { describe, it, expect } from 'vitest';
import { PC_RAIL_SHORTCUTS } from '../../../shared/pcRail';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { zh } from '../locales/zh';
import { pl } from '../locales/pl';

/**
 * The PC rail's strings ship in the locales that carry the remote family
 * (en, ko, zh, pl), with the English placeholders: the consent copy states
 * what a paired computer can do, so a half-translated version is not one.
 */
const RAIL_KEYS = Object.keys(en).filter((k) => k.startsWith('pcRail.')) as (keyof typeof en)[];
const SHORTCUT_KEYS = PC_RAIL_SHORTCUTS.map((e) => e.descriptionKey) as (keyof typeof en)[];

const placeholders = (v: string): string[] => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('PC rail strings', () => {
  it('finds the rail keys and labels every shortcut in English', () => {
    expect(RAIL_KEYS.length).toBeGreaterThan(30);
    for (const k of SHORTCUT_KEYS) expect(en[k], k).toBeTruthy();
  });

  for (const [name, locale] of [['ko', ko], ['zh', zh], ['pl', pl]] as const) {
    it(`${name} carries every rail key with the English placeholders`, () => {
      const map = locale as Record<string, string | undefined>;
      const keys = [...RAIL_KEYS, ...SHORTCUT_KEYS];
      expect(keys.filter((k) => typeof map[k] !== 'string')).toEqual([]);
      for (const k of keys) expect(placeholders(map[k] as string), k).toEqual(placeholders(en[k]));
    });
  }
});

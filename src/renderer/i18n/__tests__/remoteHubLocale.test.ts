import { describe, it, expect } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { zh } from '../locales/zh';
import { pl } from '../locales/pl';

/**
 * The Remote hub's strings ship in every locale that already carries the
 * web.* / remote.* family (en, ko, zh, pl), with the same placeholders — a
 * pairing screen half in English is the one place a reader stops trusting it.
 */
const HUB_KEYS = Object.keys(en).filter((k) =>
  /^web\.(shareThisComputer|connectPhone|connectComputer|computer|phonePairing|cancel|createComputerLink|devicesCount$|devicesActive$|deviceActiveNow$|deviceKind)/.test(k)
  || /^remote\.hub/.test(k),
) as (keyof typeof en)[];

const placeholders = (v: string): string[] => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('Remote hub strings', () => {
  it('finds the hub keys', () => {
    expect(HUB_KEYS.length).toBeGreaterThan(15);
  });
  for (const [name, locale] of [['ko', ko], ['zh', zh], ['pl', pl]] as const) {
    it(`${name} carries every hub key with the English placeholders`, () => {
      const map = locale as Record<string, string | undefined>;
      const missing = HUB_KEYS.filter((k) => typeof map[k] !== 'string');
      expect(missing).toEqual([]);
      for (const k of HUB_KEYS) expect(placeholders(map[k] as string)).toEqual(placeholders(en[k]));
    });
  }
});

import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { zh } from '../locales/zh';
import { pl } from '../locales/pl';
import { ar } from '../locales/ar';
import { bs } from '../locales/bs';
import { da } from '../locales/da';
import { de } from '../locales/de';
import { es } from '../locales/es';
import { fr } from '../locales/fr';
import { hi } from '../locales/hi';
import { id } from '../locales/id';
import { it as itLocale } from '../locales/it';
import { ja } from '../locales/ja';
import { ms } from '../locales/ms';
import { nb } from '../locales/nb';
import { ptBR } from '../locales/pt-BR';
import { ru } from '../locales/ru';
import { th } from '../locales/th';
import { tr } from '../locales/tr';
import { uk } from '../locales/uk';
import { vi } from '../locales/vi';
import { zhTW } from '../locales/zh-TW';
import { LOCALE_OPTIONS } from '..';

const keys = ['moa.settings.fleetFastPath', 'moa.settings.fleetFastPathDesc'] as const;

describe('Fleet fast path setting locale coverage', () => {
  for (const [name, messages] of Object.entries({ en, ko, zh, pl })) {
    it(`${name} has its own label and description`, () => {
      const table = messages as Record<string, string>;
      for (const key of keys) {
        expect(table[key], key).toBeTruthy();
        if (name !== 'en') expect(table[key], key).not.toBe(en[key]);
      }
    });
  }
});

// The local answer is the one Fleet fast-path text every operator sees, so
// unlike most copy it ships in every locale, never through the English fallback.
const ALL: Record<string, Record<string, string>> = {
  en, ko, zh, pl, ar, bs, da, de, es, fr, hi, id, it: itLocale, ja, ms, nb,
  'pt-BR': ptBR, ru, th, tr, uk, vi, 'zh-TW': zhTW,
};
const ANSWER_KEYS = Object.keys(en).filter((key) => key.startsWith('moa.fleetAnswer.'));
const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();

describe('Fleet fast path answer locale parity', () => {
  it('covers every shipped locale', () => {
    expect(Object.keys(ALL).sort()).toEqual(LOCALE_OPTIONS.map((o) => o.value).sort());
  });

  it('defines the answer keys in pairs for every counted phrase', () => {
    expect(ANSWER_KEYS.length).toBeGreaterThan(0);
    for (const key of ANSWER_KEYS.filter((k) => k.endsWith('.one'))) {
      expect(ANSWER_KEYS, key).toContain(key.replace(/\.one$/, '.other'));
    }
  });

  it.each(Object.keys(ALL))('%s has every answer key, no extra ones, and the same placeholders as English', (locale) => {
    const table = ALL[locale];
    const own = Object.keys(table).filter((key) => key.startsWith('moa.fleetAnswer.'));
    expect(own.sort()).toEqual([...ANSWER_KEYS].sort());
    for (const key of ANSWER_KEYS) {
      expect(table[key]?.trim(), `${locale} ${key}`).toBeTruthy();
      expect(placeholders(table[key]), `${locale} ${key}`).toEqual(placeholders((en as Record<string, string>)[key]));
    }
    // A translated table, not a copy of the English one.
    if (locale !== 'en') expect(table['moa.fleetAnswer.intro']).not.toBe(en['moa.fleetAnswer.intro']);
  });

  it('keeps the Markdown list marker out of the row template (the formatter adds it)', () => {
    for (const [locale, table] of Object.entries(ALL)) {
      expect(table['moa.fleetAnswer.row'].startsWith('-'), locale).toBe(false);
    }
  });
});

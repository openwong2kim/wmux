import { describe, expect, it } from 'vitest';
import { LOCALE_OPTIONS, type Locale } from '../index';
import { ar } from '../locales/ar';
import { bs } from '../locales/bs';
import { da } from '../locales/da';
import { de } from '../locales/de';
import { en } from '../locales/en';
import { es } from '../locales/es';
import { fr } from '../locales/fr';
import { hi } from '../locales/hi';
import { id } from '../locales/id';
import { it as italian } from '../locales/it';
import { ja } from '../locales/ja';
import { ko } from '../locales/ko';
import { ms } from '../locales/ms';
import { nb } from '../locales/nb';
import { pl } from '../locales/pl';
import { ptBR } from '../locales/pt-BR';
import { ru } from '../locales/ru';
import { th } from '../locales/th';
import { tr } from '../locales/tr';
import { uk } from '../locales/uk';
import { vi } from '../locales/vi';
import { zhTW } from '../locales/zh-TW';
import { zh } from '../locales/zh';

const KEYS = [
  'settings.sidebarShowPaneCoordinates',
  'settings.sidebarShowPaneCoordinatesDesc',
] as const;

type PaneCoordinatesTranslationKey = (typeof KEYS)[number];

const LOCALE_TRANSLATIONS = {
  en,
  ko,
  ja,
  zh,
  'zh-TW': zhTW,
  ar,
  bs,
  da,
  de,
  es,
  fr,
  hi,
  id,
  it: italian,
  ms,
  nb,
  pl,
  'pt-BR': ptBR,
  ru,
  th,
  tr,
  uk,
  vi,
} satisfies Record<Locale, Partial<Record<PaneCoordinatesTranslationKey, string>>>;

describe('pane coordinates locale contract (#1326)', () => {
  for (const { value: locale } of LOCALE_OPTIONS) {
    it(`${locale}: owns the pane coordinates setting copy instead of falling back to English`, () => {
      const translations = LOCALE_TRANSLATIONS[locale];

      for (const key of KEYS) {
        expect(
          Object.prototype.hasOwnProperty.call(translations, key),
          `${locale} falls back for "${key}"`,
        ).toBe(true);

        const copy = translations[key];
        if (typeof copy !== 'string') throw new Error(`${locale} missing "${key}"`);
        expect(copy).toBeTruthy();
        expect(copy).not.toBe(key);
        expect(copy).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    });
  }
});

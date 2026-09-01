// The update widget warns that installing ends running sessions (#866). A
// missing key does not throw — t() renders a placeholder — so a locale that
// forgot this string would silently promise nothing at the exact moment the
// user is about to lose their panes. Every locale owns it, or this fails.
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

const KEY = 'settings.updateEndsSessions';

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
} satisfies Record<Locale, Partial<Record<typeof KEY, string>>>;

describe('update session-loss warning locale contract', () => {
  for (const { value: locale } of LOCALE_OPTIONS) {
    it(`${locale}: owns the session-loss warning instead of relying on fallback`, () => {
      const translations = LOCALE_TRANSLATIONS[locale];

      expect(
        Object.prototype.hasOwnProperty.call(translations, KEY),
        `${locale} falls back for "${KEY}"`,
      ).toBe(true);

      const copy = translations[KEY];
      if (typeof copy !== 'string') throw new Error(`${locale} missing "${KEY}"`);
      expect(copy).toBeTruthy();
      expect(copy).not.toBe(KEY);
      // An untranslated placeholder or a stray interpolation token would render
      // as literal braces to the user.
      expect(copy).not.toMatch(/\{[a-zA-Z]+\}/);
    });
  }

  it('every locale is distinct from at least the key itself and non-trivially long', () => {
    for (const [locale, translations] of Object.entries(LOCALE_TRANSLATIONS)) {
      const copy = (translations as Record<string, string>)[KEY];
      expect(copy.length, `${locale} copy is suspiciously short`).toBeGreaterThan(8);
    }
  });

  // #1030 — the warning must describe what the updater actually does on every
  // platform: panes close; on macOS the daemon detaches and SESSIONS SURVIVE,
  // so "closes your running sessions" was false there and disagreed with
  // update.readyToInstall in the same file. Pin the en wording so a rewrite
  // back to session language fails loudly.
  it('en: warns about panes, not sessions (macOS keeps sessions alive)', () => {
    expect(en[KEY]).toBe('Installing closes every pane.');
    expect(en['update.readyToInstall']).toContain('Installing closes every pane.');
  });
});

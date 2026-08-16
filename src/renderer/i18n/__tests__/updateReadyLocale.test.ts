// The ready-to-install notice carries the same session-loss warning as the
// Settings widget (#866) — and #897 promoted it to the PRIMARY surface, a
// persistent toast shown precisely when Settings is closed. A missing key does
// not throw; it falls back to English, so the one sentence telling the user
// they are about to lose every pane would reach twenty locales in a language
// they may not read. `updateSessionsLocale.test.ts` already holds that line for
// the widget. This holds it for the notice, and for the button the user presses
// to act on it.
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

/** Every string the update notice puts in front of the user. */
const KEYS = [
  'update.readyToInstall',
  'update.installNow',
  'update.installFailed',
] as const;

/** `{name}` tokens each key MUST keep — t() fills them, and a translation that
 *  drops one renders a sentence with a hole where the version should be. */
const REQUIRED_TOKENS: Record<(typeof KEYS)[number], string[]> = {
  'update.readyToInstall': ['{version}', '{current}'],
  'update.installNow': [],
  'update.installFailed': ['{error}'],
};

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
} satisfies Record<Locale, Partial<Record<(typeof KEYS)[number] | 'settings.updateEndsSessions', string>>>;

describe('update ready-to-install locale contract', () => {
  for (const { value: locale } of LOCALE_OPTIONS) {
    for (const key of KEYS) {
      it(`${locale}: owns "${key}" instead of relying on fallback`, () => {
        const translations = LOCALE_TRANSLATIONS[locale] as Record<string, string | undefined>;

        expect(
          Object.prototype.hasOwnProperty.call(translations, key),
          `${locale} falls back for "${key}"`,
        ).toBe(true);

        const copy = translations[key];
        if (typeof copy !== 'string') throw new Error(`${locale} missing "${key}"`);
        expect(copy).toBeTruthy();
        expect(copy).not.toBe(key);

        // Interpolation tokens are part of the contract, not decoration: t()
        // substitutes them, so a translation that lost one silently drops the
        // version (or the error) out of the sentence.
        for (const token of REQUIRED_TOKENS[key]) {
          expect(copy, `${locale} "${key}" lost ${token}`).toContain(token);
        }
        // ...and must not invent tokens t() will never fill.
        const unknown = (copy.match(/\{[a-zA-Z]+\}/g) ?? [])
          .filter((tok) => !REQUIRED_TOKENS[key].includes(tok));
        expect(unknown, `${locale} "${key}" has unfillable tokens`).toEqual([]);
      });
    }
  }

  it('the ready notice keeps the session-loss warning, not just the version line', () => {
    // The point of this string is the consequence, not the announcement. A
    // translation trimmed to "wmux X is ready" would pass every check above
    // while dropping the only sentence that says every pane closes.
    //
    // Compared WITHIN each locale rather than against a character count: the
    // notice is that locale's warning plus a version line, so it must be the
    // longer of the two in whatever script it is written in. A flat threshold
    // is the wrong instrument here — the Chinese notice carries the identical
    // meaning in 29 characters and would fail a bar the English one clears.
    for (const [locale, translations] of Object.entries(LOCALE_TRANSLATIONS)) {
      const t = translations as Record<string, string>;
      const notice = t['update.readyToInstall'].replace(/\{[a-zA-Z]+\}/g, '').trim();
      const warning = t['settings.updateEndsSessions'];
      expect(
        notice.length,
        `${locale} ready-notice is shorter than its own session-loss warning`,
      ).toBeGreaterThanOrEqual(warning.length);
    }
  });
});

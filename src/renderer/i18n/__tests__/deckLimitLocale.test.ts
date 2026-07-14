// Locale contract for the surfaced rate-limit notices (M3). formatLimitNotice()
// lives in CommanderView.tsx as a module-local function a node-env test can't
// import without dragging in the whole React/store module graph, so this guards
// the failure mode that actually bit us before (#452): a t() key present in code
// but MISSING from the locale map renders as the raw key string. tsc can't catch
// it — t()'s signature accepts any string. Every key below is referenced by
// formatLimitNotice/formatResetCountdown; keep this list in sync with them.

import { describe, it, expect, afterAll } from 'vitest';
import { t, setLocale, type Locale } from '../index';

const KEYS = [
  'deck.limit.window',
  'deck.limit.resetsSoon',
  'deck.limit.resetsIn',
  'deck.limit.onAccount',
  'deck.limit.utilSuffix',
  'deck.limit.rejected',
  'deck.limit.approaching',
] as const;

// en drives the TranslationKey type and is the fallback for every other locale;
// ko is the only other locale that populates these (others fall back to en).
const LOCALES: Locale[] = ['en', 'ko'];

describe('deck.limit locale contract', () => {
  afterAll(() => setLocale('en'));

  for (const locale of LOCALES) {
    it(`${locale}: every limit-notice key resolves to real copy (not the raw key)`, () => {
      setLocale(locale);
      for (const key of KEYS) {
        const s = t(key);
        expect(s, `${locale} missing "${key}"`).toBeTruthy();
        expect(s, `${locale} "${key}" renders as the raw key`).not.toBe(key);
      }
    });

    it(`${locale}: a fully-composed notice line has no unresolved {placeholders}`, () => {
      setLocale(locale);
      // Mirrors formatLimitNotice(): optional fragments are built first, then
      // folded into the sentence templates.
      const on = t('deck.limit.onAccount', { account: 'Work Max' });
      const reset = ` — ${t('deck.limit.resetsIn', { rel: '2h13m' })}`;
      const util = t('deck.limit.utilSuffix', { util: 85 });
      const rejected = t('deck.limit.rejected', { window: 'five-hour', on, reset });
      const approaching = t('deck.limit.approaching', { window: 'five-hour', on, util, reset });
      for (const line of [rejected, approaching]) {
        expect(line, `${locale} left an unresolved placeholder: ${line}`).not.toMatch(/\{[a-zA-Z]+\}/);
        expect(line).toContain('Work Max');
        expect(line).toContain('2h13m');
      }
      expect(approaching).toContain('85');
    });
  }
});

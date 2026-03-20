/**
 * Lightweight i18n system — no external library, no React Context.
 * Usage:
 *   import { t, setLocale, getLocale } from '../i18n';
 *   t('sidebar.workspaces')        => "Workspaces"
 *   t('terminal.exited', { code: 1 }) => "Process exited with code 1"
 */

import { en, type TranslationKey } from './locales/en';
import { ko } from './locales/ko';
import { ja } from './locales/ja';
import { zh } from './locales/zh';

export type Locale = 'en' | 'ko' | 'ja' | 'zh';

// All translation maps share the same key set defined by the `en` locale.
// Partial<> lets other locales fall back to `en` for missing keys.
type TranslationMap = Record<TranslationKey, string>;

const translations: Record<Locale, Partial<TranslationMap>> = {
  en: en as TranslationMap,
  ko: ko as Partial<TranslationMap>,
  ja: ja as Partial<TranslationMap>,
  zh: zh as Partial<TranslationMap>,
};

// ─── State ────────────────────────────────────────────────────────────────────

let currentLocale: Locale = 'en';

// ─── Public API ───────────────────────────────────────────────────────────────

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
}

/**
 * Translate a key with optional interpolation.
 * Variables in the template are replaced with {varName} syntax.
 *
 * @example
 * t('terminal.exited', { code: 1 }) // "Process exited with code 1"
 */
export function t(key: TranslationKey | (string & {}), vars?: Record<string, string | number>): string {
  const map = translations[currentLocale];
  const k = key as TranslationKey;
  let str: string = (map[k] ?? translations.en[k] ?? key) as string;

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }

  return str;
}

/** All supported locales with display names. */
export const LOCALE_OPTIONS: Array<{ value: Locale; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文' },
];

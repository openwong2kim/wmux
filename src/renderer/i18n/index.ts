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
import { zhTW } from './locales/zh-TW';
import { ar } from './locales/ar';
import { bs } from './locales/bs';
import { da } from './locales/da';
import { de } from './locales/de';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { hi } from './locales/hi';
import { id } from './locales/id';
import { it } from './locales/it';
import { ms } from './locales/ms';
import { nb } from './locales/nb';
import { pl } from './locales/pl';
import { ptBR } from './locales/pt-BR';
import { ru } from './locales/ru';
import { th } from './locales/th';
import { tr } from './locales/tr';
import { uk } from './locales/uk';
import { vi } from './locales/vi';

export type Locale =
  | 'en'
  | 'ko'
  | 'ja'
  | 'zh'
  | 'zh-TW'
  | 'ar'
  | 'bs'
  | 'da'
  | 'de'
  | 'es'
  | 'fr'
  | 'hi'
  | 'id'
  | 'it'
  | 'ms'
  | 'nb'
  | 'pl'
  | 'pt-BR'
  | 'ru'
  | 'th'
  | 'tr'
  | 'uk'
  | 'vi';

// All translation maps share the same key set defined by the `en` locale.
// Partial<> lets other locales fall back to `en` for missing keys.
type TranslationMap = Record<TranslationKey, string>;

const translations: Record<Locale, Partial<TranslationMap>> = {
  en: en as TranslationMap,
  ko: ko as Partial<TranslationMap>,
  ja: ja as Partial<TranslationMap>,
  zh: zh as Partial<TranslationMap>,
  'zh-TW': zhTW as Partial<TranslationMap>,
  ar: ar as Partial<TranslationMap>,
  bs: bs as Partial<TranslationMap>,
  da: da as Partial<TranslationMap>,
  de: de as Partial<TranslationMap>,
  es: es as Partial<TranslationMap>,
  fr: fr as Partial<TranslationMap>,
  hi: hi as Partial<TranslationMap>,
  id: id as Partial<TranslationMap>,
  it: it as Partial<TranslationMap>,
  ms: ms as Partial<TranslationMap>,
  nb: nb as Partial<TranslationMap>,
  pl: pl as Partial<TranslationMap>,
  'pt-BR': ptBR as Partial<TranslationMap>,
  ru: ru as Partial<TranslationMap>,
  th: th as Partial<TranslationMap>,
  tr: tr as Partial<TranslationMap>,
  uk: uk as Partial<TranslationMap>,
  vi: vi as Partial<TranslationMap>,
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
      // Replacer FUNCTION, not a replacement string: `String.replace` reads
      // `$&`, `$$`, "$`" and `$'` in a replacement string as patterns, so a
      // value containing one would splice the match back into the result
      // (`{message}` reappearing verbatim) instead of being inserted. Values
      // used to be counts and names; they are now raw `Error.message`,
      // agent-authored titles and pane titles carrying paths.
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
    }
  }

  return str;
}

/** All supported locales with display names (native script). */
export const LOCALE_OPTIONS: Array<{ value: Locale; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文 (简体)' },
  { value: 'zh-TW', label: '中文 (繁體)' },
  { value: 'ar', label: 'العربية' },
  { value: 'bs', label: 'Bosanski' },
  { value: 'da', label: 'Dansk' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'it', label: 'Italiano' },
  { value: 'ms', label: 'Bahasa Melayu' },
  { value: 'nb', label: 'Norsk Bokmål' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'ru', label: 'Русский' },
  { value: 'th', label: 'ไทย' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'uk', label: 'Українська' },
  { value: 'vi', label: 'Tiếng Việt' },
];

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TranslationKey } from '../../renderer/i18n/locales/en';

/**
 * Copy for the native "Quit and Stop Sessions" confirmation.
 *
 * The strings live in the renderer's locale tables so translators see them
 * next to everything else. Main loads only the one table it needs, at click
 * time: a static import of all 23 tables would roughly double the main bundle
 * for five strings.
 */

type LocaleTable = Partial<Record<TranslationKey, string>>;

const LOADERS: Readonly<Record<string, () => Promise<LocaleTable>>> = {
  en: async () => (await import('../../renderer/i18n/locales/en')).en,
  ko: async () => (await import('../../renderer/i18n/locales/ko')).ko,
  ja: async () => (await import('../../renderer/i18n/locales/ja')).ja,
  zh: async () => (await import('../../renderer/i18n/locales/zh')).zh,
  'zh-TW': async () => (await import('../../renderer/i18n/locales/zh-TW')).zhTW,
  ar: async () => (await import('../../renderer/i18n/locales/ar')).ar,
  bs: async () => (await import('../../renderer/i18n/locales/bs')).bs,
  da: async () => (await import('../../renderer/i18n/locales/da')).da,
  de: async () => (await import('../../renderer/i18n/locales/de')).de,
  es: async () => (await import('../../renderer/i18n/locales/es')).es,
  fr: async () => (await import('../../renderer/i18n/locales/fr')).fr,
  hi: async () => (await import('../../renderer/i18n/locales/hi')).hi,
  id: async () => (await import('../../renderer/i18n/locales/id')).id,
  it: async () => (await import('../../renderer/i18n/locales/it')).it,
  ms: async () => (await import('../../renderer/i18n/locales/ms')).ms,
  nb: async () => (await import('../../renderer/i18n/locales/nb')).nb,
  pl: async () => (await import('../../renderer/i18n/locales/pl')).pl,
  'pt-BR': async () => (await import('../../renderer/i18n/locales/pt-BR')).ptBR,
  ru: async () => (await import('../../renderer/i18n/locales/ru')).ru,
  th: async () => (await import('../../renderer/i18n/locales/th')).th,
  tr: async () => (await import('../../renderer/i18n/locales/tr')).tr,
  uk: async () => (await import('../../renderer/i18n/locales/uk')).uk,
  vi: async () => (await import('../../renderer/i18n/locales/vi')).vi,
};

export interface SessionCounts {
  /** Live (attached or detached) daemon sessions — every terminal. */
  sessions: number;
  /** The live sessions whose foreground process is a known agent. */
  agents: number;
}

export interface QuitAndStopCopy {
  message: string;
  detail: string;
  confirm: string;
  cancel: string;
}

/**
 * The UI locale the renderer last persisted to session.json. Falls back to the
 * OS locale (first launch, or an unreadable file) and finally to English.
 */
export function readUiLocale(userDataDir: string, osLocale: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, 'session.json'), 'utf8')) as { locale?: unknown };
    if (typeof raw.locale === 'string' && raw.locale in LOADERS) return raw.locale;
  } catch {
    // fall through to the OS locale
  }
  if (osLocale in LOADERS) return osLocale;
  const base = osLocale.split('-')[0];
  return base in LOADERS ? base : 'en';
}

function fill(template: string, vars: Record<string, number>): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/**
 * Build the confirmation copy. `counts === null` means the daemon could not be
 * asked; the dialog still asks, but never states a number it does not have.
 */
export async function buildQuitAndStopCopy(locale: string, counts: SessionCounts | null): Promise<QuitAndStopCopy> {
  const en = await LOADERS.en();
  let table: LocaleTable = en;
  if (locale !== 'en' && LOADERS[locale]) {
    try {
      table = await LOADERS[locale]();
    } catch {
      table = en;
    }
  }
  const tr = (key: TranslationKey): string => table[key] ?? en[key] ?? key;
  return {
    message: tr('quitAndStop.message'),
    detail: counts
      ? fill(tr('quitAndStop.detail'), { agents: counts.agents, sessions: counts.sessions })
      : tr('quitAndStop.detailUnknown'),
    confirm: tr('quitAndStop.confirm'),
    cancel: tr('common.cancel'),
  };
}

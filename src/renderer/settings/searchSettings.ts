import type { TranslationKey } from '../i18n/locales/en';
import { SETTINGS_CATALOG, type SettingsCatalogEntry, type SettingsTabId } from './catalog';

export interface SettingsSearchHit {
  entry: SettingsCatalogEntry;
  haystack: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function catalogHaystack(
  entry: SettingsCatalogEntry,
  t: (key: TranslationKey) => string,
): string {
  const pieces = [t(entry.labelKey), entry.synonyms];
  if (entry.descKey) pieces.push(t(entry.descKey));
  return normalize(pieces.join(' '));
}

export function matchSettings(
  query: string,
  t: (key: TranslationKey) => string,
  catalog: SettingsCatalogEntry[] = SETTINGS_CATALOG,
): SettingsSearchHit[] {
  const needle = normalize(query);
  if (!needle) return [];
  const hits: SettingsSearchHit[] = [];
  for (const entry of catalog) {
    const haystack = catalogHaystack(entry, t);
    if (haystack.includes(needle)) hits.push({ entry, haystack });
  }
  return hits;
}

export function tabHitCount(tab: SettingsTabId, hits: SettingsSearchHit[]): number {
  return hits.filter((hit) => hit.entry.tab === tab).length;
}

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

/**
 * Split a query into search terms. Every term has to appear somewhere in the
 * haystack, but they do not have to appear together or in order — matching the
 * whole query as one contiguous string makes punctuation decide the outcome.
 * "auto update" found nothing because the label is written "Auto-update", so
 * the hyphen sat exactly where the user typed a space.
 */
function terms(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean);
}

export function matchSettings(
  query: string,
  t: (key: TranslationKey) => string,
  catalog: SettingsCatalogEntry[] = SETTINGS_CATALOG,
): SettingsSearchHit[] {
  const needles = terms(query);
  if (needles.length === 0) return [];
  const hits: SettingsSearchHit[] = [];
  for (const entry of catalog) {
    const haystack = catalogHaystack(entry, t);
    if (needles.every((needle) => haystack.includes(needle))) hits.push({ entry, haystack });
  }
  return hits;
}

export function tabHitCount(tab: SettingsTabId, hits: SettingsSearchHit[]): number {
  return hits.filter((hit) => hit.entry.tab === tab).length;
}

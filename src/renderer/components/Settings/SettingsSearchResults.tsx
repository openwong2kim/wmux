import type { ReactNode } from 'react';
import type { TranslationKey } from '../../i18n/locales/en';
import type { SettingsSearchHit } from '../../settings/searchSettings';
import type { SettingsTabId } from '../../settings/catalog';

function highlight(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm px-px" style={{ backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)', color: 'inherit' }}>
        {text.slice(idx, idx + needle.length)}
      </mark>
      {text.slice(idx + needle.length)}
    </>
  );
}

export function SettingsSearchResults({
  query,
  hits,
  tabLabel,
  t,
  onJump,
}: {
  query: string;
  hits: SettingsSearchHit[];
  tabLabel: (tab: SettingsTabId) => string;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  onJump: (id: string) => void;
}) {
  if (hits.length === 0) {
    return (
      <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }} data-testid="settings-search-empty">
        {t('settings.searchNoMatches', { query })}
      </p>
    );
  }

  const groups = new Map<SettingsTabId, SettingsSearchHit[]>();
  for (const hit of hits) {
    const list = groups.get(hit.entry.tab) ?? [];
    list.push(hit);
    groups.set(hit.entry.tab, list);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="settings-search-results">
      {Array.from(groups.entries()).map(([tab, group]) => (
        <section key={tab}>
          <h3
            className="text-[10px] font-semibold uppercase tracking-[0.09em] mb-2"
            style={{ color: 'var(--text-muted)' }}
          >
            {tabLabel(tab)}
          </h3>
          <div className="flex flex-col gap-1.5">
            {group.map((hit) => (
              <button
                key={hit.entry.id}
                type="button"
                data-jump={hit.entry.id}
                onClick={() => onJump(hit.entry.id)}
                className="text-left rounded-[5px] px-3 py-2.5"
                style={{
                  backgroundColor: 'var(--bg-mantle)',
                  border: '1px solid var(--bg-surface)',
                }}
              >
                <div className="text-sm" style={{ color: 'var(--text-main)' }}>
                  {highlight(t(hit.entry.labelKey), query)}
                </div>
                {hit.entry.descKey && (
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {highlight(t(hit.entry.descKey), query)}
                  </div>
                )}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

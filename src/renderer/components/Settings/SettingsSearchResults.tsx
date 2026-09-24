import type { ReactNode } from 'react';
import type { TranslationKey } from '../../i18n/locales/en';
import type { SettingsSearchHit } from '../../settings/searchSettings';
import type { SettingsTabId } from '../../settings/catalog';
import { FOCUS_RING } from '../focusRing';

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
      <p className="text-[13px] text-center py-8" style={{ color: 'var(--text-sub)' }} data-testid="settings-search-empty">
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
    <div className="settings-page" data-testid="settings-search-results">
      {Array.from(groups.entries()).map(([tab, group]) => (
        <section key={tab} className="settings-section">
          <div className="settings-section-head">
            <h3 className="ui-group-label settings-section-title">{tabLabel(tab)}</h3>
          </div>
          <div className="ui-group">
            {group.map((hit) => (
              <button
                key={hit.entry.id}
                type="button"
                data-jump={hit.entry.id}
                onClick={() => onJump(hit.entry.id)}
                className={`settings-row settings-search-hit text-left ${FOCUS_RING}`}
              >
                <span className="ui-field-label">
                  {highlight(t(hit.entry.labelKey), query)}
                </span>
                {hit.entry.descKey && (
                  <span className="ui-field-description settings-clamp">
                    {highlight(t(hit.entry.descKey), query)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

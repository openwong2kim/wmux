// ─── Command Deck — dock tab bar (Phase 1 P1a) ───────────────────────────────
//
// Two-tab header at the top of the right dock: [Commander] [Channels].
// `commander` is the default (the LLM-less command composer); `channels` holds
// the classic list + conversation. Pure + props-driven so the tab-switch
// behavior is unit-testable under jsdom without the store-connected dock body.

import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { DeckTab } from '../../stores/slices/deckSlice';

export interface DeckTabsProps {
  active: DeckTab;
  onSelect: (tab: DeckTab) => void;
  /** Unread total across all channels — a small badge on the Channels tab so
   *  switching away from it doesn't hide new activity. Omit / 0 → no badge. */
  channelsUnread?: number;
  /** Translator — defaults to identity so tests can omit it. */
  t?: (key: string) => string;
}

const TABS: { id: DeckTab; labelKey: string; fallback: string }[] = [
  { id: 'commander', labelKey: 'deck.tabCommander', fallback: 'Orchestrator' },
  { id: 'channels', labelKey: 'deck.tabChannels', fallback: 'Channels' },
];

export function DeckTabs({
  active,
  onSelect,
  channelsUnread = 0,
  t: tProp,
}: DeckTabsProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  return (
    <div
      data-deck-tabs
      role="tablist"
      aria-label={t('deck.tabsAriaLabel') || 'Command deck tabs'}
      className="flex items-stretch shrink-0 border-b border-[var(--bg-surface)]"
      style={{ borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgSurface', 'border')}
    >
      {TABS.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-deck-tab={tab.id}
            data-active={isActive ? 'true' : undefined}
            onClick={() => onSelect(tab.id)}
            className={`relative flex-1 flex items-center justify-center gap-1 px-3 py-2 text-[12.5px] font-semibold transition-colors duration-150 ${FOCUS_RING} ${
              isActive
                ? 'text-[var(--text-main)] bg-[rgba(var(--bg-surface-rgb),0.5)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-sub)]'
            }`}
            {...(isActive ? tokenAttrs('textMain', 'text') : tokenAttrs('textMuted', 'text'))}
          >
            <span>{t(tab.labelKey) || tab.fallback}</span>
            {tab.id === 'channels' && channelsUnread > 0 && (
              <span
                data-deck-tab-unread
                className="text-[var(--text-sub)]"
                {...tokenAttrs('textSub', 'text')}
              >
                ({channelsUnread > 99 ? '99+' : channelsUnread})
              </span>
            )}
            {isActive && (
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent-blue)]"
                {...tokenAttrs('accent', 'bg')}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export default DeckTabs;

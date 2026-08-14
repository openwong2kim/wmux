// ─── Deck mini rail — the collapsed deck ─────────────────────────────────────
//
// When the deck is collapsed the terminals reclaim its 248–320px, but the way
// back has to survive: this 36px column keeps the same glyphs the open deck's
// header shows (Agent · Git · Channels · web), stacked vertically on the deck's
// edge. Pressing one opens the deck straight onto that tab.
//
// Before this the reopen affordance was a labeled row at the foot of the
// workspace sidebar — the opposite edge from the thing it opened, and gone
// entirely once the sidebar was collapsed (MiniSidebar never carried it).

import { useStore } from '../../stores';
import { tokenAttrs } from '../../themes';
import { useT } from '../../hooks/useT';
import { IconRobot, IconGitBranch, IconHash } from '../icons';
import WebToggle from '../StatusBar/WebToggle';
import { sumUnread } from '../Channels/ChannelsPanel';
import { DECK_ICON_BUTTON, DECK_ICON_BADGE, deckIconTone, formatDeckCount } from './deckIconStyles';
import type { DeckTab } from '../../stores/slices/deckSlice';

export default function DeckMiniRail(): React.ReactElement {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const setActiveDeckTab = useStore((s) => s.setActiveDeckTab);
  const setChannelDockVisible = useStore((s) => s.setChannelDockVisible);
  const setChannelsTabVisible = useStore((s) => s.setChannelsTabVisible);
  const channelsTabVisible = useStore((s) => s.channelsTabVisible);
  const channelUnread = useStore((s) => s.channelUnread);
  const activeDeckTab = useStore((s) => s.activeDeckTab);
  const unread = formatDeckCount(sumUnread(channelUnread));
  const dirtyWsCount = useStore(
    (s) => s.workspaces.filter((w) => (w.metadata?.gitSync?.dirty ?? 0) > 0).length,
  );
  const dirty = formatDeckCount(dirtyWsCount);

  // Same edge logic as ChannelDock: the rail stands in for the dock, so it
  // sits opposite the workspace sidebar and its border faces the panes.
  const dockOnRight = sidebarPosition !== 'right';

  const open = (tab: DeckTab) => {
    // The Channels tab defaults to OFF; pressing its glyph IS the statement "I
    // want channels", so turn the tab on rather than opening an empty deck.
    if (tab === 'channels' && !channelsTabVisible) setChannelsTabVisible(true);
    setActiveDeckTab(tab);
    setChannelDockVisible(true);
  };

  return (
    <div
      className={`flex flex-col items-center shrink-0 h-full bg-[var(--bg-mantle)] ${dockOnRight ? 'border-l' : 'border-r'}`}
      style={{ width: 36, borderColor: 'var(--border-soft)' }}
      data-deck-mini-rail
      {...tokenAttrs('bgMantle', 'bg')}
    >
      <button
        type="button"
        onClick={() => open('commander')}
        data-deck-rail="commander"
        aria-label={t('deck.tabCommander') || 'Orchestrator'}
        title={t('deck.tabCommander') || 'Orchestrator'}
        className={`${DECK_ICON_BUTTON} ${deckIconTone(false, false)}`}
      >
        <IconRobot size={15} />
      </button>
      <button
        type="button"
        onClick={() => open('git')}
        data-deck-rail="git"
        aria-label={t('deck.tabGit') || 'Git'}
        title={t('deck.tabGit') || 'Git'}
        className={`${DECK_ICON_BUTTON} ${deckIconTone(false, dirty !== null)}`}
      >
        <IconGitBranch size={15} />
        {dirty && (
          <span data-deck-rail-dirty className={DECK_ICON_BADGE} {...tokenAttrs('accent', 'bg')}>
            {dirty}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => open('channels')}
        data-deck-rail="channels"
        aria-label={t('deck.tabChannels') || 'Channels'}
        title={t('deck.tabChannels') || 'Channels'}
        className={`${DECK_ICON_BUTTON} ${deckIconTone(false, unread !== null)}`}
      >
        <IconHash size={15} />
        {unread && (
          <span data-deck-rail-unread className={DECK_ICON_BADGE} {...tokenAttrs('accent', 'bg')}>
            {unread}
          </span>
        )}
      </button>
      <WebToggle />

      {/* Expand — reopens whatever tab was last active. Pinned to the foot so
          it mirrors the collapse chevron's place in the open deck's header. */}
      <button
        type="button"
        onClick={() => open(activeDeckTab)}
        data-deck-expand
        aria-label={t('deck.expandDock') || 'Expand dock'}
        title={t('deck.expandDock') || 'Expand dock'}
        className={`${DECK_ICON_BUTTON} mt-auto text-[var(--text-muted)] hover:text-[var(--text-sub)]`}
        {...tokenAttrs('textMuted', 'text')}
      >
        <span aria-hidden="true" className="text-[13px] leading-none">
          {dockOnRight ? '«' : '»'}
        </span>
      </button>
    </div>
  );
}

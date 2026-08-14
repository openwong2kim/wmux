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

/**
 * One glyph cell. `last` marks the tab the deck will return to — collapsed
 * there is no active view, but a rail where every glyph looks identical
 * leaves the expand chevron a blind guess, so the remembered tab keeps a thin
 * steel edge (the collapsed echo of the open deck's active underline).
 */
function RailGlyph({
  tab,
  icon,
  label,
  count = null,
  countNoun,
  badgeAttr,
  last,
  onOpen,
  dockOnRight,
}: {
  tab: DeckTab;
  icon: React.ReactNode;
  label: string;
  count?: string | null;
  countNoun?: string;
  badgeAttr?: string;
  last: boolean;
  onOpen: (tab: DeckTab) => void;
  dockOnRight: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onOpen(tab)}
      data-deck-rail={tab}
      data-last-active={last ? 'true' : undefined}
      // The badge digit is aria-hidden decoration, so the count has to be in
      // the name or a screen reader never hears it.
      aria-label={count ? `${label} (${count} ${countNoun})` : label}
      title={label}
      className={`${DECK_ICON_BUTTON} ${deckIconTone(false, count !== null)}`}
    >
      {icon}
      {count && (
        <span
          aria-hidden="true"
          className={DECK_ICON_BADGE}
          {...(badgeAttr ? { [badgeAttr]: '' } : {})}
          {...tokenAttrs('accent', 'bg')}
        >
          {count}
        </span>
      )}
      {last && (
        <span
          aria-hidden="true"
          className={`absolute top-1 bottom-1 w-0.5 bg-[var(--accent-blue)] ${dockOnRight ? 'left-0' : 'right-0'}`}
          {...tokenAttrs('accentSecondary', 'bg')}
        />
      )}
    </button>
  );
}

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

  // Pressing a glyph is a deliberate choice of THAT tab, so the Channels glyph
  // may flip the Settings opt-in on. Expanding is not — see `expand` below.
  const open = (tab: DeckTab) => {
    if (tab === 'channels' && !channelsTabVisible) setChannelsTabVisible(true);
    setActiveDeckTab(tab);
    setChannelDockVisible(true);
  };

  // Expand restores the last tab, and must NOT turn anything on: a persisted
  // `activeDeckTab: 'channels'` from before the Settings opt-in existed would
  // otherwise make a plain "expand" silently enable the frozen channel UI.
  const expand = () => {
    const target: DeckTab =
      activeDeckTab === 'channels' && !channelsTabVisible ? 'commander' : activeDeckTab;
    setActiveDeckTab(target);
    setChannelDockVisible(true);
  };

  return (
    <div
      className={`flex flex-col items-center shrink-0 h-full bg-[var(--bg-mantle)] ${dockOnRight ? 'border-l' : 'border-r'}`}
      style={{ width: 36, borderColor: 'var(--border-soft)' }}
      data-deck-mini-rail
      {...tokenAttrs('bgMantle', 'bg')}
    >
      <RailGlyph
        tab="commander"
        icon={<IconRobot size={15} />}
        label={t('deck.tabCommander') || 'Orchestrator'}
        last={activeDeckTab === 'commander'}
        onOpen={open}
        dockOnRight={dockOnRight}
      />
      <RailGlyph
        tab="git"
        icon={<IconGitBranch size={15} />}
        label={t('deck.tabGit') || 'Git'}
        count={dirty}
        countNoun="dirty"
        badgeAttr="data-deck-rail-dirty"
        last={activeDeckTab === 'git'}
        onOpen={open}
        dockOnRight={dockOnRight}
      />
      <RailGlyph
        tab="channels"
        icon={<IconHash size={15} />}
        label={t('deck.tabChannels') || 'Channels'}
        count={unread}
        countNoun="unread"
        badgeAttr="data-deck-rail-unread"
        last={activeDeckTab === 'channels'}
        onOpen={open}
        dockOnRight={dockOnRight}
      />
      <WebToggle />

      {/* Expand — reopens whatever tab was last active. Pinned to the foot so
          it mirrors the collapse chevron's place in the open deck's header. */}
      <button
        type="button"
        onClick={expand}
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

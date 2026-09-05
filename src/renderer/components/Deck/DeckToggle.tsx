// ─── Deck toggle — opening and closing the deck, from the titlebar ───────────
//
// The collapsed deck used to be a 36px glyph rail down the window's right edge:
// four icons at the top, an expand chevron at the foot, and ~85% of a
// full-height column empty between them (owner observation, 2026-08-18). The
// terminals paid a whole column so four glyphs had somewhere to live.
//
// Opening the deck is one command, so it gets one button, and it moves to the
// row that already exists for app-wide chrome — beside Settings. That is scope-
// correct: the deck's state (activeDeckTab / channelDockVisible) is app-global,
// not per-workspace, so an app-wide row is its natural home. It also satisfies
// the 2026-08-14 decision's REASON better than the rail did — the entry point
// had to stop disappearing with the sidebar, and the titlebar never collapses.
//
// Cost accepted with this: the rail opened a specific tab in one click, and now
// it takes two (open, then pick). ⌘K carries per-tab commands for the people
// who felt that.

import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { HIT_TARGET_24 } from '../hitArea';
import { sumUnread } from '../Channels/ChannelsPanel';

/**
 * Whether the collapsed deck holds anything worth opening it for.
 *
 * Deliberately a boolean, not a total: unread messages and dirty worktrees are
 * different kinds of thing, and adding them ("5") would invent a number that
 * means nothing. The dot says "there is something in here"; which it is comes
 * from opening the deck, one step away. It also keeps the deck honest against
 * DESIGN.md's no-dead-gauges rule — at zero there is no dot at all.
 */
export function deckHasSignal(unread: number, dirtyWorkspaces: number): boolean {
  return unread > 0 || dirtyWorkspaces > 0;
}

export default function DeckToggle() {
  const t = useT();
  const visible = useStore((s) => s.channelDockVisible);
  const setChannelDockVisible = useStore((s) => s.setChannelDockVisible);
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const channelUnread = useStore((s) => s.channelUnread);
  const dirtyWsCount = useStore(
    (s) => s.workspaces.filter((w) => (w.metadata?.gitSync?.dirty ?? 0) > 0).length,
  );

  // Only meaningful while collapsed: with the deck open its contents are on
  // screen, so a dot on the button that closes it would be noise.
  const signal = !visible && deckHasSignal(sumUnread(channelUnread), dirtyWsCount);

  // The arrow points at what pressing it does: toward the edge to collapse,
  // away from it to expand. The deck sits opposite the workspace sidebar.
  const deckOnRight = sidebarPosition !== 'right';
  const glyph = visible
    ? (deckOnRight ? '»' : '«')
    : (deckOnRight ? '«' : '»');

  const label = visible
    ? (t('deck.collapseDock') || 'Collapse dock')
    : (t('deck.expandDock') || 'Expand dock');
  // The dot is aria-hidden decoration, so the signal has to reach the
  // accessible name or a screen-reader user is told only "Expand dock" while
  // sighted users can see there is a reason to.
  const accessibleName = signal
    ? `${label} — ${t('deck.hasSignal') || 'something in here needs you'}`
    : label;

  return (
    <button
      type="button"
      onClick={() => setChannelDockVisible(!visible)}
      // 20x20 was under the 24px pointer floor (WCAG 2.2 SC 2.5.8) — and this
      // is the ONLY way back to a collapsed deck, so it is the last control in
      // the app that should be hard to hit. The glyph keeps its 13px size.
      className={`${HIT_TARGET_24} rounded-[4px] text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors`}
      title={accessibleName}
      aria-label={accessibleName}
      aria-expanded={visible}
      data-deck-toggle
      data-deck-signal={signal ? 'true' : 'false'}
    >
      {/* The dot is anchored to the GLYPH, not to the button. The button's box
          grew to 24px for the pointer's sake; the dot marks the arrow, and left
          on the button it would have drifted ~5px out and up to a corner with
          nothing under it. */}
      <span aria-hidden="true" className="relative text-[13px] leading-none">
        {glyph}
        {signal && (
          <span
            aria-hidden="true"
            className="absolute -top-px -right-[3px] w-[6px] h-[6px] rounded-full bg-[var(--accent-red)]"
            data-deck-toggle-dot
          />
        )}
      </span>
    </button>
  );
}

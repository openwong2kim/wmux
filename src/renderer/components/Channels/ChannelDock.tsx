// ─── Right-side channel dock (Approach A) ────────────────────────────────
//
// A collapsible flex column on the OPPOSITE edge from the workspace sidebar.
// Holds the channel list (ChannelsPanel) at the top and the active
// conversation (ChannelView) below. This replaces the old `position: fixed`
// ChannelView overlay that covered the terminals — the dock is a flex sibling
// in AppLayout's root row, so it reflows the panes instead of floating over
// them. Mounted only when `channelDockVisible` (uiSlice); auto-opens when a
// channel is selected (channelsSlice.setActiveChannel), collapses via the
// list header's collapse button, and reopens from the StatusBar channel toggle.
//
// Header: the dock has NO header of its own. The collapse affordance lives in
// ChannelsPanel's section header (it owns the single "Channels" title + unread
// total + new-channel + collapse), so the title shows ONCE instead of being
// duplicated by a separate dock header.
//
// Width: clamped (not a hard 320px) so a narrow window doesn't crush the
// terminals down to per-character wrapping. The dock gives back space when the
// viewport is small and grows to 320 when there's room.
//
// Edge mirroring: the workspace Sidebar sits on `sidebarPosition`; the dock
// sits opposite. AppLayout's root uses `flex-row-reverse` when the sidebar is
// docked right, so placing the dock as the last flex child puts it on the
// correct (opposite) edge automatically — we only flip the inner border side.

import { useStore } from '../../stores';
import { tokenAttrs } from '../../themes';
import { useT } from '../../hooks/useT';
import { ChannelsPanel, sumUnread } from './ChannelsPanel';
import { ChannelView } from './ChannelView';
import { DeckTabs } from '../Deck/DeckTabs';
import { CommanderView } from '../Deck/CommanderView';

// ─── Command Deck (Phase 1 P1a) ───────────────────────────────────────────────
//
// The dock is now a tabbed Command Deck. Its DEFAULT tab, `commander`, is the
// LLM-less command composer (fan-out @mentions to the fleet from one thread);
// the `channels` tab holds the classic list + conversation exactly as before
// (the code below is unchanged, just wrapped in a conditional). Phase 2's
// orchestrator chat reuses the Commander tab + composer skeleton wholesale.

export default function ChannelDock(): React.ReactElement {
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const activeDeckTab = useStore((s) => s.activeDeckTab);
  const setActiveDeckTab = useStore((s) => s.setActiveDeckTab);
  const channelUnread = useStore((s) => s.channelUnread);
  const t = useT();

  // Workspace sidebar is on `sidebarPosition`; the dock is on the opposite
  // edge. When the sidebar is on the LEFT (default), the dock is on the RIGHT,
  // so its content border faces left (border-l).
  const dockOnRight = sidebarPosition !== 'right';

  return (
    <div
      className={`flex flex-col h-full bg-[var(--bg-mantle)] ${dockOnRight ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`}
      style={{ width: 'clamp(248px, 26vw, 320px)', borderColor: 'var(--border-soft)' }}
      data-channel-dock
      {...tokenAttrs('bgMantle', 'bg')}
      {...tokenAttrs('bgSurface', 'border')}
    >
      <DeckTabs
        active={activeDeckTab}
        onSelect={setActiveDeckTab}
        channelsUnread={sumUnread(channelUnread)}
        t={t}
      />

      {activeDeckTab === 'commander' ? (
        // Commander tab — the LLM-less command composer + fan-out thread.
        <CommanderView />
      ) : (
        // Channels tab — the classic list + conversation (unchanged).
        <>
          {/* Channel list — its own header now carries the collapse affordance
              (merged from the old dock header to kill the duplicate "Channels"
              title). Capped so a long catalog can't crowd out the conversation;
              scrolls within its share. */}
          <div className="shrink-0 max-h-[45%] overflow-y-auto">
            <ChannelsPanel />
          </div>

          {/* Active conversation — fills the remaining height. Renders null when
              no channel is active (you still see the list above). */}
          <ChannelView />
        </>
      )}
    </div>
  );
}

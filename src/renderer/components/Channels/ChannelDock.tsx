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
import { GitTab } from '../Deck/GitTab';
import { ReviewTab } from '../Deck/ReviewTab';
import { OrchestratorModelChip } from '../Deck/OrchestratorModelChip';
import { FOCUS_RING } from '../focusRing';

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
  // Human channel UI is frozen (PRD §4.1): the tab hides by default and is
  // re-enabled in Settings as a read-only inspection surface. The setter
  // snaps activeDeckTab back to commander when the tab is turned off, but a
  // stale persisted 'channels' can never render either — the guard below.
  const channelsTabVisible = useStore((s) => s.channelsTabVisible);
  const gitTabVisible = useStore((s) => s.gitTabVisible);
  const setChannelDockVisible = useStore((s) => s.setChannelDockVisible);
  const t = useT();
  const showChannelsView = activeDeckTab === 'channels' && channelsTabVisible;
  // 채널과 동일 가드: 토글 OFF 상태의 stale 'git' 탭은 렌더 불가(커맨더 폴백).
  const showGitView = activeDeckTab === 'git' && gitTabVisible;
  // Review 탭 — 항상 가용(정보성 diff 로스터, 토글 없음).
  const showReviewView = activeDeckTab === 'review';

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
        active={showChannelsView ? 'channels' : showGitView ? 'git' : showReviewView ? 'review' : 'commander'}
        onSelect={setActiveDeckTab}
        channelsUnread={sumUnread(channelUnread)}
        showChannels={channelsTabVisible}
        showGit={gitTabVisible}
        rightSlot={
          <>
            {/* Orchestrator model — visible + switchable next to its name,
                only on the Commander tab (it's the brain's setting). */}
            {!showChannelsView && !showGitView && !showReviewView && <OrchestratorModelChip />}
            {/* Collapse the whole dock (terminals reclaim the width); reopen
                from the StatusBar dock toggle. Arrow points toward the edge the
                dock sits on. */}
            <button
              type="button"
              onClick={() => setChannelDockVisible(false)}
              title={t('deck.collapseDock') || 'Collapse dock'}
              aria-label={t('deck.collapseDock') || 'Collapse dock'}
              data-deck-collapse
              className={`flex items-center justify-center w-6 h-6 rounded text-[var(--text-muted)] hover:text-[var(--text-sub)] transition-colors ${FOCUS_RING}`}
              {...tokenAttrs('textMuted', 'text')}
            >
              <span aria-hidden="true" className="text-[13px] leading-none">
                {dockOnRight ? '»' : '«'}
              </span>
            </button>
          </>
        }
        t={t}
      />

      {showReviewView ? (
        // Review tab — diff-first roster across all workspaces (P1).
        <ReviewTab />
      ) : showGitView ? (
        // Git tab — the workspace's git surface (worktrees; PRs next PR).
        <GitTab />
      ) : !showChannelsView ? (
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

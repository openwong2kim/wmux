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
import { MODEL_OPTIONS } from '../Deck/OrchestratorModelChip';
import WebToggle from '../StatusBar/WebToggle';
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
  const setChannelsTabVisible = useStore((s) => s.setChannelsTabVisible);
  const setChannelDockVisible = useStore((s) => s.setChannelDockVisible);
  // Orchestrator 모델 — 컨트롤 바 칩에서 Agent 탭 인라인 드롭다운으로 이동.
  // DeckTabs는 순수 컴포넌트이므로 라벨·옵션·선택 콜백을 여기서 store와 잇는다.
  const t = useT();
  const deckBrainModel = useStore((s) => s.deckBrainModel);
  const setDeckBrainModel = useStore((s) => s.setDeckBrainModel);
  const commanderModelLabel = (() => {
    const o = MODEL_OPTIONS.find((x) => x.value === deckBrainModel) ?? MODEL_OPTIONS[0];
    return o.value === '' ? t('deck.orchestratorModelDefault') : o.label;
  })();
  const showChannelsView = activeDeckTab === 'channels' && channelsTabVisible;
  // git 탭(오너 결정 2026-07-20 — 덱 복귀, Review는 Git 탭 하단 섹션으로 병합).
  const showGitView = activeDeckTab === 'git';

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
        active={showChannelsView ? 'channels' : showGitView ? 'git' : 'commander'}
        // Pressing the Channels glyph IS the opt-in, exactly as the deleted
        // sidebar Channels row was: `channelsTabVisible` ships FALSE, so
        // hiding the glyph with it left an open deck no way at all to reach
        // channels — the row used to cover that case from the other edge.
        onSelect={(tab) => {
          if (tab === 'channels' && !channelsTabVisible) setChannelsTabVisible(true);
          setActiveDeckTab(tab);
        }}
        channelsUnread={sumUnread(channelUnread)}
        commanderModelLabel={commanderModelLabel}
        commanderModelOptions={MODEL_OPTIONS}
        commanderModelValue={deckBrainModel}
        onCommanderModelSelect={setDeckBrainModel}
        // wmux web — the fourth glyph on the strip. Not a tab (it opens a
        // popover, not a deck view), so it rides alongside the tablist rather
        // than inside it. Same glyph, same place, whether the deck is open or
        // collapsed into DeckMiniRail.
        afterTabs={<WebToggle />}
        rightSlot={
          <>
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

      {showGitView ? (
        // Git tab — 위: 현재 워크스페이스(워크트리·PR), 아래: 전 워크스페이스
        // diff 집계(구 Review, 오너 결정 2026-07-20 병합).
        <div className="flex-1 min-h-0 overflow-y-auto">
          <GitTab />
          <div className="border-t" style={{ borderColor: 'var(--border-soft)' }}>
            <ReviewTab />
          </div>
        </div>
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

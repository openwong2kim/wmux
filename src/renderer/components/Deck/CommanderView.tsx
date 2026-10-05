// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/ui/Composer.tsx, src/features/sessions/ui/AgentTranscript.tsx), MIT License, Copyright (c) 2026 Nick
// ─── Command Deck — Commander view (Phase 1 P1b/P1c/P1d) ─────────────────────
//
// The default dock tab: an LLM-less command composer. @-mention several agent
// panes at once and the fan-out is delivered by the EXISTING plumbing (W2
// immediate injection for a running Claude, the wake worker for everything
// else); the replies stack up in one `#commander` thread instead of forcing
// the human to walk pane-to-pane typing. This is the "왔다갔다 타이핑" painkiller
// — and the chat skeleton (thread list + composer + pane chips) is exactly what
// Phase 2's orchestrator chat renders on top of.
//
// Reuse (no new plumbing):
//   - data           = the `#commander` channel's channelMessages (channelsSlice)
//   - composer shell = ComposerContent (pure) + buildMentionCandidates (Composer)
//   - fan-out send   = createChannel/invite/postMessage *Daemon thunks
//   - message render = renderMessageBody + formatChannelAuthor (ChannelView)
//   - pane jump      = setActiveWorkspace + setActivePane (the pane-focus path)
//
// New here: the grouped "dispatch + replies" render (groupCommanderThreads) and
// the fan-out orchestration (lazy-create #commander, invite-before-post the
// mentioned workspaces, then post the pinned mentions).

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import {
  formatChatTime,
  isVendorBoundary,
  selectReportRail,
  vendorTagKey,
  type DeckLimitNotice,
} from './deckBrain';
import DeckFleet from './DeckFleet';
import { findMission, selectMissionChannelIds } from '../../stores/selectors/missions';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { generateId } from '../../../shared/types';
import type { ChannelMention, ChannelMessage } from '../../../shared/channels';
import {
  HUMAN_WORKSPACE_ID,
  HUMAN_MEMBER_ID,
  DEFAULT_COMPANY_ID,
} from '../../../shared/channels';
import {
  ComposerContent,
  buildMentionCandidates,
  synthesizeChannelMessage,
  type MentionCandidate,
} from '../Channels/Composer';
import { synthesizeChannel, sumUnread } from '../Channels/ChannelsPanel';
import { renderMessageBody } from '../Channels/ChannelView';
import { formatChannelAuthor } from '../../channels/authorDisplay';
import {
  COMMANDER_CHANNEL_NAME,
  findCommanderChannel,
  fanoutInviteMembers,
  groupCommanderThreads,
  type CommanderThread,
} from './commanderThread';
import {
  buildWorkspaceContextSummary,
  type DeckBrainMessage,
  type DeckToolChip,
} from './deckBrain';
import { EMPTY_DECK_BRAIN_THREAD } from '../../stores/slices/deckSlice';
import {
  buildRecoveryPanes,
  buildRecoveryPrompt,
  buildRecoveryContextLines,
  type RecoveryPane,
} from './deckRecovery';
import { buildQuickActions, type DeckQuickAction } from './deckQuickActions';
import { renderBrainMarkdown } from './BrainMarkdown';
import { DeckSchedulesPanel } from './DeckSchedulesPanel';
import { NewSessionChipContainer } from './NewSessionChip';
import { DeckLoopPanel } from './DeckLoopPanel';
import { DeckLedgerPanel } from './DeckLedgerPanel';
import { DeckApprovalCountdown } from './DeckApprovalCountdown';
import { DeckDecisionCard } from './DeckDecisionCard';
import { MoaMemoryCard } from '../Moa/MoaMemoryCard';
import BrainTerminalEmbed from './BrainTerminalEmbed';
import { DeckBriefingCard } from './DeckBriefingCard';
import { AgentModeChipContainer } from './AgentModeChip';
import { MoaHeaderMenu } from './MoaHeaderMenu';
import { onAgentModeChanged } from './deckModeBus';
import type { AgentMode } from '../../../main/deck/deckAutonomyStore';
import Button from '../ui/Button';

const EMPTY_MESSAGES: ChannelMessage[] = [];

/** A neutral 26px filled action chip (quick actions, Wake, Recover). */
const ACTION_CHIP = `h-[26px] px-2 rounded-md text-[12px] text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] bg-[var(--selection)] hover:bg-[var(--selection-hover)] hover:text-[var(--text-main)] transition-colors disabled:opacity-40 ${FOCUS_RING}`;
/** Your own message: content-10% fill with a content-10% hairline, rounded-lg. */
const USER_BUBBLE = 'max-w-[85%] rounded-lg px-3 py-2 bg-[color-mix(in_srgb,var(--text-main)_10%,transparent)] text-[13px] leading-relaxed text-[var(--text-main)] whitespace-pre-wrap break-words';
/** Timestamps: content 35%. */
const TIME = 'text-[11px] tabular-nums text-[color-mix(in_srgb,var(--text-main)_35%,transparent)]';

// ─── Pure view ───────────────────────────────────────────────────────────────

/** Why Moa will not run a turn in this workspace — main's refusal codes. */
export type MoaBlockCode = 'moa_off' | 'not_hq' | 'hq_missing' | 'hq_unknown';

export const MOA_BLOCK_CODES: readonly MoaBlockCode[] = ['moa_off', 'not_hq', 'hq_missing', 'hq_unknown'];

export const isMoaBlockCode = (code: unknown): code is MoaBlockCode =>
  typeof code === 'string' && (MOA_BLOCK_CODES as readonly string[]).includes(code);

/** The sentence for each refusal (also the failed turn's error text). */
export const MOA_BLOCK_KEY: Record<MoaBlockCode, string> = {
  moa_off: 'deck.moaOff',
  not_hq: 'deck.moaNotHq',
  hq_missing: 'deck.moaHqMissing',
  hq_unknown: 'deck.moaHqUnknown',
};

export interface MoaBlock {
  code: MoaBlockCode;
  /** Settings › Moa (switch, HQ recovery). */
  onOpenSettings?: () => void;
  /** Moa's own workspace, when one exists. */
  onOpenHq?: () => void;
}

/** What Moa mode adds to the pty layout. */
export interface CommanderMoaSlots {
  /** Waiting on you, delegated work and the briefing. Drawn above the
   *  terminal; the chat view already carries it inside its own scroll. */
  top?: React.ReactNode;
  /** The brain's transcript as chat bubbles, shown in place of the terminal
   *  while `view` is 'chat'. Null when there is no transcript source. */
  chat?: React.ReactNode;
  view: 'chat' | 'terminal';
  onViewChange: (view: 'chat' | 'terminal') => void;
}

export interface CommanderViewContentProps {
  threads: CommanderThread[];
  /** The Commander BRAIN conversation (Phase 2) — orchestrator turns streamed
   *  from the main-process Agent SDK session. Distinct from `threads` (the
   *  Phase 1 @-mention fan-out into #commander). */
  brainMessages: DeckBrainMessage[];
  /** True while a brain turn streams: the composer disables and an interrupt
   *  affordance shows. */
  brainBusy: boolean;
  /** Abort the in-flight brain turn. */
  onInterrupt: () => void;
  /** Members this composer can @-mention (every live agent pane, fleet-wide). */
  mentionCandidates: MentionCandidate[];
  /** Unified send: NO @mention → the Commander brain (deck:send); WITH @mentions
   *  → the Phase 1 fan-out (ensures #commander, invites, posts). The container
   *  routes on `mentions.length`. */
  onSubmit: (
    text: string,
    mentions: ChannelMention[],
  ) => Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }>;
  /** Jump the fleet to a pane referenced from the thread (chip / reply author). */
  onJumpToPane: (workspaceId: string, paneId: string) => void;
  /** Resolve a pane coordinate (workspace, pane) for a reply's senderPtyId so its
   *  author label can be clicked to jump. Returns null when the pane is gone. */
  resolvePtyPane: (ptyId: string) => { workspaceId: string; paneId: string } | null;
  workspaceName?: (workspaceId: string) => string | undefined;
  /** `claude-pty` brain only: the daemon session id of the embedded Claude
   *  Code TUI for this workspace. When set, the terminal REPLACES the bubble
   *  list — the TUI is the conversation view (only the turn's final text is
   *  still recorded as a bubble, which the terminal shows anyway). */
  brainPtyId?: string | null;
  /** P3b: recoverable panes after a reboot. Non-empty → the greeting card shows
   *  with a one-click "Recover fleet" button. */
  recoveryPanes?: RecoveryPane[];
  /** Send the canned recovery prompt to the brain (the card's button). */
  onRecoverFleet?: () => void;
  /** Hide the greeting card without recovering. */
  onDismissRecovery?: () => void;
  /** P3c: canned-prompt chips rendered above the composer. */
  quickActions?: DeckQuickAction[];
  /** Fire a quick action (sends its canned prompt to the brain). */
  onQuickAction?: (action: DeckQuickAction) => void;
  /** The workspace whose brain this view talks to: Moa's HQ when Moa runs,
   *  else the active workspace (M1.5). Schedules, mode, wake and the decision
   *  card are all bound to it. */
  chatWorkspaceId?: string;
  /** The workspace the human is viewing. Equal to chatWorkspaceId until the
   *  dock is pinned to the HQ. Main reads the same fact from the workspace
   *  mirror for the HQ brain's context line, so nothing here sends it. */
  viewedWorkspaceId?: string;
  /** Moa mode: the panel's own top section (Waiting on you, task cards) and
   *  the chat look over the HQ brain's terminal. Waiting on you and the task
   *  cards replace the HQ's decision card and ledger panel, so those two are
   *  not drawn. Absent = today's layouts. */
  moa?: CommanderMoaSlots;
  /** 활성 pane의 라이브 cwd — 루프 설정 모달의 스킬 카탈로그 스캔 기준. */
  activePaneCwd?: string;
  /** P2① mission control — the Fleet roster slot, pinned above the thread.
   *  Injected as a node so this surface stays presentational/store-free.
   *  Not drawn in Moa mode (`moa` set). */
  fleetSlot?: React.ReactNode;
  /** D1 briefing — unread channel count for the active workspace (renderer-only
   *  overlay on the briefing card; main can't see it). */
  channelsUnread?: number;
  /** Jump to the Channels tab (the briefing's unread-line affordance). */
  onJumpToChannels?: () => void;
  /** True when the active workspace's agent mode is `off` — the orchestrator
   *  does not run, so the composer is disabled and says why. Main refuses the
   *  send with `mode_off` regardless; this is the explanation, not the gate. */
  modeOff?: boolean;
  /** Moa will not run here: `moa_off` (known up front, disables the composer)
   *  or the code main gave the last refused send. Renders a notice with the
   *  reason and the action that fixes it. */
  moaBlock?: MoaBlock | null;
  /** D1 briefing — fingerprint of the active workspace's status-relevant fleet
   *  state; the card refetches when it moves (the autonomy-'off' path, where no
   *  brain stream ever fires). */
  fleetSignature?: string;
  t?: (key: string) => string;
}

/** How long a send waits for main's verdict before it counts as accepted.
 *  Every refusal is decided before the turn starts, well inside this. */
const SEND_VERDICT_GRACE_MS = 1500;

/** Side-effect-free presentational surface — all data via props (mirrors the
 *  ChannelViewContent split so the render is testable without the store). */
export function CommanderViewContent({
  threads,
  brainMessages,
  brainBusy,
  onInterrupt,
  mentionCandidates,
  onSubmit,
  onJumpToPane,
  resolvePtyPane,
  workspaceName = () => undefined,
  brainPtyId = null,
  recoveryPanes = [],
  onRecoverFleet,
  onDismissRecovery,
  quickActions = [],
  onQuickAction,
  chatWorkspaceId,
  moa,
  activePaneCwd,
  fleetSlot,
  channelsUnread = 0,
  onJumpToChannels,
  fleetSignature,
  modeOff = false,
  moaBlock = null,
  t: tProp,
}: CommanderViewContentProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  const moaOff = moaBlock?.code === 'moa_off';
  // The notice for a Moa refusal: the reason, and the one action that fixes it
  // (open Moa's workspace for not_hq, Settings › Moa otherwise).
  const moaNotice = moaBlock ? (
    <div
      className="ui-notice mx-3 mb-1.5 flex flex-col items-start gap-2 px-3 py-2.5 shrink-0"
      role="status"
      data-commander-moa-block={moaBlock.code}
    >
      <p className="m-0 text-[13px] leading-5">{t(MOA_BLOCK_KEY[moaBlock.code])}</p>
      {moaBlock.code === 'not_hq' && moaBlock.onOpenHq ? (
        <Button variant="secondary" size="sm" onClick={moaBlock.onOpenHq} data-commander-moa-open-hq>
          {t('deck.moaOpenHq')}
        </Button>
      ) : moaBlock.code !== 'not_hq' && moaBlock.onOpenSettings ? (
        <Button variant="secondary" size="sm" onClick={moaBlock.onOpenSettings} data-commander-moa-open-settings>
          {t('deck.moaOpenSettings')}
        </Button>
      ) : null}
    </div>
  ) : null;
  const modeOffReason =
    t('deck.composerModeOff') ||
    'The orchestrator is off for this workspace. Set Mode to Assist or Danger to talk to it.';
  // The composer is two rows tall — the full reason wraps past it and the tail
  // of the sentence is clipped. Placeholder gets the one-line form; the full
  // sentence stays on the hover title, where there is room for it.
  const modeOffPlaceholder =
    t('deck.composerModeOffShort') || 'Orchestrator off — set Mode to Assist or Danger';
  // Collapsed state of the pty layout's report rail. Local by design: it is a
  // view preference, resets on remount, and needs no persistence. Default COLLAPSED: the TUI
  // is the conversation, the rail is the durable receipt you open when you want
  // it. Declared at the top level (not inside the pty branch) because
  // `brainPtyId` hydrates a frame after mount and can go null again mid-session
  // — the state must survive the layout swap.
  const [railCollapsed, setRailCollapsed] = useState(true);
  const [automationExpanded, setAutomationExpanded] = useState(false);
  // Moa's ⋯ menu opens Loop and Schedules: each bump is one click on the chip.
  const [loopRequest, setLoopRequest] = useState(0);
  const [schedulesRequest, setSchedulesRequest] = useState(0);
  const moaHeaderMenu = moa ? (
    <MoaHeaderMenu
      t={t}
      workspaceId={chatWorkspaceId}
      brainBusy={brainBusy}
      brainPtyId={brainPtyId}
      chatAvailable={!!brainPtyId && moa.chat != null}
      view={moa.view}
      onViewChange={moa.onViewChange}
      onOpenLoop={() => setLoopRequest((n) => n + 1)}
      onOpenSchedules={() => setSchedulesRequest((n) => n + 1)}
    />
  ) : null;
  // The `#` jump for the ledger rows. The sidebar used to own this link; the
  // deck's rows own it now, so the sidebar could shrink to one navigation line
  // (DESIGN.md Layout Contract). The ledger summary is built in main from the
  // ledger alone and has no channel ids, so the mapping comes from the task
  // store here.
  // Shallow-compared: the map is rebuilt on every mission poll tick, and a new
  // object identity for the same ids would re-render the whole deck every 15 s.
  const channelByTaskId = useStore(useShallow((s) => selectMissionChannelIds(s.missionsByWorkspace)));
  const openMissionChannel = useCallback((channelId: string) => {
    // The mission channel reads in Fleet, as the task's conversation.
    const st = useStore.getState();
    const task = findMission(st.missionsByWorkspace, (item) => item.missionChannelId === channelId);
    if (task) st.openTaskConversation(task.id);
  }, []);
  const jumpToTaskWorkspace = useCallback((taskWorkspaceId: string) => {
    useStore.getState().setActiveWorkspace(taskWorkspaceId);
  }, []);
  // Main pushed a ledger transition — a task the brain just started has a row
  // here before the 15 s mission poll knows its channel. Re-pull once so the
  // `#` lands with the row instead of up to fifteen seconds later.
  const onLedgerPush = useCallback(() => {
    if (!chatWorkspaceId) return;
    void useStore.getState().refreshMissions(chatWorkspaceId);
  }, [chatWorkspaceId]);
  const finishedExpanded = useStore((s) => s.deckLedgerFinishedExpanded);
  const setFinishedExpanded = useStore((s) => s.setDeckLedgerFinishedExpanded);
  // Delegated work makes the rail worth opening: the ledger panel says a task
  // is outstanding, and the rail is where its turn reports land. Once only —
  // after that the collapse is the operator's to own again, so a later
  // transition never re-opens a rail they just closed.
  const railOpenedForTasks = useRef(false);
  const onLedgerOpenCount = useCallback((openCount: number) => {
    if (openCount > 0 && !railOpenedForTasks.current) {
      railOpenedForTasks.current = true;
      setRailCollapsed(false);
    }
  }, []);
  const [decisionPending, setDecisionPending] = useState(false);
  // The pty layout's durable turn reports (pure selector — the store keeps the
  // full message array for the other vendors' bubble log).
  const railMessages = useMemo(() => selectReportRail(brainMessages), [brainMessages]);
  const railHasError = railMessages[railMessages.length - 1]?.status === 'error';

  // Stick-to-bottom autoscroll. `stickToBottom` flips off when the user
  // scrolls up to read history (>48px from the bottom) and back on when they
  // return; every content change while stuck scrolls to the newest message.
  // Streaming text-deltas re-render this component constantly, so the effect
  // runs per delta — a plain scrollTop write is cheap.
  const threadsRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const onThreadsScroll = useCallback(() => {
    const el = threadsRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);
  useEffect(() => {
    const el = threadsRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [brainMessages, threads]);
  // Switching workspaces swaps the whole thread (M1.5) — always land on the
  // newest message of the new conversation, whatever the old scroll state.
  useEffect(() => {
    stickToBottom.current = true;
    const el = threadsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatWorkspaceId]);

  // The orchestrator control bar — the persistent automation controls. Shared
  // by both layouts: below the thread in the bubble layout, merged into the pty
  // layout's single top row. `data-deck-control-bar` stays on it either way.
  const renderControlBar = (className: string, extra?: React.ReactNode): React.ReactElement | null =>
    chatWorkspaceId || quickActions.length > 0 ? (
      <div
        data-deck-control-bar
        // Moa: no always-on controls (they live in the header's ⋯ menu), so
        // the row only shows while an opened loop/schedules panel, the approval
        // countdown or a quick action has something in it.
        className={moa ? `${className} empty:hidden` : className}
      >
        {moa ? (
          <>
            <DeckLoopPanel t={t} workspaceId={chatWorkspaceId} cwd={activePaneCwd} hideTrigger openRequest={loopRequest} />
            <DeckSchedulesPanel t={t} workspaceId={chatWorkspaceId} workspaceName={workspaceName} hideTrigger openRequest={schedulesRequest} />
          </>
        ) : (
          <>
        {/* Mode = the single autonomy knob, always showing the current mode.
            모델 선택은 Agent 탭 인라인 드롭다운으로 이동(DESIGN.md Decisions
            Log 2026-07-20)했고, fan-out은 에이전트 툴바로 복귀했다. */}
        <AgentModeChipContainer t={t} workspaceId={chatWorkspaceId} />
        {!brainPtyId && <button type="button" className="wmux-agent-tools-toggle"
          aria-expanded={automationExpanded} onClick={() => setAutomationExpanded((value) => !value)}>
          {t('deck.automationTools')} <span aria-hidden="true">{automationExpanded ? '▴' : '▾'}</span>
        </button>}
        <div className="wmux-agent-automation" hidden={!brainPtyId && !automationExpanded}>
          <DeckLoopPanel t={t} workspaceId={chatWorkspaceId} cwd={activePaneCwd} />
          <DeckSchedulesPanel t={t} workspaceId={chatWorkspaceId} workspaceName={workspaceName} />
        </div>
        {/* Brain lifecycle — the last ALWAYS-ON control, so in the pty layout
            it lands next to Wake and the two "what is the brain doing" buttons
            sit together. Deliberately not disabled while a turn streams: a
            stuck turn is the main reason to want a fresh orchestrator. */}
        {chatWorkspaceId && (
          <NewSessionChipContainer t={t} workspaceId={chatWorkspaceId} busy={brainBusy} />
        )}
          </>
        )}
        {/* How long a displayed approval has before it auto-rejects. Renders
            nothing until a pending record carries a deadline. */}
        <DeckApprovalCountdown t={t} workspaceId={chatWorkspaceId} />
        {extra}

        {/* Reboot-recovery re-entry (post-reboot only) — the canned one-click
            recovery. Flows inline after the always-on controls (no ml-auto:
            the dock is narrow enough that the bar wraps, and pushing this to
            the trailing edge stranded it alone on its own line with a gap).
            Neutral at rest, accent on hover (the DESIGN.md AI-action
            grammar), disabled while a turn streams. */}
        {/* Not in Moa's panel: each recovered pane offers its own resume pill. */}
        {!moa && quickActions.some((action) => action.id !== 'recover-fleet' || recoveryPanes.length === 0 || !!brainPtyId) && (
          <div data-deck-quick-actions className="flex flex-wrap gap-1.5">
            {quickActions.filter((action) => action.id !== 'recover-fleet' || recoveryPanes.length === 0 || !!brainPtyId).map((action) => (
              <button
                key={action.id}
                type="button"
                data-deck-quick-action
                data-action-id={action.id}
                disabled={brainBusy}
                onClick={() => onQuickAction?.(action)}
                className={ACTION_CHIP}
                {...tokenAttrs('textMain', 'text')}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    ) : null;

  // ── pty layout: the Claude Code TUI IS the dock ──────────────────────────
  //
  // The `claude-pty` orchestrator types into its own terminal, so the dock
  // stops being a chat surface: one compressed control row on top, the TUI
  // taking everything between, and a collapsed report rail as the footer. No
  // composer — the TUI is the only input path (the other vendors keep theirs
  // in the branch below, where it is their ONLY input path). No Stop button
  // either: ESC in the TUI is the interrupt.
  if (brainPtyId) {
    // Moa mode with a transcript source opens on the chat view; without one
    // (no Moa, an older main) the terminal is the only view, as before.
    const moaChatAvailable = !!moa && moa.chat != null;
    const showTerminal = !moaChatAvailable || moa!.view === 'terminal';
    return (
      <div
        data-commander-view
        className="flex flex-col flex-1 min-h-0 bg-[var(--bg-mantle)]"
        {...tokenAttrs('bgMantle', 'bg')}
      >
        {/* Moa's chat view carries its top inside the chat's own scroll. Over
            the terminal it is capped with its own scroll, so pending decisions
            can never squeeze the TUI to nothing. */}
        {showTerminal && moa?.top && (
          <div data-moa-pty-top className="shrink-0 max-h-[30%] overflow-y-auto">{moa.top}</div>
        )}
        {/* Delegated tasks, pinned above everything: the ledger is the one
            state the brain, the workers and the Stop gate share. */}
        {!moa && (
          <DeckLedgerPanel
            t={t}
            workspaceId={chatWorkspaceId}
            onOpenCountChange={onLedgerOpenCount}
            channelByTaskId={channelByTaskId}
            onOpenChannel={openMissionChannel}
            onJumpToTaskWorkspace={jumpToTaskWorkspace}
            finishedExpanded={finishedExpanded}
            onToggleFinished={setFinishedExpanded}
            onLedgerPush={onLedgerPush}
          />
        )}
        {/* One control row: the Fleet roster and the automation controls. Moa's
            panel draws no roster: the Fleet page lists every pane and Settings
            binds roles. */}
        {!moa && fleetSlot}
        {moaHeaderMenu}
        {renderControlBar(
          'flex flex-wrap items-center gap-1 px-3 py-1.5 border-b border-[var(--stroke)] shrink-0',
          // Moa: Wake and the view switch are in the header's ⋯ menu.
          moa ? undefined :
          // Wake button — pty-layout only. With no composer, this is the
          // human's one-click "take a turn now"; the bubble layout's composer
          // already covers it. Disabled mid-turn: the busy reject would be the
          // only outcome. Same visual grammar as a quick action (neutral at
          // rest, accent on hover).
          <>
          {chatWorkspaceId ? (
            <button
              type="button"
              data-commander-wake-now
              disabled={brainBusy}
              onClick={() => {
                void window.electronAPI?.deck?.wake?.(chatWorkspaceId).catch(() => {
                  /* best-effort — a rejected wake just means the brain is busy */
                });
              }}
              className={ACTION_CHIP}
              {...tokenAttrs('textMain', 'text')}
            >
              {t('deck.wakeNow') || 'Wake'}
            </button>
          ) : null}
          </>,
        )}

        {/* The TUI — the hero of this layout, taking every pixel the fixed rows
            leave. It has no collapse toggle anymore: collapsing the dock's only
            input surface has no meaning, and the rail below it is what the
            operator opens instead. */}
        {moaNotice && <div className="pt-2">{moaNotice}</div>}
        {/* Moa's "Remember this?" card waits on the operator, so it sits at the
            top of the panel, above the TUI, never inside the collapsed rail.
            It is Moa's own: it shows whichever workspace the deck is on. When
            Moa owns the panel it is the first row of Waiting on you instead. */}
        {!moa && <MoaMemoryCard t={t} className="px-3 pt-2 shrink-0 max-h-[55%] min-h-0 flex flex-col overflow-y-auto" />}
        {/* The brain pty is embedded here and nowhere else; in Moa's chat view
            it is not mounted at all until the operator asks for the terminal. */}
        {showTerminal ? (
          <div className="flex flex-col flex-1 min-h-0 px-3 py-2">
            <BrainTerminalEmbed ptyId={brainPtyId} />
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0" data-moa-chat-region>
            {moa!.chat}
          </div>
        )}

        {/* Report rail — the durable footer. The TUI scrolls its own
            conversation away, so closed turns (and the decision gate, and the
            briefing) stay reachable here. Collapsed by default; the header
            carries the count, a busy dot, and an error affordance so a
            collapsed rail never hides something that needs the operator. */}
        {/* Moa's chat view IS the conversation (and says when Moa is working),
            so the rail would only repeat it. */}
        {showTerminal && <div
          className="border-t border-[var(--stroke)] shrink-0"
        >
          <button
            type="button"
            data-commander-report-rail-toggle
            onClick={() => setRailCollapsed((v) => !v)}
            className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-[color-mix(in_srgb,var(--text-main)_45%,transparent)] hover:text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] transition-colors ${FOCUS_RING}`}
            {...tokenAttrs('textMain', 'text')}
          >
            <span aria-hidden>{railCollapsed ? '▸' : '▾'}</span>
            <span
              className={railHasError ? 'text-[var(--accent-red)]' : undefined}
              {...(railHasError ? tokenAttrs('danger', 'text') : {})}
            >
              {(t('deck.reportRail') || 'Moa\'s updates {count}').replace(
                '{count}',
                String(railMessages.length),
              )}
            </span>
            {decisionPending && (
              <span data-commander-rail-decision>
                {` · ${t('deck.reportRailDecision') || '1 decision'}`}
              </span>
            )}

            {/* Slim busy indicator: automation-driven turns (heartbeat, loop,
                schedule) must stay visible now that the busy bar is gone. */}
            {brainBusy && (
              <span data-commander-busy className="flex items-center gap-1.5 ml-auto">
                <span
                  aria-hidden="true"
                  className="inline-block w-2 h-2 rounded-full border border-[var(--accent)] border-t-transparent animate-spin"
                />
                <span>{t('deck.commanderThinking') || 'Moa is working…'}</span>
              </span>
            )}
          </button>
          <div
            data-commander-threads
            className={
              railCollapsed
                ? 'hidden'
                : 'max-h-[30vh] overflow-y-auto px-4 pb-3 space-y-3'
            }
          >
            {!moa && (
              <DeckBriefingCard
                workspaceId={chatWorkspaceId}
                t={t}
                onJumpToPane={onJumpToPane}
                resolvePtyPane={resolvePtyPane}
                channelsUnread={channelsUnread}
                onJumpToChannels={onJumpToChannels}
                fleetSignature={fleetSignature}
              />
            )}
            {!moa && (
              <DeckDecisionCard
                workspaceId={chatWorkspaceId}
                onPendingChange={setDecisionPending}
                t={t}
              />
            )}
            {railMessages.map((m, i) => (
              <Fragment key={m.id}>
                {isVendorBoundary(railMessages[i - 1], m) && m.vendor && (
                  <CommanderVendorBreak vendor={m.vendor} t={t} />
                )}
                <CommanderBrainItem message={m} onJumpToPane={onJumpToPane} t={t} />
              </Fragment>
            ))}
          </div>
        </div>}
      </div>
    );
  }

  return (
    <div
      data-commander-view
      data-commander-layout="chat"
      // Mantle, not base: the deck is chrome (one panel family with the
      // sidebar and the dock shell around it — DESIGN.md layout contract);
      // painting base here made the thread read as a detached page.
      className="flex flex-col flex-1 min-h-0 bg-[var(--bg-mantle)]"
      {...tokenAttrs('bgMantle', 'bg')}
    >
      {/* Delegated tasks, pinned above the roster (see the pty layout above). */}
      {!moa && (
        <DeckLedgerPanel
          t={t}
          workspaceId={chatWorkspaceId}
          onOpenCountChange={onLedgerOpenCount}
          channelByTaskId={channelByTaskId}
          onOpenChannel={openMissionChannel}
          onJumpToTaskWorkspace={jumpToTaskWorkspace}
          finishedExpanded={finishedExpanded}
          onToggleFinished={setFinishedExpanded}
          onLedgerPush={onLedgerPush}
        />
      )}
      {/* P2① — Fleet roster pinned above the thread (does not scroll with it).
          Not in Moa's panel (see the pty layout above). */}
      {!moa && fleetSlot}
      {/* Message list — the brain conversation (Phase 2) plus the Phase 1
          @-mention fan-out threads. Chat convention: sticks to the bottom
          (newest message) as content streams in, unless the user scrolled up
          to read history — then it stays put until they return to the bottom. */}
      <div
        ref={threadsRef}
        onScroll={onThreadsScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3"
        data-commander-threads
      >
        {/* Moa: Waiting on you, delegated work and the briefing scroll with the
            conversation, one column (the negative margin undoes this list's
            padding: the sections bring their own). */}
        {moa?.top && <div className="-mx-4 -mt-3" data-moa-top>{moa.top}</div>}
        {/* No empty-state paragraph. It said "Ask the orchestrator to run your
            agents, or @mention agent panes to command them directly" — three
            centred lines saying what the composer's own placeholder ("Tell the
            orchestrator, or @mention panes…") says one row below, inside the box
            you would type it into. One instruction, at the point of use. */}

        {/* Reboot-recovery greeting card (P3b) — shown while recoverable panes
            exist and the card wasn't dismissed. One click sends the canned
            recovery prompt to the brain. */}
        {/* Not in Moa's panel: each recovered pane offers its own resume pill. */}
        {!moa && recoveryPanes.length > 0 && (
          <div
            data-commander-recovery
            className="rounded-lg px-4 py-3 space-y-2 bg-[var(--selection-subtle)]"
          >
            <div
              className="text-[13px] font-semibold text-[var(--text-main)] leading-relaxed"
              {...tokenAttrs('textMain', 'text')}
            >
              {(t('deck.recoveryTitle') ||
                '{count} agent pane(s) were running before the last shutdown and can be recovered.'
              ).replace('{count}', String(recoveryPanes.length))}
            </div>
            <div
              className="text-[11px] font-mono text-[var(--text-sub)] leading-relaxed"
              {...tokenAttrs('textSub', 'text')}
            >
              {recoveryPanes.map((p) => p.label).join(' · ')}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-recovery-run
                disabled={brainBusy}
                onClick={onRecoverFleet}
                className={ACTION_CHIP}
              >
                {t('deck.recoveryRun') || 'Recover agents'}
              </button>
              <button
                type="button"
                data-recovery-dismiss
                onClick={onDismissRecovery}
                className={`h-[26px] px-2 rounded-md text-[12px] text-[color-mix(in_srgb,var(--text-main)_50%,transparent)] hover:bg-[var(--hover-fill)] hover:text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] transition-colors ${FOCUS_RING}`}
                {...tokenAttrs('textMain', 'text')}
              >
                {t('deck.recoveryDismiss') || 'Dismiss'}
              </button>
            </div>
          </div>
        )}

        {/* D1 briefing — the deterministic "welcome home" summary. Frames the
            thread ABOVE the decision card; neutral chrome (amber stays reserved
            for the decision card + running dots). Self-contained + renders null
            when the config is disabled or there is nothing to brief. */}
        {/* Moa's top already carries its briefing. */}
        {!moa && (
          <DeckBriefingCard
            workspaceId={chatWorkspaceId}
            t={t}
            onJumpToPane={onJumpToPane}
            resolvePtyPane={resolvePtyPane}
            channelsUnread={channelsUnread}
            onJumpToChannels={onJumpToChannels}
            fleetSignature={fleetSignature}
          />
        )}

        {/* Decision gate — a brain-raised decision blocking the loop until the
            operator answers. Self-contained (hydrates from the durable store, so
            it survives a reboot); renders null unless a decision is pending for
            this workspace. */}
        {!moa && <DeckDecisionCard workspaceId={chatWorkspaceId} t={t} />}
        {!moa && <MoaMemoryCard t={t} />}

        {/* Brain conversation — the normalized bubbles + tool chips. The
            `claude-pty` vendor never reaches here (it returns the TUI layout
            above); every other vendor renders its whole turn log. */}
        {brainMessages.map((m, i) => (
          <Fragment key={m.id}>
            {isVendorBoundary(brainMessages[i - 1], m) && m.vendor && (
              <CommanderVendorBreak vendor={m.vendor} t={t} />
            )}
            <CommanderBrainItem message={m} onJumpToPane={onJumpToPane} t={t} />
          </Fragment>
        ))}

        {/* Fan-out threads — "dispatch + replies" groups (Phase 1). */}
        {threads.map((thread, idx) => (
          <CommanderThreadItem
            key={thread.dispatch ? `d-${thread.dispatch.seq}` : `r-${idx}`}
            thread={thread}
            onJumpToPane={onJumpToPane}
            resolvePtyPane={resolvePtyPane}
            workspaceName={workspaceName}
            t={t}
          />
        ))}
      </div>

      {/* Busy bar — spinner + interrupt while a brain turn streams. */}
      {brainBusy && (
        <div
          data-commander-busy
          className="flex items-center gap-2 px-4 py-1.5 border-t border-[var(--stroke)] shrink-0"
        >
          <span
            aria-hidden="true"
            className="inline-block w-3 h-3 rounded-full border-2 border-[var(--accent-blue)] border-t-transparent animate-spin"
          />
          <span
            className="text-[12px] text-[color-mix(in_srgb,var(--text-main)_50%,transparent)] flex-1"
            {...tokenAttrs('textMain', 'text')}
          >
            {t('deck.commanderThinking') || 'Moa is working…'}
          </span>
          <button
            type="button"
            data-commander-interrupt
            onClick={onInterrupt}
            // Stop is the solid primary control, never a colour.
            className={`h-[26px] px-2 rounded-md text-[12px] font-medium bg-[var(--primary-fill)] text-[var(--primary-ink)] hover:bg-[color-mix(in_srgb,var(--primary-fill)_90%,transparent)] transition-colors ${FOCUS_RING}`}
          >
            {t('deck.commanderStop') || 'Stop'}
          </button>
        </div>
      )}

      {/* Orchestrator control bar — the persistent automation controls, right
          above the composer where the hand already is. Mode is the master
          autonomy switch (off/assist/auto; 'off' even tears down
          running loops + schedules), so it anchors the left and a hairline
          separates it from the two automations it governs — Loop and Schedules.
          The reboot-recovery re-entry chip, when present, trails on the right so
          it never crowds the always-on controls. Each control's container
          self-hides when its preload API is absent, so pure jsdom parent tests
          are unaffected. */}
      {moaHeaderMenu}
      {renderControlBar(
        'flex flex-wrap items-center gap-1 px-3 py-1.5 shrink-0',
      )}

      {/* Composer — the SAME pure shell the channel composer uses. No @mention →
            the Commander brain; @mention → the Phase 1 fan-out. Disabled while a
            brain turn streams (the one-turn-at-a-time contract) AND while the
            workspace's mode is `off`, where there is no orchestrator to talk to
            at all — main refuses those sends with `mode_off`, so leaving the box
            live would only produce a silent rejection. The title says which of
            the two it is, and how to undo the `off` case. */}
      {moaNotice}
      <div
        className="px-1.5 pb-1.5 shrink-0"
        title={moaOff ? t('deck.moaOff') : modeOff ? modeOffReason : undefined}
        data-commander-composer
        data-mode-off={modeOff ? 'true' : undefined}
        data-moa-off={moaOff ? 'true' : undefined}
      >
        <ComposerContent
          channelId={COMMANDER_CHANNEL_NAME}
          onSubmit={onSubmit}
          mentionCandidates={mentionCandidates}
          disabled={brainBusy || modeOff || moaOff}
          placeholder={
            // Moa off comes first: main refuses with moa_off before it reads
            // the workspace's mode.
            moaOff
              ? t('deck.moaOffShort')
              : modeOff
              ? modeOffPlaceholder
              // Moa's panel before its brain is up: the same words as its chat.
              : moa
              ? t('moa.panel.placeholder')
              : t('deck.commanderPlaceholder') || 'Tell the orchestrator, or @mention panes…'
          }
          hint={moa ? t('chat.inputHint') : undefined}
          t={t}
        />
      </div>
    </div>
  );
}

/** One brain turn message: a human prompt bubble, or an assistant response
 *  (streamed prose + the tool chips it fired). Tool chips that targeted a pane
 *  carry a jump button — every action in the chat is one click from its
 *  evidence (the litmus test). */
/**
 * The break between two brains' turns. Switching vendor mid-session leaves one
 * thread holding turns from two brains that share no transcript and no session,
 * so the log states the change rather than letting the bubbles run together.
 */
function CommanderVendorBreak({
  vendor,
  t,
}: {
  vendor: NonNullable<DeckBrainMessage['vendor']>;
  t: (key: string) => string;
}): React.ReactElement {
  const key = vendorTagKey(vendor);
  return (
    <div
      data-commander-vendor-break
      data-vendor={vendor}
      className="flex items-center gap-2 pt-1"
    >
      <span className="flex-1 h-px bg-[var(--stroke)]" aria-hidden="true" />
      <span
        className="text-[10px] font-mono uppercase tracking-[0.06em] text-[color-mix(in_srgb,var(--text-main)_45%,transparent)]"
        {...tokenAttrs('textMuted', 'text')}
      >
        {(t('deck.vendorSwitched') || 'now: {brain}').replace(
          '{brain}',
          (key && t(key)) || vendor,
        )}
      </span>
      <span className="flex-1 h-px bg-[var(--stroke)]" aria-hidden="true" />
    </div>
  );
}

function CommanderBrainItem({
  message,
  onJumpToPane,
  t,
}: {
  message: DeckBrainMessage;
  onJumpToPane: (workspaceId: string, paneId: string) => void;
  t: (key: string) => string;
}): React.ReactElement {
  const isUser = message.role === 'user';
  // An event-woken turn's "user" side is machine-generated (the coalescer's
  // [pane-events] flush prompt) — rendering it as a full bubble reads as a
  // wall of text the human never typed. Collapse it to a compact wake badge
  // with an expander for the raw evidence.
  if (isUser && message.text.startsWith('[pane-events]')) {
    return <CommanderWakeBadge message={message} t={t} />;
  }
  // Chat convention (owner call): YOUR messages sit right-aligned in a lifted
  // bubble with no author label (right = you, always); the orchestrator's
  // prose stays left, chrome-free. Both carry a local HH:MM timestamp.
  if (isUser) {
    return (
      <div
        data-commander-brain-message
        data-role="user"
        className="flex flex-col items-end gap-0.5"
      >
        <div
          className={USER_BUBBLE}
          data-commander-brain-text
          {...tokenAttrs('textMain', 'text')}
        >
          {message.text}
        </div>
        {message.ts && (
          <span className={`${TIME} pr-1`} {...tokenAttrs('textMain', 'text')}>
            {formatChatTime(message.ts)}
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      data-commander-brain-message
      data-role={message.role}
      className="flex flex-col gap-1"
    >
      <span className="flex items-baseline gap-2">
        <span
          className="text-[12px] font-bold text-[var(--text-main)]"
          {...tokenAttrs('textMain', 'text')}
        >
          {t('deck.commander') || 'Orchestrator'}
        </span>
        {/* Which brain wrote this turn. Absent on turns from before the stamp
            existed — an unstamped turn shows no tag rather than a guess. */}
        {message.vendor && (
          <span
            data-commander-brain-vendor
            data-vendor={message.vendor}
            className="text-[10px] font-mono uppercase tracking-[0.06em] text-[color-mix(in_srgb,var(--text-main)_45%,transparent)]"
            {...tokenAttrs('textMuted', 'text')}
          >
            {(vendorTagKey(message.vendor) && t(vendorTagKey(message.vendor))) || message.vendor}
          </span>
        )}
        {message.ts && (
          <span className={TIME} {...tokenAttrs('textMain', 'text')}>
            {formatChatTime(message.ts)}
          </span>
        )}
      </span>
      {message.text && (
        // Assistant prose renders as markdown (headings/lists/code from the
        // model); the human's own message (the branch above) stays literal —
        // what they typed is what they see.
        <div
          className="text-[13px] leading-relaxed text-[var(--text-main)] break-words"
          data-commander-brain-text
          {...tokenAttrs('textMain', 'text')}
        >
          {renderBrainMarkdown(message.text)}
        </div>
      )}
      {/* Tool calls — flat monospace LOG LINES in call order (design decision
          3: hierarchy from typography, not chip boxes). */}
      {message.tools && message.tools.length > 0 && (
        <div className="flex flex-col gap-0.5 pt-1" data-commander-brain-tools>
          {message.tools.map((chip, i) => (
            <CommanderToolChip key={chip.toolId ?? `${chip.name}-${i}`} chip={chip} onJumpToPane={onJumpToPane} t={t} />
          ))}
        </div>
      )}
      {message.status === 'error' && message.errorText && (
        <div
          role="alert"
          data-commander-brain-error
          className="text-[11px] text-[var(--accent-red)]"
          {...tokenAttrs('danger', 'text')}
        >
          {message.errorText}
        </div>
      )}
      {/* M3: surfaced subscription rate-limit notices for this turn. Amber (the
          "alive + focus" cue) — a hard `rejected` is the one the operator must
          act on; `allowed_warning` is a quieter heads-up. */}
      {message.limitNotices && message.limitNotices.length > 0 && (
        <div className="flex flex-col gap-0.5 pt-1" data-commander-brain-limits>
          {message.limitNotices.map((notice, i) => (
            <div
              // Key includes `status`: escalation intentionally keeps BOTH an
              // allowed_warning AND a rejected for the same account/window/reset
              // episode, so omitting status collided their keys (Codex review).
              key={`${notice.status}-${notice.accountId ?? ''}-${notice.window ?? ''}-${notice.resetsAtMs ?? i}`}
              role="status"
              data-limit-status={notice.status}
              className="text-[11px] text-[var(--accent-yellow)]"
              {...tokenAttrs('warning', 'text')}
            >
              {formatLimitNotice(notice, t)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One line of copy for a surfaced rate-limit notice, fully routed through the
 *  locale system (no hard-coded sentences — 3-way review). `rejected` = hard
 *  wall; `allowed_warning` = approaching. Account name, utilization, and reset
 *  countdown are optional fragments blanked when absent. */
function formatLimitNotice(notice: DeckLimitNotice, t: ReturnType<typeof useT>): string {
  const window = notice.window ? notice.window.replace(/_/g, '-') : t('deck.limit.window');
  const on = notice.accountName ? t('deck.limit.onAccount', { account: notice.accountName }) : '';
  const reset = notice.resetsAtMs != null ? ` — ${formatResetCountdown(notice.resetsAtMs, t)}` : '';
  if (notice.status === 'rejected') {
    return t('deck.limit.rejected', { window, on, reset });
  }
  const util = notice.utilization != null ? t('deck.limit.utilSuffix', { util: Math.round(notice.utilization) }) : '';
  return t('deck.limit.approaching', { window, on, util, reset });
}

/** "resets in 2h13m" / "resets soon" from an epoch-ms reset time. Past/near → a
 *  soft "soon" rather than a negative countdown. Both wrappers are localized. */
function formatResetCountdown(resetsAtMs: number, t: ReturnType<typeof useT>): string {
  const deltaMs = resetsAtMs - Date.now();
  if (deltaMs <= 60_000) return t('deck.limit.resetsSoon');
  const mins = Math.round(deltaMs / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const rel = h > 0 ? `${h}h${m > 0 ? `${m}m` : ''}` : `${m}m`;
  return t('deck.limit.resetsIn', { rel });
}

/** The compact rendition of an event-woken turn's machine-generated prompt:
 *  one muted mono line ("woken by agent events · N") with an expander for the
 *  raw [pane-events] block. Right-aligned like a user message (it occupies the
 *  turn's user slot) but visually a system marker, not a human bubble. */
function CommanderWakeBadge({
  message,
  t,
}: {
  message: DeckBrainMessage;
  t: (key: string) => string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  // One `seq=` line per coalesced event — the badge's count.
  const count = (message.text.match(/^\s+seq=/gm) ?? []).length;
  return (
    <div data-commander-wake-badge className="flex flex-col items-end gap-0.5">
      <div className="flex items-baseline gap-2">
        <span
          className="text-[11px] font-mono text-[var(--text-muted)]"
          {...tokenAttrs('textMuted', 'text')}
        >
          » {t('deck.wokenByEvents') || 'Woken by agent events'}
          {count > 0 ? ` · ${count}` : ''}
        </span>
        <button
          type="button"
          data-commander-wake-toggle
          onClick={() => setExpanded((v) => !v)}
          className={`text-[11px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text-sub)] ${FOCUS_RING}`}
          {...tokenAttrs('textMuted', 'text')}
        >
          {expanded
            ? t('deck.wokenHide') || 'Hide'
            : t('deck.wokenShow') || 'Details'}
        </button>
        {message.ts && (
          <span
            className={TIME}
            {...tokenAttrs('textMain', 'text')}
          >
            {formatChatTime(message.ts)}
          </span>
        )}
      </div>
      {expanded && (
        <pre
          data-commander-wake-raw
          className="max-w-[85%] overflow-x-auto rounded-lg px-3 py-1.5 bg-[color-mix(in_srgb,var(--text-main)_5%,transparent)] text-[11px] font-mono leading-relaxed text-[var(--text-sub)] whitespace-pre-wrap break-words"
          {...tokenAttrs('textSub', 'text')}
        >
          {message.text}
        </pre>
      )}
    </div>
  );
}

/** A single tool call rendered as a flat MONOSPACE LOG LINE (the mock's
 *  `.call` row): a ✓/✕ result glyph (● while running), the tool name, a
 *  truncated input summary, and, when the tool targeted a pane, a right-
 *  aligned jump link. No box, no decorative dot — the glyph IS the status. */
function CommanderToolChip({
  chip,
  onJumpToPane,
  t,
}: {
  chip: DeckToolChip;
  onJumpToPane: (workspaceId: string, paneId: string) => void;
  t: (key: string) => string;
}): React.ReactElement {
  const glyph = chip.ok === undefined ? '●' : chip.ok ? '✓' : '✕';
  const glyphColor =
    chip.ok === undefined
      ? 'var(--text-muted)'
      : chip.ok
        ? 'var(--accent-green)'
        : 'var(--accent-red)';
  const canJump = !!chip.paneId && !!chip.workspaceId;
  return (
    <div
      data-commander-tool-chip
      data-tool-name={chip.name}
      {...(canJump ? { 'data-pane-id': chip.paneId, 'data-workspace-id': chip.workspaceId } : {})}
      className="flex items-baseline gap-2 text-[11px] font-mono text-[var(--text-muted)] min-w-0"
      {...tokenAttrs('textMuted', 'text')}
    >
      <span aria-hidden="true" className="shrink-0" style={{ color: glyphColor }}>
        {glyph}
      </span>
      <span className="text-[var(--text-sub)] shrink-0" {...tokenAttrs('textSub', 'text')}>
        {chip.name}
      </span>
      {chip.inputSummary && <span className="truncate">{chip.inputSummary}</span>}
      {canJump && (
        <button
          type="button"
          data-commander-tool-jump
          onClick={() => onJumpToPane(chip.workspaceId!, chip.paneId!)}
          className={`ml-auto shrink-0 font-sans text-[11px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text-sub)] ${FOCUS_RING}`}
          {...tokenAttrs('textMuted', 'text')}
        >
          {t('deck.jumpToPane') || 'Jump to this pane'}
        </button>
      )}
    </div>
  );
}

/** One "dispatch + replies" group. The dispatch shows the target pane chips
 *  (from its @mentions) as clickable jump affordances; each reply shows its
 *  agent-pane author (also a jump when the pane is still live). */
function CommanderThreadItem({
  thread,
  onJumpToPane,
  resolvePtyPane,
  workspaceName,
  t,
}: {
  thread: CommanderThread;
  onJumpToPane: (workspaceId: string, paneId: string) => void;
  resolvePtyPane: (ptyId: string) => { workspaceId: string; paneId: string } | null;
  workspaceName: (workspaceId: string) => string | undefined;
  t: (key: string) => string;
}): React.ReactElement {
  const { dispatch, replies } = thread;
  return (
    <div data-commander-thread className="flex flex-col gap-1.5">
      {dispatch && (
        <div data-commander-dispatch className="flex flex-col items-end gap-0.5">
          {/* Chat convention: your dispatch sits right-aligned in a bubble, no
              author label (right = you). Local HH:MM below (was UTC slice). */}
          <div
            className={USER_BUBBLE}
            data-commander-dispatch-text
            {...tokenAttrs('textMain', 'text')}
          >
            {renderMessageBody(dispatch.text, dispatch.mentions)}
          </div>
          <span
            className={`${TIME} pr-1`}
            {...tokenAttrs('textMain', 'text')}
          >
            {formatChatTime(new Date(dispatch.postedAt).getTime())}
          </span>
          {/* Target pane chips — the fan-out recipients, clickable to jump. */}
          {dispatch.mentions && dispatch.mentions.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5 justify-end" data-commander-targets>
              {dispatch.mentions.map((m) => (
                <button
                  key={`${m.workspaceId}:${m.paneId ?? m.name}`}
                  type="button"
                  data-commander-target-chip
                  data-workspace-id={m.workspaceId}
                  data-pane-id={m.paneId}
                  disabled={!m.paneId}
                  onClick={() => m.paneId && onJumpToPane(m.workspaceId, m.paneId)}
                  title={t('deck.jumpToPane') || 'Jump to this pane'}
                  className={`h-[22px] px-1.5 rounded-md text-[11px] text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] bg-[var(--selection)] hover:bg-[var(--selection-hover)] hover:text-[var(--text-main)] transition-colors disabled:opacity-50 disabled:cursor-default ${FOCUS_RING}`}
                  {...tokenAttrs('textMain', 'text')}
                >
                  @{m.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Replies — indented under the dispatch. */}
      {replies.length > 0 && (
        <div className="flex flex-col gap-2 pl-3 border-l-2 border-[var(--stroke)]" data-commander-replies>
          {replies.map((m) => {
            const author = formatChannelAuthor(m, workspaceName);
            const pane = m.senderPtyId ? resolvePtyPane(m.senderPtyId) : null;
            return (
              <div key={`${m.channelId}:${m.seq}`} data-commander-reply data-seq={m.seq} className="flex flex-col gap-0.5">
                <div className="flex items-baseline gap-2">
                  <span
                    aria-hidden="true"
                    className="self-center inline-block w-2 h-2 shrink-0 rounded-[1px]"
                    style={{
                      backgroundColor: `hsl(${author.hue} 55% 62%)`,
                      border: '1px solid var(--border-soft)',
                    }}
                  />
                  {pane ? (
                    <button
                      type="button"
                      data-commander-reply-author
                      onClick={() => onJumpToPane(pane.workspaceId, pane.paneId)}
                      title={t('deck.jumpToPane') || 'Jump to this pane'}
                      className={`text-[12px] font-bold text-[var(--text-main)] hover:text-[var(--accent-blue)] hover:underline ${FOCUS_RING}`}
                      {...tokenAttrs('textMain', 'text')}
                    >
                      {author.primary}
                    </button>
                  ) : (
                    <span
                      className="text-[12px] font-bold text-[var(--text-main)]"
                      data-commander-reply-author
                      {...tokenAttrs('textMain', 'text')}
                    >
                      {author.primary}
                    </span>
                  )}
                  {author.chip && (
                    <span className="text-[11px] text-[var(--text-sub)]" {...tokenAttrs('textSub', 'text')}>
                      {author.chip}
                    </span>
                  )}
                  <span
                    className={TIME}
                    {...tokenAttrs('textMain', 'text')}
                  >
                    {formatChatTime(new Date(m.postedAt).getTime())}
                  </span>
                </div>
                <div
                  className="text-[13px] leading-relaxed text-[var(--text-main)] whitespace-pre-wrap break-words"
                  data-commander-reply-text
                  {...tokenAttrs('textMain', 'text')}
                >
                  {renderMessageBody(m.text, m.mentions)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Container ─────────────────────────────────────────────────────────────────

/** Store-connected Commander view: resolves the #commander thread + fleet-wide
 *  @-candidates and wires the fan-out send + pane jumps. */
/** The active workspace's agent mode, read from main and refreshed whenever the
 *  mode chip writes a new one (deckModeBus). Null while unknown — a preload
 *  without the bridge, or before the first read resolves — and a null is
 *  deliberately NOT treated as `off`: main is the enforcement, and guessing
 *  `off` here would lock the composer on every surface that has no bridge. */
function useActiveAgentMode(workspaceId: string): AgentMode | null {
  const [mode, setMode] = useState<AgentMode | null>(null);
  useEffect(() => {
    const api = window.electronAPI?.deck?.mode;
    if (!api || !workspaceId) {
      setMode(null);
      return;
    }
    let cancelled = false;
    const read = (): void => {
      api
        .get(workspaceId)
        .then((r) => { if (!cancelled) setMode(r.mode ?? null); })
        .catch(() => { if (!cancelled) setMode(null); });
    };
    read();
    const off = onAgentModeChanged(read);
    return () => {
      cancelled = true;
      off();
    };
  }, [workspaceId]);
  return mode;
}

export interface CommanderViewProps {
  /** The workspace whose brain this view talks to (Moa's HQ, or the active
   *  workspace when there is no HQ). Every conversation read and write uses
   *  it: thread, brain pty, decision card, briefing, controls, send, wake,
   *  interrupt. */
  chatWorkspaceId: string;
  /** The workspace the operator is looking at, for context only: the fleet
   *  summary a send carries, the active pane's cwd, the recovery card. */
  viewedWorkspaceId: string;
  /** Moa mode: build the panel's top section and the transcript chat. The
   *  chat gets this view's send and interrupt so a typed message takes the
   *  same path as every other brain send. */
  moa?: {
    top?: React.ReactNode;
    renderChat?: (args: {
      brainPtyId: string;
      busy: boolean;
      onSend: (text: string) => Promise<{ ok: boolean }>;
      onInterrupt: () => void;
      onTerminal: () => void;
      /** Waiting on you, delegated work and the briefing: drawn at the top of
       *  the chat's own scroll, so the panel scrolls as one column. */
      top?: React.ReactNode;
    }) => React.ReactNode;
  };
}

export function CommanderView({ chatWorkspaceId: chatWorkspaceIdProp, viewedWorkspaceId, moa: moaSlots }: CommanderViewProps): React.ReactElement {
  const t = useT();
  const channels = useStore((s) => s.channels);
  // D1 briefing: the unread-channels overlay + a jump to the Channels tab. The
  // count is a renderer-only augmentation (main can't see channel unread).
  const channelUnread = useStore((s) => s.channelUnread);
  const channelsUnread = useMemo(() => sumUnread(channelUnread), [channelUnread]);
  const setActiveDeckTab = useStore((s) => s.setActiveDeckTab);
  const onJumpToChannels = useCallback(() => setActiveDeckTab('channels'), [setActiveDeckTab]);
  const workspaces = useStore((s) => s.workspaces);
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const paneLabel = useStore((s) => s.paneLabel);
  const paneRole = useStore((s) => s.paneRole);
  const createChannelDaemon = useStore((s) => s.createChannelDaemon);
  const inviteChannelDaemon = useStore((s) => s.inviteChannelDaemon);
  const postMessageDaemon = useStore((s) => s.postMessageDaemon);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const setActivePane = useStore((s) => s.setActivePane);
  const pushToast = useStore((s) => s.pushToast);
  const company = useStore((s) => s.company);
  // Commander brain (Phase 2, per-workspace M1.5): the deck shows ONE
  // workspace's orchestrator thread — Moa's HQ, or (no HQ) the active
  // workspace, so switching workspace tabs switches the conversation. Other
  // workspaces' turns keep streaming into their own threads via
  // useDeckStream's envelope routing.
  const chatWorkspaceId = chatWorkspaceIdProp || '';
  // 활성 pane의 라이브 cwd(OSC 7 추적 surface.cwd) — 루프 모달의 스킬 카탈로그
  // 스캔 기준. 트리 워크는 셀렉터 안에서 원시 문자열로 수렴시켜 리렌더 최소화.
  const activePaneCwd = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === viewedWorkspaceId);
    if (!ws) return '';
    const findLeaf = (pane: import('../../../shared/types').Pane): import('../../../shared/types').PaneLeaf | null => {
      if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
      for (const child of pane.children) {
        const found = findLeaf(child);
        if (found) return found;
      }
      return null;
    };
    const leaf = findLeaf(ws.rootPane);
    const surface = leaf?.surfaces.find((sf) => sf.id === leaf.activeSurfaceId);
    return surface?.cwd || ws.profile?.startupCwd || '';
  });
  const brainThread =
    useStore((s) => (chatWorkspaceId ? s.brainThreads[chatWorkspaceId] : undefined)) ??
    EMPTY_DECK_BRAIN_THREAD;
  const startDeckBrainTurn = useStore((s) => s.startDeckBrainTurn);
  const failDeckBrainTurn = useStore((s) => s.failDeckBrainTurn);
  // Reboot recovery (P3b) — the resume hints the daemon surfaces only for
  // panes recovered this boot (the same signal the per-pane pill uses).
  const resumeHintByPtyId = useStore((s) => s.resumeHintByPtyId);
  const resumeBindingByPtyId = useStore((s) => s.resumeBindingByPtyId);
  const ptyReadyByPtyId = useStore((s) => s.ptyReadyByPtyId);
  const recoveryCardDismissed = useStore((s) => s.recoveryCardDismissed);
  const dismissRecoveryCard = useStore((s) => s.dismissRecoveryCard);
  // `claude-pty` only: main pushes this workspace's brain pty id when the
  // adapter spawns its TUI. Any other vendor never sets it, so the bubble
  // rendering path is unchanged for them.
  const brainPtyIds = useStore((s) => s.brainPtyIds);
  const brainPtyId = chatWorkspaceId ? brainPtyIds[chatWorkspaceId] ?? null : null;

  // M1.5: recovery is per-workspace — this deck's card lists only the VIEWED
  // workspace's recoverable panes (each workspace recovers from its own tab;
  // under Moa the HQ brain is asked to recover the one on screen).
  const recoveryPanes = useMemo(
    () =>
      buildRecoveryPanes({
        resumeHintByPtyId,
        resumeBindingByPtyId,
        ptyReadyByPtyId,
        workspaces: workspaces.filter((w) => w.id === viewedWorkspaceId),
        paneLabel,
      }),
    [resumeHintByPtyId, resumeBindingByPtyId, ptyReadyByPtyId, workspaces, viewedWorkspaceId, paneLabel],
  );

  const commanderChannel = useMemo(() => findCommanderChannel(channels), [channels]);
  const messages = useStore((s) =>
    commanderChannel ? s.channelMessages[commanderChannel.id] ?? EMPTY_MESSAGES : EMPTY_MESSAGES,
  );

  const threads = useMemo(
    () => groupCommanderThreads(messages, HUMAN_WORKSPACE_ID),
    [messages],
  );

  // Workspace-name projection for reply author chips — subscribe to a stable
  // string key (mirrors ChannelView) so the transcript doesn't re-render on
  // every unrelated pane-tree mutation. `id=encoded(name)` pairs joined by `&`:
  // workspace ids are `ws-<uuid>` (no `=`/`&`) and names are URI-encoded, so the
  // key round-trips any workspace name safely.
  const workspaceNamesKey = useStore((s) =>
    s.workspaces.map((w) => `${w.id}=${encodeURIComponent(w.name)}`).join('&'),
  );
  // D1 briefing: a primitive fingerprint of the ACTIVE workspace's
  // status-relevant fleet state, so the card can refetch when a pane changes
  // even in autonomy mode 'off' (where no brain turn ever streams). Collapsed
  // to a string inside the selector — the workspaceNamesKey idiom — so an
  // unrelated pane-tree mutation neither re-renders this view nor wakes the
  // card. Deliberately NOT included: the hook-running decay clock
  // (`agentClockMs`), which ticks continuously and would turn this into a
  // refetch loop. Every state the briefing actually acts on (blocked, error,
  // complete) is a retained ATTENTION status and lives in `surfaceAgentStatus`;
  // the workspace-level status covers the active pane's running/idle.
  const fleetSignature = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === chatWorkspaceId);
    if (!ws) return '';
    const parts: string[] = [`~${ws.metadata?.agentStatus ?? ''}`];
    // Workspace-wide (#977) — paired with deckBrain.countAgentPanes. If only
    // one of the two sees stashed panes, the briefing goes stale exactly when a
    // stashed agent changes state, which is when it matters most.
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      for (const surface of leaf.surfaces) {
        if (!surface.ptyId) continue;
        parts.push(`${surface.ptyId}:${s.surfaceAgentStatus[surface.ptyId] ?? ''}`);
      }
    }
    return parts.join('|');
  });

  const workspaceName = useMemo(() => {
    const names = new Map<string, string>();
    for (const pair of workspaceNamesKey.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq > 0) names.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
    }
    return (id: string) => names.get(id);
  }, [workspaceNamesKey]);

  // @-candidates = every LIVE agent pane in the fleet. Unlike the channel
  // composer (members only), the Commander composer can address ANY pane —
  // invite-before-post makes its workspace a member on send.
  const mentionCandidates = useMemo<MentionCandidate[]>(
    () =>
      buildMentionCandidates({
        workspaces,
        surfaceAgent,
        paneLabel,
        memberWorkspaceIds: new Set(workspaces.map((w) => w.id)),
        selfWorkspaceId: HUMAN_WORKSPACE_ID,
      }),
    [workspaces, surfaceAgent, paneLabel],
  );

  const resolvePtyPane = useCallback(
    (ptyId: string): { workspaceId: string; paneId: string } | null => {
      for (const w of workspaces) {
        // Workspace-wide (#977): a stashed pane is a legitimate jump target —
        // onJumpToPane unstashes it on the way.
        for (const leaf of getWorkspaceLeafPanes(w)) {
          if (leaf.surfaces.some((sf) => sf.surfaceType !== 'browser' && sf.ptyId === ptyId)) {
            return { workspaceId: w.id, paneId: leaf.id };
          }
        }
      }
      return null;
    },
    [workspaces],
  );

  const onJumpToPane = useCallback(
    (workspaceId: string, paneId: string) => {
      setActiveWorkspace(workspaceId);
      // #977 — unstash first. setActivePane only accepts panes in the visible
      // tree, so jumping to a stashed pane would otherwise be a silent no-op:
      // the workspace switches, nothing else happens, and the user is left
      // looking at the wrong pane with no explanation. Idempotent when the pane
      // is already on screen.
      useStore.getState().unstashPane(paneId, workspaceId);
      setActivePane(paneId);
    },
    [setActiveWorkspace, setActivePane],
  );

  // Fan-out send (P1c): lazy-create #commander, invite the mentioned workspaces
  // (before the post so the daemon keeps their mentions), then post with the
  // pinned mentions. Delivery is entirely the existing plumbing (W2 immediate
  // injection + wake worker) — no new delivery code here.
  const handleFanout = useCallback(
    async (
      text: string,
      mentions: ChannelMention[],
    ): Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }> => {
      // 1. Ensure the #commander channel exists (private, ws-human owned).
      let channel = findCommanderChannel(useStore.getState().channels);
      if (!channel) {
        const companyId = company?.id ?? DEFAULT_COMPANY_ID;
        const created = await createChannelDaemon({
          name: COMMANDER_CHANNEL_NAME,
          visibility: 'private',
          createdBy: {
            workspaceId: HUMAN_WORKSPACE_ID,
            memberId: HUMAN_MEMBER_ID,
            memberName: HUMAN_MEMBER_ID,
          },
          channel: synthesizeChannel({
            companyId,
            name: COMMANDER_CHANNEL_NAME,
            visibility: 'private',
          }),
        });
        if (created.ok) {
          channel = created.value;
        } else {
          // ALREADY_EXISTS race (created elsewhere between our check and now):
          // re-read the mirror. Any other error is a hard failure.
          channel = findCommanderChannel(useStore.getState().channels);
          if (!channel) {
            return { ok: false, errorCode: created.error.code, errorMessage: created.error.message };
          }
        }
      }

      // 2. Invite the mentioned workspaces BEFORE posting (a mention only lands
      //    if its workspace is a member). Best-effort + idempotent: a
      //    DUPLICATE_MEMBER (already invited) or any transient invite error must
      //    not block the post — the daemon re-validates mentions on post and
      //    drops anything that truly isn't a member.
      const inviteMembers = fanoutInviteMembers(mentions, HUMAN_WORKSPACE_ID);
      for (const member of inviteMembers) {
        await inviteChannelDaemon(channel.id, member, HUMAN_WORKSPACE_ID);
      }

      // 3. Post the fan-out with the pinned mentions.
      const clientMsgId = generateId('cmid');
      const mentionsArg = mentions.length > 0 ? mentions : undefined;
      const message = synthesizeChannelMessage({
        channelId: channel.id,
        seq: channel.nextSeq,
        text,
        senderWorkspaceId: HUMAN_WORKSPACE_ID,
        senderMemberId: HUMAN_MEMBER_ID,
        senderMemberName: HUMAN_MEMBER_ID,
        clientMsgId,
        mentions: mentionsArg,
      });
      const result = await postMessageDaemon(channel.id, {
        text,
        sender: {
          workspaceId: HUMAN_WORKSPACE_ID,
          memberId: HUMAN_MEMBER_ID,
          memberName: HUMAN_MEMBER_ID,
        },
        clientMsgId,
        mentions: mentionsArg,
        message,
      });
      if (!result.ok) {
        pushToast({ level: 'error', message: t('channels.postFailed') || 'Post failed' });
        return { ok: false, errorCode: result.error.code, errorMessage: result.error.message };
      }
      // The post shipped, but the daemon may have dropped some mentions whose
      // workspace still isn't a member (invite failed) — surface that instead of
      // a silent drop, same contract as the channel composer.
      if (result.droppedMentions && result.droppedMentions.length > 0) {
        const names = result.droppedMentions.map((d) => d.name ?? d.workspaceId).join(', ');
        pushToast({
          level: 'warn',
          message: (
            t('channels.mentionDropped') ||
            'These @mentions did not land (not a channel member): {names}'
          ).replace('{names}', names),
        });
      }
      return { ok: true };
    },
    [company, createChannelDaemon, inviteChannelDaemon, postMessageDaemon, pushToast, t],
  );

  // Brain send (P2d): NO @mention → the main-process Agent SDK commander. Push
  // the optimistic human + streaming-assistant messages, then invoke deck:send.
  // The turn's content streams back over deck:onStream (useDeckStream → the
  // deckSlice reducer).
  //
  // Chat contract: this resolves IMMEDIATELY after the optimistic open — NOT
  // when deck:send's promise settles. deck:send resolves only after the WHOLE
  // turn finishes streaming (main awaits mgr.send), and the composer clears
  // its input on this promise — awaiting it left the typed text sitting in
  // the composer for the entire orchestrator turn. A late reject (busy race /
  // disposed) is surfaced by failing the open turn's bubble instead.
  // Moa: the switch (known up front) and the last refusal main gave a send
  // in this workspace (not_hq / hq_missing / hq_unknown, or moa_off from a
  // race with the switch).
  const moa = useStore((s) => s.moa);
  const [moaRefusal, setMoaRefusal] = useState<{ workspaceId: string; code: MoaBlockCode } | null>(null);
  const moaBlock = useMemo((): MoaBlock | null => {
    let code: MoaBlockCode | null = null;
    if (moa && !moa.config.enabled) code = 'moa_off';
    else if (moaRefusal && moaRefusal.workspaceId === chatWorkspaceId && moaRefusal.code !== 'moa_off') {
      code = moaRefusal.code;
    }
    if (!code) return null;
    const hqId = moa?.hq.state === 'ok' ? moa.hq.workspaceId : null;
    return {
      code,
      onOpenSettings: () => useStore.getState().openSettingsTab('moa'),
      ...(hqId && hqId !== chatWorkspaceId ? { onOpenHq: () => useStore.getState().openMoaHq() } : {}),
    };
  }, [moa, moaRefusal, chatWorkspaceId]);

  const handleBrainSend = useCallback(
    async (text: string): Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }> => {
      const api = window.electronAPI?.deck;
      if (!api || !chatWorkspaceId) {
        pushToast({ level: 'error', message: t('deck.commanderUnavailable') || 'The orchestrator is unavailable' });
        return { ok: false, errorCode: 'UNAVAILABLE' };
      }
      const workspaceId = chatWorkspaceId;
      // The operator's `/clear` (alias `/reset`) — a command, not a message:
      // reset the brain's context instead of sending a turn. The transcript
      // stays (audit trail); the next turn starts a fresh SDK conversation.
      const trimmed = text.trim();
      if (trimmed === '/clear' || trimmed === '/reset') {
        const clear = api.conversation?.clear;
        if (!clear) {
          pushToast({ level: 'error', message: t('deck.commanderUnavailable') || 'The orchestrator is unavailable' });
          return { ok: false, errorCode: 'UNAVAILABLE' };
        }
        try {
          const r = await clear(workspaceId);
          pushToast(
            r.ok
              ? { level: 'info', message: t('deck.contextCleared') || 'Orchestrator context cleared — the next turn starts fresh.' }
              : { level: 'error', message: t('deck.contextClearFailed') || 'Could not clear the orchestrator context.' },
          );
        } catch {
          pushToast({ level: 'error', message: t('deck.contextClearFailed') || 'Could not clear the orchestrator context.' });
        }
        return { ok: true }; // composer clears; nothing was sent
      }
      startDeckBrainTurn(workspaceId, text);
      // One-shot workspace snapshot for the system prompt (main injects it on
      // the first turn only and re-caps to 2048 chars). Recovery facts (P3b)
      // ride along so a typed "recover my agents" works without the card —
      // placed FIRST and with the summary's budget shrunk to fit, because
      // main's cap truncates the TAIL: appended recovery lines would be
      // exactly what a large workspace cuts off (codex P2).
      const recoveryLines = buildRecoveryContextLines(recoveryPanes);
      const wsSummary = buildWorkspaceContextSummary({
        workspaces,
        // The summary describes what the operator is looking at; under Moa
        // that is not the HQ the message goes to.
        activeWorkspaceId: viewedWorkspaceId || workspaceId,
        surfaceAgent,
        paneLabel,
        paneRole,
        channels,
        ...(recoveryLines ? { maxChars: Math.max(400, 2000 - recoveryLines.length) } : {}),
      });
      const fleetContext = recoveryLines ? `${recoveryLines}\n\n${wsSummary}` : wsSummary;
      // The orchestrator model override rides along on every send; main swaps
      // this workspace's brain between turns when it changes (Settings →
      // Claude tab). deck:send resolves when the whole turn ends, but every
      // refusal (Moa gates, mode off, busy) comes back at once: the composer
      // waits SEND_VERDICT_GRACE_MS for one and keeps its draft on refusal;
      // silence means accepted. A late refusal still closes the turn below.
      const verdict = (res: { ok: boolean; code?: string }): { ok: boolean; errorCode?: string; errorMessage?: string } => {
        // Main's Moa gates refuse with their own codes (deck.handler
        // refuseWhenModeOff); the preload type predates them.
        const code: string | undefined = res.code;
        if (res.ok) {
          setMoaRefusal((prev) => (prev?.workspaceId === workspaceId ? null : prev));
          return { ok: true };
        }
        let reason: string;
        if (isMoaBlockCode(code)) {
          // Say which gate refused and keep the notice (with its fix) up.
          setMoaRefusal({ workspaceId, code });
          reason = t(MOA_BLOCK_KEY[code]);
        } else {
          // Rejected before any stream event (busy race / disposed): close the
          // open turn with an error so the placeholder doesn't spin forever.
          reason = code === 'busy'
            ? t('deck.commanderBusy') || 'A command is already running.'
            : t('deck.commanderFailed') || 'The command could not run.';
        }
        failDeckBrainTurn(workspaceId, reason);
        return { ok: false, errorCode: code ?? 'FAILED', errorMessage: reason };
      };
      const sent = api
        .send({
          workspaceId,
          text,
          fleetContext,
          ...(useStore.getState().deckBrainModel ? { model: useStore.getState().deckBrainModel } : {}),
        })
        .then(verdict, (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          failDeckBrainTurn(workspaceId, message);
          return { ok: false, errorCode: 'FAILED', errorMessage: message };
        });
      const early = await Promise.race([
        sent,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SEND_VERDICT_GRACE_MS)),
      ]);
      return early ?? { ok: true };
    },
    [chatWorkspaceId, viewedWorkspaceId, workspaces, surfaceAgent, paneLabel, paneRole, channels, recoveryPanes, startDeckBrainTurn, failDeckBrainTurn, pushToast, t],
  );

  // diff→오케스트레이터 질문 릴레이(deckSlice.pendingBrainPrompt) — DiffPanel이
  // 질문을 실어 두고 이 탭으로 전환하면 여기서 집어 정상 send 경로(fleet
  // context·optimistic 버블 포함)로 발사한다. 소비 즉시 클리어(1회성).
  const pendingBrainPrompt = useStore((s) => s.pendingBrainPrompt);
  const setPendingBrainPrompt = useStore((s) => s.setPendingBrainPrompt);
  useEffect(() => {
    if (!pendingBrainPrompt) return;
    // 이미 턴이 도는 중이면 소비하지 않고 대기(Codex P2) — 여기서 clear+send하면
    // deck:send가 busy로 거부하고 질문이 유실된다. busy가 풀리면(브레인 status
    // 변화로 이 effect 재실행) 그때 발사한다.
    if (brainThread.status === 'busy') return;
    setPendingBrainPrompt(null);
    void handleBrainSend(pendingBrainPrompt);
  }, [pendingBrainPrompt, brainThread.status, setPendingBrainPrompt, handleBrainSend]);

  // P3b: the greeting card's one-click recovery — send the canned prompt to
  // the brain, and retire the card only once the send was ACCEPTED (a busy
  // race / disposed session / missing bridge must not eat the one-click
  // affordance — CodeRabbit). The per-pane pills self-clear as agents return.
  const handleRecoverFleet = useCallback(() => {
    if (recoveryPanes.length === 0) return;
    void handleBrainSend(buildRecoveryPrompt(recoveryPanes)).then((res) => {
      if (res.ok) dismissRecoveryCard();
    });
  }, [recoveryPanes, dismissRecoveryCard, handleBrainSend]);

  // P3c quick actions: the chip set for the current deck state. The recover
  // chip keys off the UNDISMISSED pane list — dismissing the greeting card must
  // not take the one-click recovery away (the chip IS the re-entry path).
  const quickActions = useMemo(
    () => buildQuickActions({ recoveryPanes, t }),
    [recoveryPanes, t],
  );
  const handleQuickAction = useCallback(
    (action: DeckQuickAction) => {
      // Recovery goes through the card's handler so the card retires once the
      // send is accepted; everything else is a plain canned brain send.
      if (action.id === 'recover-fleet') {
        handleRecoverFleet();
        return;
      }
      void handleBrainSend(action.prompt);
    },
    [handleRecoverFleet, handleBrainSend],
  );

  // Unified composer submit: route on whether the message @-mentions panes.
  const handleSubmit = useCallback(
    (text: string, mentions: ChannelMention[]) =>
      mentions.length > 0 ? handleFanout(text, mentions) : handleBrainSend(text),
    [handleFanout, handleBrainSend],
  );

  // Mode `off` = the orchestrator does not run, so the composer is disabled.
  const agentMode = useActiveAgentMode(chatWorkspaceId);

  const onInterrupt = useCallback(() => {
    if (!chatWorkspaceId) return;
    window.electronAPI?.deck?.interrupt(chatWorkspaceId).catch(() => {
      /* best-effort — the turn may already be over */
    });
  }, [chatWorkspaceId]);

  // Moa's chat look over the HQ brain's terminal. The view choice is local and
  // transient; a fresh panel opens on the chat.
  const [brainView, setBrainView] = useState<'chat' | 'terminal'>('chat');
  const showTerminal = useCallback(() => setBrainView('terminal'), []);
  const brainBusy = brainThread.status === 'busy';
  const moaContent = useMemo((): CommanderMoaSlots | undefined => {
    if (!moaSlots) return undefined;
    // Moa's column, in order: Waiting on you, delegated work, then the
    // briefing, minus the decision lines Waiting on you already states.
    const top = (
      <>
        {moaSlots.top}
        <DeckBriefingCard
          workspaceId={chatWorkspaceId}
          t={t}
          onJumpToPane={onJumpToPane}
          resolvePtyPane={resolvePtyPane}
          channelsUnread={channelsUnread}
          onJumpToChannels={onJumpToChannels}
          fleetSignature={fleetSignature}
          omitDecision
        />
      </>
    );
    const chat = brainPtyId && moaSlots.renderChat
      ? moaSlots.renderChat({ brainPtyId, busy: brainBusy, onSend: handleBrainSend, onInterrupt, onTerminal: showTerminal, top })
      : null;
    return { top, chat, view: brainView, onViewChange: setBrainView };
  }, [moaSlots, brainPtyId, brainBusy, handleBrainSend, onInterrupt, showTerminal, brainView,
    chatWorkspaceId, t, onJumpToPane, resolvePtyPane, channelsUnread, onJumpToChannels, fleetSignature]);

  return (
    <CommanderViewContent
      threads={threads}
      brainMessages={brainThread.messages}
      brainBusy={brainBusy}
      onInterrupt={onInterrupt}
      mentionCandidates={mentionCandidates}
      onSubmit={handleSubmit}
      onJumpToPane={onJumpToPane}
      resolvePtyPane={resolvePtyPane}
      workspaceName={workspaceName}
      brainPtyId={brainPtyId}
      recoveryPanes={recoveryCardDismissed ? [] : recoveryPanes}
      onRecoverFleet={handleRecoverFleet}
      onDismissRecovery={dismissRecoveryCard}
      quickActions={quickActions}
      onQuickAction={handleQuickAction}
      chatWorkspaceId={chatWorkspaceId}
      viewedWorkspaceId={viewedWorkspaceId}
      moa={moaContent}
      activePaneCwd={activePaneCwd}
      fleetSlot={<DeckFleet onJumpToPane={onJumpToPane} />}
      channelsUnread={channelsUnread}
      onJumpToChannels={onJumpToChannels}
      fleetSignature={fleetSignature}
      modeOff={agentMode === 'off'}
      moaBlock={moaBlock}
      t={t}
    />
  );
}

export default CommanderView;

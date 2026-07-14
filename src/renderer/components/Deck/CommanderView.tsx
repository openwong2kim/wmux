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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { formatChatTime, type DeckLimitNotice } from './deckBrain';
import DeckFleet from './DeckFleet';
import { findLeafPanes } from '../../hooks/a2aAddressing';
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
import { synthesizeChannel } from '../Channels/ChannelsPanel';
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
import { DeckLoopPanel } from './DeckLoopPanel';
import { AgentModeChipContainer } from './AgentModeChip';

const EMPTY_MESSAGES: ChannelMessage[] = [];

// ─── Pure view ───────────────────────────────────────────────────────────────

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
  /** M1.5: the workspace this deck view is bound to — new schedules are
   *  created against its orchestrator. */
  activeWorkspaceId?: string;
  /** 활성 pane의 라이브 cwd — 루프 설정 모달의 스킬 카탈로그 스캔 기준. */
  activePaneCwd?: string;
  /** P2① mission control — the Fleet roster slot, pinned above the thread.
   *  Injected as a node so this surface stays presentational/store-free. */
  fleetSlot?: React.ReactNode;
  t?: (key: string) => string;
}

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
  recoveryPanes = [],
  onRecoverFleet,
  onDismissRecovery,
  quickActions = [],
  onQuickAction,
  activeWorkspaceId,
  activePaneCwd,
  fleetSlot,
  t: tProp,
}: CommanderViewContentProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  const isEmpty = threads.length === 0 && brainMessages.length === 0;

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
  }, [activeWorkspaceId]);

  return (
    <div
      data-commander-view
      // Mantle, not base: the deck is chrome (one panel family with the
      // sidebar and the dock shell around it — DESIGN.md layout contract);
      // painting base here made the thread read as a detached page.
      className="flex flex-col flex-1 min-h-0 bg-[var(--bg-mantle)]"
      {...tokenAttrs('bgMantle', 'bg')}
    >
      {/* P2① — Fleet roster pinned above the thread (does not scroll with it). */}
      {fleetSlot}
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
        {isEmpty && (
          <div
            data-commander-empty
            className="text-[12.5px] text-[var(--text-muted)] text-center py-8 leading-relaxed"
            {...tokenAttrs('textMuted', 'text')}
          >
            {t('deck.commanderEmpty') ||
              'Ask the orchestrator to run your agents, or @mention agent panes to command them directly.'}
          </div>
        )}

        {/* Reboot-recovery greeting card (P3b) — shown while recoverable panes
            exist and the card wasn't dismissed. One click sends the canned
            recovery prompt to the brain. */}
        {recoveryPanes.length > 0 && (
          <div
            data-commander-recovery
            className="rounded-[7px] px-4 py-3 space-y-2 bg-[rgba(var(--bg-surface-rgb),0.55)]"
            {...tokenAttrs('bgSurface', 'bg')}
          >
            <div
              className="text-[12.5px] font-semibold text-[var(--text-main)] leading-relaxed"
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
                className={`px-2.5 py-1 rounded-[4px] text-[12px] font-semibold text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.8)] hover:text-[var(--accent-blue)] transition-colors disabled:opacity-40 ${FOCUS_RING}`}
              >
                {t('deck.recoveryRun') || 'Recover agents'}
              </button>
              <button
                type="button"
                data-recovery-dismiss
                onClick={onDismissRecovery}
                className={`px-2 py-1 rounded-md text-[12px] text-[var(--text-muted)] hover:opacity-80 transition-opacity ${FOCUS_RING}`}
                {...tokenAttrs('textMuted', 'text')}
              >
                {t('deck.recoveryDismiss') || 'Dismiss'}
              </button>
            </div>
          </div>
        )}

        {/* Brain conversation — orchestrator turns (text bubbles + tool chips). */}
        {brainMessages.map((m) => (
          <CommanderBrainItem key={m.id} message={m} onJumpToPane={onJumpToPane} t={t} />
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
          className="flex items-center gap-2 px-4 py-1.5 border-t border-[var(--bg-surface)] shrink-0"
          style={{ borderColor: 'var(--border-soft)' }}
          {...tokenAttrs('bgSurface', 'border')}
        >
          <span
            aria-hidden="true"
            className="inline-block w-3 h-3 rounded-full border-2 border-[var(--accent-blue)] border-t-transparent animate-spin"
          />
          <span
            className="text-[12px] text-[var(--text-sub)] flex-1"
            {...tokenAttrs('textSub', 'text')}
          >
            {t('deck.commanderThinking') || 'Orchestrator is working…'}
          </span>
          <button
            type="button"
            data-commander-interrupt
            onClick={onInterrupt}
            className={`px-2 py-0.5 rounded-md text-[12px] text-[var(--accent-red)] bg-[rgba(var(--bg-surface-rgb),0.6)] hover:opacity-80 transition-opacity ${FOCUS_RING}`}
            {...tokenAttrs('danger', 'text')}
          >
            {t('deck.commanderStop') || 'Stop'}
          </button>
        </div>
      )}

      {/* Orchestrator control bar — the persistent automation controls, right
          above the composer where the hand already is. Mode is the master
          autonomy switch (off/manual/assist/orchestrate; 'off' even tears down
          running loops + schedules), so it anchors the left and a hairline
          separates it from the two automations it governs — Loop and Schedules.
          The reboot-recovery re-entry chip, when present, trails on the right so
          it never crowds the always-on controls. Each control's container
          self-hides when its preload API is absent, so pure jsdom parent tests
          are unaffected. */}
      {(activeWorkspaceId || quickActions.length > 0) && (
        <div
          data-deck-control-bar
          className="flex flex-wrap items-center gap-1.5 px-4 py-1.5 border-t border-[var(--bg-surface)] shrink-0"
          style={{ borderColor: 'var(--border-soft)' }}
          {...tokenAttrs('bgSurface', 'border')}
        >
          {/* Mode = the single autonomy knob, always showing the current mode. */}
          <AgentModeChipContainer t={t} workspaceId={activeWorkspaceId} />
          {/* Hairline seam: master switch │ the automations it governs. */}
          <span
            aria-hidden="true"
            data-deck-control-sep
            className="h-4 w-px mx-0.5 bg-[var(--border-soft)]"
          />
          {/* The one-click loop chip + panel (loop engineering v1) — binds to
              THIS workspace. */}
          <DeckLoopPanel t={t} workspaceId={activeWorkspaceId} cwd={activePaneCwd} />
          {/* Schedules chip + inline panel — new schedules bind to THIS
              workspace's orchestrator (M1.5). */}
          <DeckSchedulesPanel t={t} workspaceId={activeWorkspaceId} workspaceName={workspaceName} />

          {/* Reboot-recovery re-entry (post-reboot only) — the canned one-click
              recovery, trailing right. Neutral at rest, accent on hover (the
              DESIGN.md AI-action grammar), disabled while a turn streams. */}
          {quickActions.length > 0 && (
            <div data-deck-quick-actions className="flex flex-wrap gap-1.5 ml-auto">
              {quickActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  data-deck-quick-action
                  data-action-id={action.id}
                  disabled={brainBusy}
                  onClick={() => onQuickAction?.(action)}
                  className={`px-2.5 py-1 rounded-md text-[12px] font-semibold text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.6)] hover:text-[var(--accent-blue)] transition-colors disabled:opacity-40 ${FOCUS_RING}`}
                  {...tokenAttrs('textSub', 'text')}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Composer — the SAME pure shell the channel composer uses. No @mention →
            the Commander brain; @mention → the Phase 1 fan-out. Disabled while a
            brain turn streams (the one-turn-at-a-time contract). */}
      <div
        className="border-t border-[var(--bg-surface)] shrink-0"
        style={{ borderColor: 'var(--border-soft)' }}
        {...tokenAttrs('bgSurface', 'border')}
      >
        <ComposerContent
          channelId={COMMANDER_CHANNEL_NAME}
          onSubmit={onSubmit}
          mentionCandidates={mentionCandidates}
          disabled={brainBusy}
          placeholder={t('deck.commanderPlaceholder') || 'Tell the orchestrator, or @mention panes…'}
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
          className="max-w-[85%] rounded-lg rounded-tr-[3px] px-3 py-1.5 bg-[rgba(var(--bg-surface-rgb),0.8)] text-[13px] leading-relaxed text-[var(--text-main)] whitespace-pre-wrap break-words"
          data-commander-brain-text
          {...tokenAttrs('bgSurface', 'bg')}
          {...tokenAttrs('textMain', 'text')}
        >
          {message.text}
        </div>
        {message.ts && (
          <span className="text-[9.5px] font-mono text-[var(--text-muted)] pr-1" {...tokenAttrs('textMuted', 'text')}>
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
        {message.ts && (
          <span className="text-[9.5px] font-mono text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
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
              className="text-[11px] text-[var(--accent-amber)]"
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
          className={`text-[10.5px] text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text-sub)] ${FOCUS_RING}`}
          {...tokenAttrs('textMuted', 'text')}
        >
          {expanded
            ? t('deck.wokenHide') || 'Hide'
            : t('deck.wokenShow') || 'Details'}
        </button>
        {message.ts && (
          <span
            className="text-[9.5px] font-mono text-[var(--text-muted)]"
            {...tokenAttrs('textMuted', 'text')}
          >
            {formatChatTime(message.ts)}
          </span>
        )}
      </div>
      {expanded && (
        <pre
          data-commander-wake-raw
          className="max-w-[85%] overflow-x-auto rounded-[4px] px-3 py-1.5 bg-[rgba(var(--bg-surface-rgb),0.55)] text-[10.5px] font-mono leading-relaxed text-[var(--text-sub)] whitespace-pre-wrap break-words"
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
            className="max-w-[85%] rounded-lg rounded-tr-[3px] px-3 py-1.5 bg-[rgba(var(--bg-surface-rgb),0.8)] text-[13px] leading-relaxed text-[var(--text-main)] whitespace-pre-wrap break-words"
            data-commander-dispatch-text
            {...tokenAttrs('bgSurface', 'bg')}
            {...tokenAttrs('textMain', 'text')}
          >
            {renderMessageBody(dispatch.text, dispatch.mentions)}
          </div>
          <span
            className="text-[9.5px] font-mono text-[var(--text-muted)] pr-1"
            {...tokenAttrs('textMuted', 'text')}
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
                  className={`px-2 py-0.5 rounded-[4px] text-[11.5px] text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.6)] hover:text-[var(--accent-blue)] transition-colors disabled:opacity-50 disabled:cursor-default ${FOCUS_RING}`}
                  {...tokenAttrs('textSub', 'text')}
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
        <div className="flex flex-col gap-2 pl-3 border-l-2 border-[var(--bg-surface)]" data-commander-replies>
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
                    className="text-[9.5px] font-mono text-[var(--text-muted)]"
                    {...tokenAttrs('textMuted', 'text')}
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
export function CommanderView(): React.ReactElement {
  const t = useT();
  const channels = useStore((s) => s.channels);
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
  // Commander brain (Phase 2, per-workspace M1.5): the deck shows the ACTIVE
  // workspace's orchestrator thread — switching workspace tabs switches the
  // conversation. Background workspaces' turns keep streaming into their own
  // threads via useDeckStream's envelope routing.
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId) || '';
  // 활성 pane의 라이브 cwd(OSC 7 추적 surface.cwd) — 루프 모달의 스킬 카탈로그
  // 스캔 기준. 트리 워크는 셀렉터 안에서 원시 문자열로 수렴시켜 리렌더 최소화.
  const activePaneCwd = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
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
    useStore((s) => (activeWorkspaceId ? s.brainThreads[activeWorkspaceId] : undefined)) ??
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

  // M1.5: recovery is per-workspace — this deck's card lists only the ACTIVE
  // workspace's recoverable panes (its orchestrator cannot target the others;
  // each workspace recovers from its own tab).
  const recoveryPanes = useMemo(
    () =>
      buildRecoveryPanes({
        resumeHintByPtyId,
        resumeBindingByPtyId,
        ptyReadyByPtyId,
        workspaces: workspaces.filter((w) => w.id === activeWorkspaceId),
        paneLabel,
      }),
    [resumeHintByPtyId, resumeBindingByPtyId, ptyReadyByPtyId, workspaces, activeWorkspaceId, paneLabel],
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
        for (const leaf of findLeafPanes(w.rootPane)) {
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
  const handleBrainSend = useCallback(
    async (text: string): Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }> => {
      const api = window.electronAPI?.deck;
      if (!api || !activeWorkspaceId) {
        pushToast({ level: 'error', message: t('deck.commanderUnavailable') || 'The orchestrator is unavailable' });
        return { ok: false, errorCode: 'UNAVAILABLE' };
      }
      const workspaceId = activeWorkspaceId;
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
        activeWorkspaceId: workspaceId,
        surfaceAgent,
        paneLabel,
        paneRole,
        channels,
        ...(recoveryLines ? { maxChars: Math.max(400, 2000 - recoveryLines.length) } : {}),
      });
      const fleetContext = recoveryLines ? `${recoveryLines}\n\n${wsSummary}` : wsSummary;
      // The orchestrator model override rides along on every send; main swaps
      // this workspace's brain between turns when it changes (Settings →
      // Claude tab). Fire-and-observe: the verdict closes the bubble on
      // rejection, the stream fills it on acceptance.
      void api
        .send({
          workspaceId,
          text,
          fleetContext,
          ...(useStore.getState().deckBrainModel ? { model: useStore.getState().deckBrainModel } : {}),
        })
        .then((res) => {
          if (!res.ok) {
            // Rejected before any stream event (busy race / disposed): close
            // the open turn with an error so the placeholder doesn't spin
            // forever.
            failDeckBrainTurn(
              workspaceId,
              res.code === 'busy'
                ? t('deck.commanderBusy') || 'A command is already running.'
                : t('deck.commanderFailed') || 'The command could not run.',
            );
          }
        })
        .catch((err) => {
          failDeckBrainTurn(workspaceId, err instanceof Error ? err.message : String(err));
        });
      return { ok: true };
    },
    [activeWorkspaceId, workspaces, surfaceAgent, paneLabel, paneRole, channels, recoveryPanes, startDeckBrainTurn, failDeckBrainTurn, pushToast, t],
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

  const onInterrupt = useCallback(() => {
    if (!activeWorkspaceId) return;
    window.electronAPI?.deck?.interrupt(activeWorkspaceId).catch(() => {
      /* best-effort — the turn may already be over */
    });
  }, [activeWorkspaceId]);

  return (
    <CommanderViewContent
      threads={threads}
      brainMessages={brainThread.messages}
      brainBusy={brainThread.status === 'busy'}
      onInterrupt={onInterrupt}
      mentionCandidates={mentionCandidates}
      onSubmit={handleSubmit}
      onJumpToPane={onJumpToPane}
      resolvePtyPane={resolvePtyPane}
      workspaceName={workspaceName}
      recoveryPanes={recoveryCardDismissed ? [] : recoveryPanes}
      onRecoverFleet={handleRecoverFleet}
      onDismissRecovery={dismissRecoveryCard}
      quickActions={quickActions}
      onQuickAction={handleQuickAction}
      activeWorkspaceId={activeWorkspaceId}
      activePaneCwd={activePaneCwd}
      fleetSlot={<DeckFleet onJumpToPane={onJumpToPane} />}
      t={t}
    />
  );
}

export default CommanderView;

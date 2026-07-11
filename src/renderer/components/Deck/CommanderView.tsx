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

import { useCallback, useMemo } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
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
  buildFleetContextSummary,
  type DeckBrainMessage,
  type DeckToolChip,
} from './deckBrain';

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
  t: tProp,
}: CommanderViewContentProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  const isEmpty = threads.length === 0 && brainMessages.length === 0;
  return (
    <div
      data-commander-view
      className="flex flex-col flex-1 min-h-0 bg-[var(--bg-base)]"
      {...tokenAttrs('bgBase', 'bg')}
    >
      {/* Message list — the brain conversation (Phase 2) plus the Phase 1
          @-mention fan-out threads. */}
      <div
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3"
        data-commander-threads
      >
        {isEmpty && (
          <div
            data-commander-empty
            className="text-caption font-mono text-[var(--text-muted)] text-center py-8 leading-relaxed"
            {...tokenAttrs('textMuted', 'text')}
          >
            {t('deck.commanderEmpty') ||
              'Ask the commander to run your fleet, or @mention agent panes to command them directly.'}
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
            className="text-[10px] font-mono text-[var(--text-sub)] flex-1"
            {...tokenAttrs('textSub', 'text')}
          >
            {t('deck.commanderThinking') || 'Commander is working…'}
          </span>
          <button
            type="button"
            data-commander-interrupt
            onClick={onInterrupt}
            className={`px-2 py-0.5 rounded text-[10px] font-mono text-[var(--accent-red)] bg-[rgba(var(--bg-surface-rgb),0.6)] hover:opacity-80 transition-opacity ${FOCUS_RING}`}
            {...tokenAttrs('danger', 'text')}
          >
            {t('deck.commanderStop') || 'Stop'}
          </button>
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
          placeholder={t('deck.commanderPlaceholder') || 'Command your fleet — @mention panes…'}
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
  return (
    <div
      data-commander-brain-message
      data-role={message.role}
      className="flex flex-col gap-1"
    >
      <span
        className={`text-caption font-mono font-bold ${isUser ? 'text-[var(--text-main)]' : 'text-[var(--accent-blue)]'}`}
        {...(isUser ? tokenAttrs('textMain', 'text') : tokenAttrs('accent', 'text'))}
      >
        {isUser ? t('channels.me') || 'Me' : t('deck.commander') || 'Commander'}
      </span>
      {message.text && (
        <div
          className="text-[12px] font-mono text-[var(--text-main)] whitespace-pre-wrap break-words"
          data-commander-brain-text
          {...tokenAttrs('textMain', 'text')}
        >
          {message.text}
        </div>
      )}
      {/* Tool chips — one per fleet action, in call order. */}
      {message.tools && message.tools.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5" data-commander-brain-tools>
          {message.tools.map((chip, i) => (
            <CommanderToolChip key={chip.toolId ?? `${chip.name}-${i}`} chip={chip} onJumpToPane={onJumpToPane} t={t} />
          ))}
        </div>
      )}
      {message.status === 'error' && message.errorText && (
        <div
          role="alert"
          data-commander-brain-error
          className="text-[10px] font-mono text-[var(--accent-red)]"
          {...tokenAttrs('danger', 'text')}
        >
          {message.errorText}
        </div>
      )}
    </div>
  );
}

/** A single tool-call chip. Shows the tool name + a compact input summary and a
 *  status dot (running / ok / failed); when the tool targeted a pane, the whole
 *  chip is a jump button. */
function CommanderToolChip({
  chip,
  onJumpToPane,
  t,
}: {
  chip: DeckToolChip;
  onJumpToPane: (workspaceId: string, paneId: string) => void;
  t: (key: string) => string;
}): React.ReactElement {
  const dot =
    chip.ok === undefined
      ? 'var(--text-muted)'
      : chip.ok
        ? 'var(--accent-green)'
        : 'var(--accent-red)';
  const canJump = !!chip.paneId && !!chip.workspaceId;
  const label = (
    <>
      <span
        aria-hidden="true"
        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: dot }}
      />
      <span className="font-bold">{chip.name}</span>
      {chip.inputSummary && <span className="opacity-70 truncate max-w-[160px]">{chip.inputSummary}</span>}
    </>
  );
  const base =
    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-[rgba(var(--bg-surface-rgb),0.6)]';
  if (canJump) {
    return (
      <button
        type="button"
        data-commander-tool-chip
        data-tool-name={chip.name}
        data-pane-id={chip.paneId}
        data-workspace-id={chip.workspaceId}
        onClick={() => onJumpToPane(chip.workspaceId!, chip.paneId!)}
        title={t('deck.jumpToPane') || 'Jump to this pane'}
        className={`${base} text-[var(--accent-blue)] hover:opacity-80 transition-opacity ${FOCUS_RING}`}
        {...tokenAttrs('accent', 'text')}
      >
        {label}
      </button>
    );
  }
  return (
    <span
      data-commander-tool-chip
      data-tool-name={chip.name}
      className={`${base} text-[var(--text-sub)]`}
      {...tokenAttrs('textSub', 'text')}
    >
      {label}
    </span>
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
        <div data-commander-dispatch className="flex flex-col gap-0.5">
          <div className="flex items-baseline gap-2">
            <span
              className="text-caption font-mono font-bold text-[var(--text-main)]"
              {...tokenAttrs('textMain', 'text')}
            >
              {t('channels.me') || 'Me'}
            </span>
            <span
              className="text-[9px] font-mono text-[var(--text-muted)]"
              {...tokenAttrs('textMuted', 'text')}
            >
              {new Date(dispatch.postedAt).toISOString().slice(11, 19)}
            </span>
          </div>
          <div
            className="text-[12px] font-mono text-[var(--text-main)] whitespace-pre-wrap break-words"
            data-commander-dispatch-text
            {...tokenAttrs('textMain', 'text')}
          >
            {renderMessageBody(dispatch.text, dispatch.mentions)}
          </div>
          {/* Target pane chips — the fan-out recipients, clickable to jump. */}
          {dispatch.mentions && dispatch.mentions.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5" data-commander-targets>
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
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--accent-blue)] bg-[rgba(var(--bg-surface-rgb),0.6)] hover:opacity-80 transition-opacity disabled:opacity-50 disabled:cursor-default ${FOCUS_RING}`}
                  {...tokenAttrs('accent', 'text')}
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
                      className={`text-caption font-mono font-bold text-[var(--accent-blue)] hover:underline ${FOCUS_RING}`}
                      {...tokenAttrs('accent', 'text')}
                    >
                      {author.primary}
                    </button>
                  ) : (
                    <span
                      className="text-caption font-mono font-bold text-[var(--text-main)]"
                      data-commander-reply-author
                      {...tokenAttrs('textMain', 'text')}
                    >
                      {author.primary}
                    </span>
                  )}
                  {author.chip && (
                    <span className="text-[10px] font-mono text-[var(--text-sub)]" {...tokenAttrs('textSub', 'text')}>
                      {author.chip}
                    </span>
                  )}
                  <span
                    className="text-[9px] font-mono text-[var(--text-muted)]"
                    {...tokenAttrs('textMuted', 'text')}
                  >
                    {new Date(m.postedAt).toISOString().slice(11, 19)}
                  </span>
                </div>
                <div
                  className="text-[12px] font-mono text-[var(--text-main)] whitespace-pre-wrap break-words"
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
  const createChannelDaemon = useStore((s) => s.createChannelDaemon);
  const inviteChannelDaemon = useStore((s) => s.inviteChannelDaemon);
  const postMessageDaemon = useStore((s) => s.postMessageDaemon);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const setActivePane = useStore((s) => s.setActivePane);
  const pushToast = useStore((s) => s.pushToast);
  const company = useStore((s) => s.company);
  // Commander brain (Phase 2).
  const brainMessages = useStore((s) => s.brainMessages);
  const brainStatus = useStore((s) => s.brainStatus);
  const startDeckBrainTurn = useStore((s) => s.startDeckBrainTurn);
  const failDeckBrainTurn = useStore((s) => s.failDeckBrainTurn);

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
  // deckSlice reducer); deck:send resolves only with the accept/reject verdict.
  const handleBrainSend = useCallback(
    async (text: string): Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }> => {
      const api = window.electronAPI?.deck;
      if (!api) {
        pushToast({ level: 'error', message: t('deck.commanderUnavailable') || 'Commander is unavailable' });
        return { ok: false, errorCode: 'UNAVAILABLE' };
      }
      startDeckBrainTurn(text);
      // One-shot fleet snapshot for the system prompt (main injects it on the
      // first turn only and re-caps to its own budget).
      const fleetContext = buildFleetContextSummary({
        workspaces,
        surfaceAgent,
        paneLabel,
        channels,
      });
      try {
        const res = await api.send(text, fleetContext);
        if (!res.ok) {
          // Rejected before any stream event (busy race / disposed): close the
          // open turn with an error so the placeholder doesn't spin forever.
          failDeckBrainTurn(
            res.code === 'busy'
              ? t('deck.commanderBusy') || 'A command is already running.'
              : t('deck.commanderFailed') || 'The command could not run.',
          );
          return { ok: false, errorCode: res.code };
        }
        return { ok: true };
      } catch (err) {
        failDeckBrainTurn(err instanceof Error ? err.message : String(err));
        return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
      }
    },
    [workspaces, surfaceAgent, paneLabel, channels, startDeckBrainTurn, failDeckBrainTurn, pushToast, t],
  );

  // Unified composer submit: route on whether the message @-mentions panes.
  const handleSubmit = useCallback(
    (text: string, mentions: ChannelMention[]) =>
      mentions.length > 0 ? handleFanout(text, mentions) : handleBrainSend(text),
    [handleFanout, handleBrainSend],
  );

  const onInterrupt = useCallback(() => {
    window.electronAPI?.deck?.interrupt().catch(() => {
      /* best-effort — the turn may already be over */
    });
  }, []);

  return (
    <CommanderViewContent
      threads={threads}
      brainMessages={brainMessages}
      brainBusy={brainStatus === 'busy'}
      onInterrupt={onInterrupt}
      mentionCandidates={mentionCandidates}
      onSubmit={handleSubmit}
      onJumpToPane={onJumpToPane}
      resolvePtyPane={resolvePtyPane}
      workspaceName={workspaceName}
      t={t}
    />
  );
}

export default CommanderView;

// Moa's conversation as chat bubbles, over the HQ brain's terminal. The data
// is the brain's own transcript (deck.moa.transcript), read through the same
// useTranscript state machine and rendered by the same Chat components a
// normal pane's Chat view uses: this file only adapts the source and routes
// the composer to deck.send, so there is one parser and one look.
//
// Loaded lazily (like ChatView): assistant-ui stays out of the main bundle
// until Moa's panel actually shows a conversation.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AssistantRuntimeProvider, MessageNotSentError, useExternalStoreRuntime, type AppendMessage } from '@assistant-ui/react';
import { useT } from '../../../hooks/useT';
import { useStore } from '../../../stores';
import { useTranscript } from '../../Chat/useTranscript';
import { transcriptMessages } from '../../Chat/chatMessages';
import { ChatCodeBlockContext, ChatPtyContext, UserText } from '../../Chat/ChatMessage';
import { Thread } from '../../Chat/assistant-ui/Thread';
import { useComposerDraft } from '../../Chat/chatDrafts';
import Button from '../../ui/Button';
import { MoaDockContext, NEEDS_YOU_ROW } from './MoaWaitingOnYou';
import { useDeckHeaderSlot } from '../../Deck/deckHeaderSlot';
import { FOCUS_RING } from '../../focusRing';
import type { ChatBridgeApi } from '../../../../shared/transcript/turnEvents';
import type { MoaApproval } from '../../../../shared/moa';
import '../moa.css';

/** The preload's `deck.moa.transcript` (main reads the HQ brain; no pty id). */
export type MoaTranscriptApi = NonNullable<NonNullable<NonNullable<Window['electronAPI']>['deck']>['moa']>['transcript'];

type MoaPreload = NonNullable<NonNullable<NonNullable<Window['electronAPI']>['deck']>['moa']>;
/** The preload's Moa prompt calls (#1772): read, answer, and main's change signal. */
export type MoaApprovalApi = Pick<MoaPreload, 'approval' | 'approvalAnswer'> & Partial<Pick<MoaPreload, 'onChanged'>>;

/** While Moa waits on its prompt: how often its record is read again (it trails the hook by ~1 s). */
const APPROVAL_POLL_MS = 2_000;

/**
 * deck.moa.transcript in the shape useTranscript reads. Keyed by the brain's
 * pty id so code-block bodies and approval gates resolve against that pty.
 * An unknown gate state (daemon unreachable) counts as open here: the gate
 * only drives the "use the terminal" hint, and main gates the send itself.
 */
/**
 * The terminal brain types each turn as one paste (Moa's context blocks with
 * the prompt at the end). Main swaps in the prompt it sent (it keeps the last
 * ones on disk); a pasted entry it has no record of shows one short line
 * instead of Moa's instructions. Text after the paste is not used: the TUI
 * splits a long paste, so it is the wire's tail, not the operator's words.
 */
export function tidyMoaUserText<E extends { kind: string; text?: string }>(events: readonly E[], instructionsLabel: string): E[] {
  return events.map((e) =>
    e.kind === 'user_text' && typeof e.text === 'string' && e.text.includes('<pasted_content')
      ? { ...e, text: instructionsLabel }
      : e);
}

export function moaTranscriptBridge(
  ptyId: string,
  api: MoaTranscriptApi,
  chat: Partial<ChatBridgeApi> | undefined,
  instructionsLabel = 'Instructions sent to Moa',
): ChatBridgeApi {
  return {
    status: () => api.status(),
    snapshot: async (_id, before) => {
      const page = await api.snapshot(before === undefined ? undefined : { before });
      return page ? { ...page, events: tidyMoaUserText(page.events, instructionsLabel) } : page;
    },
    subscribe: async () => ({ ok: true, status: await api.subscribe('panel') }),
    unsubscribe: async () => {
      await api.unsubscribe('panel');
      return { ok: true };
    },
    onAppend: (cb) => api.onAppend((data) => cb(ptyId, { ...data, events: tidyMoaUserText(data.events, instructionsLabel) })),
    onGate: chat?.onGate ?? (() => () => undefined),
    openGates: async () => (await chat?.openGates?.().catch(() => null)) ?? [],
    // The daemon cannot resolve the brain pty: main reads the HQ transcript.
    codeBlock: ({ srcOffset, n, eventId }) =>
      api.codeBlock?.({ srcOffset, n, ...(eventId ? { eventId } : {}) }) ?? Promise.resolve(null),
    // Never used: Moa's composer goes through deck.send (main's gated path).
    send: async () => ({ result: 'unavailable' }),
  };
}

export interface MoaTranscriptChatProps {
  /** The HQ brain's pty (brainPtyIds[hq]). */
  ptyId: string;
  /** A brain turn is running (one turn at a time). */
  busy: boolean;
  /** CommanderView's brain send: dispatches and resolves at once. */
  onSend: (text: string) => Promise<{ ok: boolean }>;
  onInterrupt: () => void;
  /** Swap to the terminal view (prompts only the TUI shows). */
  onTerminal: () => void;
  /** The panel's top sections, drawn first inside the chat's scroll (Waiting
   *  on you portals itself into the dock above the composer). */
  top?: React.ReactNode;
  /** Injected in tests; defaults to the preload. */
  api?: MoaTranscriptApi;
  /** Injected in tests; defaults to the preload. */
  approvalApi?: MoaApprovalApi;
}

interface Pending { id: string; text: string; before: ReadonlySet<string> }

export default function MoaTranscriptChat({ ptyId, busy, onSend, onInterrupt, onTerminal, top, api, approvalApi }: MoaTranscriptChatProps) {
  const t = useT();
  const source = api ?? window.electronAPI?.deck?.moa?.transcript;
  const prompts = approvalApi ?? window.electronAPI?.deck?.moa;
  const bridge = useMemo(
    () => (source ? moaTranscriptBridge(ptyId, source, window.electronAPI?.chat, t('moa.panel.instructionsSent')) : undefined),
    [ptyId, source, t],
  );
  const data = useTranscript(ptyId, !!bridge, bridge);
  // Main's subscription survives a brain swap (it re-pushes the tail with
  // `reset`), but not an HQ change: subscribe again when the HQ moves.
  const hqId = useStore((s) => s.moa?.hq.workspaceId ?? null);
  const { retry } = data;
  const firstHq = useRef(hqId);
  useEffect(() => {
    if (firstHq.current === hqId) return;
    firstHq.current = hqId;
    retry();
  }, [hqId, retry]);
  const messages = useMemo(() => transcriptMessages(data.events, true), [data.events]);
  const [pending, setPending] = useState<Pending[]>([]);
  // The latest events, for onNew to read after its await: the closure's copy
  // is from the render that started the send.
  const eventsRef = useRef(data.events);
  eventsRef.current = data.events;

  // A sent message shows until the transcript records a new prompt (main may
  // wrap the text, so any new user row settles the oldest bubble) or the
  // turn ends without one (a refused send says why in the panel's notice).
  useEffect(() => {
    setPending((current) => {
      if (current.length === 0) return current;
      const fresh = data.events.filter((e) => e.kind === 'user_text' && !current[0].before.has(e.id));
      return fresh.length ? current.slice(fresh.length) : current;
    });
  }, [data.events]);
  useEffect(() => {
    if (!busy) setPending([]);
  }, [busy]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    if (!text.trim()) return;
    if (busy) throw new MessageNotSentError(t('moa.panel.busy'));
    const before = new Set(data.events.filter((e) => e.kind === 'user_text').map((e) => e.id));
    const result = await onSend(text).catch(() => ({ ok: false }));
    if (!result.ok) throw new MessageNotSentError(t('moa.panel.sendFailed'));
    // /clear and /reset are commands, not messages: nothing to wait for.
    if (/^\/(clear|reset)$/.test(text.trim())) return;
    // The transcript may have recorded the prompt while onSend was in flight.
    // The settle effect already ran then, with nothing pending to clear, so a
    // bubble added now would sit beside the real row until the next event.
    if (eventsRef.current.some((e) => e.kind === 'user_text' && !before.has(e.id))) return;
    setPending((current) => [...current, { id: crypto.randomUUID(), text, before }].slice(-4));
  }, [busy, data.events, onSend, t]);

  const runtime = useExternalStoreRuntime({ messages, isRunning: false, isLoading: data.loading, isSendDisabled: busy, onNew });
  // The chat unmounts for the terminal view and with the panel: keep the draft.
  useComposerDraft(runtime, `moa:${hqId ?? ''}:${data.status.agentSessionId ?? 'new'}`);

  // Waiting on a permission prompt (or any dialog) that only the TUI shows.
  // Main's appends carry no status on this path, so `agentStatus` refreshes
  // on useTranscript's 5 s poll: the hint can trail the prompt by up to ~5 s.
  const awaitingTerminal = data.status.agentStatus === 'awaiting_input' || (data.blocked && data.status.available && !data.loading && !data.error);

  // Moa's own permission prompt as an approval record (#1772): its question
  // and choices in the row, answered through the daemon's fences. Read again
  // on main's change signal, on every status poll, and every 2 s while the row
  // is up (the record lands about a second after the dialog).
  const [approval, setApproval] = useState<MoaApproval | null>(null);
  const [answering, setAnswering] = useState(false);
  const [approvalNotice, setApprovalNotice] = useState<{ kind: 'retry' | 'error' } | null>(null);
  const readApproval = useCallback(async () => {
    if (!prompts?.approval) return;
    const read = await prompts.approval().catch(() => null);
    const next = read?.approval ?? null;
    setApproval((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    if (!next) setApprovalNotice(null);
  }, [prompts]);
  useEffect(() => { void readApproval(); }, [readApproval, data.status, awaitingTerminal]);
  useEffect(() => prompts?.onChanged?.(() => { void readApproval(); }), [prompts, readApproval]);
  const showPrompt = awaitingTerminal || approval !== null;
  useEffect(() => {
    if (!showPrompt) return;
    const timer = setInterval(() => { void readApproval(); }, APPROVAL_POLL_MS);
    return () => clearInterval(timer);
  }, [showPrompt, readApproval]);
  const answerApproval = useCallback(async (choiceKey: string) => {
    if (!approval?.promptFingerprint || !prompts?.approvalAnswer) return;
    setAnswering(true);
    try {
      const result = await prompts.approvalAnswer({ approvalId: approval.id, choiceKey, promptFingerprint: approval.promptFingerprint })
        .catch(() => ({ ok: false as const, code: 'error' as const }));
      // Answered or gone elsewhere: the card leaves quietly with the next read.
      if (result.ok || result.code === 'not_pending') setApprovalNotice(null);
      else setApprovalNotice({ kind: result.code === 'answer_too_soon' ? 'retry' : 'error' });
    } finally {
      setAnswering(false);
      void readApproval();
    }
  }, [approval, prompts, readApproval]);
  const empty = messages.length === 0 && pending.length === 0;
  // A callback ref: the dock mounts with the composer's footer.
  const [dockEl, setDockEl] = useState<HTMLDivElement | null>(null);
  // Tool activity (folded tool rows, "The agent is working…") is hidden: the
  // chat reads as messages. While Moa works, a small control beside its name
  // in the panel header says so, and opens the activity on demand.
  const [showActivity, setShowActivity] = useState(false);
  const headerSlot = useDeckHeaderSlot();
  const activityToggle = (busy || showActivity) && headerSlot ? createPortal(
    <button
      type="button"
      onClick={() => setShowActivity((v) => !v)}
      aria-expanded={showActivity}
      aria-label={t(showActivity ? 'moa.panel.activityHide' : 'moa.panel.activityShow')}
      title={t(showActivity ? 'moa.panel.activityHide' : 'moa.panel.activityShow')}
      className={`wmux-moa-working order-first inline-flex items-center gap-1.5 h-6 px-1.5 rounded-[6px] text-[11px] text-[var(--text-sub)] hover:bg-[var(--hover-fill)] ${FOCUS_RING}`}
      data-moa-working-toggle
    >
      {busy && <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[var(--text-sub)]" />}
      {busy ? t('moa.panel.working') : t('moa.panel.activity')}
    </button>,
    headerSlot,
  ) : null;
  return (
    <MoaDockContext.Provider value={dockEl}>
    <ChatPtyContext.Provider value={ptyId}>
      <ChatCodeBlockContext.Provider value={bridge?.codeBlock ?? null}>
      <AssistantRuntimeProvider runtime={runtime}>
        {activityToggle}
        <div className="flex flex-col flex-1 min-h-0" data-moa-chat data-activity={showActivity ? 'shown' : 'hidden'}>
          <Thread
            composer={runtime.thread.composer}
            empty={empty}
            working={busy}
            disabled={busy}
            placeholder={t('moa.panel.placeholder')}
            hint={busy ? t('moa.panel.busy') : undefined}
            history={<>
              {top && <div className="wmux-moa-chat-top" data-moa-chat-top>{top}</div>}
              {data.hasMore && !data.loading && (
                <button type="button" className="wmux-chat-earlier ui-btn" disabled={data.loadingEarlier} onClick={() => void data.loadEarlier()}>
                  {data.loadingEarlier ? t('chat.loading') : t('chat.loadEarlier')}
                </button>
              )}
            </>}
            // A snapshot that is not there yet (no brain turn so far) reads as
            // a quiet empty conversation, not a connection error.
            welcome={!empty ? null : data.loading
              ? <div className="wmux-chat-empty" role="status">{t('chat.loading')}</div>
              // The brain is up but its first turn has not written a transcript.
              : data.status.reason === 'no-transcript-path'
              ? <div className="wmux-chat-empty" role="status" data-moa-chat-starting>{t('moa.panel.chatStarting')}</div>
              : <div className="wmux-chat-empty" data-moa-chat-empty><strong>{t('moa.panel.chatEmpty')}</strong><p>{t('moa.panel.chatEmptyHint')}</p></div>}
            pending={pending.map((item) => (
              <div key={item.id} className="wmux-chat-message wmux-chat-user wmux-chat-pending" data-moa-chat-pending>
                <UserText>{item.text}</UserText>
                <p className="wmux-chat-pending-caption">{t('chat.pendingSent')}</p>
              </div>
            ))}
            stop={busy && (
              <button type="button" className="wmux-chat-stop" onClick={onInterrupt} aria-label={t('chat.stop')} title={t('chat.stopTitle')} data-moa-chat-stop>
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
                {t('chat.stop')}
              </button>
            )}
            notices={<>
              {/* Decisions and hand-off cards (Waiting on you) dock here,
                  above the composer: sticky with it, the chat scrolling
                  above them. */}
              <div ref={setDockEl} className="wmux-moa-dock" data-moa-dock />
              {/* A dialog only the TUI shows holds the turn (and so the
                  composer): this is the one way forward, drawn as a
                  needs-you row with the action, not a footnote. */}
              {showPrompt && (
                <div className={`${NEEDS_YOU_ROW} mx-3 my-1.5 flex flex-col gap-2 text-[13px] text-[var(--text-main)]`} role="status" data-moa-chat-terminal-hint>
                  {approval ? (
                    <div className="min-w-0 flex flex-col gap-1" data-moa-chat-approval={approval.id}>
                      <span className="font-medium">{approval.question ?? t('moa.panel.approvalTitle', { tool: approval.toolName ?? '' })}</span>
                      {approval.toolName && approval.question && <span className="text-[12px] text-[var(--text-sub)]">{approval.toolName}</span>}
                      {approval.summary && <code className="font-mono text-[12px] text-[var(--text-sub)] break-all whitespace-pre-wrap" data-moa-chat-approval-summary>{approval.summary}</code>}
                      {approval.answered && <span className="text-[12px] text-[var(--text-sub)]" data-moa-chat-approval-answered>{t('moa.panel.approvalAnswered')}</span>}
                    </div>
                  ) : (
                    <span className="min-w-0">{t('moa.panel.terminalHint')}</span>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {approval?.answerable && approval.choices?.map((choice) => (
                      <Button key={choice.key} variant="secondary" size="sm" disabled={answering}
                        onClick={() => { void answerApproval(choice.key); }} data-moa-chat-approval-choice={choice.key}>
                        {choice.label}
                      </Button>
                    ))}
                    <Button variant="secondary" size="sm" onClick={onTerminal} data-moa-chat-answer-in-terminal>{t('moa.panel.answerInTerminal')}</Button>
                  </div>
                  {approvalNotice && (
                    <span className={`text-[12px] ${approvalNotice.kind === 'error' ? 'text-[var(--accent-red)]' : 'text-[var(--text-sub)]'}`} role="alert" data-moa-chat-approval-notice={approvalNotice.kind}>
                      {t(approvalNotice.kind === 'retry' ? 'moa.panel.approvalTooSoon' : 'moa.panel.approvalFailed')}
                    </span>
                  )}
                </div>
              )}
              {data.error && !empty && (
                <div className="wmux-chat-notice" role="alert">
                  {t('chat.connectionError')} <button type="button" onClick={data.retry}>{t('chat.retry')}</button>
                </div>
              )}
            </>}
          />
        </div>
      </AssistantRuntimeProvider>
      </ChatCodeBlockContext.Provider>
    </ChatPtyContext.Provider>
    </MoaDockContext.Provider>
  );
}

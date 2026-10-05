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
import { ChatCodeBlockContext, ChatPtyContext, ChatRowRendererContext, UserText } from '../../Chat/ChatMessage';
import type { ChatRow } from '../../Chat/chatMessages';
import { useMoaDecisions, useWorkLinks, type MoaDecisionsApi, type WorkLinksApi } from './useMoaPanelData';
import { MoaPurposeCard, isPurposeEventId, liftPurposeEvents, purposeWaits } from './MoaPurposeCard';
import { MoaReportCard, moaResultEvents, resultLinkId, withResultEvents, type MoaTaskResultApi } from './MoaResultCard';
import { foldMoaReports, foldNarration, reportIdOf } from './moaChatShape';
import { openMoaPane } from './MoaPanelTop';
import { Thread } from '../../Chat/assistant-ui/Thread';
import { useComposerDraft } from '../../Chat/chatDrafts';
import Button from '../../ui/Button';
import { MoaDockContext, NEEDS_YOU_ROW } from './MoaWaitingOnYou';
import { useDeckHeaderSlot } from '../../Deck/deckHeaderSlot';
import { FOCUS_RING } from '../../focusRing';
import type { ChatBridgeApi, TurnEvent } from '../../../../shared/transcript/turnEvents';
import type { MoaApproval } from '../../../../shared/moa';
import '../moa.css';

/** The preload's `deck.moa.transcript` (main reads the HQ brain; no pty id). */
export type MoaTranscriptApi = NonNullable<NonNullable<NonNullable<Window['electronAPI']>['deck']>['moa']>['transcript'];

type MoaPreload = NonNullable<NonNullable<NonNullable<Window['electronAPI']>['deck']>['moa']>;
/** The preload's Moa prompt calls (#1772): read, answer, and main's change signal. */
export type MoaApprovalApi = Pick<MoaPreload, 'approval' | 'approvalAnswer'> & Partial<Pick<MoaPreload, 'onChanged'>>;

/** While Moa waits on its prompt: how often its record is read again (it trails the hook by ~1 s). */
const APPROVAL_POLL_MS = 2_000;
/** A turn the store opened this recently, while no chat was mounted, is the operator's send. */
const FIRST_SEND_WINDOW_MS = 60_000;
/** Pages read back on open to reach the operator's first message. */
const AUTO_PAGES = 6;

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

/**
 * The prompts main types for Moa itself (pane events, a fleet snapshot, the
 * decision resume lines, Wake, a loop's kickoff, the startup reconcile) are not
 * the operator's words: they never draw as a user bubble. Each becomes an
 * invisible turn start, so the turn still begins there.
 */
// Start-anchored, and only openings main itself writes: an operator prompt
// (even one main prefixed with context blocks) never matches.
const MOA_WAKE_TEXT = new RegExp('^\\s*(?:' + [
  String.raw`\[pane-events\]`,
  String.raw`\[fleet-snapshot\]`,
  String.raw`The operator (?:just resolved|DISMISSED) the decision you raised`,
  String.raw`A decision you (?:SELF-RESOLVED|raised has been pending too long)`,
  String.raw`The operator pressed the Wake button`,
  String.raw`The loop above has just started`,
  String.raw`A human request is still active after wmux startup`,
].join('|') + ')');
const WAKE_PREFIX = 'moa-wake:';

export function hideMoaWakes(events: readonly TurnEvent[]): TurnEvent[] {
  return events.map((e) => (e.kind === 'user_text' && MOA_WAKE_TEXT.test(e.text)
    ? { id: `${WAKE_PREFIX}${e.id}`, kind: 'meta' as const, subtype: 'turn_started' as const, label: '', ...(e.ts !== undefined ? { ts: e.ts } : {}) }
    : e));
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
  /** Injected in tests; default to the preload. */
  linksApi?: WorkLinksApi;
  resultApi?: MoaTaskResultApi;
  decisionsApi?: MoaDecisionsApi;
}

/** A sent bubble; `failed` holds the reason once main refused it late (after
 *  the composer had already taken the send as accepted). */
interface Pending { id: string; text: string; before: ReadonlySet<string>; failed?: string }

/**
 * The bubbles left when a turn ends without the transcript recording them.
 * A send main refused after the composer's verdict window closes the store's
 * open turn with an error: that bubble stays, marked not sent with its reason,
 * so the message is never lost silently. Any other leftover goes.
 */
export function settleOnTurnEnd(pending: readonly Pending[], thread: { messages: ReadonlyArray<{ role: string; text: string; status?: string; errorText?: string }> } | undefined): Pending[] {
  const messages = thread?.messages ?? [];
  return pending.flatMap((p) => {
    if (p.failed) return [p];
    const at = messages.map((m) => m.role === 'user' && m.text === p.text).lastIndexOf(true);
    const reply = at >= 0 ? messages[at + 1] : undefined;
    return reply?.status === 'error' ? [{ ...p, failed: reply.errorText || '' }] : [];
  });
}

export default function MoaTranscriptChat({ ptyId, busy, onSend, onInterrupt, onTerminal, top, api, approvalApi, linksApi, resultApi, decisionsApi }: MoaTranscriptChatProps) {
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
  // Delegated work that finished shows as a result card where it finished.
  const links = useWorkLinks(true, linksApi ?? window.electronAPI?.workLinks);
  const since = useMemo(() => data.events.find((e) => typeof e.ts === 'number')?.ts, [data.events]);
  // Moa's own hand-offs, decisions, completions and fan-outs read as purpose
  // cards, lifted out before the chat folds tool rows.
  const lifted = useMemo(() => liftPurposeEvents(hideMoaWakes(data.events)), [data.events]);
  const { decisions: pendingDecisions } = useMoaDecisions(true, decisionsApi);
  // One report per finished job, and only each turn's last reply as a
  // message: narration folds into the activity (moaChatShape).
  const folded = useMemo(() => foldMoaReports(withResultEvents(lifted.events, moaResultEvents(links, since)), lifted.purposes), [lifted, links, since]);
  const shownEvents = useMemo(() => foldNarration(folded.events), [folded.events]);
  const messages = useMemo(() => transcriptMessages(shownEvents, true), [shownEvents]);
  const results = resultApi ?? window.electronAPI?.deck?.moa;
  const wsNames = useStore((s) => s.workspaces);
  // Tool activity (folded tool rows, "The agent is working…") is hidden: the
  // chat reads as messages. While Moa works, a small control beside its name
  // in the panel header says so, and opens the activity on demand.
  const [showActivity, setShowActivity] = useState(false);
  const renderRow = useCallback((row: ChatRow) => {
    if (row.event.id.startsWith(WAKE_PREFIX)) return <></>;
    if (isPurposeEventId(row.event.id)) {
      const purpose = lifted.purposes.get(row.event.id);
      // A call that did not go through is Moa's own retry, not news: it shows
      // with the rest of the activity.
      if (!purpose || (purpose.ok === false && !showActivity)) return <></>;
      return <MoaPurposeCard purpose={purpose} waiting={purposeWaits(purpose, pendingDecisions)} t={t} />;
    }
    const workspaceName = (id: string) => wsNames.find((w) => w.id === id)?.name;
    const api = results as MoaTaskResultApi | undefined;
    const reportId = reportIdOf(row.event.id);
    if (reportId) {
      const report = folded.reports.get(reportId);
      if (!report) return <></>;
      const reported = report.linkIds.flatMap((id) => links.filter((l) => l.id === id));
      return <MoaReportCard report={report} links={reported} workspaceName={workspaceName} api={api} onOpen={openMoaPane} t={t} />;
    }
    const id = resultLinkId(row.event.id);
    const link = id ? links.find((l) => l.id === id) : undefined;
    if (!link) return id ? <></> : null;
    return <MoaReportCard links={[link]} workspaceName={workspaceName} api={api} onOpen={openMoaPane} t={t} />;
  }, [lifted, folded, pendingDecisions, links, wsNames, results, showActivity, t]);
  const [pending, setPending] = useState<Pending[]>([]);
  // The first page is a byte window of the brain's transcript; one exchange
  // with Moa's context and tool output can fill it, which hid the operator's
  // own first message behind "Load earlier messages". Page back on our own
  // until an operator message is in view (bounded).
  const autoPages = useRef(0);
  const { hasMore, loading, loadingEarlier, loadEarlier } = data;
  const operatorShown = useMemo(() => data.events.some((e) => e.kind === 'user_text' && !MOA_WAKE_TEXT.test(e.text)), [data.events]);
  useEffect(() => {
    if (operatorShown || !hasMore || loading || loadingEarlier || autoPages.current >= AUTO_PAGES) return;
    autoPages.current += 1;
    void loadEarlier();
  }, [operatorShown, hasMore, loading, loadingEarlier, loadEarlier]);
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
      const live = current.filter((p) => !p.failed);
      if (live.length === 0) return current;
      const fresh = data.events.filter((e) => e.kind === 'user_text' && !live[0].before.has(e.id));
      if (!fresh.length) return current;
      const settled = new Set(live.slice(0, fresh.length).map((p) => p.id));
      return current.filter((p) => !settled.has(p.id));
    });
  }, [data.events]);
  useEffect(() => {
    if (busy) return;
    const thread = hqId ? useStore.getState().brainThreads[hqId] : undefined;
    setPending((current) => {
      const next = settleOnTurnEnd(current, thread);
      return next.length === 0 && current.length === 0 ? current : next;
    });
  }, [busy, hqId]);
  // The first message is sent from the panel's bare composer, before Moa's
  // brain (and so this chat) exists: its words are the open turn main's send
  // recorded in the store. Shown once as the sent bubble, so the panel does not
  // sit blank (or on the first-run guidance) while the brain starts.
  const openTurnText = useStore((s) => {
    if (!hqId) return null;
    const last = s.brainThreads[hqId]?.messages.findLast((m) => m.role === 'user');
    return last && Date.now() - (last.ts ?? 0) < FIRST_SEND_WINDOW_MS ? last.text : null;
  });
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !busy || data.loading || !openTurnText?.trim() || MOA_WAKE_TEXT.test(openTurnText)) return;
    seeded.current = true;
    const users = data.events.filter((e) => e.kind === 'user_text');
    if (users.some((e) => e.kind === 'user_text' && e.text.trim() === openTurnText.trim())) return;
    setPending((current) => (current.length ? current
      : [{ id: crypto.randomUUID(), text: openTurnText, before: new Set(users.map((e) => e.id)) }]));
  }, [busy, data.loading, data.events, openTurnText]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    if (!text.trim()) return;
    if (busy) throw new MessageNotSentError(t('moa.panel.busy'));
    // Sending again settles an earlier refusal of the same words.
    setPending((current) => current.filter((p) => !(p.failed !== undefined && p.text === text)));
    const before = new Set(data.events.filter((e) => e.kind === 'user_text').map((e) => e.id));
    // /clear and /reset are commands, not messages: nothing to wait for.
    const command = /^\/(clear|reset)$/.test(text.trim());
    // The bubble shows the moment the operator sends, not when the brain's
    // transcript records the prompt (seconds later). The settle effect drops
    // it once that row lands, even while onSend is still in flight.
    const id = crypto.randomUUID();
    if (!command) setPending((current) => [...current, { id, text, before }].slice(-4));
    const result = await onSend(text).catch(() => ({ ok: false }));
    if (!result.ok) {
      setPending((current) => current.filter((p) => p.id !== id));
      throw new MessageNotSentError(t('moa.panel.sendFailed'));
    }
    // The prompt landed while onSend was in flight: no bubble beside the row.
    if (eventsRef.current.some((e) => e.kind === 'user_text' && !before.has(e.id))) {
      setPending((current) => current.filter((p) => p.id !== id));
    }
  }, [busy, data.events, onSend, t]);

  const runtime = useExternalStoreRuntime({ messages, isRunning: false, isLoading: data.loading, isSendDisabled: busy, onNew });
  // A late refusal puts the words back in the composer (when it is empty),
  // so a retry is one Enter away even if the bubble is dismissed.
  const restored = useRef(new Set<string>());
  useEffect(() => {
    for (const p of pending) {
      if (p.failed === undefined || restored.current.has(p.id)) continue;
      restored.current.add(p.id);
      const composer = runtime.thread.composer;
      if (!composer.getState().text.trim()) composer.setText(p.text);
    }
  }, [pending, runtime]);
  const retrySend = useCallback((item: Pending) => {
    runtime.thread.composer.setText('');
    void onNew({ content: [{ type: 'text', text: item.text }] } as unknown as AppendMessage).catch(() => {
      // Refused at once: the bubble is gone, so put the words back.
      runtime.thread.composer.setText(item.text);
    });
  }, [onNew, runtime]);
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
  // Hidden wakes and bare markers are rows too: the conversation is empty
  // until something the operator can read is in it.
  const empty = pending.length === 0 && !shownEvents.some((e) => e.kind === 'user_text' || (e.kind === 'assistant_text' && !e.thinking)
    || isPurposeEventId(e.id) || !!reportIdOf(e.id) || !!resultLinkId(e.id));
  // A callback ref: the dock mounts with the composer's footer.
  const [dockEl, setDockEl] = useState<HTMLDivElement | null>(null);
  const headerSlot = useDeckHeaderSlot();
  // Shown while Moa works and whenever there is folded activity to open, so a
  // finished turn's steps stay reachable.
  const hasActivity = useMemo(
    () => messages.some((m) => {
      const row = (m.metadata?.custom as { row?: ChatRow } | undefined)?.row;
      if (!row) return false;
      if (row.activity) return true;
      // A failed call sits outside the fold but is activity all the same.
      const { event } = row;
      return event.kind === 'tool_use' ? row.result?.ok === false
        : event.kind === 'tool_result' ? !event.ok
        : isPurposeEventId(event.id) && lifted.purposes.get(event.id)?.ok === false;
    }),
    [messages, lifted],
  );
  // Idle, the control only opens what Moa did: it never says Moa is working.
  const activityLabel = t(showActivity ? 'moa.panel.activityHide' : busy ? 'moa.panel.activityShow' : 'moa.panel.activityShowIdle');
  const activityToggle = (busy || showActivity || hasActivity) && headerSlot ? createPortal(
    <button
      type="button"
      onClick={() => setShowActivity((v) => !v)}
      aria-expanded={showActivity}
      aria-label={activityLabel}
      title={activityLabel}
      // A dot, not a word: the header row has no room beside "Main bot" at
      // the dock's width. The label and tooltip say what it is.
      className={`wmux-moa-working order-first inline-flex items-center justify-center w-6 h-6 rounded-[6px] hover:bg-[var(--hover-fill)] ${showActivity ? 'bg-[var(--selection-emphasis)]' : ''} ${FOCUS_RING}`}
      data-moa-working-toggle
      data-busy={busy ? 'true' : undefined}
    >
      <span aria-hidden="true" className={`w-2 h-2 rounded-full ${busy ? 'bg-[var(--text-sub)]' : 'border border-[var(--text-sub)]'}`} />
    </button>,
    headerSlot,
  ) : null;
  return (
    <MoaDockContext.Provider value={dockEl}>
    <ChatPtyContext.Provider value={ptyId}>
      <ChatCodeBlockContext.Provider value={bridge?.codeBlock ?? null}>
      <ChatRowRendererContext.Provider value={renderRow}>
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
                {item.failed === undefined
                  ? <p className="wmux-chat-pending-caption">{t('chat.pendingSent')}</p>
                  : <p className="wmux-chat-pending-caption" role="alert" data-moa-chat-not-sent>
                      {item.failed ? t('moa.panel.notSentReason', { reason: item.failed }) : t('moa.panel.notSent')}{' '}
                      <button type="button" className="underline underline-offset-2" disabled={busy} onClick={() => retrySend(item)} data-moa-chat-retry>
                        {t('moa.panel.retrySend')}
                      </button>
                    </p>}
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
      </ChatRowRendererContext.Provider>
      </ChatCodeBlockContext.Provider>
    </ChatPtyContext.Provider>
    </MoaDockContext.Provider>
  );
}

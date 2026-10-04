// Moa's conversation as chat bubbles, over the HQ brain's terminal. The data
// is the brain's own transcript (deck.moa.transcript), read through the same
// useTranscript state machine and rendered by the same Chat components a
// normal pane's Chat view uses: this file only adapts the source and routes
// the composer to deck.send, so there is one parser and one look.
//
// Loaded lazily (like ChatView): assistant-ui stays out of the main bundle
// until Moa's panel actually shows a conversation.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider, MessageNotSentError, useExternalStoreRuntime, type AppendMessage } from '@assistant-ui/react';
import { useT } from '../../../hooks/useT';
import { useStore } from '../../../stores';
import { useTranscript } from '../../Chat/useTranscript';
import { transcriptMessages } from '../../Chat/chatMessages';
import { ChatCodeBlockContext, ChatPtyContext, UserText } from '../../Chat/ChatMessage';
import { Thread } from '../../Chat/assistant-ui/Thread';
import type { ChatBridgeApi } from '../../../../shared/transcript/turnEvents';

/** The preload's `deck.moa.transcript` (main reads the HQ brain; no pty id). */
export type MoaTranscriptApi = NonNullable<NonNullable<NonNullable<Window['electronAPI']>['deck']>['moa']>['transcript'];

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
  /** Injected in tests; defaults to the preload. */
  api?: MoaTranscriptApi;
}

interface Pending { id: string; text: string; before: ReadonlySet<string> }

export default function MoaTranscriptChat({ ptyId, busy, onSend, onInterrupt, onTerminal, api }: MoaTranscriptChatProps) {
  const t = useT();
  const source = api ?? window.electronAPI?.deck?.moa?.transcript;
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
    setPending((current) => [...current, { id: crypto.randomUUID(), text, before }].slice(-4));
  }, [busy, data.events, onSend, t]);

  const runtime = useExternalStoreRuntime({ messages, isRunning: false, isLoading: data.loading, isSendDisabled: busy, onNew });

  // Waiting on a permission prompt (or any dialog) that only the TUI shows.
  // Main's appends carry no status on this path, so `agentStatus` refreshes
  // on useTranscript's 5 s poll: the hint can trail the prompt by up to ~5 s.
  const awaitingTerminal = data.status.agentStatus === 'awaiting_input' || (data.blocked && data.status.available && !data.loading && !data.error);
  const empty = messages.length === 0 && pending.length === 0;
  return (
    <ChatPtyContext.Provider value={ptyId}>
      <ChatCodeBlockContext.Provider value={bridge?.codeBlock ?? null}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="flex flex-col flex-1 min-h-0" data-moa-chat>
          <Thread
            composer={runtime.thread.composer}
            empty={empty}
            working={busy}
            disabled={busy}
            placeholder={t('moa.panel.placeholder')}
            hint={busy ? t('moa.panel.busy') : undefined}
            history={data.hasMore && !data.loading && (
              <button type="button" className="wmux-chat-earlier ui-btn" disabled={data.loadingEarlier} onClick={() => void data.loadEarlier()}>
                {data.loadingEarlier ? t('chat.loading') : t('chat.loadEarlier')}
              </button>
            )}
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
              {awaitingTerminal && (
                <div className="wmux-chat-notice" role="status" data-moa-chat-terminal-hint>
                  {t('moa.panel.terminalHint')}{' '}
                  <button type="button" onClick={onTerminal}>{t('moa.panel.viewAsTerminal')}</button>
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
  );
}

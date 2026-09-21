import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider, MessageNotSentError, useExternalStoreRuntime, type AppendMessage } from '@assistant-ui/react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useTranscript } from './useTranscript';
import { transcriptMessages } from './chatMessages';
import { ChatPtyContext } from './ChatMessage';

import { chatRunState } from './chatRunState';
import { ChatProgress } from './ChatProgress';
import { Thread } from './assistant-ui/Thread';

// Drafts survive view/workspace changes, but never cross conversation boundaries.
const drafts = new Map<string, string>();

export default function ChatView({ ptyId, active, onTerminal }: { ptyId: string; active: boolean; onTerminal: () => void }) {
  const data = useTranscript(ptyId, active);
  // Remount runtime/draft state on a new conversation within the same PTY.
  return <ChatThread key={`${ptyId}:${data.status.agentSessionId ?? ''}`} ptyId={ptyId} data={data} onTerminal={onTerminal} />;
}

function ChatThread({ ptyId, data, onTerminal }: { ptyId: string; data: ReturnType<typeof useTranscript>; onTerminal: () => void }) {
  const t = useT();
  const [sendState, setSendState] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const sentAfterUser = useRef<string | undefined>(undefined);
  const agentStatus = useStore((s) => s.surfaceAgentStatus[ptyId]);
  const turnOpenAt = useStore((s) => s.surfaceTurnOpenAt?.[ptyId]);
  const blocked = data.blocked || agentStatus === 'awaiting_input' || data.status.agentStatus === 'awaiting_input';
  const progress = chatRunState({ ...data, available: data.status.available, agentAlive: data.status.agentAlive,
    sending, sent: sendState === 'sent', blocked, turnOpen: !!turnOpenAt, status: agentStatus ?? data.status.agentStatus });
  const busy = progress === 'working' || progress === 'waiting';
  // An exited agent leaves saved history; a live-looking composer would invite a message to nobody.
  const ended = progress === 'ended';
  const uncertain = progress === 'unconfirmed' || sendState === 'error' || sendState === 'unconfirmed';
  const messages = useMemo(() => transcriptMessages(data.events), [data.events]);
  const latestUser = [...data.events].reverse().find((event) => event.kind === 'user_text')?.id;
  // The tail page is cut by bytes, so a reply can arrive without the prompt
  // that produced it. Page back, bounded, until the thread opens on a request.
  const autoEarlier = useRef(0);
  const { hasMore, loading, loadingEarlier, error, loadEarlier } = data;
  useEffect(() => {
    if (latestUser || !hasMore || loading || loadingEarlier || error || !data.events.length || autoEarlier.current >= 3) return;
    autoEarlier.current++;
    void loadEarlier();
  }, [latestUser, hasMore, loading, loadingEarlier, error, data.events.length, loadEarlier]);
  useEffect(() => {
    if (sendState && latestUser !== sentAfterUser.current) setSendState(null);
  }, [latestUser, sendState]);
  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    if (inFlight.current || busy || blocked || uncertain || data.status.agentAlive === false || data.error || !data.status.agentSessionId || !data.status.available) {
      throw new MessageNotSentError(t('chat.sendUnavailable'));
    }
    sentAfterUser.current = latestUser;
    inFlight.current = true; setSending(true); setSendState(null);
    try {
      const response = await window.electronAPI.chat.send({ ptyId, agentSessionId: data.status.agentSessionId, text });
      if (response.result !== 'sent') {
        setSendState(response.result);
        // Keep the draft on a refused/uncertain delivery. The error text makes
        // partial delivery explicit; it is never retried automatically.
        throw new MessageNotSentError(t(`chat.send.${response.result}`));
      }
      setSendState('sent');
    } catch (error) {
      if (error instanceof MessageNotSentError) throw error;
      setSendState('error');
      throw new MessageNotSentError(t('chat.send.error'));
    } finally { inFlight.current = false; setSending(false); }
  }, [busy, blocked, uncertain, data.status.agentAlive, data.error, data.status.agentSessionId, data.status.available, latestUser, ptyId, t]);
  const runtime = useExternalStoreRuntime({ messages, isRunning: busy || sending, isLoading: data.loading,
    isSendDisabled: blocked || busy || uncertain || data.error || !data.status.available || data.status.agentAlive === false || sending, onNew });
  useEffect(() => {
    const session = data.status.agentSessionId;
    if (!session) return;
    const key = `${ptyId}:${session}`;
    const composer = runtime.thread.composer;
    composer.setText(drafts.get(key) ?? '');
    return composer.subscribe(() => {
      const text = composer.getState().text;
      drafts.delete(key);
      if (text) drafts.set(key, text);
      if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
    });
  }, [runtime, ptyId, data.status.agentSessionId]);
  const reasonKey = ['no-hook', 'stale-session', 'no-transcript-path', 'not-claude', 'unsafe-transcript-path', 'unreadable'].includes(data.status.reason)
    ? `chat.reason.${data.status.reason}` : 'chat.reason.unavailable';
  return <ChatPtyContext.Provider value={ptyId}><AssistantRuntimeProvider runtime={runtime}>
    <Thread status={<ChatProgress state={progress} lastSyncedAt={data.lastSyncedAt} onTerminal={onTerminal} />} empty={messages.length === 0} working={busy} disabled={!data.status.available || data.loading || ended}
      placeholder={ended ? t('chat.placeholderEnded') : undefined}
      history={data.hasMore && <button type="button" className="wmux-chat-earlier ui-btn" disabled={data.loadingEarlier}
        onClick={() => void data.loadEarlier()}>{data.loadingEarlier ? t('chat.loading') : t('chat.loadEarlier')}</button>}
      welcome={data.loading ? <div className="wmux-chat-empty" role="status">{t('chat.loading')}</div>
        : !data.status.available && messages.length === 0 ? <div className="wmux-chat-empty"><strong>{t('chat.unavailable')}</strong><p>{t(reasonKey)}</p>
          <button type="button" className="ui-btn" onClick={onTerminal}>{t('chat.openTerminal')}</button></div>
        : messages.length === 0 ? <div className="wmux-chat-empty"><strong>{t('chat.empty')}</strong><p>{t('chat.emptyHint')}</p></div> : null}
      notices={<>
        {/* A refusal already says why below; one state, one notice. */}
        {uncertain && !sendState && <div className="wmux-chat-notice">{t('chat.send.unconfirmed')}</div>}
        {data.error && <div className="wmux-chat-notice" role="alert">{t('chat.connectionError')} <button type="button" onClick={data.retry}>{t('chat.retry')}</button></div>}
        {blocked && data.status.available && <div className="wmux-chat-notice">{t('chat.approvalHint')} <button type="button" onClick={onTerminal}>{t('chat.openTerminal')}</button></div>}
        {sendState && <div className="wmux-chat-notice" role="status">{t(`chat.send.${sendState}`)}
          {sendState !== 'sent' && <button type="button" onClick={onTerminal}>{t('chat.openTerminal')}</button>}</div>}
      </>} />
  </AssistantRuntimeProvider></ChatPtyContext.Provider>;
}

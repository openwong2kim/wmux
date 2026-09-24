import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider, MessageNotSentError, useExternalStoreRuntime, type AppendMessage } from '@assistant-ui/react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useTranscript } from './useTranscript';
import { transcriptMessages } from './chatMessages';
import { ChatPtyContext } from './ChatMessage';

import { chatRunState } from './chatRunState';
import { ChatProgress } from './ChatProgress';
import { ChatControls } from './ChatControls';
import type { TerminalLaunchAgent, TerminalLaunchMode } from '../../../shared/transcript/terminalChat';
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
  const [launchAgent, setLaunchAgent] = useState<TerminalLaunchAgent>('claude');
  const [launchMode, setLaunchMode] = useState<TerminalLaunchMode>('default');
  const [launched, setLaunched] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const launch = window.electronAPI?.chat?.launchTerminal;
  const canLaunch = !!launch && !data.status.managed && !data.status.available && !data.status.agentSessionId && !data.status.agentAlive &&
    ['no-hook', 'no-binding'].includes(data.status.reason) && !launched;
  const inFlight = useRef(false);
  const sentAfterUser = useRef<string | undefined>(undefined);
  const agentStatus = useStore((s) => s.surfaceAgentStatus[ptyId]);
  const turnOpenAt = useStore((s) => s.surfaceTurnOpenAt?.[ptyId]);
  const managed = data.status.managed;
  const nativeTui = data.status.terminal?.agent === 'opencode';
  const readOnly = data.status.terminal?.capabilities.send === false;
  const blocked = managed ? managed.phase === 'blocked' : nativeTui ? data.status.agentStatus === 'awaiting_input' : data.blocked || agentStatus === 'awaiting_input' || data.status.agentStatus === 'awaiting_input';
  const legacyProgress = chatRunState({ ...data, available: data.status.available, agentAlive: data.status.agentAlive,
    sending, sent: sendState === 'sent', blocked, turnOpen: nativeTui ? false : !!turnOpenAt, status: nativeTui ? data.status.agentStatus : agentStatus ?? data.status.agentStatus });
  const progress = managed ? ({ connecting: 'connecting', ready: 'ready', running: 'working', blocked: 'blocked', disconnected: 'disconnected', unconfirmed: 'unconfirmed' } as const)[managed.phase] : legacyProgress;
  const busy = progress === 'working' || progress === 'waiting';
  const ended = progress === 'ended';
  const uncertain = managed ? ['unconfirmed', 'disconnected', 'connecting'].includes(managed.phase) : progress === 'unconfirmed' || sendState === 'error' || sendState === 'unconfirmed';
  const messages = useMemo(() => transcriptMessages(data.events, true), [data.events]);
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
    if (text.trim() === '/' || text.trim() === '$') throw new MessageNotSentError(t('chat.skillsHint'));
    if (canLaunch && launch) {
      if (inFlight.current || data.loading) throw new MessageNotSentError(t('chat.sendUnavailable'));
      inFlight.current = true; setSending(true); setLaunchError('');
      try {
        const result = await launch({ ptyId, agent: launchAgent, mode: launchMode, prompt: text });
        if (!result.ok) throw new MessageNotSentError(result.error ?? t('chat.controlFailed'));
        setLaunched(true); data.retry();
      } catch (error) {
        const message = error instanceof MessageNotSentError ? error.message : t('chat.controlFailed');
        setLaunchError(message);
        throw new MessageNotSentError(message);
      } finally { inFlight.current = false; setSending(false); }
      return;
    }
    if (inFlight.current || readOnly || busy || blocked || uncertain || data.status.agentAlive === false || data.error || !data.status.agentSessionId || !data.status.available) {
      throw new MessageNotSentError(t('chat.sendUnavailable'));
    }
    sentAfterUser.current = latestUser;
    inFlight.current = true; setSending(true); setSendState(null);
    try {
      const response = await window.electronAPI.chat.send({ ptyId, agentSessionId: data.status.agentSessionId, text, ...((managed || data.status.terminal) ? { requestId: crypto.randomUUID() } : {}) });
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
  }, [canLaunch, launch, launchAgent, launchMode, data.loading, data.retry, readOnly, busy, blocked, uncertain, data.status.agentAlive, data.error, data.status.agentSessionId, data.status.available, latestUser, ptyId, t, managed]);
  const runtime = useExternalStoreRuntime({ messages, isRunning: busy || sending, isLoading: data.loading,
    isSendDisabled: canLaunch ? sending || data.loading : launched || readOnly || blocked || busy || uncertain || data.error || !data.status.available || data.status.agentAlive === false || sending, onNew });
  useEffect(() => {
    const session = data.status.agentSessionId ?? 'new';
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
    <Thread composer={runtime.thread.composer} status={<><ChatProgress state={canLaunch ? 'ready' : progress} lastSyncedAt={data.lastSyncedAt} onTerminal={onTerminal} /><ChatControls ptyId={ptyId} status={data.status} refresh={data.retry} /></>} empty={messages.length === 0} working={busy} disabled={canLaunch ? sending || data.loading : launched || readOnly || !data.status.available || data.loading || ended || !!managed && (managed.phase !== 'ready' || !managed.capabilities.send)}
      placeholder={canLaunch ? t('chat.initialMessage') : ended ? t('chat.placeholderEnded') : undefined}
      skillScope={!managed ? { ptyId, agent: canLaunch ? launchAgent : data.status.terminal?.agent ?? 'claude', composer: runtime.thread.composer, onTerminal, live: !!data.status.agentAlive } : undefined}
      maxLength={canLaunch ? 2000 : 16_000}
      composerOptions={canLaunch && <div className="wmux-chat-launch-options">
        <select aria-label={t('chat.provider')} value={launchAgent} disabled={sending} onChange={event => {
          setLaunchAgent(event.target.value as TerminalLaunchAgent); setLaunchMode('default');
        }}><option value="claude">Claude</option><option value="codex">Codex</option></select>
        <select aria-label={t('chat.launchMode')} value={launchMode} disabled={sending} onChange={event => setLaunchMode(event.target.value as TerminalLaunchMode)}>
          <option value="default">{t('chat.modeDefault')}</option>
          {launchAgent === 'claude' ? <option value="bypass">{t('chat.modeBypass')}</option> : <option value="yolo">{t('chat.modeYolo')}</option>}
        </select>
      </div>}
      history={data.hasMore && !data.loading && <button type="button" className="wmux-chat-earlier ui-btn" disabled={data.loadingEarlier}
        onClick={() => void data.loadEarlier()}>{data.loadingEarlier ? t('chat.loading') : t('chat.loadEarlier')}</button>}
      welcome={data.loading && messages.length === 0 ? <div className="wmux-chat-empty" role="status">{t('chat.loading')}</div>
        : canLaunch ? <div className="wmux-chat-empty"><strong>{t('chat.startNew')}</strong><p>{t('chat.chooseAgentHint')}</p></div>
        : !data.status.available && messages.length === 0 ? <div className="wmux-chat-empty"><strong>{t('chat.unavailable')}</strong><p>{t(reasonKey)}</p>
          <button type="button" className="ui-btn" onClick={onTerminal}>{t('chat.openTerminal')}</button></div>
        : messages.length === 0 ? <div className="wmux-chat-empty"><strong>{t('chat.empty')}</strong><p>{t('chat.emptyHint')}</p></div> : null}
      notices={<>
        {launched && <div className="wmux-chat-notice" role="status">{t('chat.terminalStarting')} <button type="button" onClick={onTerminal}>{t('chat.openTerminal')}</button></div>}
        {launchError && <div className="wmux-chat-notice" role="alert">{launchError}</div>}
        {data.status.terminal?.historyTruncated && <div className="wmux-chat-notice">{t('chat.retentionLimit')}</div>}
        {/* A refusal already says why below; one state, one notice. */}
        {uncertain && !managed && !sendState && <div className="wmux-chat-notice">{t('chat.send.unconfirmed')}</div>}
        {data.error && <div className="wmux-chat-notice" role="alert">{t('chat.connectionError')} <button type="button" onClick={data.retry}>{t('chat.retry')}</button></div>}
        {blocked && !managed && data.status.available && <div className="wmux-chat-notice">{t('chat.approvalHint')} <button type="button" onClick={onTerminal}>{t('chat.openTerminal')}</button></div>}
        {sendState && <div className="wmux-chat-notice" role="status">{t(`chat.send.${sendState}`)}
          {sendState !== 'sent' && <button type="button" onClick={onTerminal}>{t('chat.openTerminal')}</button>}</div>}
      </>} />
  </AssistantRuntimeProvider></ChatPtyContext.Provider>;
}

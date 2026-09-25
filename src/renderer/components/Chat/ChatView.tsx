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
import type { TurnEvent } from '../../../shared/transcript/turnEvents';
import { registerChatDropTarget, withoutImageTokens, type ChatAttachment } from './chatAttachments';
import { ChatAttachmentChips, ChatSentImages } from './ChatAttachmentViews';
import { CHAT_ATTACHMENT_LIMIT } from '../../../shared/transcript/chatAttachments';

// Drafts survive view/workspace changes, but never cross conversation boundaries.
const drafts = new Map<string, string>();
const attachmentDrafts = new Map<string, ChatAttachment[]>();
// Queued sends outlive a switch to Terminal and back until Claude records them.
const pendingSends = new Map<string, PendingSend[]>();

/** A sent message the transcript has not recorded yet (Claude records a queued one when it runs it). */
interface PendingSend { id: string; text: string; images: ChatAttachment[]; queued: boolean; before: ReadonlySet<string> }
type StopState = 'stopping' | 'stopped' | 'kept' | 'not_running' | 'blocked' | 'failed';
const STOP_CONFIRM_MS = 10_000;
const STOP_NOTICE_MS = 8_000;
const sameMessage = (a: string, b: string) => withoutImageTokens(a).replace(/\s+/g, ' ') === withoutImageTokens(b).replace(/\s+/g, ' ');
const lastAborted = (events: readonly TurnEvent[]) => [...events].reverse().find((e) => e.kind === 'meta' && e.subtype === 'turn_aborted')?.id;

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
  const capabilities = managed ? undefined : data.status.terminal?.capabilities;
  // Claude queues a prompt typed mid-turn; other agents are sent to after the reply.
  const canQueue = !!capabilities?.queue;
  const interrupt = window.electronAPI?.chat?.interrupt;
  const canStop = !!capabilities?.cancel && !!interrupt;
  const canAttach = !!capabilities?.images && !!window.electronAPI?.chat?.attachment;
  const draftKey = `${ptyId}:${data.status.agentSessionId ?? 'new'}`;
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => attachmentDrafts.get(draftKey) ?? []);
  const [attachError, setAttachError] = useState('');
  const [pending, setPending] = useState<PendingSend[]>(() => pendingSends.get(draftKey) ?? []);
  const [stopState, setStopState] = useState<StopState | null>(null);
  const stopBase = useRef<string | undefined>(undefined);
  const aborted = lastAborted(data.events);
  useEffect(() => {
    if (attachments.length) attachmentDrafts.set(draftKey, attachments); else attachmentDrafts.delete(draftKey);
  }, [attachments, draftKey]);
  useEffect(() => {
    if (pending.length) pendingSends.set(draftKey, pending); else pendingSends.delete(draftKey);
    if (pendingSends.size > 100) pendingSends.delete(pendingSends.keys().next().value!);
  }, [pending, draftKey]);
  const addPaths = useCallback(async (paths: string[]) => {
    const preview = window.electronAPI?.chat?.attachment;
    if (!canAttach || !preview) { setAttachError(t('chat.attach.unsupported')); return; }
    setAttachError('');
    for (const path of paths) {
      const result = await preview({ path }).catch(() => ({ ok: false, reason: 'missing' } as const));
      const name = path.split(/[\\/]/).pop() || path;
      if (!result.ok) { setAttachError(t(`chat.attach.${result.reason}`, { name })); continue; }
      let full = false;
      setAttachments((current) => {
        if (current.some((item) => item.path === result.path)) return current;
        if (current.length >= CHAT_ATTACHMENT_LIMIT) { full = true; return current; }
        return [...current, { path: result.path, name: result.name, thumbnail: result.thumbnail }];
      });
      if (full) setAttachError(t('chat.attach.limit', { count: CHAT_ATTACHMENT_LIMIT }));
    }
  }, [canAttach, t]);
  const addPathsRef = useRef(addPaths);
  addPathsRef.current = addPaths;
  useEffect(() => registerChatDropTarget(ptyId, (paths) => void addPathsRef.current(paths)), [ptyId]);
  const pasteImage = useCallback(async () => {
    if (!canAttach) { setAttachError(t('chat.attach.unsupported')); return; }
    const path = await window.clipboardAPI?.readImage?.(ptyId).catch(() => null);
    if (path) await addPaths([path]); else setAttachError(t('chat.attach.pasteFailed'));
  }, [addPaths, canAttach, ptyId, t]);
  // A pending bubble leaves once the transcript records the same words as a new
  // user row. One row settles one bubble, oldest first: the same words queued
  // twice stay two bubbles until both are recorded.
  useEffect(() => {
    setPending((current) => {
      const settled = new Set<string>();
      const next = current.filter((item) => {
        const row = data.events.find((e) => e.kind === 'user_text' && !item.before.has(e.id) && !settled.has(e.id) && sameMessage(e.text, item.text));
        if (row) settled.add(row.id);
        return !row;
      });
      return next.length === current.length ? current
        : next.map((item) => ({ ...item, before: new Set([...item.before, ...settled]) }));
    });
  }, [data.events]);
  const stop = useCallback(async () => {
    const agentSessionId = data.status.agentSessionId;
    if (!interrupt || !agentSessionId || stopState === 'stopping') return;
    stopBase.current = aborted;
    setStopState('stopping');
    try {
      const { result } = await interrupt({ ptyId, agentSessionId });
      if (result !== 'sent') setStopState(result === 'not_running' || result === 'blocked' ? result : 'failed');
    } catch { setStopState('failed'); }
  }, [interrupt, data.status.agentSessionId, stopState, aborted, ptyId]);
  // Stopping… ends on the agent's own record of the interrupt or the turn ending,
  // else says the agent kept running. No Stop hook fires on an interrupt, so the
  // hook's open-turn latch is released here.
  useEffect(() => {
    if (stopState !== 'stopping') return;
    if (aborted !== stopBase.current) {
      useStore.getState?.().clearSurfaceTurnOpen?.(ptyId);
      setStopState('stopped');
    } else if (!busy) setStopState('stopped');
  }, [stopState, aborted, busy, ptyId]);
  useEffect(() => {
    if (!stopState) return;
    const timer = setTimeout(() => setStopState((state) => state === 'stopping' ? 'kept' : state === stopState ? null : state),
      stopState === 'stopping' ? STOP_CONFIRM_MS : STOP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [stopState]);
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
    if (inFlight.current || readOnly || (busy && !canQueue) || blocked || uncertain || data.status.agentAlive === false || data.error || !data.status.agentSessionId || !data.status.available) {
      throw new MessageNotSentError(t('chat.sendUnavailable'));
    }
    sentAfterUser.current = latestUser;
    inFlight.current = true; setSending(true); setSendState(null);
    const images = attachments;
    const before = new Set(data.events.filter((e) => e.kind === 'user_text').map((e) => e.id));
    try {
      const response = await window.electronAPI.chat.send({ ptyId, agentSessionId: data.status.agentSessionId, text,
        ...((managed || data.status.terminal) ? { requestId: crypto.randomUUID() } : {}),
        ...(images.length ? { attachments: images.map((image) => image.path) } : {}) });
      if (response.result !== 'sent') {
        setSendState(response.result);
        // Keep the draft on a refused/uncertain delivery. The error text makes
        // partial delivery explicit; it is never retried automatically.
        throw new MessageNotSentError(t(`chat.send.${response.result}`));
      }
      setSendState('sent');
      setAttachments((current) => current.filter((item) => !images.includes(item)));
      setPending((current) => [...current, { id: crypto.randomUUID(), text, images, queued: busy, before }].slice(-8));
    } catch (error) {
      if (error instanceof MessageNotSentError) throw error;
      setSendState('error');
      throw new MessageNotSentError(t('chat.send.error'));
    } finally { inFlight.current = false; setSending(false); }
  }, [canLaunch, launch, launchAgent, launchMode, data.loading, data.retry, data.events, readOnly, busy, canQueue, attachments, blocked, uncertain, data.status.agentAlive, data.error, data.status.agentSessionId, data.status.available, latestUser, ptyId, t, managed]);
  // assistant-ui only learns about our own send. A turn the agent is running is
  // shown by the working row; telling the runtime would inject an empty
  // optimistic reply row and make Enter insert a newline instead of sending.
  const runtime = useExternalStoreRuntime({ messages, isRunning: sending, isLoading: data.loading,
    isSendDisabled: canLaunch ? sending || data.loading : launched || readOnly || blocked || (busy && !canQueue) || uncertain || data.error || !data.status.available || data.status.agentAlive === false || sending, onNew });
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
  // A send in flight owns the composer until its pastes land.
  const showStop = canStop && (busy && !blocked && !sending || stopState === 'stopping');
  const runningHint = busy && !managed && !blocked
    ? t(canStop ? (canQueue ? 'chat.hint.runningQueue' : 'chat.hint.runningStop') : 'chat.hint.runningNoStop') : undefined;
  const keys = useMemo(() => ({
    escape: () => { if (!showStop || stopState === 'stopping') return false; void stop(); return true; },
    backspaceAtStart: () => {
      if (!attachments.length) return false;
      setAttachments((current) => current.slice(0, -1));
      return true;
    },
    pasteImage: () => void pasteImage(),
  }), [showStop, stopState, stop, attachments.length, pasteImage]);
  const reasonKey = ['no-hook', 'stale-session', 'no-transcript-path', 'not-claude', 'unsafe-transcript-path', 'unreadable'].includes(data.status.reason)
    ? `chat.reason.${data.status.reason}` : 'chat.reason.unavailable';
  return <ChatPtyContext.Provider value={ptyId}><AssistantRuntimeProvider runtime={runtime}>
    <Thread composer={runtime.thread.composer} status={<><ChatProgress state={canLaunch ? 'ready' : progress} lastSyncedAt={data.lastSyncedAt} onTerminal={onTerminal} /><ChatControls ptyId={ptyId} status={data.status} refresh={data.retry} /></>} empty={messages.length === 0} working={busy} disabled={canLaunch ? sending || data.loading : launched || readOnly || !data.status.available || data.loading || ended || !!managed && (managed.phase !== 'ready' || !managed.capabilities.send)}
      placeholder={canLaunch ? t('chat.initialMessage') : ended ? t('chat.placeholderEnded') : undefined}
      skillScope={!managed ? { ptyId, agent: canLaunch ? launchAgent : data.status.terminal?.agent ?? 'claude', composer: runtime.thread.composer, onTerminal, live: !!data.status.agentAlive } : undefined}
      maxLength={canLaunch ? 2000 : 16_000}
      keys={keys} hint={runningHint}
      attachments={<ChatAttachmentChips items={attachments} onRemove={(path) => setAttachments((current) => current.filter((item) => item.path !== path))} />}
      stop={showStop && <button type="button" className="wmux-chat-stop" disabled={stopState === 'stopping'} onClick={() => void stop()}
        title={t('chat.stopTitle')} aria-label={stopState === 'stopping' ? t('chat.stopping') : t('chat.stop')}>
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
        {stopState === 'stopping' ? t('chat.stopping') : t('chat.stop')}
      </button>}
      pending={pending.map((item) => <div key={item.id} className="wmux-chat-message wmux-chat-user wmux-chat-pending">
        <ChatSentImages images={item.images} />
        <div className="wmux-chat-user-text">{item.text}</div>
        <p className="wmux-chat-pending-caption">{t(item.queued ? 'chat.queued' : 'chat.pendingSent')}</p>
      </div>)}
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
        {attachError && <div className="wmux-chat-notice" role="alert">{attachError}</div>}
        {stopState && <div className="wmux-chat-notice" role="status">{t(`chat.stopState.${stopState}`)}
          {['kept', 'blocked', 'failed'].includes(stopState) && <button type="button" onClick={onTerminal}>{t('chat.openTerminal')}</button>}</div>}
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

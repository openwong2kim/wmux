import { useState } from 'react';
import type { ChatControlResult, ChatInteraction, ChatInteractionAnswer } from '../../../shared/transcript/chatSession';
import type { TranscriptStatus } from '../../../shared/transcript/turnEvents';
import { useT } from '../../hooks/useT';

export function ChatControls({ ptyId, status, refresh }: { ptyId: string; status: TranscriptStatus; refresh: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controls = window.electronAPI?.chat?.controls;
  const managed = status.managed;

  const run = async (operation: () => Promise<ChatControlResult>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await operation(); if (!result.ok) setError(result.error ?? t('chat.controlFailed')); refresh(); }
    catch { setError(t('chat.controlFailed')); }
    finally { setBusy(false); }
  };
  if (!managed || !controls) return null;
  const identity = { ptyId, agentSessionId: status.agentSessionId ?? '' };
  return <div className="wmux-chat-controls">
    {managed ? <>
      <div className="wmux-chat-control-row"><strong>{managed.provider.name}</strong><span>{t('chat.managedSession')}</span>
        {['running', 'blocked'].includes(managed.phase) && managed.capabilities.cancel && <button type="button" className="ui-btn" disabled={busy}
          onClick={() => void run(() => controls.cancel(identity))}>{t('chat.stop')}</button>}
        {['disconnected', 'unconfirmed'].includes(managed.phase) && <button type="button" className="ui-btn" disabled={busy}
          onClick={() => void run(() => controls.reconnect(identity))}>{t('chat.reconnect')}</button>}
        {!['connecting', 'running', 'blocked'].includes(managed.phase) && <button type="button" className="ui-btn" disabled={busy} onClick={() => void run(() => controls.close(identity))}>{t('chat.closeManaged')}</button>}
      </div>
      {managed.phase === 'unconfirmed' && <p role="status">{t('chat.deliveryUnknown')}</p>}
      {managed.error && <p role="alert">{managed.error}</p>}
      {managed.historyTruncated && <p>{t('chat.retentionLimit')}</p>}
      {managed.pending.map((request) => <Interaction key={request.id} request={request} busy={busy}
        answer={(answer) => run(() => controls.respond({ ...identity, requestId: request.id, answer }))} />)}
    </> : null}
    {error && <p role="alert">{error}</p>}
  </div>;
}

function Interaction({ request, busy, answer }: { request: ChatInteraction; busy: boolean; answer: (answer: ChatInteractionAnswer) => Promise<void> }) {
  const t = useT();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  return <section className="wmux-chat-interaction" aria-label={request.title}>
    <strong>{request.title}</strong>
    {request.detail && <pre>{request.detail}</pre>}
    {request.kind === 'permission' ? <div className="wmux-chat-control-row">{request.options.map((option) =>
      <button key={option.id} type="button" className="ui-btn" disabled={busy} onClick={() => void answer({ optionId: option.id })}>{option.label}</button>)}</div>
      : <form onSubmit={(e) => { e.preventDefault(); void answer({ answers }); }}>
        {request.questions?.map((question) => <fieldset key={question.id} disabled={busy}>
          <legend>{question.text}</legend>
          {question.options?.map((option) => <label key={option}><input type={question.multiple ? 'checkbox' : 'radio'} name={question.id}
            checked={answers[question.id]?.includes(option) ?? false} onChange={(e) => setAnswers((old) => ({ ...old,
              [question.id]: question.multiple ? e.target.checked ? [...(old[question.id] ?? []), option] : (old[question.id] ?? []).filter((v) => v !== option) : [option],
            }))} />{option}</label>)}
          <input type={question.secret ? 'password' : 'text'} aria-label={question.text} placeholder={t('chat.customAnswer')}
            maxLength={16_000} autoComplete="off" onChange={(e) => setAnswers((old) => ({ ...old, [question.id]: e.target.value ? [e.target.value] : [] }))} />
        </fieldset>)}
        <button type="submit" className="ui-btn" disabled={busy || request.questions?.some((q) => !answers[q.id]?.length)}>{t('chat.submitAnswer')}</button>
      </form>}
  </section>;
}

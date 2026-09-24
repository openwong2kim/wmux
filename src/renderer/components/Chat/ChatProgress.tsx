import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import type { ChatRunState } from './chatRunState';

export function ChatProgress({ state, lastSyncedAt, onTerminal }: {
  state: ChatRunState; lastSyncedAt: number | null; onTerminal: () => void;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = lastSyncedAt ? Math.max(0, Math.floor((now - lastSyncedAt) / 1000)) : null;
  return <div className="wmux-chat-progress" data-chat-state={state}>
    <div role="status" aria-live="polite" className="wmux-chat-progress-label">
      <span className="wmux-chat-progress-dot" aria-hidden="true" />{t(`chat.state.${state}`)}
    </div>
    <div className="wmux-chat-progress-detail">
      <span>{state === 'working' ? t('chat.recordedUpdates') : seconds === null ? state === 'ready' ? '' : t('chat.checkingConnection') : t('chat.lastSynced', { seconds })}</span>
      <button type="button" onClick={onTerminal}>{t('chat.openTerminal')}</button>
    </div>
  </div>;
}

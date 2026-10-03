import { lazy, Suspense, useEffect } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { markChatV2Covering } from './coverage';
import { usePaneChatV2Binding } from './useChatV2';
import { selectChatSurfaceView, type ChatSurfaceView } from './viewState';

const ChatV2View = lazy(() => import('./ChatV2View'));

/** Which view a terminal surface shows. Reads state only: it never spawns a PTY. */
export function useChatSurfaceView(ptyId: string | undefined, chatViewEnabled: boolean, viewMode: 'terminal' | 'chat' | undefined): ChatSurfaceView {
  const chat = chatViewEnabled && viewMode === 'chat' && !!ptyId;
  const binding = usePaneChatV2Binding(ptyId, chat);
  const agentRunning = useStore((s) => !!ptyId && !!s.surfaceAgent[ptyId]?.name
    && s.agentAliveByPtyId?.[ptyId] !== false && s.commandRunningByPtyId?.[ptyId] !== false);
  if (!ptyId) return chatViewEnabled && viewMode === 'chat' ? 'projection' : 'terminal';
  return selectChatSurfaceView({ chatViewEnabled, viewMode, binding, agentRunning });
}

/** The chat-v2 view laid over the pane's (inert) anchor terminal. */
export function ChatV2Overlay({ ptyId, surfaceId }: { ptyId: string; surfaceId: string }) {
  const t = useT();
  useEffect(() => markChatV2Covering(ptyId), [ptyId]);
  return (
    <div className="absolute inset-0 z-10 bg-[var(--bg-base)]" data-chatv2-surface>
      <Suspense fallback={<div className="wmux-chatv2-state" role="status">{t('chat.loading')}</div>}>
        <ChatV2View paneId={ptyId} active onTerminal={() => useStore.getState().setSurfaceViewMode(surfaceId, 'terminal')} />
      </Suspense>
    </div>
  );
}

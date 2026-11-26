import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { markChatV2Covering } from './coverage';
import { usePaneMove } from './ContinueInChat';
import { usePaneChatV2Binding } from './useChatV2';
import { knownBinding, onKnownBindings } from './controller';
import { selectChatSurfaceView, type ChatSurfaceView } from './viewState';

const ChatV2View = lazy(() => import('./ChatV2View'));

/** Which view a terminal surface shows. Reads state only: it never spawns a PTY. */
export function useChatSurfaceView(ptyId: string | undefined, chatViewEnabled: boolean, viewMode: 'terminal' | 'chat' | undefined): ChatSurfaceView {
  const chat = chatViewEnabled && viewMode === 'chat' && !!ptyId;
  const binding = usePaneChatV2Binding(ptyId, chat);
  const agentRunning = useStore((s) => !!ptyId && !!s.surfaceAgent[ptyId]?.name
    && s.agentAliveByPtyId?.[ptyId] !== false && s.commandRunningByPtyId?.[ptyId] !== false);
  const move = usePaneMove(ptyId);
  if (!ptyId) return chatViewEnabled && viewMode === 'chat' ? 'projection' : 'terminal';
  return selectChatSurfaceView({ chatViewEnabled, viewMode, binding, agentRunning, movingFromProjection: move.fromProjection && move.phase === 'moving' });
}

/**
 * Whether the surface shows the chat-v2 view, for the pane header's kind
 * badge. Reads what the pane already asked the host and re-renders only when
 * the answer flips, not on every push that republishes the binding.
 */
export function useShowsChatV2(ptyId: string | undefined, chatViewEnabled: boolean, viewMode: 'terminal' | 'chat' | undefined): boolean {
  const agentRunning = useStore((s) => !!ptyId && !!s.surfaceAgent[ptyId]?.name
    && s.agentAliveByPtyId?.[ptyId] !== false && s.commandRunningByPtyId?.[ptyId] !== false);
  const move = usePaneMove(ptyId);
  const moving = move.fromProjection && move.phase === 'moving';
  return useSyncExternalStore(onKnownBindings, () => !!ptyId
    && selectChatSurfaceView({ chatViewEnabled, viewMode, binding: knownBinding(ptyId), agentRunning, movingFromProjection: moving }) === 'chatv2');
}

/** The chat-v2 view laid over the pane's (inert) anchor terminal. */
export function ChatV2Overlay({ ptyId, surfaceId, cwd }: { ptyId: string; surfaceId: string; cwd?: string }) {
  const t = useT();
  useEffect(() => markChatV2Covering(ptyId), [ptyId]);
  return (
    <div className="absolute inset-0 z-10 bg-[var(--bg-base)]" data-chatv2-surface>
      <Suspense fallback={<div className="wmux-chatv2-state" role="status">{t('chat.loading')}</div>}>
        <ChatV2View paneId={ptyId} active cwd={cwd} onTerminal={() => useStore.getState().setSurfaceViewMode(surfaceId, 'terminal')} />
      </Suspense>
    </div>
  );
}

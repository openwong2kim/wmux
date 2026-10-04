// The top of Moa's panel: what waits on you (every workspace's pending
// decision), then the work Moa handed out. Capped so the conversation below
// always keeps most of the column; it scrolls within its share.
import { Suspense, lazy, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../../stores';
import type { MoaPendingDecision } from '../../../../shared/moa';
import { MoaWaitingOnYou, answeredElsewhere, type ResolveDecision } from './MoaWaitingOnYou';
import { MoaTaskCards } from './MoaTaskCards';
import { selectTaskCards, useWorkLinks, type WorkLinksApi } from './useMoaPanelData';
import type { CommanderViewProps } from '../../Deck/CommanderView';

type T = (key: string, vars?: Record<string, string | number>) => string;

const defaultResolve: ResolveDecision = async (args) => {
  const resolve = window.electronAPI?.deck?.decision?.resolve;
  if (!resolve) return { ok: false };
  return resolve(args);
};

export function MoaPanelTop({
  decisions,
  onResolved,
  resolve = defaultResolve,
  linksApi,
  t,
}: {
  decisions: readonly MoaPendingDecision[];
  /** Re-read the decisions after an answer (main also signals it). */
  onResolved?: () => void;
  resolve?: ResolveDecision;
  linksApi?: WorkLinksApi;
  t: T;
}): React.ReactElement {
  const links = useWorkLinks(true, linksApi ?? window.electronAPI?.workLinks);
  const pendingIds = useMemo(() => new Set(decisions.map((d) => d.decision.id)), [decisions]);
  const cards = useMemo(() => selectTaskCards(links, pendingIds), [links, pendingIds]);
  const names = useStore(useShallow((s) => s.workspaces.map((w) => `${w.id}\u0000${w.name}`)));
  const workspaceName = useMemo(() => {
    const map = new Map(names.map((pair) => pair.split('\u0000') as [string, string]));
    return (id: string) => map.get(id);
  }, [names]);
  // Fan-out tasks get an "Open conversation" link to their mission channel in Fleet.
  const missionByPaneGroup = useStore((s) => s.missionByPaneGroup);
  const conversationTaskId = useCallback((workspaceId: string) => missionByPaneGroup[workspaceId]?.id, [missionByPaneGroup]);
  const openConversation = useCallback((taskId: string) => useStore.getState().openTaskConversation(taskId), []);
  const onResolve = useCallback<ResolveDecision>(async (args) => {
    const r = await resolve(args);
    // Answered elsewhere still moved main's list: re-read it.
    if (r.ok || answeredElsewhere(r)) onResolved?.();
    return r;
  }, [resolve, onResolved]);
  // Main names a decision's workspace when it knows it; fall back to ours.
  const named = useMemo(
    () => decisions.map((d) => (d.workspaceName ? d : { ...d, workspaceName: workspaceName(d.workspaceId) })),
    [decisions, workspaceName],
  );
  return (
    // Focusable so an answer that empties the list has somewhere to put focus.
    <div data-moa-panel-top tabIndex={-1} className="shrink-0 max-h-[30%] overflow-y-auto outline-none">
      <MoaWaitingOnYou decisions={named} onResolve={onResolve}
        conversationTaskId={conversationTaskId} onOpenConversation={openConversation} t={t} />
      <MoaTaskCards links={cards} pendingDecisions={decisions} workspaceName={workspaceName}
        conversationTaskId={conversationTaskId} onOpenConversation={openConversation} t={t} />
    </div>
  );
}

const LazyMoaTranscriptChat = lazy(() => import('./MoaTranscriptChat'));

type RenderChat = NonNullable<NonNullable<CommanderViewProps['moa']>['renderChat']>;

/** CommanderView's chat slot: the transcript chat when main exposes the HQ
 *  transcript, else nothing (the terminal stays the only view). */
export const renderMoaChat: RenderChat = ({ brainPtyId, busy, onSend, onInterrupt, onTerminal }) => {
  if (!window.electronAPI?.deck?.moa?.transcript) return null;
  return (
    <Suspense fallback={null}>
      <LazyMoaTranscriptChat ptyId={brainPtyId} busy={busy} onSend={onSend} onInterrupt={onInterrupt} onTerminal={onTerminal} />
    </Suspense>
  );
};

// The top of Moa's panel: what waits on you (every workspace's pending
// decision), then the work Moa handed out. No height of its own: it scrolls
// with the conversation as one column (the chat draws it at the top of its
// scroll), so a long card grows instead of hiding behind an inner scrollbar.
// Waiting on you is the exception: with the chat on screen it docks above the
// composer (MoaDockContext), so a decision is never scrolled out of reach.
import { Suspense, lazy, useCallback, useContext, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../../stores';
import type { MoaPendingDecision } from '../../../../shared/moa';
import { MoaDockContext, MoaWaitingOnYou, answeredElsewhere, useDelegatedApprovals, type DelegatedApprovalsApi, type ResolveDecision } from './MoaWaitingOnYou';
import { MoaTaskCards } from './MoaTaskCards';
import { defaultReceiptsApi, selectTaskCards, useWorkLinks, type MoaHandoffReceiptsApi, type WorkLinksApi } from './useMoaPanelData';
import { defaultHandoffResolve, type HandoffResolve } from './MoaHandoffCard';
import { MoaHandoffReceipts } from './MoaHandoffReceipts';
import { focusNotificationTarget, focusPaneByPtyId, type FocusTargetState } from '../../../hooks/useNotificationListener';
import type { CommanderViewProps } from '../../Deck/CommanderView';

type T = (key: string, vars?: Record<string, string | number>) => string;

const defaultResolve: ResolveDecision = async (args) => {
  const resolve = window.electronAPI?.deck?.decision?.resolve;
  if (!resolve) return { ok: false };
  return resolve(args);
};

/** Jump to a pane: by its pty when known (Fleet's path), else the workspace
 *  and then the pane inside it. */
export function openMoaPane(workspaceId: string, paneId?: string, ptyId?: string): void {
  const get = () => useStore.getState() as unknown as FocusTargetState;
  if (ptyId && focusPaneByPtyId(get, ptyId)) return;
  focusNotificationTarget(get, { workspaceId });
  if (paneId) useStore.getState().focusPaneSurface(workspaceId, paneId);
}

export function MoaPanelTop({
  decisions,
  onResolved,
  resolve = defaultResolve,
  linksApi,
  handoffResolve = defaultHandoffResolve,
  receiptsApi,
  onOpenPane = openMoaPane,
  approvalsApi,
  t,
}: {
  decisions: readonly MoaPendingDecision[];
  /** Re-read the decisions after an answer (main also signals it). */
  onResolved?: () => void;
  resolve?: ResolveDecision;
  linksApi?: WorkLinksApi;
  handoffResolve?: HandoffResolve;
  receiptsApi?: MoaHandoffReceiptsApi;
  onOpenPane?: (workspaceId: string, paneId?: string) => void;
  /** Injected in tests; defaults to the preload. */
  approvalsApi?: DelegatedApprovalsApi;
  t: T;
}): React.ReactElement {
  const delegatedApprovals = useDelegatedApprovals(approvalsApi);
  const links = useWorkLinks(true, linksApi ?? window.electronAPI?.workLinks);
  const pendingIds = useMemo(() => new Set(decisions.map((d) => d.decision.id)), [decisions]);
  // A job Moa handed out that is done is told once, by its report card in the
  // chat; Delegated work keeps what is still under way.
  const cards = useMemo(
    // Only work handed out through Moa or by the operator (an issue / PR from
    // the Git page). A 'manual' link is one agent's A2A task to another — an
    // orchestrator pane's delegations listed here read as Moa's own.
    () => selectTaskCards(links.filter((l) => l.origin !== 'manual'), pendingIds)
      .filter((l) => !(l.state === 'done' && (l.origin === 'moa' || l.origin === 'moa-auto'))),
    [links, pendingIds],
  );
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
  const onHandoffResolve = useCallback<HandoffResolve>(async (req) => {
    const r = await handoffResolve(req);
    if (r.ok || r.code === 'not_pending') onResolved?.();
    return r;
  }, [handoffResolve, onResolved]);
  const receipts = useMemo(() => receiptsApi ?? defaultReceiptsApi(), [receiptsApi]);
  const dock = useContext(MoaDockContext);
  // Before Moa's first turn there is no brain and so no chat: the panel would
  // be a bare composer. Say what to ask, once, until the first send.
  const noBrain = useStore((s) => {
    const hq = s.moa?.hq.workspaceId;
    return !!hq && !s.brainPtyIds[hq];
  });
  const firstRun = noBrain && !dock && decisions.length === 0 && cards.length === 0 && delegatedApprovals.length === 0;
  // Main names a decision's workspace when it knows it; fall back to ours.
  const named = useMemo(
    () => decisions.map((d) => (d.workspaceName ? d : { ...d, workspaceName: workspaceName(d.workspaceId) })),
    [decisions, workspaceName],
  );
  return (
    // Focusable so an answer that empties the list has somewhere to put focus.
    <div data-moa-panel-top tabIndex={-1} className="shrink-0 outline-none">
      {firstRun && (
        <div className="px-3 pt-3 pb-1 flex flex-col gap-1" data-moa-first-run>
          <p className="m-0 text-[13px] font-medium text-[var(--text-main)]">{t('moa.panel.chatEmpty')}</p>
          <p className="m-0 text-[13px] leading-snug text-[var(--text-sub)]">{t('moa.panel.chatEmptyHint')}</p>
        </div>
      )}
      <MoaHandoffReceipts api={receipts} workspaceName={workspaceName} onOpenPane={onOpenPane} t={t} />
      {(() => {
        const waiting = (
          <MoaWaitingOnYou decisions={named} onResolve={onResolve} handoffResolve={onHandoffResolve}
            delegatedApprovals={delegatedApprovals} onOpenPty={(ws, ptyId) => openMoaPane(ws, undefined, ptyId)}
            conversationTaskId={conversationTaskId} onOpenConversation={openConversation} t={t} />
        );
        return dock ? createPortal(waiting, dock) : waiting;
      })()}
      <MoaTaskCards links={cards} pendingDecisions={decisions} workspaceName={workspaceName}
        conversationTaskId={conversationTaskId} onOpenConversation={openConversation} onOpenPane={onOpenPane} t={t} />
    </div>
  );
}

const LazyMoaTranscriptChat = lazy(() => import('./MoaTranscriptChat'));

type RenderChat = NonNullable<NonNullable<CommanderViewProps['moa']>['renderChat']>;

/** CommanderView's chat slot: the transcript chat when main exposes the HQ
 *  transcript, else nothing (the terminal stays the only view). */
export const renderMoaChat: RenderChat = ({ brainPtyId, busy, onSend, onInterrupt, onTerminal, top }) => {
  if (!window.electronAPI?.deck?.moa?.transcript) return null;
  return (
    <Suspense fallback={null}>
      <LazyMoaTranscriptChat ptyId={brainPtyId} busy={busy} onSend={onSend} onInterrupt={onInterrupt} onTerminal={onTerminal} top={top} />
    </Suspense>
  );
};

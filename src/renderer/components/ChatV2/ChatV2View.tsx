import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useT } from '../../hooks/useT';
import { CHATV2_AGENT_CAPS, type ChatV2Agent, type ChatV2RunMode } from '../../../shared/chatv2/ipc';
import { Composer, dequeueMessage, enqueueMessage, moveDraft, QueuedMessages, requeueToDraft, restoreToDraft, setDelivering, useDeliveringId, useDraft, useQueuedMessages } from './Composer';
import { clientMessageId } from './controller';
import { shortDir } from '../../utils/shortDir';
import { FindBar } from './FindBar';
import { PinnedApproval } from './Cards';
import { rowHolds, transcriptRows, type RowCache, type TranscriptRow } from './rows';
import { S } from './strings';
import { OpenScope, TranscriptRowView, type TranscriptActions } from './Transcript';
import { useChatV2 } from './useChatV2';
import { getChatV2Bridge } from './bridge';
import { ContinueInChat, usePaneMove } from './ContinueInChat';
import { useStore } from '../../stores';
import { focusPaneByPtyId } from '../../hooks/useNotificationListener';
import { useTranscriptWindow } from '../shared/useTranscriptWindow';
import { ArrowIcon } from './ArrowIcon';

const NEAR_BOTTOM_PX = 48;
/** How far above the newest row the reader has to be before "Jump to latest" shows by itself. */
const AWAY_PX = 240;

// Chats with a model or effort change on its way, by draft key. Outside the
// view, so a view that remounts meanwhile still holds its queue until it settles.
const configuringKeys = new Set<string>();
const configuringListeners = new Set<() => void>();
function setConfiguringKey(key: string, on: boolean): void {
  if (on === configuringKeys.has(key)) return;
  if (on) configuringKeys.add(key); else configuringKeys.delete(key);
  for (const listener of [...configuringListeners]) listener();
}
function useConfiguring(key: string): boolean {
  return useSyncExternalStore((listener) => { configuringListeners.add(listener); return () => { configuringListeners.delete(listener); }; }, () => configuringKeys.has(key));
}

const holdsBlock = rowHolds;

/** A row's own key and the keys of every row it holds (a run's calls, a folded turn's work). */
const rowKeys = (row: TranscriptRow): string[] =>
  row.kind === 'toolGroup' || row.kind === 'turnFold' ? [row.key, ...row.rows.flatMap(rowKeys)] : [row.key];

/** The newest row's key, read through runs and folded turns (their last member), skipping the footer. */
export function newestKey(rows: readonly TranscriptRow[]): string | undefined {
  let row: TranscriptRow | undefined = rows.findLast((candidate) => candidate.kind !== 'footer');
  while (row && (row.kind === 'toolGroup' || row.kind === 'turnFold') && row.rows.length) row = row.rows.at(-1);
  // A settled turn with nothing in its fold stands for its prompt, the newest row before it settled.
  return row?.kind === 'turnFold' ? row.turnId : row?.key;
}

/**
 * Keys of rows appended after the transcript first loaded, so only those fade
 * in. A row stays marked once marked (dropping the mark mid-fade would cut it);
 * rows above the last one already shown (an earlier page) and a group that
 * absorbed rows already shown are not new. The live footer and a question sit
 * below the rows that stream in, so they do not count as "last shown".
 */
export function enteringKeys(rows: readonly TranscriptRow[], known: Set<string> | null, entered: Set<string>): Set<string> | null {
  const keys = rowKeys;
  if (!known) return rows.length ? new Set(rows.flatMap(keys)) : null;
  let lastKnown = -1;
  rows.forEach((row, index) => {
    if (row.kind !== 'footer' && row.kind !== 'question' && keys(row).some((key) => known.has(key))) lastKnown = index;
  });
  rows.forEach((row, index) => {
    const own = keys(row);
    if (index > lastKnown && !own.some((key) => known.has(key))) entered.add(row.key);
    own.forEach((key) => known.add(key));
  });
  return known;
}

/**
 * Where a chat created now would run, as the daemon decides it. Asked again
 * whenever the pane reports a new directory (`hint`), which is only a cue.
 */
function RunsIn({ paneId, hint }: { paneId: string; hint?: string }) {
  const [cwd, setCwd] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCwd(null);
    void getChatV2Bridge()?.call('bindingForPane', { paneId }).then(
      (result) => { if (!cancelled && result.ok && !result.binding && result.cwd) setCwd(result.cwd); },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [paneId, hint]);
  return (
    <p className="wmux-chatv2-runs-in" data-chatv2-runs-in title={cwd ?? undefined}>
      {cwd ? S.runsIn(shortDir(cwd)) : S.runsInUnknown}
    </p>
  );
}

/**
 * Chat v2 for one pane. Never creates a PTY: the pane's shell PTY is the
 * anchor (`paneId`), and everything here goes through the chat-v2 bridge.
 */
export default function ChatV2View({ paneId, active, onTerminal, cwd }: {
  paneId: string;
  active: boolean;
  onTerminal: () => void;
  /** The directory the pane last reported; a change asks the daemon again where a chat would run. */
  cwd?: string;
}) {
  const t = useT();
  const { state, controller, retry } = useChatV2(paneId, active);
  const view = state.view;
  const draftKey = view ? `${paneId}:${view.binding.chatSessionId}` : `${paneId}:new`;
  const queue = useQueuedMessages(draftKey);
  const deliveringId = useDeliveringId(draftKey);
  const [findOpen, setFindOpen] = useState(false);
  const [findId, setFindId] = useState<string | null>(null);
  const [newModel, setNewModel] = useState('');
  const [newEffort, setNewEffort] = useState('');
  // A model or effort change on its way to the agent.
  const configuring = useConfiguring(draftKey);
  const [newMode, setNewMode] = useState<ChatV2RunMode>('default');
  const [newAgent, setNewAgent] = useState<ChatV2Agent>('claude');
  // An agent without the Claude models or a bypass mode (Codex) starts on its own default and always asks.
  const pickAgent = (agent: ChatV2Agent) => {
    setNewAgent(agent);
    if (!CHATV2_AGENT_CAPS[agent].claudeModels) setNewModel('');
    if (!CHATV2_AGENT_CAPS[agent].bypass) setNewMode('default');
    if (!CHATV2_AGENT_CAPS[agent].efforts.includes(newEffort)) setNewEffort('');
  };
  const [handingOff, setHandingOff] = useState(false);
  const moveError = usePaneMove(paneId).error;
  // Bumped to remount the composer when a draft moved under it.
  const [draftRev, setDraftRev] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Rows arrived below while the reader was scrolled up: offer the way back,
  // and say so to a screen reader (a polite live region, apart from the button).
  const [newBelow, setNewBelow] = useState(false);
  // Scrolled away from the newest row (more than a screen's worth of slack): the way back is offered too.
  const [away, setAway] = useState(false);
  const [announce, setAnnounce] = useState('');
  const lastRowKey = useRef<string | undefined>(undefined);
  // Every row key the last commit showed: a turn folding its work under a notice
  // it already showed makes that notice the newest row, but it is not news.
  const shownKeys = useRef(new Set<string>());

  const rowCache = useRef<RowCache>(new WeakMap());
  const rows = useMemo(() => (view ? transcriptRows(view.session, rowCache.current) : []), [view]);
  const knownKeys = useRef<Set<string> | null>(null);
  const entered = useRef(new Set<string>());
  const knownFor = useRef<string | undefined>(undefined);
  if (knownFor.current !== view?.session.id) {
    // Another chat's first load is a first load too.
    knownFor.current = view?.session.id;
    knownKeys.current = null;
    entered.current = new Set();
    // Its window opens at the tail, so the view follows it from there.
    pinned.current = true;
    lastRowKey.current = undefined;
  }
  const lastKey = newestKey(rows);
  knownKeys.current = enteringKeys(rows, knownKeys.current, entered.current);
  // A long transcript mounts its recent rows; earlier ones are read in on the way up.
  const transcriptWindow = useTranscriptWindow({
    resetKey: view?.session.id,
    items: rows,
    keyOf: (row) => row.key,
    isTurnStart: (row) => row.kind === 'user',
    scrollRef: scroller,
  });
  // The newest turn ended on an error and nothing runs: its error offers Retry (the same prompt, sent again).
  const lastUser = view?.session.blocks.findLast((block) => block.role === 'user');
  const lastError = view && !view.session.busy && lastUser?.outcome === 'failed'
    ? view.session.blocks.findLast((block) => block.role === 'system' && block.notice === 'error')
    : undefined;
  const retryId = lastError && lastUser && view!.session.blocks.indexOf(lastError) > view!.session.blocks.indexOf(lastUser) ? lastError.id : undefined;
  // Only a prompt the view holds whole, with no attachments, can be sent again as it was.
  // A handed-off chat sends nothing (the terminal holds the conversation).
  const retryText = retryId && view?.binding.capabilities.send && view.binding.status !== 'handed-off' && !lastUser?.overflow?.text && !lastUser?.attachments?.length ? lastUser?.text : undefined;
  const actions = useMemo<TranscriptActions>(() => ({
    answer: (requestId, decision, answers) => controller?.answer(requestId, decision, answers) ?? Promise.resolve(false),
    body: (blockId, field, offset) => controller?.body(blockId, field, offset) ?? Promise.resolve(null),
    ...(retryId && retryText ? { retryId, retry: () => controller?.send(retryText) ?? Promise.resolve(false) } : {}),
  }), [controller, retryId, retryText]);

  // Stay at the bottom while the reader is there; otherwise note that a row
  // arrived below (the live footer only ticks, so it does not count).
  // A turn that settles folds its work, which is not news either: the newest
  // row is read through runs and folds, so it stays the same row across the fold.
  // Far enough from the newest row (or in a window cut short by find) to offer the way back.
  const measureAway = () => {
    const el = scroller.current;
    if (!el) return;
    setAway(el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_PX || transcriptWindow.laterCount > 0);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    const arrived = lastRowKey.current !== undefined && lastKey !== lastRowKey.current && !(lastKey !== undefined && shownKeys.current.has(lastKey));
    lastRowKey.current = lastKey;
    shownKeys.current = new Set(rows.flatMap(rowKeys));
    if (el && pinned.current && !findId) { el.scrollTop = el.scrollHeight; setNewBelow(false); setAnnounce(''); }
    // A turn that settles while the reader is inside it keeps their place through the browser's own scroll anchoring.
    else if (arrived) { setNewBelow(true); setAnnounce(S.newBelow); }
    measureAway();
  }, [transcriptWindow.visible, findId, lastKey, queue.length]);
  // A row opened or closed by the reader, or the pane resized, moves the bottom
  // without a scroll: measured again, and back at the end it follows again.
  const settle = useRef(() => undefined as void);
  settle.current = () => {
    const el = scroller.current;
    if (!el) return;
    measureAway();
    if (!findId && transcriptWindow.laterCount === 0 && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) {
      pinned.current = true;
      setNewBelow(false);
      setAnnounce('');
    }
  };
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !scroller.current) return;
    const observer = new ResizeObserver(() => settle.current());
    observer.observe(scroller.current);
    if (column.current) observer.observe(column.current);
    return () => observer.disconnect();
    // Again whenever the viewport itself may have been swapped (loading, unavailable, another chat).
  }, [view?.session.id, state.phase, !controller]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = fromBottom < NEAR_BOTTOM_PX;
    measureAway();
    // The bottom of a window cut short (after find) is not the end of the chat.
    pinned.current = atBottom && transcriptWindow.laterCount === 0;
    if (pinned.current) { setNewBelow(false); setAnnounce(''); }
    transcriptWindow.onScroll(atBottom);
  };
  // Back to the newest row, and keep following from there (also on send).
  // An open find holds the view on its match and may have cut the window
  // short, so it ends first.
  const toLatest = () => {
    if (findOpen || findId) { setFindOpen(false); setFindId(null); }
    pinned.current = true;
    setNewBelow(false);
    setAway(false);
    setAnnounce('');
    transcriptWindow.toTail();
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  // A match the window hides is revealed first, then scrolled to once.
  const shownFind = useRef<string | null>(null);
  useEffect(() => {
    if (!findId) { shownFind.current = null; return; }
    if (shownFind.current === findId) return;
    const match = scroller.current?.querySelector(`[data-block-id="${CSS.escape(findId)}"]`);
    if (match) {
      shownFind.current = findId;
      match.scrollIntoView({ block: 'center' });
      return;
    }
    const index = rows.findIndex((row) => holdsBlock(row, findId));
    if (index < 0) return;
    pinned.current = false;
    transcriptWindow.reveal(index);
  }, [findId, transcriptWindow.startIndex, transcriptWindow.endIndex]);

  const followedBeforeFind = useRef(false);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f' && view) {
      event.preventDefault();
      event.stopPropagation();
      if (!findOpen) followedBeforeFind.current = pinned.current;
      setFindOpen(true);
    }
  };
  // A reader who was following before find opened is back at the newest row.
  const closeFind = () => {
    setFindOpen(false);
    setFindId(null);
    if (!followedBeforeFind.current) return;
    pinned.current = true;
    transcriptWindow.toTail();
  };

  // Messages sent mid-turn wait here (DESIGN.md, Chat feedback: Queued until
  // it runs) and go one at a time once the agent is free. The chat-v2 host
  // refuses a send while a turn runs, so the queue is the renderer's; each
  // item keeps its message id, so a resend after a remount is a duplicate.
  const status = view?.binding.status;
  const running = !!view && (!!view.session.busy || status === 'running' || status === 'needs-input');
  // Not while a model change runs: the host refuses a send then, and the queue drains once it settles.
  const canDeliver = !!view && !running && !configuring && (status === 'idle' || status === 'stopped') && view.binding.capabilities.send;
  const nextQueued = canDeliver ? queue[0] : undefined;
  // The copy (epoch and seq) a delivery last waited on: it is tried again only
  // once another event folded (a turn's end, a reload), never in a loop.
  const heldAt = useRef<string | null>(null);
  const copyAt = view ? `${view.epoch}:${view.lastSeq}` : '';
  useEffect(() => {
    // The store marks the delivery in flight, so a view that remounted meanwhile does not start it twice.
    if (!nextQueued || !controller || deliveringId || heldAt.current === copyAt) return;
    const key = draftKey;
    const item = nextQueued;
    setDelivering(key, item.id);
    const hold = () => { heldAt.current = copyAt; };
    void controller.deliver({ id: item.id, text: item.text, attachments: item.staged.map((file) => file.path) }).then((outcome) => {
      setDelivering(key, null);
      if (outcome === 'wait') { hold(); return; }
      if (outcome === 'gone') {
        // Its chat is gone: the queue goes to the composer the pane shows now.
        const now = controller.current.view;
        requeueToDraft(key, now ? `${paneId}:${now.binding.chatSessionId}` : `${paneId}:new`);
        return;
      }
      dequeueMessage(key, item.id);
      // Refused: back in the composer, not lost (the error says why).
      if (outcome === 'failed') restoreToDraft(key, item, true);
    }, () => {
      // The bridge failed: it stays queued and is tried again on the next event.
      setDelivering(key, null);
      hold();
    });
  }, [nextQueued, controller, draftKey, deliveringId, copyAt, paneId, configuring]);

  // A first message whose chat was created after a split remount stays under
  // the new-chat draft; once the chat shows, it moves to the chat's composer.
  const newChatDraft = useDraft(`${paneId}:new`);
  useEffect(() => {
    if (!view || newChatDraft.sending || (!newChatDraft.text && !newChatDraft.staged.length)) return;
    moveDraft(`${paneId}:new`, draftKey);
  }, [view, newChatDraft, paneId, draftKey]);

  if (state.phase === 'loading') {
    return <div className="wmux-chatv2" data-chatv2="loading"><div className="wmux-chatv2-state" role="status">{t('chat.loading')}</div></div>;
  }
  if (state.phase === 'unavailable' || !controller) {
    return (
      <div className="wmux-chatv2" data-chatv2="unavailable">
        
        <div className="wmux-chatv2-state" role="alert">
          <p>{state.error?.message ?? S.unavailable}</p>
          <div className="wmux-chatv2-card-actions">
            <button type="button" className="wmux-chatv2-btn" onClick={() => (controller ? void controller.reload() : retry())}>{S.retry}</button>
            <button type="button" className="wmux-chatv2-btn" onClick={onTerminal}>{t('chat.openTerminal')}</button>
          </div>
        </div>
      </div>
    );
  }

  // A failed move into chat matters until the pane has a chat again.
  const showMoveError = !!moveError && (!view || view.binding.status === 'handed-off');
  const error = state.error || showMoveError
    ? <div className="wmux-chatv2-notice" data-tone="error" role="alert">{state.error?.message ?? moveError}</div>
    : null;

  if (state.phase === 'empty' || !view) {
    return (
      <div className="wmux-chatv2" data-chatv2="empty">
        
        <div className="wmux-chatv2-viewport">
          <div className="wmux-chatv2-column wmux-chatv2-empty">
            <strong>{S.newChat}</strong>
            <p>{S.newChatHint(S.agentName[newAgent])}</p>
            <RunsIn paneId={paneId} hint={cwd} />
          </div>
        </div>
        <div className="wmux-chatv2-dock">
          {error}
          <Composer
            paneId={paneId}
            draftKey={`${paneId}:new`}
            placeholder={S.placeholderNew(S.agentName[newAgent])}
            disabled={false}
            running={false}
            canStop={false}
            canAttach
            chips={{ agent: newAgent, model: newModel, effort: newEffort, mode: newMode, editable: true, onModel: setNewModel, onEffort: setNewEffort, onMode: setNewMode, onAgent: pickAgent }}
            onSend={async (text, staged) => {
              const attachments = staged.map((item) => item.path);
              if (!(await controller.create({ agent: newAgent, mode: newMode, model: newModel, effort: newEffort }))) return false;
              const chatSessionId = controller.current.view?.binding.chatSessionId;
              if (await controller.send(text, attachments)) return true;
              // The chat exists but the first message did not go: its text and files move to that chat's composer together.
              if (chatSessionId) { moveDraft(`${paneId}:new`, `${paneId}:${chatSessionId}`); setDraftRev((rev) => rev + 1); }
              return false;
            }}
            onStop={() => undefined}
          />
        </div>
      </div>
    );
  }

  const binding = view.binding;
  // The oldest approval that waits is pinned over the composer (one at a time).
  const pendingApproval = view.session.blocks.find((block) => block.approval && !block.approval.decided);
  const handedOff = binding.status === 'handed-off';
  // Handed off because a terminal agent in another pane took the conversation.
  const continuedIn = handedOff ? binding.continuedIn : undefined;
  const continuedInPane = continuedIn?.paneId;
  const canHandOff = binding.capabilities.toTerminal && !handedOff && !running && binding.status !== 'starting';
  const continueInTerminal = async () => {
    setHandingOff(true);
    try { if (await controller.toTerminal()) onTerminal(); } finally { setHandingOff(false); }
  };
  // Model and effort change between turns; the daemon applies them live or restarts on the same conversation.
  const tunable = !configuring && !running && !handedOff && (binding.status === 'idle' || binding.status === 'stopped');
  const configure = async (change: { model?: string; effort?: string }) => {
    const key = draftKey;
    setConfiguringKey(key, true);
    try { await controller.configure(change); } finally { setConfiguringKey(key, false); }
  };

  return (
    <div className="wmux-chatv2" data-chatv2="ready" data-status={binding.status} onKeyDown={onKeyDown}>
      
      {findOpen && <FindBar blocks={view.session.blocks} onNavigate={setFindId} onClose={closeFind} />}
      <div className="wmux-chatv2-viewport" ref={scroller} onScroll={onScroll}>
        <OpenScope.Provider value={view.session.id}>
        <div ref={column} className="wmux-chatv2-column" role="log" aria-label={t('chat.conversation')}>
          {state.hasEarlier && transcriptWindow.hiddenCount === 0 && (
            <button type="button" className="wmux-chatv2-link wmux-chatv2-earlier" onClick={() => void controller.loadEarlier()}>{S.loadEarlier}</button>
          )}
          {transcriptWindow.visible.map((row) => (
            <TranscriptRowView
              key={row.key}
              row={row}
              cwd={view.session.cwd}
              actions={actions}
              findActive={!!findId && holdsBlock(row, findId)}
              findId={row.kind === 'toolGroup' || row.kind === 'turnFold' ? findId : undefined}
              enter={entered.current.has(row.key)}
            />
          ))}
        </div>
        </OpenScope.Provider>
      </div>
      <div className="wmux-chatv2-dock">
        <div className="sr-only" role="status" aria-live="polite" data-chatv2-announce>{announce}</div>
        {(newBelow || away) && (
          <button type="button" className="wmux-chatv2-jump" title={t('chat.scrollToBottom')} data-chatv2-jump data-new={newBelow || undefined} onClick={toLatest}>
            <ArrowIcon dir="down" />
            <span>{newBelow ? S.newBelow : S.jumpToLatest}</span>
          </button>
        )}
        {error}
        {pendingApproval && !handedOff && <PinnedApproval key={pendingApproval.approval!.requestId} block={pendingApproval} cwd={view.session.cwd} active={active} onAnswer={actions.answer} />}
        {handedOff ? (
          <div className="wmux-chatv2-notice wmux-chatv2-handed-off">
            <span>{continuedIn ? t(continuedInPane ? 'chat.continuedInPane' : 'chat.continuedInTerminal') : S.handedOff}</span>
            {continuedInPane ? (
              <button type="button" className="wmux-chatv2-link" onClick={() => focusPaneByPtyId(() => useStore.getState(), continuedInPane)}>{t('chat.showPane')}</button>
            ) : !continuedIn && (
              <button type="button" className="wmux-chatv2-link" onClick={onTerminal}>{t('chat.openTerminal')}</button>
            )}
            {/* Shown only while no agent runs in the pane (viewState); the daemon checks again. */}
            <ContinueInChat paneId={paneId} tombstone className="wmux-chatv2-link" />
            <button type="button" className="wmux-chatv2-btn" title={S.startNewChatHint} onClick={() => void controller.close()}>{S.startNewChat}</button>
          </div>
        ) : (
          <>
          <QueuedMessages draftKey={draftKey} deliveringId={deliveringId} queuedLabel={t('chat.queued')} />
          <Composer
            key={`${binding.chatSessionId}:${draftRev}`}
            paneId={paneId}
            canAttach={binding.capabilities.images}
            draftKey={draftKey}
            placeholder={S.placeholder(S.agentName[binding.agent])}
            disabled={!binding.capabilities.send || binding.status === 'failed'}
            running={running}
            canStop={binding.capabilities.interrupt}
            chips={{
              agent: binding.agent,
              model: binding.model,
              effort: view.session.modelSettings.effort ?? '',
              mode: binding.mode,
              cwd: view.session.cwd,
              editable: false,
              tunable,
              onModel: (model) => void configure({ model }),
              onEffort: (effort) => void configure({ effort }),
            }}
            skills={() => controller.skills()}
            onSend={async (text, staged) => {
              toLatest();
              // Behind a running turn, an agent still starting, a model change, or what is already queued, so the order holds.
              if (running || queue.length || binding.status === 'starting' || configuring) { enqueueMessage(draftKey, { id: clientMessageId(), text, staged }); return true; }
              return controller.send(text, staged.map((item) => item.path));
            }}
            onStop={() => void controller.interrupt()}
            menu={binding.capabilities.toTerminal && !handedOff ? [{
              id: 'terminal',
              label: S.continueInTerminal,
              title: canHandOff ? S.continueInTerminalHint : S.modelBusy,
              disabled: !canHandOff || handingOff,
              onSelect: () => void continueInTerminal(),
            }] : []}
          />
          </>
        )}
        {(binding.status === 'starting' || binding.status === 'stopped' || binding.status === 'failed') && (
          <div className="wmux-chatv2-status" data-status={binding.status}>{binding.error?.message ?? S.status[binding.status]}</div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../../hooks/useT';
import { CHATV2_AGENT_CAPS, type ChatV2Agent, type ChatV2RunMode } from '../../../shared/chatv2/ipc';
import { Composer, dequeueMessage, enqueueMessage, moveDraft, requeueToDraft, restoreToDraft, setDelivering, setDraft, useDeliveringId, useDraft, useQueuedMessages } from './Composer';
import { clientMessageId } from './controller';
import { shortDir } from '../../utils/shortDir';
import { FindBar } from './FindBar';
import { groupToolRows, sessionRows, type RowCache, type TranscriptRow } from './rows';
import { S } from './strings';
import { TranscriptRowView, type TranscriptActions } from './Transcript';
import { useChatV2 } from './useChatV2';
import { getChatV2Bridge } from './bridge';
import { ChatKindBadge } from '../Chat/ChatKindBadge';
import { ContinueInChat, usePaneMove } from './ContinueInChat';
import { useStore } from '../../stores';
import { focusPaneByPtyId } from '../../hooks/useNotificationListener';
import { useTranscriptWindow } from '../shared/useTranscriptWindow';
import { ArrowIcon } from './ArrowIcon';
import { IconX } from '../icons';

const NEAR_BOTTOM_PX = 48;

/** Whether `row` shows the block `blockId` (a group, as one of its members). */
const holdsBlock = (row: TranscriptRow, blockId: string): boolean =>
  row.kind === 'toolGroup' ? row.rows.some((member) => 'block' in member && member.block.id === blockId) : 'block' in row && row.block.id === blockId;

const kindRow = <div className="wmux-chatv2-kind"><ChatKindBadge kind="chatOnly" /></div>;

/**
 * Keys of rows appended after the transcript first loaded, so only those fade
 * in. A row stays marked once marked (dropping the mark mid-fade would cut it);
 * rows above the last one already shown (an earlier page) and a group that
 * absorbed rows already shown are not new. The live footer and a question sit
 * below the rows that stream in, so they do not count as "last shown".
 */
export function enteringKeys(rows: readonly TranscriptRow[], known: Set<string> | null, entered: Set<string>): Set<string> | null {
  const keys = (row: TranscriptRow) => (row.kind === 'toolGroup' ? [row.key, ...row.rows.map((member) => member.key)] : [row.key]);
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
  // A queued message whose Edit was refused (no room for its images).
  const [editRefused, setEditRefused] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findId, setFindId] = useState<string | null>(null);
  const [newModel, setNewModel] = useState('');
  const [newMode, setNewMode] = useState<ChatV2RunMode>('default');
  const [newAgent, setNewAgent] = useState<ChatV2Agent>('claude');
  // An agent without the Claude models or a bypass mode (Codex) starts on its own default and always asks.
  const pickAgent = (agent: ChatV2Agent) => {
    setNewAgent(agent);
    if (!CHATV2_AGENT_CAPS[agent].claudeModels) setNewModel('');
    if (!CHATV2_AGENT_CAPS[agent].bypass) setNewMode('default');
  };
  const [handingOff, setHandingOff] = useState(false);
  const moveError = usePaneMove(paneId).error;
  // Bumped to remount the composer when a draft moved under it.
  const [draftRev, setDraftRev] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Rows arrived below while the reader was scrolled up: offer the way back,
  // and say so to a screen reader (a polite live region, apart from the button).
  const [newBelow, setNewBelow] = useState(false);
  const [announce, setAnnounce] = useState('');
  const lastRowKey = useRef<string | undefined>(undefined);

  const rowCache = useRef<RowCache>(new WeakMap());
  const rows = useMemo(() => (view ? groupToolRows(sessionRows(view.session, rowCache.current), rowCache.current) : []), [view]);
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
  knownKeys.current = enteringKeys(rows, knownKeys.current, entered.current);
  // A long transcript mounts its recent rows; earlier ones are read in on the way up.
  const transcriptWindow = useTranscriptWindow({
    resetKey: view?.session.id,
    items: rows,
    keyOf: (row) => row.key,
    isTurnStart: (row) => row.kind === 'user',
    scrollRef: scroller,
  });
  const actions = useMemo<TranscriptActions>(() => ({
    answer: (requestId, decision, answers) => controller?.answer(requestId, decision, answers) ?? Promise.resolve(false),
    body: (blockId, field, offset) => controller?.body(blockId, field, offset) ?? Promise.resolve(null),
  }), [controller]);

  // Stay at the bottom while the reader is there; otherwise note that a row
  // arrived below (the live footer only ticks, so it does not count).
  const lastKey = rows.findLast((row) => row.kind !== 'footer')?.key;
  useLayoutEffect(() => {
    const el = scroller.current;
    const arrived = lastRowKey.current !== undefined && lastKey !== lastRowKey.current;
    lastRowKey.current = lastKey;
    if (el && pinned.current && !findId) { el.scrollTop = el.scrollHeight; setNewBelow(false); setAnnounce(''); }
    else if (arrived) { setNewBelow(true); setAnnounce(S.newBelow); }
  }, [transcriptWindow.visible, findId, lastKey, queue.length]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
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
  const canDeliver = !!view && !running && (status === 'idle' || status === 'stopped') && view.binding.capabilities.send;
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
  }, [nextQueued, controller, draftKey, deliveringId, copyAt, paneId]);

  // A first message whose chat was created after a split remount stays under
  // the new-chat draft; once the chat shows, it moves to the chat's composer.
  const newChatDraft = useDraft(`${paneId}:new`);
  useEffect(() => {
    if (!view || newChatDraft.sending || (!newChatDraft.text && !newChatDraft.staged.length)) return;
    moveDraft(`${paneId}:new`, draftKey);
  }, [view, newChatDraft, paneId, draftKey]);

  if (state.phase === 'loading') {
    return <div className="wmux-chatv2" data-chatv2="loading">{kindRow}<div className="wmux-chatv2-state" role="status">{t('chat.loading')}</div></div>;
  }
  if (state.phase === 'unavailable' || !controller) {
    return (
      <div className="wmux-chatv2" data-chatv2="unavailable">
        {kindRow}
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
        {kindRow}
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
            canAttach={false}
            chips={{ agent: newAgent, model: newModel, effort: '', mode: newMode, editable: true, onModel: setNewModel, onMode: setNewMode, onAgent: pickAgent }}
            onSend={async (text, staged) => {
              const attachments = staged.map((item) => item.path);
              if (!(await controller.create({ agent: newAgent, mode: newMode, model: newModel }))) return false;
              setDraft(`${paneId}:new`, '');
              const chatSessionId = controller.current.view?.binding.chatSessionId;
              if (await controller.send(text, attachments)) return true;
              // The chat exists but the first message did not go: keep it in that chat's composer.
              if (chatSessionId) { setDraft(`${paneId}:${chatSessionId}`, text); setDraftRev((rev) => rev + 1); }
              return false;
            }}
            onStop={() => undefined}
          />
        </div>
      </div>
    );
  }

  const binding = view.binding;
  const handedOff = binding.status === 'handed-off';
  // Handed off because a terminal agent in another pane took the conversation.
  const continuedIn = handedOff ? binding.continuedIn : undefined;
  const continuedInPane = continuedIn?.paneId;
  const canHandOff = binding.capabilities.toTerminal && !handedOff && !running && binding.status !== 'starting';
  const continueInTerminal = async () => {
    setHandingOff(true);
    try { if (await controller.toTerminal()) onTerminal(); } finally { setHandingOff(false); }
  };

  return (
    <div className="wmux-chatv2" data-chatv2="ready" data-status={binding.status} onKeyDown={onKeyDown}>
      {kindRow}
      {findOpen && <FindBar blocks={view.session.blocks} onNavigate={setFindId} onClose={closeFind} />}
      <div className="wmux-chatv2-viewport" ref={scroller} onScroll={onScroll}>
        <div className="wmux-chatv2-column" role="log" aria-label={t('chat.conversation')}>
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
              findId={row.kind === 'toolGroup' ? findId : undefined}
              enter={entered.current.has(row.key)}
            />
          ))}
          {queue.map((item) => (
            <div key={item.id} className="wmux-chatv2-queued" data-chatv2-queued data-sending={item.id === deliveringId || undefined}>
              <div className="wmux-chatv2-user">{item.text}</div>
              {item.staged.map((file) => <div key={file.path} className="wmux-chatv2-meta">{file.name}</div>)}
              {/* Until it goes, a queued message can be taken back: Edit puts it in the composer, × drops it.
                  Once its delivery started neither could stop it, so neither is offered. */}
              {item.id === deliveringId ? (
                <div className="wmux-chatv2-queued-caption"><span>{S.queuedSending}</span></div>
              ) : (
                <div className="wmux-chatv2-queued-caption">
                  <span>{editRefused === item.id ? S.editQueuedFull : t('chat.queued')}</span>
                  <button type="button" className="wmux-chatv2-link" data-chatv2-queued-edit
                    onClick={() => {
                      if (!restoreToDraft(draftKey, item)) { setEditRefused(item.id); return; }
                      setEditRefused(null);
                      dequeueMessage(draftKey, item.id);
                    }}>{S.editQueued}</button>
                  <button type="button" className="wmux-chatv2-icon" aria-label={S.removeQueued} title={S.removeQueued} data-chatv2-queued-remove
                    onClick={() => dequeueMessage(draftKey, item.id)}><IconX size={12} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="wmux-chatv2-dock">
        <div className="sr-only" role="status" aria-live="polite" data-chatv2-announce>{announce}</div>
        {newBelow && (
          <button type="button" className="wmux-chatv2-jump" aria-label={t('chat.scrollToBottom')} title={t('chat.scrollToBottom')} data-chatv2-jump onClick={toLatest}>
            <ArrowIcon dir="down" />
          </button>
        )}
        {error}
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
          <Composer
            key={`${binding.chatSessionId}:${draftRev}`}
            paneId={paneId}
            canAttach={binding.capabilities.images}
            draftKey={draftKey}
            placeholder={S.placeholder(S.agentName[binding.agent])}
            disabled={!binding.capabilities.send || binding.status === 'failed'}
            running={running}
            canStop={binding.capabilities.interrupt}
            chips={{ agent: binding.agent, model: binding.model, effort: view.session.modelSettings.effort ?? '', mode: binding.mode, cwd: view.session.cwd, editable: false }}
            onSend={async (text, staged) => {
              toLatest();
              // Behind a running turn, an agent still starting, or what is already queued, so the order holds.
              if (running || queue.length || binding.status === 'starting') { enqueueMessage(draftKey, { id: clientMessageId(), text, staged }); return true; }
              return controller.send(text, staged.map((item) => item.path));
            }}
            onStop={() => void controller.interrupt()}
            extra={canHandOff ? (
              <button type="button" className="wmux-chatv2-btn" title={S.continueInTerminalHint} disabled={handingOff} onClick={() => void continueInTerminal()}>
                {S.continueInTerminal}
              </button>
            ) : null}
          />
        )}
        {(binding.status === 'starting' || binding.status === 'stopped' || binding.status === 'failed') && (
          <div className="wmux-chatv2-status" data-status={binding.status}>{binding.error?.message ?? S.status[binding.status]}</div>
        )}
      </div>
    </div>
  );
}

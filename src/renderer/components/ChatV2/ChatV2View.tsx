import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../../hooks/useT';
import type { ChatV2RunMode } from '../../../shared/chatv2/ipc';
import { Composer, setDraft, shortDir } from './Composer';
import { FindBar } from './FindBar';
import { sessionRows, type RowCache } from './rows';
import { S } from './strings';
import { TranscriptRowView, type TranscriptActions } from './Transcript';
import { useChatV2 } from './useChatV2';
import { getChatV2Bridge } from './bridge';

const NEAR_BOTTOM_PX = 48;

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
  const [findOpen, setFindOpen] = useState(false);
  const [findId, setFindId] = useState<string | null>(null);
  const [newModel, setNewModel] = useState('');
  const [newMode, setNewMode] = useState<ChatV2RunMode>('default');
  const [handingOff, setHandingOff] = useState(false);
  // Bumped to remount the composer when a draft moved under it.
  const [draftRev, setDraftRev] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const rowCache = useRef<RowCache>(new WeakMap());
  const rows = useMemo(() => (view ? sessionRows(view.session, rowCache.current) : []), [view]);
  const actions = useMemo<TranscriptActions>(() => ({
    answer: (requestId, decision, answers) => controller?.answer(requestId, decision, answers) ?? Promise.resolve(false),
    body: (blockId, field, offset) => controller?.body(blockId, field, offset) ?? Promise.resolve(null),
  }), [controller]);

  // Stay at the bottom while the reader is there.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current && !findId) el.scrollTop = el.scrollHeight;
  }, [rows, findId]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };
  useEffect(() => {
    if (!findId) return;
    scroller.current?.querySelector(`[data-block-id="${CSS.escape(findId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [findId]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f' && view) {
      event.preventDefault();
      event.stopPropagation();
      setFindOpen(true);
    }
  };
  const closeFind = useCallback(() => { setFindOpen(false); setFindId(null); }, []);

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

  const error = state.error ? <div className="wmux-chatv2-notice" data-tone="error" role="alert">{state.error.message}</div> : null;

  if (state.phase === 'empty' || !view) {
    return (
      <div className="wmux-chatv2" data-chatv2="empty">
        <div className="wmux-chatv2-viewport">
          <div className="wmux-chatv2-column wmux-chatv2-empty">
            <strong>{S.newChat}</strong>
            <p>{S.newChatHint}</p>
            <RunsIn paneId={paneId} hint={cwd} />
          </div>
        </div>
        <div className="wmux-chatv2-dock">
          {error}
          <Composer
            paneId={paneId}
            draftKey={`${paneId}:new`}
            placeholder={S.placeholderNew}
            disabled={false}
            running={false}
            canStop={false}
            canAttach={false}
            chips={{ model: newModel, effort: '', mode: newMode, editable: true, onModel: setNewModel, onMode: setNewMode }}
            onSend={async (text, attachments) => {
              if (!(await controller.create({ agent: 'claude', mode: newMode, model: newModel }))) return false;
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
  const running = !!view.session.busy || binding.status === 'running' || binding.status === 'needs-input';
  const canHandOff = binding.capabilities.toTerminal && !handedOff && !running && binding.status !== 'starting';
  const continueInTerminal = async () => {
    setHandingOff(true);
    try { if (await controller.toTerminal()) onTerminal(); } finally { setHandingOff(false); }
  };

  return (
    <div className="wmux-chatv2" data-chatv2="ready" data-status={binding.status} onKeyDown={onKeyDown}>
      {findOpen && <FindBar blocks={view.session.blocks} onNavigate={setFindId} onClose={closeFind} />}
      <div className="wmux-chatv2-viewport" ref={scroller} onScroll={onScroll}>
        <div className="wmux-chatv2-column" role="log" aria-label={t('chat.conversation')}>
          {state.hasEarlier && (
            <button type="button" className="wmux-chatv2-link wmux-chatv2-earlier" onClick={() => void controller.loadEarlier()}>{S.loadEarlier}</button>
          )}
          {rows.map((row) => (
            <TranscriptRowView
              key={row.key}
              row={row}
              cwd={view.session.cwd}
              actions={actions}
              findActive={!!findId && 'block' in row && row.block.id === findId}
            />
          ))}
        </div>
      </div>
      <div className="wmux-chatv2-dock">
        {error}
        {handedOff ? (
          <div className="wmux-chatv2-notice wmux-chatv2-handed-off">
            <span>{S.handedOff}</span>
            <button type="button" className="wmux-chatv2-link" onClick={onTerminal}>{t('chat.openTerminal')}</button>
            <button type="button" className="wmux-chatv2-btn" title={S.startNewChatHint} onClick={() => void controller.close()}>{S.startNewChat}</button>
          </div>
        ) : (
          <Composer
            key={`${binding.chatSessionId}:${draftRev}`}
            paneId={paneId}
            canAttach={binding.capabilities.images}
            draftKey={`${paneId}:${binding.chatSessionId}`}
            placeholder={S.placeholder}
            disabled={!binding.capabilities.send || binding.status === 'failed'}
            running={running}
            canStop={binding.capabilities.interrupt}
            chips={{ model: binding.model, effort: view.session.modelSettings.effort ?? '', mode: binding.mode, cwd: view.session.cwd, editable: false }}
            onSend={(text, attachments) => controller.send(text, attachments)}
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

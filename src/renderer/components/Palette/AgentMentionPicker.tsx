import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { t as translate } from '../../i18n';
import { tokenAttrs } from '../../themes';
import { displayCombo } from '../../../shared/keymap';
import { shortcutPlatform } from '../../utils/shortcutBindings';
import { unwrapRpc } from '../../utils/unwrapRpc';
import {
  buildMentionReference,
  buildMentionSendParams,
  buildMentionTargets,
  describeMentionSendResult,
  filterMentionTargets,
  focusedMentionSource,
  type MentionPaneTarget,
  type MentionSendOutcome,
  type MentionSource,
  type MentionTarget,
} from '../../utils/agentMention';
import { insertMention, OPEN_MENTION_PICKER_EVENT, toastMentionInsert } from '../../utils/agentMentionInsert';
import { useModalLayer } from '../ui/modalLayer';
import { StatusMarkView } from '../Sidebar/AgentMarks';
import Button from '../ui/Button';

type Feedback = { tone: 'ok' | 'error' | 'note'; text: string };

/** One opening of the picker: what it was opened from and the list at that moment. */
interface Session {
  id: number;
  source: MentionSource;
  targets: MentionTarget[];
}

function outcomeFeedback(outcome: MentionSendOutcome, name: string): Feedback {
  if (outcome.kind === 'sent') {
    return { tone: 'ok', text: translate(outcome.nudge ? 'mention.sentNudge' : 'mention.sent', { name }) };
  }
  if (outcome.kind === 'stored') {
    return { tone: 'note', text: translate('mention.stored', { name, reason: outcome.reason }) };
  }
  return { tone: 'error', text: translate('mention.refused', { reason: outcome.reason }) };
}

/**
 * The direct send (⌘Enter / Ctrl+Enter). It goes through main's RPC router —
 * the same `a2a.task.send` an agent's send_message reaches — so the task is
 * mirrored into the daemon like any other: it survives a restart and the web
 * and phone clients see it.
 */
async function sendDirect(source: MentionSource, target: MentionPaneTarget, text: string): Promise<MentionSendOutcome> {
  try {
    const raw = await window.electronAPI.rpc.invoke('a2a.task.send', buildMentionSendParams(source, target, text));
    return describeMentionSendResult(unwrapRpc(raw));
  } catch (err) {
    return { kind: 'refused', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The agent mention picker (⌘⇧2 / F2): a command-palette-style list of the
 * other agents, across workspaces. Enter inserts a one-line reference into the
 * focused agent's input; ⌘Enter / Ctrl+Enter with a message sends it straight
 * to the chosen pane.
 *
 * Opened by an event rather than store state: what it needs is a snapshot of
 * the focused pane at the moment it opened, taken before its own input takes
 * focus away from that pane.
 */
export default function AgentMentionPicker() {
  const [session, setSession] = useState<Session | null>(null);
  // Mirrors `session` for async callbacks, which must not act on a picker the
  // user already closed or reopened.
  const sessionRef = useRef<Session | null>(null);
  const nextId = useRef(0);

  useEffect(() => {
    const open = () => {
      // Pressing the shortcut again while the picker is up does nothing: the
      // draft and the selection are the user's.
      if (sessionRef.current) return;
      const state = useStore.getState();
      const source = focusedMentionSource(state);
      if (!source) {
        state.pushToast({ message: translate('mention.noSource'), level: 'info' });
        return;
      }
      const next = { id: ++nextId.current, source, targets: buildMentionTargets(state, source.ptyId) };
      sessionRef.current = next;
      setSession(next);
    };
    document.addEventListener(OPEN_MENTION_PICKER_EVENT, open);
    return () => document.removeEventListener(OPEN_MENTION_PICKER_EVENT, open);
  }, []);

  const close = useCallback(() => {
    sessionRef.current = null;
    setSession(null);
  }, []);

  if (!session) return null;
  return <PickerPanel key={session.id} session={session} sessionRef={sessionRef} close={close} />;
}

function PickerPanel({ session, sessionRef, close }: {
  session: Session;
  sessionRef: React.MutableRefObject<Session | null>;
  close: () => void;
}) {
  const t = useT();
  const { source, targets } = session;
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Escape, the Tab trap and handing focus back to the pane on close are the
  // shared modal layer's (DESIGN.md "Dialogs & forms").
  const attachLayer = useModalLayer({ onEscape: close });
  const platform = shortcutPlatform();
  const mac = platform === 'darwin';
  const sendCombo = displayCombo(mac ? 'Meta+Enter' : 'Ctrl+Enter', platform);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => filterMentionTargets(targets, query), [targets, query]);
  const active = results[Math.min(activeIdx, Math.max(0, results.length - 1))];
  const paneTarget = active?.kind === 'pane' ? active : undefined;
  const canSend = !!paneTarget && !!message.trim() && !sending;

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx]);

  const insert = (target: MentionTarget | undefined) => {
    if (!target) return;
    close();
    toastMentionInsert(insertMention(source, buildMentionReference(target)));
  };

  const send = async () => {
    if (sending) return;
    if (!paneTarget) {
      setFeedback({ tone: 'note', text: t('mention.pickPane') });
      return;
    }
    const text = message.trim();
    if (!text) {
      setFeedback({ tone: 'note', text: t('mention.needMessage', { combo: sendCombo }) });
      return;
    }
    setSending(true);
    const outcome = await sendDirect(source, paneTarget, text);
    const shown = outcomeFeedback(outcome, paneTarget.agentName);
    if (sessionRef.current !== session) {
      // Closed (or closed and reopened) while the send was in flight: the
      // result still reaches the user, just not through a panel that is gone.
      useStore.getState().pushToast({ message: shown.text, level: shown.tone === 'error' ? 'error' : 'info' });
      return;
    }
    setSending(false);
    setFeedback(shown);
    // Clear the field only if it still holds what was sent — the user may
    // have started the next message while this one was on its way.
    if (outcome.kind === 'sent') setMessage((current) => (current.trim() === text ? '' : current));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, field: 'filter' | 'message') => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = Math.max(results.length, 1);
      setActiveIdx((prev) => (prev + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // The message field has nothing to insert: Enter there sends as well.
      if ((mac ? e.metaKey : e.ctrlKey) || field === 'message') void send();
      else insert(active);
    }
  };

  const feedbackColor = feedback?.tone === 'error'
    ? 'var(--accent-red)'
    : feedback?.tone === 'ok' ? 'var(--text-main)' : 'var(--text-sub)';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
      style={{ backgroundColor: 'var(--bg-overlay-scrim, rgba(0, 0, 0, 0.55))' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      data-agent-mention-picker
    >
      <div
        ref={attachLayer}
        role="dialog"
        aria-modal="true"
        aria-label={t('mention.title')}
        className="ui-popover ui-surface w-[520px] max-h-[60vh] flex flex-col overflow-hidden"
        style={{ padding: 0 }}
        onMouseDown={(e) => e.stopPropagation()}
        {...tokenAttrs('bgBase', 'bg')}
      >
        <div className="flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: '1px solid var(--surface-hairline)' }}>
          <span className="shrink-0 text-[14px] leading-5 text-[var(--text-sub)]" aria-hidden>@</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={(e) => onKeyDown(e, 'filter')}
            placeholder={t('mention.placeholder')}
            aria-label={t('mention.placeholder')}
            role="combobox"
            aria-expanded
            aria-controls="agent-mention-list"
            aria-activedescendant={active ? `agent-mention-${active.key}` : undefined}
            className="flex-1 bg-transparent text-[var(--text-main)] text-[14px] leading-5 placeholder-[var(--text-muted)] outline-none"
            spellCheck={false}
            autoComplete="off"
            data-agent-mention-filter
          />
          <kbd className="ui-kbd shrink-0">ESC</kbd>
        </div>

        <div ref={listRef} id="agent-mention-list" role="listbox" className="overflow-y-auto flex-1 py-1.5">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-[var(--text-sub)]">
              {targets.length === 0 ? t('mention.empty') : t('mention.noMatch')}
            </div>
          ) : results.map((target, idx) => {
            const isActive = target === active;
            return (
              <button
                key={target.key}
                id={`agent-mention-${target.key}`}
                type="button"
                role="option"
                aria-selected={isActive}
                data-active={isActive ? 'true' : undefined}
                tabIndex={-1}
                onMouseMove={() => { if (idx !== activeIdx) setActiveIdx(idx); }}
                onClick={() => insert(target)}
                className={[
                  'mx-1.5 flex w-[calc(100%-12px)] items-center gap-3 rounded-[8px] px-3 py-2 text-left transition-colors text-[var(--text-main)]',
                  isActive ? 'bg-[var(--surface-fill-hover)]' : '',
                ].join(' ')}
              >
                {target.kind === 'pane' ? (
                  <>
                    <span className="shrink-0 flex h-4 w-4 items-center justify-center">
                      <StatusMarkView status={target.status} neutralRunning />
                    </span>
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="shrink-0 text-[13px] leading-5">{target.agentName}</span>
                      {target.title && (
                        <span className="truncate text-[12px] leading-5 text-[var(--text-sub)]">{target.title}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-[11px] leading-4 text-[var(--text-sub)]">{target.workspaceName}</span>
                    <span className="ui-code shrink-0 text-[11px] leading-4 text-[var(--text-sub)]">{target.coordinate}</span>
                  </>
                ) : (
                  <>
                    <span className="shrink-0 flex h-4 w-4 items-center justify-center" />
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="shrink-0 text-[13px] leading-5">{target.workspaceName}</span>
                      <span className="truncate text-[12px] leading-5 text-[var(--text-sub)]">
                        {t('mention.workspaceRow', { count: target.panes.length })}
                      </span>
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderTop: '1px solid var(--surface-hairline)' }}>
          <input
            type="text"
            value={message}
            onChange={(e) => { setMessage(e.target.value); setFeedback(null); }}
            onKeyDown={(e) => onKeyDown(e, 'message')}
            placeholder={paneTarget ? t('mention.messagePlaceholder', { name: paneTarget.agentName }) : t('mention.pickPane')}
            aria-label={t('mention.messageLabel')}
            className="ui-input flex-1 min-w-0 text-[13px]"
            spellCheck={false}
            autoComplete="off"
            data-agent-mention-message
          />
          <Button
            variant={canSend ? 'primary' : 'secondary'}
            size="sm"
            disabled={!canSend}
            onClick={() => void send()}
            data-agent-mention-send
          >
            {t('mention.send')}
          </Button>
        </div>

        <div className="flex items-center gap-4 px-4 pb-2.5 min-h-[28px]">
          {feedback ? (
            <span role="status" className="truncate text-[12px] leading-4" style={{ color: feedbackColor }} title={feedback.text} data-agent-mention-feedback>
              {feedback.text}
            </span>
          ) : (
            <>
              <span className="ui-note flex items-center gap-1.5"><kbd className="ui-kbd">Enter</kbd>{t('mention.insert')}</span>
              {/* A workspace row has no single pane to send to. */}
              {paneTarget
                ? <span className="ui-note flex items-center gap-1.5" data-agent-mention-send-hint><kbd className="ui-kbd">{sendCombo}</kbd>{t('mention.sendHint')}</span>
                : active && <span className="ui-note" data-agent-mention-pick-pane>{t('mention.pickPane')}</span>}
              <span className="ui-note flex items-center gap-1.5"><kbd className="ui-kbd">Esc</kbd>{t('palette.close')}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

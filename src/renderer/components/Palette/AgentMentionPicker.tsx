import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { handleRpcMethod } from '../../hooks/useRpcBridge';
import { tokenAttrs } from '../../themes';
import { displayCombo } from '../../../shared/keymap';
import { shortcutPlatform } from '../../utils/shortcutBindings';
import {
  buildMentionReference,
  buildMentionSendParams,
  buildMentionTargets,
  describeMentionSendResult,
  filterMentionTargets,
  focusedMentionSource,
  type MentionSource,
  type MentionTarget,
} from '../../utils/agentMention';
import { focusMentionSource, insertMention, OPEN_MENTION_PICKER_EVENT } from '../../utils/agentMentionInsert';
import { StatusMarkView } from '../Sidebar/AgentMarks';
import Button from '../ui/Button';

type Feedback = { tone: 'ok' | 'error' | 'note'; text: string };

/**
 * The agent mention picker (⌘⇧2 / F2): a command-palette-style list of the
 * other agents, across workspaces. Enter inserts a one-line reference into the
 * focused agent's input; ⌘Enter / Ctrl+Enter with a message sends it straight
 * to the chosen pane through the A2A send path.
 *
 * Opened by an event rather than store state: what it needs is a snapshot of
 * the focused pane at the moment it opened, taken before its own input takes
 * focus away from that pane.
 */
export default function AgentMentionPicker() {
  const t = useT();
  const [source, setSource] = useState<MentionSource | null>(null);
  const [targets, setTargets] = useState<MentionTarget[]>([]);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mac = shortcutPlatform() === 'darwin';
  const sendCombo = displayCombo(mac ? 'Meta+Enter' : 'Ctrl+Enter', shortcutPlatform());

  useEffect(() => {
    const open = () => {
      const state = useStore.getState();
      const src = focusedMentionSource(state);
      if (!src) {
        state.pushToast({ message: t('mention.noSource'), level: 'info' });
        return;
      }
      setSource(src);
      setTargets(buildMentionTargets(state, src.ptyId));
      setQuery('');
      setMessage('');
      setActiveIdx(0);
      setFeedback(null);
    };
    document.addEventListener(OPEN_MENTION_PICKER_EVENT, open);
    return () => document.removeEventListener(OPEN_MENTION_PICKER_EVENT, open);
  }, [t]);

  useEffect(() => { if (source) inputRef.current?.focus(); }, [source]);

  const results = useMemo(() => filterMentionTargets(targets, query), [targets, query]);
  const active = results[Math.min(activeIdx, Math.max(0, results.length - 1))];

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!source) return null;

  const targetName = (target: MentionTarget) =>
    target.kind === 'pane' ? target.agentName : target.workspaceName;

  const close = (refocus: boolean) => {
    const src = source;
    setSource(null);
    // Hand the keyboard back to the pane the picker was opened from.
    if (refocus) focusMentionSource(src);
  };

  const insert = (target: MentionTarget | undefined) => {
    if (!target) return;
    const src = source;
    setSource(null);
    insertMention(src, buildMentionReference(target));
  };

  const send = async (target: MentionTarget | undefined) => {
    if (!target || sending) return;
    const text = message.trim();
    if (!text) {
      setFeedback({ tone: 'note', text: t('mention.needMessage', { combo: sendCombo }) });
      return;
    }
    setSending(true);
    try {
      const result = await handleRpcMethod('a2a.task.send', buildMentionSendParams(source, target, text));
      const outcome = describeMentionSendResult(result);
      const name = targetName(target);
      if (outcome.kind === 'sent') {
        setMessage('');
        setFeedback({ tone: 'ok', text: t(outcome.nudge ? 'mention.sentNudge' : 'mention.sent', { name }) });
      } else if (outcome.kind === 'stored') {
        setFeedback({ tone: 'note', text: t('mention.stored', { name, reason: outcome.reason }) });
      } else {
        setFeedback({ tone: 'error', text: t('mention.refused', { reason: outcome.reason }) });
      }
    } catch (err) {
      setFeedback({ tone: 'error', text: t('mention.refused', { reason: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, field: 'filter' | 'message') => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = Math.max(results.length, 1);
      setActiveIdx((prev) => (prev + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // The message field has nothing to insert: Enter there sends as well.
      if ((mac ? e.metaKey : e.ctrlKey) || field === 'message') void send(active);
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
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(true); }}
      data-agent-mention-picker
    >
      <div
        role="dialog"
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
            placeholder={t('mention.messagePlaceholder', { name: active ? targetName(active) : '…' })}
            aria-label={t('mention.messageLabel')}
            className="ui-input flex-1 min-w-0 text-[13px]"
            spellCheck={false}
            autoComplete="off"
            data-agent-mention-message
          />
          <Button
            variant={message.trim() && active && !sending ? 'primary' : 'secondary'}
            size="sm"
            disabled={!message.trim() || !active || sending}
            onClick={() => void send(active)}
          >
            {t('mention.send')}
          </Button>
        </div>

        <div className="flex items-center gap-4 px-4 pb-2.5 min-h-[28px]">
          {feedback ? (
            <span role="status" className="truncate text-[12px] leading-4" style={{ color: feedbackColor }} data-agent-mention-feedback>
              {feedback.text}
            </span>
          ) : (
            <>
              <span className="ui-note flex items-center gap-1.5"><kbd className="ui-kbd">Enter</kbd>{t('mention.insert')}</span>
              <span className="ui-note flex items-center gap-1.5"><kbd className="ui-kbd">{sendCombo}</kbd>{t('mention.sendHint')}</span>
              <span className="ui-note flex items-center gap-1.5"><kbd className="ui-kbd">Esc</kbd>{t('palette.close')}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

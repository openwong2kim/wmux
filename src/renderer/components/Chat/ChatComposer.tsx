// Chat composer (plan PR-7, PRD §4.3).
//
// Two safety rules govern this file, both from the eng review:
//
//  • A1/A2 — the gate is NOT derived here. `needsInput` arrives as a prop from
//    the hook-authoritative source (PR-6, the daemon ApprovalRegistry). This
//    component obeys it and never second-guesses it from `agentStatus`
//    (`'waiting'` is Claude Code's IDLE footer, and byte-silence `idle` fires
//    ~15s into every permission menu — either would unlock a menu).
//
//  • A7 — the send helper writes `\r` from a 100ms timeout. A pane can move
//    onto a permission menu inside that window, where a bare Enter selects the
//    highlighted option. So the gate is re-read twice: once synchronously
//    before calling the helper, and again inside the helper's timeout via
//    `submitGuard`.
//
// Under `needsInput` the textarea is REMOVED from the DOM, not disabled: a
// disabled input still accepts paste in some engines, and the whole point of
// the gate is that no byte reaches the PTY.
//
// DECSET 2004 dependency: `submitBracketedPasteToPty` wraps the payload in
// bracketed-paste markers, which only behave as paste if the foreground program
// enabled DECSET 2004. Claude Code does; a plain shell treats the markers as
// literal text, which is why Chat View is gated on a Claude transcript.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { submitBracketedPasteToPty } from '../../utils/ptyMessageDelivery';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';

export interface ChatComposerProps {
  ptyId: string;
  /** Hard gate from the hook-authoritative source (PR-6). Not a heuristic. */
  needsInput: boolean;
  /** The question the pane is blocked on, shown above the locked composer. */
  pendingQuestion?: string;
  agentStatus: 'running' | 'idle' | 'complete' | undefined;
  onJumpToTerminal: () => void;
  /** Called with the raw text AFTER the PTY write — the caller echoes it. */
  onSend: (text: string) => void;
  /** Pane focus: autofocus the textarea, nothing else. */
  isActive?: boolean;
}

const STATUS_COLOR: Record<'running' | 'idle' | 'complete', string> = {
  running: 'var(--accent)',
  idle: 'var(--text-muted)',
  complete: 'var(--accent-green)',
};

export function ChatComposer({
  ptyId,
  needsInput,
  pendingQuestion,
  agentStatus,
  onJumpToTerminal,
  onSend,
  isActive,
}: ChatComposerProps): React.ReactElement {
  const t = useT();
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Read by the deferred-Enter guard, so it sees the gate as of fire time.
  const needsInputRef = useRef(needsInput);
  useEffect(() => {
    needsInputRef.current = needsInput;
  }, [needsInput]);

  // A file dropped anywhere on a chat surface arrives here rather than at the
  // hidden xterm (AppLayout routes it). Appended to whatever is already typed,
  // space-separated, the way dropping onto a shell prompt behaves. Keyed on
  // `seq` so dropping the same path twice injects twice.
  const injection = useStore((s) => s.chatDropInjection[ptyId]);
  const clearInjection = useStore((s) => s.clearChatDropInjection);
  useEffect(() => {
    if (!injection) return;
    setValue((prev) => (prev && !prev.endsWith(' ') ? `${prev} ${injection.text}` : `${prev}${injection.text}`));
    clearInjection(ptyId);
    textareaRef.current?.focus();
    // `injection` is a fresh object per delivery (the store bumps `seq`), so
    // its identity is the trigger — no separate seq dependency is needed.
  }, [injection, ptyId, clearInjection]);

  useEffect(() => {
    if (isActive && !needsInput) textareaRef.current?.focus();
  }, [isActive, needsInput]);

  const send = useCallback(() => {
    const text = value;
    if (text.trim().length === 0) return;
    // Synchronous re-check: the gate may have engaged since the last render.
    if (needsInputRef.current) return;
    // The same guard now covers the PAYLOAD write as well as the deferred
    // Enter — the payload used to go out unconditionally at call time.
    const written = submitBracketedPasteToPty(ptyId, text, undefined, {
      submitGuard: () => !needsInputRef.current,
    });
    // Nothing was written, so nothing is echoed: an optimistic row for a message
    // the gate refused would read as sent and never be answered.
    if (!written) return;
    onSend(text);
    setValue('');
  }, [value, ptyId, onSend]);

  /** Insert a newline at the caret, keeping undo history and the caret position. */
  const insertNewline = useCallback((el: HTMLTextAreaElement) => {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    setValue((prev) => `${prev.slice(0, start)}\n${prev.slice(end)}`);
    // The value lands on the next render, so move the caret after it does.
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 1;
    });
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl+J is a newline, not a send. It is the key Claude Code's own TUI
      // binds for exactly that, so a user who learned it in the terminal
      // reaches for it here — and it used to do nothing at all: this handler
      // only ever looked at Enter, and Ctrl+J is not a textarea editing command
      // in Chromium either, so the keystroke vanished. (The chat toggle chord
      // is Ctrl+Shift+J, which is a different key and stays unaffected.)
      if (e.key === 'j' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        insertNewline(e.currentTarget);
        return;
      }
      // Enter sends, Shift+Enter newlines — the convention the agent's own TUI
      // uses, so muscle memory carries over.
      //
      // `isComposing` is what stops that convention from mangling Hangul (and
      // every other IME). Mid-composition, Enter COMMITS the candidate — it is
      // not a submit — so firing send() there cuts the message off at a
      // half-finished syllable and clears the box. Every other composer in this
      // repo already guards it; this one did not, and this repo's agents are
      // routinely driven in Korean.
      if (
        e.key === 'Enter' &&
        !e.nativeEvent.isComposing &&
        e.keyCode !== 229 &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        send();
      }
    },
    [send, insertNewline],
  );

  const statusRow = (
    <div className="flex items-baseline gap-1.5 px-1 pb-1" data-chat-status-row>
      {agentStatus && (
        <>
          <span
            className="text-[9px] leading-none"
            style={{ color: STATUS_COLOR[agentStatus] }}
            aria-hidden="true"
          >
            ●
          </span>
          <span className="text-[11px] font-mono text-[var(--text-muted)]">
            {t(`chat.status.${agentStatus}`)}
          </span>
        </>
      )}
      {needsInput && (
        <span className="text-[11px] font-mono text-[var(--accent-red)]" data-chat-needs-input>
          {t('chat.status.needsInput')}
        </span>
      )}
    </div>
  );

  if (needsInput) {
    return (
      <div className="flex flex-col px-2 pt-1.5 pb-2" data-chat-composer="locked">
        {statusRow}
        {pendingQuestion && (
          <div
            className="px-1 pb-1.5 text-[12px] leading-relaxed text-[var(--text-sub)] whitespace-pre-wrap break-words"
            data-chat-pending-question
          >
            {pendingQuestion}
          </div>
        )}
        <div className="px-1 pb-1 text-[11px] font-mono text-[var(--text-muted)]">
          {t('chat.terminalOnlyAnswer')}
        </div>
        {/* The ONE warm solid-fill primary of this surface. */}
        <button
          type="button"
          onClick={onJumpToTerminal}
          data-chat-answer-in-terminal
          className={`ui-btn ui-btn-primary self-start ${FOCUS_RING}`}
        >
          {t('chat.answerInTerminal')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col px-2 pt-1.5 pb-2" data-chat-composer="open">
      {statusRow}
      {/* No send button. Enter already sends and Shift+Enter newlines — the
          agent's own TUI convention, and true on soft keyboards too, which have
          a return key. A button would spend this surface's one warm primary on
          a redundant control and squeeze the field it sits beside; the key is
          named in the placeholder instead. */}
      <textarea
        ref={textareaRef}
        data-chat-input
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('chat.placeholder')}
        aria-label={t('chat.placeholder')}
        className="ui-input w-full resize-none text-[13px] leading-relaxed py-1.5"
      />
    </div>
  );
}

export default ChatComposer;

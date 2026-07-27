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
// Under `needsInput` the textarea and send button are REMOVED from the DOM,
// not disabled: a disabled input still accepts paste in some engines, and the
// whole point of the gate is that no byte reaches the PTY.
//
// DECSET 2004 dependency: `submitBracketedPasteToPty` wraps the payload in
// bracketed-paste markers, which only behave as paste if the foreground program
// enabled DECSET 2004. Claude Code does; a plain shell treats the markers as
// literal text, which is why Chat View is gated on a Claude transcript.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { submitBracketedPasteToPty } from '../../utils/ptyMessageDelivery';
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

  useEffect(() => {
    if (isActive && !needsInput) textareaRef.current?.focus();
  }, [isActive, needsInput]);

  const send = useCallback(() => {
    const text = value;
    if (text.trim().length === 0) return;
    // Synchronous re-check: the gate may have engaged since the last render.
    if (needsInputRef.current) return;
    submitBracketedPasteToPty(ptyId, text, undefined, {
      submitGuard: () => !needsInputRef.current,
    });
    onSend(text);
    setValue('');
  }, [value, ptyId, onSend]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends, Shift+Enter newlines — the convention the agent's own TUI
      // uses, so muscle memory carries over.
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
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
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          data-chat-input
          rows={2}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('chat.placeholder')}
          aria-label={t('chat.placeholder')}
          className="ui-input flex-1 resize-none text-[13px] leading-relaxed py-1.5"
        />
        <button
          type="button"
          data-chat-send
          onClick={send}
          disabled={value.trim().length === 0}
          className={`ui-btn ui-btn-primary ${FOCUS_RING}`}
        >
          {t('chat.send')}
        </button>
      </div>
    </div>
  );
}

export default ChatComposer;

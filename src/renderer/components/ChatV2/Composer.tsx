import { useRef, useState, type KeyboardEvent } from 'react';
import { CLAUDE_MODEL_OPTIONS, claudeModelLabel } from '../../../shared/claudeModels';
import type { ChatV2RunMode } from '../../../shared/chatv2/ipc';
import { CHATV2_MAX_PROMPT_BYTES, utf8Bytes } from '../../../shared/chatv2/limits';
import { S } from './strings';

// Drafts survive view switches, per pane and conversation.
const drafts = new Map<string, string>();

export interface ComposerChips {
  model: string;
  /** Effort as the head reports it; '' = the agent's default. Not settable through the contract yet. */
  effort: string;
  mode: ChatV2RunMode;
  /** Model and permissions can still change (before the chat starts). */
  editable: boolean;
  onModel?: (model: string) => void;
  onMode?: (mode: ChatV2RunMode) => void;
}

export function Composer({ draftKey, chips, placeholder, disabled, running, canStop, onSend, onStop, extra }: {
  draftKey: string;
  chips: ComposerChips;
  placeholder: string;
  disabled: boolean;
  running: boolean;
  canStop: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  extra?: React.ReactNode;
}) {
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? '');
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const setText = (value: string) => {
    setTextState(value);
    if (value) drafts.set(draftKey, value); else drafts.delete(draftKey);
  };
  const tooLong = utf8Bytes(text) > CHATV2_MAX_PROMPT_BYTES;
  const canSend = !disabled && !running && !sending && !!text.trim() && !tooLong;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const sent = text;
    try {
      if (await onSend(sent)) setText('');
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
    else if (event.key === 'Escape' && !text && running && canStop) { event.preventDefault(); onStop(); }
  };

  const modelKnown = CLAUDE_MODEL_OPTIONS.some((option) => option.value === chips.model);
  return (
    <div className="wmux-chatv2-composer">
      <textarea
        ref={input}
        className="wmux-chatv2-textarea"
        aria-label={placeholder}
        placeholder={placeholder}
        value={text}
        rows={2}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="wmux-chatv2-composer-bar">
        <div className="wmux-chatv2-chips">
          <label className="wmux-chatv2-chip" title={chips.editable ? S.model : S.modelFixed}>
            <span className="sr-only">{S.model}</span>
            <select value={chips.model} disabled={!chips.editable} onChange={(event) => chips.onModel?.(event.target.value)}>
              {!modelKnown && <option value={chips.model}>{claudeModelLabel(chips.model)}</option>}
              {CLAUDE_MODEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <span className="wmux-chatv2-chip" aria-disabled="true" title={S.effortFixed}>
            <span className="sr-only">{S.effort}: </span>{chips.effort || S.effortDefault}
          </span>
          <label className="wmux-chatv2-chip" data-mode={chips.mode} title={chips.mode === 'bypass' ? S.modeBypassHint : S.modeDefaultHint}>
            <span className="sr-only">{S.permission}</span>
            <select value={chips.mode} disabled={!chips.editable} onChange={(event) => chips.onMode?.(event.target.value as ChatV2RunMode)}>
              <option value="default">{S.modeDefault}</option>
              <option value="bypass">{S.modeBypass}</option>
            </select>
          </label>
        </div>
        <div className="wmux-chatv2-composer-actions">
          {extra}
          {running && canStop ? (
            <button type="button" className="wmux-chatv2-btn" onClick={onStop}>{S.stop}</button>
          ) : (
            <button type="button" className="wmux-chatv2-send" aria-label={S.send} disabled={!canSend} onClick={() => void send()}>↑</button>
          )}
        </div>
      </div>
    </div>
  );
}

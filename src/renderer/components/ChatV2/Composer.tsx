import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CLAUDE_MODEL_OPTIONS, claudeModelLabel } from '../../../shared/claudeModels';
import type { ChatV2RunMode } from '../../../shared/chatv2/ipc';
import { CHATV2_MAX_PROMPT_BYTES, utf8Bytes } from '../../../shared/chatv2/limits';
import { CHAT_ATTACHMENT_LIMIT, validChatImagePath } from '../../../shared/transcript/chatAttachments';
import { registerChatDropTarget, registerChatInsertTarget } from '../Chat/chatAttachments';
import { getChatV2Bridge } from './bridge';
import { S } from './strings';

// Drafts survive view switches, per pane and conversation (`<paneId>:<chatSessionId|new>`).
const drafts = new Map<string, string>();

export function setDraft(key: string, text: string): void {
  if (text) drafts.set(key, text); else drafts.delete(key);
}

/** Forget every draft of a pane that closed. */
export function forgetDrafts(paneId: string): void {
  for (const key of [...drafts.keys()]) if (key.startsWith(`${paneId}:`)) drafts.delete(key);
}

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

interface Staged { path: string; name: string }

export function Composer({ paneId, draftKey, chips, placeholder, disabled, running, canStop, canAttach, onSend, onStop, extra }: {
  paneId: string;
  draftKey: string;
  chips: ComposerChips;
  placeholder: string;
  disabled: boolean;
  running: boolean;
  canStop: boolean;
  /** The chat takes image attachments. */
  canAttach: boolean;
  onSend: (text: string, attachments: string[]) => Promise<boolean>;
  onStop: () => void;
  extra?: React.ReactNode;
}) {
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? '');
  const [staged, setStaged] = useState<Staged[]>([]);
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const setText = (value: string) => {
    setTextState(value);
    setDraft(draftKey, value);
  };

  // Drops and mention inserts for this pane land here, never in the hidden terminal.
  useEffect(() => registerChatDropTarget(paneId, (paths) => {
    if (!canAttach) { setNotice(S.attachUnsupported); return; }
    const images = paths.filter(validChatImagePath);
    if (images.length < paths.length) setNotice(S.attachImagesOnly);
    const bridge = getChatV2Bridge();
    if (!bridge) return;
    void Promise.all(images.map(async (path) => ({ path, result: await bridge.stageAttachment(path) }))).then((results) => {
      const ok = results.flatMap(({ path, result }) => (result.ok ? [{ path: result.path, name: path.split(/[\\/]/).pop() ?? path }] : []));
      if (ok.length < results.length) setNotice(S.attachRefused);
      setStaged((prev) => [...prev, ...ok].slice(0, CHAT_ATTACHMENT_LIMIT));
    });
  }), [paneId, canAttach]);
  useEffect(() => registerChatInsertTarget(paneId, {
    insert: (value) => {
      const next = textRef.current ? `${textRef.current} ${value}` : value;
      if (utf8Bytes(next) > CHATV2_MAX_PROMPT_BYTES) return false;
      setText(next);
      input.current?.focus();
      return true;
    },
    focus: () => input.current?.focus(),
  }), [paneId, draftKey]);

  const tooLong = utf8Bytes(text) > CHATV2_MAX_PROMPT_BYTES;
  const canSend = !disabled && !running && !sending && (!!text.trim() || staged.length > 0) && !tooLong;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setNotice('');
    try {
      if (await onSend(text, staged.map((item) => item.path))) {
        setText('');
        setStaged([]);
      }
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
      {(staged.length > 0 || notice) && (
        <div className="wmux-chatv2-attachments">
          {staged.map((item) => (
            <span key={item.path} className="wmux-chatv2-chip" data-attachment>
              {item.name}
              <button type="button" className="wmux-chatv2-icon" aria-label={`${S.removeAttachment} ${item.name}`}
                onClick={() => setStaged((prev) => prev.filter((other) => other.path !== item.path))}>✕</button>
            </span>
          ))}
          {notice && <span className="wmux-chatv2-status" role="status">{notice}</span>}
        </div>
      )}
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

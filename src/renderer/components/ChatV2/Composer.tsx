import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { CLAUDE_MODEL_OPTIONS, claudeModelLabel } from '../../../shared/claudeModels';
import { CHATV2_AGENT_CAPS, CHATV2_AGENTS, type ChatV2Agent, type ChatV2RunMode } from '../../../shared/chatv2/ipc';
import { CHATV2_MAX_PROMPT_BYTES, utf8Bytes } from '../../../shared/chatv2/limits';
import { CHAT_ATTACHMENT_LIMIT, validChatImagePath } from '../../../shared/transcript/chatAttachments';
import { registerChatDropTarget, registerChatInsertTarget, spliceAtCaret } from '../Chat/chatAttachments';
import { DictationButton, dictationAvailable } from '../Dictation/DictationButton';
import { shortDir } from '../../utils/shortDir';
import { getChatV2Bridge } from './bridge';
import { S } from './strings';
import { IconX } from '../icons';
import { ArrowIcon } from './ArrowIcon';

// Drafts survive view switches and split remounts, per pane and conversation
// (`<paneId>:<chatSessionId|new>`): the text, the staged attachments, the
// messages queued behind a running turn, whether a send is in flight, and
// which queued message is being delivered.
export interface StagedAttachment { path: string; name: string }
/** A message sent mid-turn, delivered when the turn ends. `id` is its clientMessageId. */
export interface QueuedMessage { id: string; text: string; staged: readonly StagedAttachment[] }
interface DraftEntry { text: string; staged: readonly StagedAttachment[]; queue: readonly QueuedMessage[]; sending: boolean; delivering: string | null }

const EMPTY_DRAFT: DraftEntry = { text: '', staged: [], queue: [], sending: false, delivering: null };
const drafts = new Map<string, DraftEntry>();
const draftListeners = new Set<() => void>();

const draftEntry = (key: string): DraftEntry => drafts.get(key) ?? EMPTY_DRAFT;

function updateDraft(key: string, patch: Partial<DraftEntry>): void {
  const next = { ...draftEntry(key), ...patch };
  if (!next.text && !next.staged.length && !next.queue.length && !next.sending && !next.delivering) drafts.delete(key); else drafts.set(key, next);
  for (const listener of [...draftListeners]) listener();
}

function onDrafts(listener: () => void): () => void {
  draftListeners.add(listener);
  return () => { draftListeners.delete(listener); };
}

/** One conversation's draft, kept current. */
export function useDraft(key: string): DraftEntry {
  return useSyncExternalStore(onDrafts, () => draftEntry(key));
}

/** One conversation's queued messages, kept current (typing does not change it). */
export function useQueuedMessages(key: string): readonly QueuedMessage[] {
  return useSyncExternalStore(onDrafts, () => draftEntry(key).queue);
}

/** The id of the queued message whose delivery has started, if any. */
export function useDeliveringId(key: string): string | null {
  return useSyncExternalStore(onDrafts, () => draftEntry(key).delivering);
}

export function setDelivering(key: string, id: string | null): void {
  if (draftEntry(key).delivering !== id) updateDraft(key, { delivering: id });
}

export function getDraft(key: string): string {
  return draftEntry(key).text;
}

export function setDraft(key: string, text: string): void {
  if (draftEntry(key).text !== text) updateDraft(key, { text });
}

export function getStaged(key: string): readonly StagedAttachment[] {
  return draftEntry(key).staged;
}

export function setStaged(key: string, staged: readonly StagedAttachment[]): void {
  updateDraft(key, { staged });
}

export function queuedMessages(key: string): readonly QueuedMessage[] {
  return draftEntry(key).queue;
}

export function enqueueMessage(key: string, message: QueuedMessage): void {
  updateDraft(key, { queue: [...draftEntry(key).queue, message] });
}

export function dequeueMessage(key: string, id: string): void {
  const queue = draftEntry(key).queue;
  if (queue.some((item) => item.id === id)) updateDraft(key, { queue: queue.filter((item) => item.id !== id) });
}

/**
 * Put a message back in the composer, ahead of what is there now. False, and
 * nothing changed, when its attachments would not fit beside the staged ones;
 * with `force` (a message that has nowhere else to go) every attachment is
 * kept, over the limit too, for the owner to trim before sending.
 */
export function restoreToDraft(key: string, message: { text: string; staged: readonly StagedAttachment[] }, force = false): boolean {
  const { text, staged } = draftEntry(key);
  if (!force && message.staged.length + staged.length > CHAT_ATTACHMENT_LIMIT) return false;
  updateDraft(key, {
    text: text ? `${message.text}\n\n${text}` : message.text,
    staged: [...message.staged, ...staged],
  });
  return true;
}

/** Move a draft's text and attachments to another key (a chat created under a remount). */
export function moveDraft(from: string, to: string): void {
  const { text, staged } = draftEntry(from);
  if (from === to || (!text && !staged.length)) return;
  restoreToDraft(to, { text, staged }, true);
  updateDraft(from, { text: '', staged: [] });
}

/** Move every queued message of `from` back into the composer of `to` (its chat is gone), oldest first. */
export function requeueToDraft(from: string, to: string): void {
  const queue = draftEntry(from).queue;
  if (!queue.length) return;
  updateDraft(from, { queue: [], delivering: null });
  for (const item of [...queue].reverse()) restoreToDraft(to, item, true);
}

/** Forget every draft (text, attachments, queue) of a pane that closed. */
export function forgetDrafts(paneId: string): void {
  let changed = false;
  for (const key of [...drafts.keys()]) if (key.startsWith(`${paneId}:`)) changed = drafts.delete(key) || changed;
  if (changed) for (const listener of [...draftListeners]) listener();
}

export interface ComposerChips {
  /** The agent the chat runs (default Claude Code). */
  agent?: ChatV2Agent;
  model: string;
  /** Effort as the head reports it; '' = the agent's default. Not settable through the contract yet. */
  effort: string;
  mode: ChatV2RunMode;
  /** The directory the chat runs in, once it started. */
  cwd?: string;
  /** Model and permissions can still change (before the chat starts). */
  editable: boolean;
  onModel?: (model: string) => void;
  onMode?: (mode: ChatV2RunMode) => void;
  /** Present before the chat starts: the agent can still change. */
  onAgent?: (agent: ChatV2Agent) => void;
}

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
  /** Resolves true once the message went (or was queued); the composer then clears what was sent. */
  onSend: (text: string, staged: readonly StagedAttachment[]) => Promise<boolean>;
  onStop: () => void;
  extra?: React.ReactNode;
}) {
  // Kept in the draft store, so a split remount keeps them and a send that
  // finishes after one still clears what it sent.
  const { text, staged, sending } = useDraft(draftKey);
  const [notice, setNotice] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const setText = (value: string) => setDraft(draftKey, value);

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
      setStaged(draftKey, [...getStaged(draftKey), ...ok].slice(0, CHAT_ATTACHMENT_LIMIT));
    });
  }), [paneId, draftKey, canAttach]);
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

  // Dictated text goes in at the caret (over a selection), for the owner to
  // edit; it is never sent by itself.
  const pendingCaret = useRef<number | null>(null);
  useEffect(() => {
    const el = input.current;
    if (pendingCaret.current === null || !el) return;
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);
  const insertDictation = (value: string) => {
    const el = input.current;
    const current = textRef.current;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? start;
    const next = spliceAtCaret(current.slice(0, start) + current.slice(end), start, value);
    pendingCaret.current = next.caret;
    textRef.current = next.text;
    setText(next.text);
    el?.focus();
  };

  const tooLong = utf8Bytes(text) > CHATV2_MAX_PROMPT_BYTES;
  // Mid-turn, Send queues the message (the view delivers it when the turn ends).
  const canSend = !disabled && !sending && (!!text.trim() || staged.length > 0) && !tooLong;

  const send = async () => {
    if (!canSend) return;
    const key = draftKey;
    updateDraft(key, { sending: true });
    setNotice('');
    try {
      if (await onSend(text, staged)) {
        // Only what was sent: edits made since (in this composer or one that
        // remounted meanwhile) stay.
        if (getDraft(key) === text) setDraft(key, '');
        if (getStaged(key) === staged) setStaged(key, []);
      }
    } finally {
      updateDraft(key, { sending: false });
      input.current?.focus();
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
    else if (event.key === 'Escape' && !text && running && canStop) { event.preventDefault(); onStop(); }
  };

  // The chip strip scrolls sideways in a narrow composer; an edge fades while chips are hidden past it.
  const strip = useRef<HTMLDivElement>(null);
  const stripEdges = () => {
    const el = strip.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    const fade = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
    if (fade) el.dataset.fade = fade; else delete el.dataset.fade;
  };
  useEffect(() => {
    stripEdges();
    const el = strip.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(stripEdges);
    observer.observe(el);
    return () => observer.disconnect();
  }, [chips.agent, chips.model, chips.effort, chips.cwd]);

  const agent = chips.agent ?? 'claude';
  const caps = CHATV2_AGENT_CAPS[agent];
  const modelKnown = CLAUDE_MODEL_OPTIONS.some((option) => option.value === chips.model);
  return (
    <div className="wmux-chatv2-composer">
      {(staged.length > 0 || notice) && (
        <div className="wmux-chatv2-attachments">
          {staged.map((item) => (
            <span key={item.path} className="wmux-chatv2-chip" data-attachment>
              {item.name}
              <button type="button" className="wmux-chatv2-icon" aria-label={`${S.removeAttachment} ${item.name}`}
                onClick={() => setStaged(draftKey, staged.filter((other) => other.path !== item.path))}><IconX size={12} /></button>
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
          <div ref={strip} className="wmux-chatv2-chip-strip" onScroll={stripEdges}>
            {chips.onAgent ? (
              <label className="wmux-chatv2-chip" title={S.agent} data-chatv2-agent={agent}>
                <span className="sr-only">{S.agent}</span>
                <select value={agent} disabled={!chips.editable} onChange={(event) => chips.onAgent?.(event.target.value as ChatV2Agent)}>
                  {CHATV2_AGENTS.map((id) => <option key={id} value={id}>{S.agentName[id]}</option>)}
                </select>
              </label>
            ) : (
              <span className="wmux-chatv2-chip" aria-disabled="true" title={S.agentFixed} data-chatv2-agent={agent}>
                <span className="sr-only">{S.agent}: </span>{S.agentName[agent]}
              </span>
            )}
            {!caps.claudeModels ? (
              <span className="wmux-chatv2-chip" aria-disabled="true" title={S.agentModelHint(S.agentName[agent])}>
                <span className="sr-only">{S.model}: </span>{chips.model || S.agentModelDefault(S.agentName[agent])}
              </span>
            ) : (
              <label className="wmux-chatv2-chip" title={chips.editable ? S.model : S.modelFixed}>
                <span className="sr-only">{S.model}</span>
                <select value={chips.model} disabled={!chips.editable} onChange={(event) => chips.onModel?.(event.target.value)}>
                  {!modelKnown && <option value={chips.model}>{claudeModelLabel(chips.model)}</option>}
                  {CLAUDE_MODEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            )}
            <span className="wmux-chatv2-chip" aria-disabled="true" title={S.effortFixed}>
              <span className="sr-only">{S.effort}: </span>{chips.effort || S.effortDefault}
            </span>
            {chips.cwd && (
              <span className="wmux-chatv2-chip wmux-chatv2-cwd" aria-disabled="true" title={`${S.workingDirectory}: ${chips.cwd}`} data-chatv2-cwd>
                <span className="sr-only">{S.workingDirectory}: </span>{shortDir(chips.cwd)}
              </span>
            )}
          </div>
          {/* Permissions say whether the agent asks first: pinned outside the strip, always in full.
              After it, so the chips still start with the Agent chip (DESIGN.md, Agent chip). */}
          <label className="wmux-chatv2-chip" data-chatv2-permission data-mode={chips.mode} aria-disabled={!caps.bypass || undefined} title={!caps.bypass ? S.alwaysAsks(S.agentName[agent]) : chips.mode === 'bypass' ? S.modeBypassHint : S.modeDefaultHint}>
            <span className="sr-only">{S.permission}</span>
            <select value={chips.mode} disabled={!chips.editable || !caps.bypass} onChange={(event) => chips.onMode?.(event.target.value as ChatV2RunMode)}>
              <option value="default">{S.modeDefault}</option>
              <option value="bypass">{S.modeBypass}</option>
            </select>
          </label>
        </div>
        <div className="wmux-chatv2-composer-actions">
          {extra}
          {dictationAvailable() && (
            <DictationButton target={`chat:${paneId}`} onText={insertDictation} disabled={disabled} className="wmux-chatv2-icon" />
          )}
          {running && canStop && <button type="button" className="wmux-chatv2-btn" onClick={onStop}>{S.stop}</button>}
          <button type="button" className="wmux-chatv2-send" aria-label={running ? S.sendQueued : S.send} title={running ? S.sendQueued : S.send} disabled={!canSend} onClick={() => void send()}><ArrowIcon dir="up" /></button>
        </div>
      </div>
    </div>
  );
}

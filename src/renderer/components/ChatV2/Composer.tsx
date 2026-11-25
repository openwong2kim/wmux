import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent } from 'react';
import { CLAUDE_MODEL_OPTIONS, claudeModelLabel } from '../../../shared/claudeModels';
import { CHATV2_AGENT_CAPS, CHATV2_AGENTS, type ChatV2Agent, type ChatV2RunMode, type ChatV2StageAttachmentResult } from '../../../shared/chatv2/ipc';
import { CHATV2_MAX_PROMPT_BYTES, utf8Bytes } from '../../../shared/chatv2/limits';
import { CHAT_ATTACHMENT_LIMIT } from '../../../shared/transcript/chatAttachments';
import type { ChatSkill, ChatSkillCatalog } from '../../../shared/transcript/chatSkills';
import { registerChatDropTarget, registerChatInsertTarget, spliceAtCaret } from '../Chat/chatAttachments';
import { skillQuery } from '../Chat/ChatComposerInput';
import { DictationButton, dictationAvailable } from '../Dictation/DictationButton';
import Popover from '../ui/Popover';
import { shortDir } from '../../utils/shortDir';
import { getChatV2Bridge } from './bridge';
import { S } from './strings';
import { Icon, IconFile, IconMoreHorizontal, IconPlus, IconX } from '../icons';
import { ArrowIcon } from './ArrowIcon';
import { usePreviewSource } from '../Preview/usePreviewSource';
import { rememberAttachmentThumbnail } from './thumbnails';
import './composer.css';

// Drafts survive view switches and split remounts, per pane and conversation
// (`<paneId>:<chatSessionId|new>`): the text, the staged attachments, the
// messages queued behind a running turn, whether a send is in flight, and
// which queued message is being delivered.
/** `path` is what `send` takes; `kind` only shapes the chip (an older draft has none). */
export interface StagedAttachment { path: string; name: string; kind?: 'image' | 'file' }
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
    text: text && message.text ? `${message.text}\n\n${text}` : message.text || text,
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
  /** Effort as the head reports it; '' = the agent's default. */
  effort: string;
  mode: ChatV2RunMode;
  /** The directory the chat runs in, once it started (shown in the overflow menu). */
  cwd?: string;
  /** Before the chat starts: agent, model, effort and permissions can all change. */
  editable: boolean;
  /** A started chat between turns: model and effort can change (`configure`). */
  tunable?: boolean;
  onModel?: (model: string) => void;
  onEffort?: (effort: string) => void;
  onMode?: (mode: ChatV2RunMode) => void;
  /** Present before the chat starts: the agent can still change. */
  onAgent?: (agent: ChatV2Agent) => void;
}

/** A row of the composer's overflow menu (Continue in Terminal, …). */
export interface ComposerMenuItem {
  id: string;
  label: string;
  title?: string;
  disabled?: boolean;
  onSelect: () => void;
}

const EFFORT_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** A square on the 14px icon grid: Stop. */
function StopIcon() {
  return <Icon size={14}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" /></Icon>;
}

const THUMBNAIL_EDGE = 160;

/** A small data URL of a loaded image, or undefined where it cannot be drawn. */
function thumbnailOf(img: HTMLImageElement): string | undefined {
  const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  try {
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

/**
 * A staged image, shown from its staged copy through the preview scheme (main
 * never decodes it). Once it loads, a small copy is kept for the sent message.
 */
function AttachmentThumb({ path }: { path: string }) {
  const source = usePreviewSource(path);
  const url = source.status === 'ready' && source.kind === 'image' ? source.url : null;
  useEffect(() => {
    if (!url) return;
    // A CORS load of its own, so the canvas can be read; the chip's picture never depends on it.
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => rememberAttachmentThumbnail(path, thumbnailOf(img));
    img.src = url;
    return () => { img.onload = null; };
  }, [path, url]);
  return url
    ? <img src={url} alt="" />
    : <span className="wmux-chatv2-attachment-icon" aria-hidden="true"><IconFile size={14} /></span>;
}

type MenuEntry = ChatSkill & { action?: 'model' | 'effort' | 'menu'; menuId?: string };

export function Composer({ paneId, draftKey, chips, placeholder, disabled, running, canStop, canAttach, onSend, onStop, menu: extraMenu = [], skills }: {
  paneId: string;
  draftKey: string;
  chips: ComposerChips;
  placeholder: string;
  disabled: boolean;
  running: boolean;
  canStop: boolean;
  /** The chat takes attachments. */
  canAttach: boolean;
  /** Resolves true once the message went (or was queued); the composer then clears what was sent. */
  onSend: (text: string, staged: readonly StagedAttachment[]) => Promise<boolean>;
  onStop: () => void;
  /** Rows of the ⋯ menu beside send. */
  menu?: readonly ComposerMenuItem[];
  /** The agent's skills for the `/` menu; absent before the chat exists. */
  skills?: () => Promise<ChatSkillCatalog>;
}) {
  // Kept in the draft store, so a split remount keeps them and a send that
  // finishes after one still clears what it sent.
  const { text, staged, sending } = useDraft(draftKey);
  const [notice, setNotice] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const modelSelect = useRef<HTMLSelectElement>(null);
  const effortSelect = useRef<HTMLSelectElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const setText = (value: string) => setDraft(draftKey, value);

  // Checked by main: an image becomes a staged copy, any other file keeps its path.
  const addResults = (results: readonly ChatV2StageAttachmentResult[]) => {
    const ok: StagedAttachment[] = [];
    let refused = '';
    for (const result of results) {
      if (result.ok) ok.push({ path: result.path, name: result.name, kind: result.kind });
      else refused = result.reason === 'too-large' ? S.attachTooLarge : S.attachRefused;
    }
    const current = getStaged(draftKey);
    const fresh = ok.filter((item) => !current.some((other) => other.path === item.path));
    const next = [...current, ...fresh];
    if (next.length > CHAT_ATTACHMENT_LIMIT) refused = S.attachLimit(CHAT_ATTACHMENT_LIMIT);
    setNotice(refused);
    if (fresh.length) setStaged(draftKey, next.slice(0, CHAT_ATTACHMENT_LIMIT));
  };
  const addPaths = (paths: readonly string[]) => {
    if (!canAttach) { setNotice(S.attachUnsupported); return; }
    const bridge = getChatV2Bridge();
    if (!bridge) return;
    void Promise.all(paths.map((path) => bridge.stageAttachment(path).catch((): ChatV2StageAttachmentResult => ({ ok: false, reason: 'missing' })))).then(addResults);
  };
  const addPathsRef = useRef(addPaths);
  addPathsRef.current = addPaths;
  const pick = () => {
    const bridge = getChatV2Bridge();
    if (!bridge || !canAttach) return;
    void bridge.pickAttachments().then(addResults, () => setNotice(S.attachRefused)).finally(() => input.current?.focus());
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData;
    // A mixed clipboard (a browser copy carries text and a picture) pastes its text.
    if (data.getData('text/plain') || ![...data.files].some((file) => file.type.startsWith('image/'))) return;
    event.preventDefault();
    if (!canAttach) { setNotice(S.attachUnsupported); return; }
    void window.clipboardAPI?.readImage?.(paneId).then((path) => (path ? addPathsRef.current([path]) : setNotice(S.attachRefused)), () => setNotice(S.attachRefused));
  };

  // Drops and mention inserts for this pane land here, never in the hidden terminal.
  useEffect(() => registerChatDropTarget(paneId, (paths) => addPathsRef.current(paths)), [paneId]);
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
  // One button: Stop while a turn runs and nothing is typed, else Send (which queues mid-turn).
  // Esc stops on the same condition; with a draft, Stop stays in the ⋯ menu and as `/stop`.
  const stoppable = running && canStop;
  const showStop = stoppable && !text.trim() && staged.length === 0;
  const menu: readonly ComposerMenuItem[] = stoppable ? [{ id: 'stop', label: S.stop, onSelect: onStop }, ...extraMenu] : extraMenu;

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

  // The `/` menu: in-chat commands first, then the agent's skills (inserted as text).
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [catalog, setCatalog] = useState<ChatSkillCatalog | null>(null);
  const [selected, setSelected] = useState(0);
  // skillQuery reads only a token at the very start of the text, so choosing replaces from index 0.
  const query = skillQuery(text, caret);
  const slashOpen = !disabled && !dismissed && !!query && text.startsWith('/');
  const skillsRef = useRef(skills);
  skillsRef.current = skills;
  const canLoadSkills = !!skills;
  useEffect(() => {
    // A catalog that could not be read is asked for again the next time the menu opens.
    if (!slashOpen) { if (catalog?.state === 'unavailable') setCatalog(null); return; }
    const load = skillsRef.current;
    if (catalog || !load) return;
    let cancelled = false;
    void load().then((result) => { if (!cancelled) setCatalog(result); }, () => { if (!cancelled) setCatalog({ skills: [], state: 'unavailable' }); });
    return () => { cancelled = true; };
  }, [slashOpen, catalog, canLoadSkills]);
  const agent = chips.agent ?? 'claude';
  const caps = CHATV2_AGENT_CAPS[agent];
  const adjustable = chips.editable || !!chips.tunable;
  const commands: MenuEntry[] = [
    ...(adjustable && caps.claudeModels ? [{ name: 'model', invocation: '/model', description: S.commandModel, source: 'chat', action: 'model' as const }] : []),
    ...(adjustable ? [{ name: 'effort', invocation: '/effort', description: S.commandEffort, source: 'chat', action: 'effort' as const }] : []),
    ...menu.filter((item) => !item.disabled).map((item) => ({ name: item.id, invocation: `/${item.id}`, description: item.label, source: 'chat', action: 'menu' as const, menuId: item.id })),
  ];
  const needle = (query?.query ?? '').toLocaleLowerCase();
  // One row per invocation: a chat command wins over a skill of the same name.
  const entries: MenuEntry[] = [...commands, ...(catalog?.skills ?? [])]
    .filter((entry, i, all) => all.findIndex((other) => other.invocation === entry.invocation) === i)
    .filter((entry) => `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(needle));
  const index = Math.min(selected, Math.max(0, entries.length - 1));
  useEffect(() => { setSelected(0); }, [query?.query, catalog]);
  useLayoutEffect(() => {
    if (slashOpen) document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [slashOpen, index, listId]);
  const choose = (entry: MenuEntry) => {
    if (!query) return;
    const tail = text.slice(query.end);
    setDismissed(true);
    if (entry.action) {
      setText(tail.replace(/^ /, ''));
      if (entry.action === 'menu') { menu.find((item) => item.id === entry.menuId)?.onSelect(); return; }
      const target = entry.action === 'model' ? modelSelect.current : effortSelect.current;
      target?.focus();
      try { target?.showPicker?.(); } catch { /* focus is enough where the picker cannot open */ }
      return;
    }
    const prefix = entry.invocation + (tail.startsWith(' ') ? '' : ' ');
    setText(prefix + tail);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(prefix.length, prefix.length); setCaret(prefix.length); });
  };

  // IME: a keydown inside a composition, or the Enter that ends one (some engines send it just after compositionend), is the IME's.
  const composing = useRef(false);
  const composedAt = useRef(-Infinity);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && event.timeStamp - composedAt.current < 50) return;
    if (slashOpen && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) && !(event.key === 'Enter' && event.shiftKey)) {
      event.preventDefault();
      if (event.key === 'Escape') setDismissed(true);
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setSelected((index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % Math.max(1, entries.length));
      else if (entries[index]) choose(entries[index]);
      else if (event.key === 'Enter') void send();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
    else if (event.key === 'Escape' && showStop) { event.preventDefault(); onStop(); }
    else if (event.key === 'Backspace' && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0 && staged.length) {
      event.preventDefault();
      setStaged(draftKey, staged.slice(0, -1));
    }
  };

  // The ⋯ menu: where the chat runs, and actions that are not chips.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const away = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [menuOpen]);
  const showMenu = menu.length > 0 || !!chips.cwd;

  const modelKnown = CLAUDE_MODEL_OPTIONS.some((option) => option.value === chips.model);
  const effortKnown = !chips.effort || caps.efforts.includes(chips.effort);
  return (
    <div className="wmux-chatv2-composer" data-chatv2-composer>
      {slashOpen && (
        <Popover role="presentation" className="wmux-chatv2-slash" aria-label={S.commandsAndSkills}>
          {catalog === null && skills && <p className="wmux-chatv2-slash-note" role="status">{S.loadingSkills}</p>}
          {catalog?.state === 'unavailable' && <p className="wmux-chatv2-slash-note" role="status">{S.skillsUnavailable}</p>}
          {!entries.length && (catalog !== null || !skills) && <p className="wmux-chatv2-slash-note" role="status">{S.noMatch}</p>}
          <div id={listId} role="listbox" aria-label={S.commandsAndSkills} className="wmux-chatv2-slash-list">
            {entries.map((entry, i) => (
              <button key={`${entry.action ?? 'skill'}:${entry.invocation}`} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === index} tabIndex={-1}
                className="wmux-chatv2-slash-row" onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSelected(i)} onClick={() => choose(entry)}>
                <span className="wmux-chatv2-slash-name">{entry.invocation}</span>
                {entry.description && <span className="wmux-chatv2-slash-desc" title={entry.description}>{entry.description}</span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {(staged.length > 0 || notice) && (
        <div className="wmux-chatv2-attachments">
          {staged.map((item) => (
            <span key={item.path} className="wmux-chatv2-attachment" data-attachment data-kind={item.kind ?? 'image'} title={item.name}>
              {(item.kind ?? 'image') === 'image' ? <AttachmentThumb path={item.path} /> : <span className="wmux-chatv2-attachment-icon" aria-hidden="true"><IconFile size={14} /></span>}
              <span className="wmux-chatv2-attachment-name">{item.name}</span>
              <button type="button" className="wmux-chatv2-attachment-remove" aria-label={`${S.removeAttachment} ${item.name}`}
                onClick={() => setStaged(draftKey, staged.filter((other) => other.path !== item.path))}><IconX size={10} /></button>
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
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={slashOpen}
        aria-controls={slashOpen ? listId : undefined}
        aria-activedescendant={slashOpen && entries[index] ? `${listId}-${index}` : undefined}
        onChange={(event) => { setText(event.target.value); setCaret(event.target.selectionStart); setDismissed(false); }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onBlur={() => setDismissed(true)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => { composing.current = false; composedAt.current = event.timeStamp; }}
        onKeyDown={onKeyDown}
        onPaste={paste}
      />
      <div className="wmux-chatv2-composer-bar">
        <div className="wmux-chatv2-chips">
          {canAttach && (
            <button type="button" className="wmux-chatv2-icon" aria-label={S.attach} title={S.attach} disabled={disabled} onClick={pick} data-chatv2-attach><IconPlus size={14} /></button>
          )}
          {chips.onAgent ? (
            <label className="wmux-chatv2-chip" title={S.agent} data-chatv2-agent={agent}>
              <span className="sr-only">{S.agent}</span>
              <select value={agent} disabled={!chips.editable} onChange={(event) => chips.onAgent?.(event.target.value as ChatV2Agent)}>
                {CHATV2_AGENTS.map((id) => <option key={id} value={id}>{S.agentName[id]}</option>)}
              </select>
            </label>
          ) : (
            <span className="wmux-chatv2-chip" aria-disabled="true" title={S.agentFixed} data-chatv2-agent={agent} data-fixed>
              <span className="sr-only">{S.agent}: </span>{S.agentName[agent]}
            </span>
          )}
          {!caps.claudeModels ? (
            <span className="wmux-chatv2-chip" aria-disabled="true" title={S.agentModelHint(S.agentName[agent])}>
              <span className="sr-only">{S.model}: </span>{chips.model || S.agentModelDefault(S.agentName[agent])}
            </span>
          ) : (
            <label className="wmux-chatv2-chip" title={adjustable ? S.model : S.modelBusy} aria-disabled={!adjustable || undefined} data-chatv2-model>
              <span className="sr-only">{S.model}</span>
              <select ref={modelSelect} value={chips.model} disabled={!adjustable} onChange={(event) => chips.onModel?.(event.target.value)}>
                {!modelKnown && <option value={chips.model}>{claudeModelLabel(chips.model)}</option>}
                {CLAUDE_MODEL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          )}
          <label className="wmux-chatv2-chip" title={adjustable ? S.effort : S.modelBusy} aria-disabled={!adjustable || undefined} data-chatv2-effort>
            <span className="sr-only">{S.effort}</span>
            <select ref={effortSelect} value={chips.effort} disabled={!adjustable} onChange={(event) => chips.onEffort?.(event.target.value)}>
              <option value="">{S.effortDefault}</option>
              {!effortKnown && <option value={chips.effort}>{chips.effort}</option>}
              {caps.efforts.map((level) => <option key={level} value={level}>{S.effortLevel(EFFORT_LABEL[level] ?? level)}</option>)}
            </select>
          </label>
          {/* Permissions say whether the agent asks first: always shown, after the agent chip (DESIGN.md, Agent chip). */}
          <label className="wmux-chatv2-chip" data-chatv2-permission data-mode={chips.mode} aria-disabled={!chips.editable || !caps.bypass || undefined} title={!caps.bypass ? S.alwaysAsks(S.agentName[agent]) : chips.mode === 'bypass' ? S.modeBypassHint : S.modeDefaultHint}>
            <span className="sr-only">{S.permission}</span>
            <select value={chips.mode} disabled={!chips.editable || !caps.bypass} onChange={(event) => chips.onMode?.(event.target.value as ChatV2RunMode)}>
              <option value="default">{S.modeDefault}</option>
              <option value="bypass">{S.modeBypass}</option>
            </select>
          </label>
        </div>
        <div className="wmux-chatv2-composer-actions">
          {dictationAvailable() && (
            <DictationButton target={`chat:${paneId}`} onText={insertDictation} disabled={disabled} className="wmux-chatv2-icon" />
          )}
          {showMenu && (
            <div className="wmux-chatv2-more" ref={menuRoot}>
              <button type="button" className="wmux-chatv2-icon" aria-label={S.moreActions} title={S.moreActions} aria-haspopup="menu" aria-expanded={menuOpen}
                data-chatv2-more onClick={() => setMenuOpen((open) => !open)}><IconMoreHorizontal size={14} /></button>
              {menuOpen && (
                <Popover role="menu" className="wmux-chatv2-more-menu" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenuOpen(false); } }}>
                  {chips.cwd && <p className="wmux-chatv2-more-cwd" title={chips.cwd} data-chatv2-cwd>{S.runsIn(shortDir(chips.cwd))}</p>}
                  {menu.map((item) => (
                    <button key={item.id} type="button" role="menuitem" className="ui-section-row wmux-chatv2-more-row" title={item.title} disabled={item.disabled}
                      data-chatv2-menu={item.id} onClick={() => { setMenuOpen(false); item.onSelect(); }}>{item.label}</button>
                  ))}
                </Popover>
              )}
            </div>
          )}
          {showStop ? (
            <button type="button" className="wmux-chatv2-send" data-stop aria-label={S.stop} title={S.stopHint} onClick={onStop}><StopIcon /></button>
          ) : (
            <button type="button" className="wmux-chatv2-send" aria-label={running ? S.sendQueued : S.send} title={running ? S.sendQueued : S.send} disabled={!canSend} onClick={() => void send()}><ArrowIcon dir="up" /></button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Messages waiting behind the running turn, in the dock above the composer
 * (not in the transcript: they have not been sent). Until one goes it can be
 * taken back: Edit puts it in the composer, × drops it. Once its delivery
 * started neither could stop it, so neither is offered.
 */
export function QueuedMessages({ draftKey, deliveringId, queuedLabel }: { draftKey: string; deliveringId: string | null; queuedLabel: string }) {
  const queue = useQueuedMessages(draftKey);
  // A queued message whose Edit was refused (no room for its attachments).
  const [editRefused, setEditRefused] = useState<string | null>(null);
  if (!queue.length) return null;
  return (
    <ol className="wmux-chatv2-queue" aria-label={S.queuedMessages}>
      {queue.map((item) => (
        <li key={item.id} className="wmux-chatv2-queued" data-chatv2-queued data-sending={item.id === deliveringId || undefined}>
          <span className="wmux-chatv2-queued-text" title={item.text}>{item.text || item.staged.map((file) => file.name).join(', ')}</span>
          {item.staged.length > 0 && item.text && <span className="wmux-chatv2-queued-files">{S.attachmentCount(item.staged.length)}</span>}
          {item.id === deliveringId ? (
            <span className="wmux-chatv2-queued-caption"><span>{S.queuedSending}</span></span>
          ) : (
            <span className="wmux-chatv2-queued-caption">
              <span>{editRefused === item.id ? S.editQueuedFull : queuedLabel}</span>
              <button type="button" className="wmux-chatv2-link" data-chatv2-queued-edit
                onClick={() => {
                  if (!restoreToDraft(draftKey, item)) { setEditRefused(item.id); return; }
                  setEditRefused(null);
                  dequeueMessage(draftKey, item.id);
                }}>{S.editQueued}</button>
              <button type="button" className="wmux-chatv2-icon" aria-label={S.removeQueued} title={S.removeQueued} data-chatv2-queued-remove
                onClick={() => dequeueMessage(draftKey, item.id)}><IconX size={12} /></button>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

import type { ChatAttachmentPreview } from '../../../shared/transcript/turnEvents';

export interface ChatAttachment { path: string; name: string; thumbnail: string }

/**
 * A file dropped on a pane in Chat view belongs to that pane's composer, not
 * its hidden terminal. AppLayout owns the window-wide drop; the mounted Chat
 * view registers here to take it instead.
 */
const dropTargets = new Map<string, (paths: string[]) => void>();
export function registerChatDropTarget(ptyId: string, take: (paths: string[]) => void): () => void {
  dropTargets.set(ptyId, take);
  return () => { if (dropTargets.get(ptyId) === take) dropTargets.delete(ptyId); };
}
export function deliverChatDrop(ptyId: string, paths: string[]): boolean {
  const take = dropTargets.get(ptyId);
  if (!take) return false;
  take(paths);
  return true;
}

/**
 * Text inserted into a pane in Chat view (the agent mention picker) belongs
 * in that pane's composer at its caret, not in the hidden terminal. The
 * mounted composer registers here, same shape as the drop targets above.
 */
export interface ChatInsertTarget {
  /** False when the text does not fit under the composer's length limit. */
  insert: (text: string) => boolean;
  focus: () => void;
}
const insertTargets = new Map<string, ChatInsertTarget>();
export function registerChatInsertTarget(ptyId: string, target: ChatInsertTarget): () => void {
  insertTargets.set(ptyId, target);
  return () => { if (insertTargets.get(ptyId) === target) insertTargets.delete(ptyId); };
}
/** True inserted, false no room, null no composer mounted for that pane. */
export function deliverChatInsert(ptyId: string, text: string): boolean | null {
  const target = insertTargets.get(ptyId);
  return target ? target.insert(text) : null;
}
export function focusChatComposer(ptyId: string): boolean {
  const target = insertTargets.get(ptyId);
  target?.focus();
  return !!target;
}

/** `text` spliced in at `caret`, with a space either side where a word would touch it. */
export function spliceAtCaret(current: string, caret: number, text: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, current.length));
  const before = current.slice(0, at);
  const after = current.slice(at);
  const head = before + (before && !/\s$/.test(before) ? ' ' : '') + text;
  return { text: head + (after && !/^\s/.test(after) ? ' ' : '') + after, caret: head.length };
}

// Sent-message thumbnails re-render with every transcript update.
const previews = new Map<string, Promise<ChatAttachmentPreview>>();
export function previewAttachment(path: string): Promise<ChatAttachmentPreview> {
  const api = window.electronAPI?.chat?.attachment;
  if (!api) return Promise.resolve({ ok: false, reason: 'missing' });
  let preview = previews.get(path);
  if (!preview) {
    preview = api({ path }).catch(() => ({ ok: false, reason: 'missing' } as const));
    previews.set(path, preview);
    if (previews.size > 64) previews.delete(previews.keys().next().value!);
  }
  return preview;
}

/** Claude Code writes `[Image #1]` where the picture was; the chat shows the picture. */
export function withoutImageTokens(text: string): string {
  return text.replace(/\[Image #\d+\]\s?/g, '').trim();
}

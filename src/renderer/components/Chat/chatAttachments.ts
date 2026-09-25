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

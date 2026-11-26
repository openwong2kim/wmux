/**
 * Editor surfaces holding unsaved scratch edits. EditorPanel owns the buffer;
 * the close-tab confirm only needs to know whether closing would drop it.
 */
const dirty = new Set<string>();

export function setEditorDirty(surfaceId: string, isDirty: boolean): void {
  if (isDirty) dirty.add(surfaceId);
  else dirty.delete(surfaceId);
}

export function isEditorDirty(surfaceId: string): boolean {
  return dirty.has(surfaceId);
}

/**
 * Scratch text of an editor whose panel unmounted while its tab stays open (a
 * split, a move to another pane, a workspace switch). The remounted panel
 * takes it back, so a re-render never drops what was typed.
 */
const scratch = new Map<string, string>();

export function keepEditorScratch(surfaceId: string, text: string | null): void {
  if (text === null) scratch.delete(surfaceId);
  else scratch.set(surfaceId, text);
}

export function takeEditorScratch(surfaceId: string): string | undefined {
  const text = scratch.get(surfaceId);
  scratch.delete(surfaceId);
  return text;
}

/** Whether any editor tab in these panes holds unsaved scratch text. */
export function anyEditorDirty(leaves: ReadonlyArray<{ surfaces: ReadonlyArray<{ id: string; surfaceType?: string }> }>): boolean {
  return leaves.some((leaf) => leaf.surfaces.some((s) => s.surfaceType === 'editor' && dirty.has(s.id)));
}

/**
 * A pane or workspace close that would drop scratch text waits here for the
 * user's answer (ScratchDropConfirm). One at a time: a second request while
 * one is open is ignored, like the close-tab confirm.
 */
let pendingDrop: (() => void) | null = null;
const dropListeners = new Set<() => void>();

export function confirmScratchDrop(hasDirty: boolean, proceed: () => void): void {
  if (!hasDirty) {
    proceed();
    return;
  }
  if (pendingDrop) return;
  pendingDrop = proceed;
  dropListeners.forEach((l) => l());
}

export function getPendingScratchDrop(): (() => void) | null {
  return pendingDrop;
}

/** Answer the pending request: true runs the close, false keeps editing. */
export function resolveScratchDrop(discard: boolean): void {
  const run = pendingDrop;
  pendingDrop = null;
  dropListeners.forEach((l) => l());
  if (discard) run?.();
}

export function subscribeScratchDrop(listener: () => void): () => void {
  dropListeners.add(listener);
  return () => dropListeners.delete(listener);
}

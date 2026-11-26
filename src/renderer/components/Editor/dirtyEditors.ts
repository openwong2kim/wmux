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

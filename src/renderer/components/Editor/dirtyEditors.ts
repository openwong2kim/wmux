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

// Dragging a pane header into a wmux terminal inserts just the pane's tag
// (`#w1-2 `) — the prompt an agent is being typed into wants the address, not
// a page of ids. A drop anywhere else (another app's chat box) still gets the
// full markdown from text/plain.
//
// The drag is recognised by in-memory state rather than an extra DataTransfer
// type: chat clients have flipped into attachment mode on non-standard types
// before (see SurfaceTabs.handleDragStart), and this state never leaves the
// renderer. It only applies when the dropped text is exactly the markdown this
// drag carried, so a stale entry (a dragend that never fired) cannot rewrite
// some other drag's payload.

let activeDrag: { text: string; tag: string } | null = null;

export function beginPaneTagDrag(plainText: string, tag: string): void {
  activeDrag = { text: plainText, tag };
}

export function endPaneTagDrag(): void {
  activeDrag = null;
}

/** What a wmux terminal should insert for a dropped text/plain payload: the
 *  pane tag plus a space for a pane-header drag, else null (use the text). */
export function paneTagDropText(plainText: string): string | null {
  if (!activeDrag || activeDrag.text !== plainText) return null;
  return `${activeDrag.tag} `;
}

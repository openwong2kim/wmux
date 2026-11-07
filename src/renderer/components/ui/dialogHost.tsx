import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Where a Dialog opened from inside a pane renders. A pane root is its own
 * stacking context (Pane.tsx `isolate`), so a dialog left inside it paints
 * under every pane painted after it and its clicks land on the next pane.
 * The host sits beside the panes, inside the workspace: the dialog escapes
 * the pane, and still hides with its workspace (display:none) and goes inert
 * with it under a rail page, as it did when it was inline.
 */
// undefined: no host above. null: a host above whose element is not set yet.
const DialogHostContext = createContext<HTMLElement | null | undefined>(undefined);

/** The host element a Dialog portals into, or null to render inline. */
export function useDialogHost(): HTMLElement | null {
  return useContext(DialogHostContext) ?? null;
}

/** True below a DialogHost, so a nested container does not add another. */
export function useHasDialogHost(): boolean {
  return useContext(DialogHostContext) !== undefined;
}

/**
 * Provide a dialog host for everything below. The host element is an empty
 * `display: contents` sibling of the children, so it adds no box to the
 * layout; a dialog's root is `position: fixed` and sizes to the viewport.
 */
export function DialogHost({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  return (
    <DialogHostContext.Provider value={host}>
      {children}
      <div ref={setHost} style={{ display: 'contents' }} data-dialog-host="" />
    </DialogHostContext.Provider>
  );
}

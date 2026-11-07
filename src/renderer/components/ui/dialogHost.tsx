import { createContext, useContext, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

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
 * Provide a dialog host for everything below. The host element is a sibling
 * after the children with no size of its own (a dialog's root is
 * `position: fixed` and sizes to the viewport). It is its own stacking
 * context at the panes' level: what it holds paints above the panes before
 * it, and under whatever covers them, as a rail page does.
 */
const HOST_STYLE: CSSProperties = { position: 'absolute', top: 0, left: 0, width: 0, height: 0, isolation: 'isolate' };

export function DialogHost({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  return (
    <DialogHostContext.Provider value={host}>
      {children}
      <div ref={setHost} style={HOST_STYLE} data-dialog-host="" />
    </DialogHostContext.Provider>
  );
}

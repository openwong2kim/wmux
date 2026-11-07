import { createContext, useContext, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Where a Dialog opened from inside a pane renders. A pane root is its own
 * stacking context (Pane.tsx `isolate`), so a dialog left inside it paints
 * under every pane painted after it and its clicks land on the next pane.
 *
 * The workspace viewport holds one DialogLayer: a stacking context at
 * `--z-pane-dialog`, over every pane of every multiview tile and over the
 * agent toolbar, under a rail page (Settings included), and inert with the
 * Workspaces page under one. Each pane tree (PaneContainer) keeps its own
 * DialogHost inside that layer, hidden while its workspace is, so a dialog
 * still hides with the workspace that opened it.
 */
// undefined: none above. null: one above whose element is not set yet.
const DialogLayerContext = createContext<HTMLElement | null | undefined>(undefined);
const DialogHostContext = createContext<HTMLElement | null | undefined>(undefined);

/** The host element a Dialog portals into, or null to render inline. */
export function useDialogHost(): HTMLElement | null {
  return useContext(DialogHostContext) ?? null;
}

/** True below a DialogHost, so a nested container does not add another. */
export function useHasDialogHost(): boolean {
  return useContext(DialogHostContext) !== undefined;
}

// No size of its own: a dialog's root is `position: fixed` and sizes to the viewport.
const LAYER_STYLE: CSSProperties = { position: 'absolute', top: 0, left: 0, width: 0, height: 0, zIndex: 'var(--z-pane-dialog)' };
// A host with no layer above (a pane tree outside the workspace viewport, the
// Bots page's worker panel) is its own stacking context after the panes.
const STANDALONE_HOST_STYLE: CSSProperties = { position: 'absolute', top: 0, left: 0, width: 0, height: 0, isolation: 'isolate' };

/** The workspace viewport's dialog layer, after its children. */
export function DialogLayer({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  return (
    <DialogLayerContext.Provider value={layer}>
      {children}
      <div ref={setLayer} style={LAYER_STYLE} data-dialog-layer="" />
    </DialogLayerContext.Provider>
  );
}

/**
 * One pane tree's host: in the layer when there is one, else after the
 * children. `visible` follows the tree's workspace.
 */
export function DialogHost({ visible = true, children }: { visible?: boolean; children: ReactNode }) {
  const layer = useContext(DialogLayerContext);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const style: CSSProperties = layer === undefined
    ? (visible ? STANDALONE_HOST_STYLE : { ...STANDALONE_HOST_STYLE, display: 'none' })
    : { display: visible ? 'contents' : 'none' };
  const element = <div ref={setHost} style={style} data-dialog-host="" />;
  return (
    <DialogHostContext.Provider value={host}>
      {children}
      {layer === undefined ? element : layer ? createPortal(element, layer) : null}
    </DialogHostContext.Provider>
  );
}

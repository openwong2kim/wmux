import type { Pane } from '../../../shared/types';

/**
 * Issue #645 — pointer-driven pane drag.
 *
 * Deliberately NOT HTML5 drag-and-drop. Surface tabs are already `draggable`
 * and their drag exports terminal text to other apps through `dataTransfer`
 * (SurfaceTabs.handleDragStart), and there is a separate file-drop path onto
 * terminals. Sharing that machinery would mean every pane drag competes with
 * both. Pointer events live in a different world entirely, so the two cannot
 * interfere.
 *
 *   pointerdown on the grip
 *        │  (movement < THRESHOLD_PX → it was a click; pane just focuses)
 *        ▼
 *   pointermove ─────────────▶ hit-test eligible panes ──▶ {target, edge}
 *        │                          │
 *        │                          └── quadrant of the hovered pane:
 *        │                              left/right/top/bottom, centre = swap
 *        ▼
 *   pointerup → commit          Escape / pointercancel → abort, nothing moved
 */

/** Movement below this is a click, not a drag — so the grip stays clickable. */
export const DRAG_THRESHOLD_PX = 4;

/** Fraction of a pane's width/height that counts as its "centre" (= swap). */
const CENTRE_FRACTION = 0.34;

export type DropEdge = 'left' | 'right' | 'top' | 'bottom';

export interface DropTarget {
  paneId: string;
  /** null = drop on the centre, meaning swap rather than re-parent. */
  edge: DropEdge | null;
}

export interface PaneRect {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Which panes may receive a drop.
 *
 * "Rendered" is not the same as "eligible": panes hidden behind a zoom are
 * mounted (hide-don't-unmount), a multiview grid mounts several workspaces at
 * once, and the pane being dragged cannot receive itself.
 */
export function collectDropRects(opts: {
  root: ParentNode;
  sourcePaneId: string;
  workspaceId: string;
}): PaneRect[] {
  const { root, sourcePaneId, workspaceId } = opts;
  const rects: PaneRect[] = [];

  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-pane-root]'))) {
    const paneId = el.dataset.paneRoot;
    if (!paneId || paneId === sourcePaneId) continue;
    // Multiview mounts other workspaces' trees in sibling tiles; v1 keeps a
    // drag inside the workspace it started in.
    if (el.dataset.paneWorkspace !== workspaceId) continue;
    // Behind a zoom: mounted but invisible, so a drop there would look like it
    // vanished into nothing.
    if (el.closest('[data-wmux-zoom-hidden]')) continue;

    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue; // parked / collapsed
    rects.push({ paneId, left: r.left, top: r.top, width: r.width, height: r.height });
  }

  return rects;
}

/**
 * Resolve a pointer position to a drop target.
 *
 *   ┌─────────────────┐   outer third on each axis → that edge
 *   │ ╲     top     ╱ │   middle → swap (edge: null)
 *   │  ┌───────────┐  │
 *   │l │  centre   │r │   The dominant axis wins when the pointer is in a
 *   │  └───────────┘  │   corner: whichever edge it is proportionally
 *   │ ╱    bottom   ╲ │   closest to.
 *   └─────────────────┘
 */
export function resolveDropTarget(
  rects: readonly PaneRect[],
  x: number,
  y: number,
): DropTarget | null {
  const hit = rects.find(
    (r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height,
  );
  if (!hit) return null;

  const fx = (x - hit.left) / hit.width;
  const fy = (y - hit.top) / hit.height;

  const inCentreX = fx > CENTRE_FRACTION && fx < 1 - CENTRE_FRACTION;
  const inCentreY = fy > CENTRE_FRACTION && fy < 1 - CENTRE_FRACTION;
  if (inCentreX && inCentreY) return { paneId: hit.paneId, edge: null };

  // Distance to each edge as a fraction, so a 2000px-wide pane and a 200px-tall
  // one are compared fairly.
  const candidates: Array<{ edge: DropEdge; d: number }> = [
    { edge: 'left', d: fx },
    { edge: 'right', d: 1 - fx },
    { edge: 'top', d: fy },
    { edge: 'bottom', d: 1 - fy },
  ];
  candidates.sort((a, b) => a.d - b.d);
  return { paneId: hit.paneId, edge: candidates[0].edge };
}

/** Leaf ids of a pane tree, in layout order. Used to validate a drag source. */
export function isLeafPane(root: Pane, paneId: string): boolean {
  if (root.type === 'leaf') return root.id === paneId;
  return root.children.some((c) => isLeafPane(c, paneId));
}

// Which corners of the workspace column a pane subtree reaches, as tokens
// (tl tr bl br). Glass mode rounds the boxes of the panes in the column's
// sidebar-side corners instead of clipping the whole column (ui.css), so the
// tokens follow what is on screen: the first or last child that is shown,
// skipping the panels a zoomed pane hides.
import type { Pane, PaneLeaf } from '../../../shared/types';
import { findLeaf } from '../../../shared/paneUtils';
import { isTerminalKindSurfaceType, isTerminalSurfaceType, isWorkSurfaceType } from './surfaceKinds';

/** Every corner: the root of the active workspace's pane tree. */
export const ALL_PANE_CORNERS = 'tl tr bl br';

/** The corners child `index` of a split reaches, given the corners the split
 *  reaches and which children are shown. A horizontal split lays its
 *  children side by side (left corners go to the first shown child, right
 *  corners to the last); a vertical one stacks them (top corners first,
 *  bottom corners last). */
export function childCorners(corners: string, orientation: 'horizontal' | 'vertical', index: number, shown: readonly boolean[]): string {
  if (!corners || !shown[index]) return '';
  const first = shown.indexOf(true);
  const last = shown.lastIndexOf(true);
  return corners.split(' ').filter((c) => {
    const leading = orientation === 'horizontal' ? c[1] === 'l' : c[0] === 't';
    return index === (leading ? first : last);
  }).join(' ');
}

/** A pane that shows one plain terminal: no work area beside it (Pane's
 *  split) and no chat view over it. Only such a pane rounds its own corner. */
export function isPlainTerminalPane(pane: PaneLeaf, chatViewEnabled: boolean): boolean {
  const active = pane.surfaces.find((s) => s.id === pane.activeSurfaceId);
  const split = pane.surfaces.some((s) => isTerminalKindSurfaceType(s.surfaceType)) && pane.surfaces.some((s) => isWorkSurfaceType(s.surfaceType));
  return !split && isTerminalSurfaceType(active?.surfaceType) && !(chatViewEnabled && active?.viewMode === 'chat');
}

/** The column sides ('left', 'right') whose two corner panes are both plain
 *  terminals, walking the tree the way PaneContainer hands out corners. */
export function glassCornerSides(root: Pane, zoomedPaneId: string | null, chatViewEnabled: boolean): string {
  const plain = new Set<string>();
  const walk = (pane: Pane, corners: string) => {
    if (!corners) return;
    if (pane.type === 'leaf') {
      if (isPlainTerminalPane(pane, chatViewEnabled)) for (const c of corners.split(' ')) plain.add(c);
      return;
    }
    const zoomIn = zoomedPaneId !== null && findLeaf(pane, zoomedPaneId) !== null;
    const shown = pane.children.map((child) => zoomedPaneId === null || !zoomIn || findLeaf(child, zoomedPaneId) !== null);
    pane.children.forEach((child, i) => walk(child, childCorners(corners, pane.direction, i, shown)));
  };
  walk(root, ALL_PANE_CORNERS);
  return [plain.has('tl') && plain.has('bl') ? 'left' : '', plain.has('tr') && plain.has('br') ? 'right' : ''].filter(Boolean).join(' ');
}

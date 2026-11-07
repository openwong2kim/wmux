// Which corners of the workspace column a pane subtree reaches, as tokens
// (tl tr bl br). Glass mode rounds the boxes of the panes in the column's
// sidebar-side corners instead of clipping the whole column (ui.css), so the
// tokens follow what is on screen: the first or last child that is shown,
// skipping the panels a zoomed pane hides.

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

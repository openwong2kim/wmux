const MARGIN = 4;

export interface FlyoutAnchor { left: number; right: number; top: number }

/**
 * Viewport position of a `position: fixed` flyout beside its trigger row: flush
 * with the row's right edge (no gap, so hover never drops crossing it), flipped
 * to the row's left when it would pass the window's right edge, and shifted up
 * when it would pass the bottom.
 */
export function fixedFlyoutPosition(
  anchor: FlyoutAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  let left = anchor.right;
  if (left + size.width > viewport.width - MARGIN && anchor.left - size.width >= MARGIN) {
    left = anchor.left - size.width;
  }
  const top = Math.max(MARGIN, Math.min(anchor.top, viewport.height - MARGIN - size.height));
  return { left, top };
}

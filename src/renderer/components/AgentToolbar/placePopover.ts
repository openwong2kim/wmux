/** Flip a popover into the viewport. Anchor-right-aligned (cluster lives on the right). */
export function placePopover(
  anchor: { top: number; left: number; right: number; bottom: number } | null,
  size: { width: number; height: number },
  pad = 8,
): { top: number; left: number } {
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const w = size.width;
  const h = size.height;
  let left = anchor ? anchor.right - w : Math.max(pad, (vw - w) / 2);
  let top = anchor ? anchor.bottom + 4 : Math.max(pad, vh / 5);
  if (left + w > vw - pad) left = vw - w - pad;
  if (left < pad) left = pad;
  if (top + h > vh - pad) {
    const above = anchor ? anchor.top - h - 4 : pad;
    top = above >= pad ? above : Math.max(pad, vh - h - pad);
  }
  return { top, left };
}

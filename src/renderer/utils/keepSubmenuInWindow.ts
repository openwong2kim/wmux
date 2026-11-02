/**
 * Keep a context menu and its submenus inside the window.
 *
 * `keepMenuInWindow` fits a `fixed` menu opened at the pointer;
 * `keepSubmenuInWindow` is the ref callback for a submenu that opens beside its
 * item (`absolute top-0` under a `relative` item). Near the bottom or the side
 * of the window either would run off the edge and hide its last entries, so it
 * is moved just enough to fit. Both refit when their size changes: rows that
 * fill in after opening (account and profile lists) would otherwise push the
 * last items back out.
 *
 * Offsets, not getBoundingClientRect, measure everything: the scale-in
 * animation would report sizes smaller and positions shifted from where the
 * menu lays out.
 */
const MARGIN = 4;
/** `ml-0.5` / `mr-0.5`: the gap between a submenu and its item. */
const GAP = '0.125rem';
const GAP_PX = 2;

export function fitSubmenuTop(itemTop: number, height: number, viewportHeight: number): number {
  const overflow = itemTop + height - (viewportHeight - MARGIN);
  if (overflow <= 0) return 0;
  return -Math.max(0, Math.min(overflow, itemTop - MARGIN));
}

/** Where a menu opened at `pos` must start along one axis to stay inside `viewport`. */
export function fitMenuStart(pos: number, size: number, viewport: number): number {
  if (pos + size <= viewport - MARGIN) return pos;
  return Math.max(MARGIN, viewport - size - MARGIN);
}

/**
 * Whether a submenu opens to the left of its item: on the preferred side when
 * it fits there, otherwise on the side with more room.
 */
export function submenuOpensLeft(
  itemLeft: number,
  itemWidth: number,
  width: number,
  viewportWidth: number,
  preferLeft: boolean,
): boolean {
  const roomLeft = itemLeft - MARGIN;
  const roomRight = viewportWidth - MARGIN - (itemLeft + itemWidth);
  const preferred = preferLeft ? roomLeft : roomRight;
  const other = preferLeft ? roomRight : roomLeft;
  if (preferred >= width + GAP_PX || other <= preferred) return preferLeft;
  return !preferLeft;
}

/** Untransformed layout position of `el` in the window, summed up its offset parents. */
function layoutOrigin(el: HTMLElement): { left: number; top: number } {
  let left = 0;
  let top = 0;
  for (let n: Element | null = el; n instanceof HTMLElement; n = n.offsetParent) {
    left += n.offsetLeft;
    top += n.offsetTop;
  }
  return { left, top };
}

function refitOnResize(el: HTMLElement, fit: () => void): (() => void) | undefined {
  if (typeof ResizeObserver === 'undefined') return undefined;
  const observer = new ResizeObserver(fit);
  observer.observe(el);
  return () => observer.disconnect();
}

export function keepMenuInWindow(el: HTMLElement, x: number, y: number): (() => void) | undefined {
  const fit = () => {
    el.style.left = `${fitMenuStart(x, el.offsetWidth, window.innerWidth)}px`;
    el.style.top = `${fitMenuStart(y, el.offsetHeight, window.innerHeight)}px`;
  };
  fit();
  return refitOnResize(el, fit);
}

export function keepSubmenuInWindow(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const item = el.offsetParent;
  if (!(item instanceof HTMLElement)) return undefined;
  // The side its classes open it on, read before any refit overrides it.
  const preferLeft = el.offsetLeft < 0;
  const fit = () => {
    const origin = layoutOrigin(item);
    el.style.top = `${fitSubmenuTop(origin.top, el.offsetHeight, window.innerHeight)}px`;
    const left = submenuOpensLeft(origin.left, item.offsetWidth, el.offsetWidth, window.innerWidth, preferLeft);
    const flip = left !== preferLeft;
    el.style.left = flip ? (left ? 'auto' : '100%') : '';
    el.style.right = flip ? (left ? '100%' : 'auto') : '';
    el.style.marginLeft = flip ? (left ? '0' : GAP) : '';
    el.style.marginRight = flip ? (left ? GAP : '0') : '';
  };
  fit();
  return refitOnResize(el, fit);
}

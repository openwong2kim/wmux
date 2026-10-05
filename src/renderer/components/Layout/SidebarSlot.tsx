import { useEffect, useLayoutEffect, useState, type ReactNode, type TransitionEvent } from 'react';
import { holdFits, onFitsReleased, releaseFits } from '../../utils/layoutTransitionGate';

/** Must match `.wmux-sidebar-slot[data-animating]` in ui.css. */
export const SIDEBAR_TOGGLE_MS = 190;
/** Releases the fit hold when transitionend never arrives (hidden window …). */
export const SIDEBAR_TOGGLE_FALLBACK_MS = SIDEBAR_TOGGLE_MS + 150;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/**
 * The sheet's sidebar column. A toggle animates the column's width while the
 * sidebar stays mounted at its own width (so rows never rewrap per frame), and
 * holds terminal fits for the duration so every pane refits exactly once, on
 * transitionend. Width changes from the drag handle are not animated: the
 * transition only exists while a toggle runs.
 */
export function SidebarSlot({
  visible,
  width,
  position,
  children,
}: {
  visible: boolean;
  width: number;
  position: 'left' | 'right';
  children: ReactNode;
}) {
  const [animating, setAnimating] = useState(false);
  const [prevVisible, setPrevVisible] = useState(visible);
  const [toggleSeq, setToggleSeq] = useState(0);
  // Derived during render (state-from-props), not in an effect: an effect
  // would commit one frame with visible=false and animating=false, unmounting
  // the sidebar only to remount it — losing its scroll and local state.
  if (prevVisible !== visible) {
    setPrevVisible(visible);
    const animate = !prefersReducedMotion();
    setAnimating(animate);
    if (animate) setToggleSeq((n) => n + 1);
  }

  // Layout effect: the hold must be in place before the first animated frame
  // reaches the panes' ResizeObservers. A re-toggle mid-animation extends it.
  useLayoutEffect(() => {
    if (toggleSeq > 0) holdFits(SIDEBAR_TOGGLE_FALLBACK_MS);
  }, [toggleSeq]);

  // transitionend, the fallback timer and unmount all end the animation here.
  useEffect(() => onFitsReleased(() => setAnimating(false)), []);
  useEffect(() => () => {
    if (animating) releaseFits();
  }, [animating]);

  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    // Sidebar rows run their own transitions, which bubble up here.
    if (e.target !== e.currentTarget || e.propertyName !== 'width') return;
    releaseFits();
  };

  return (
    <div
      className={`wmux-sidebar-slot flex shrink-0 min-h-0 ${position === 'right' ? 'justify-end' : ''}`}
      data-animating={animating ? '' : undefined}
      // Clip only while animating: the resize handle sits 4px outside the
      // sidebar's edge and must stay reachable when the column is at rest.
      style={{ width: visible ? width : 0, overflow: animating ? 'hidden' : undefined }}
      inert={!visible}
      onTransitionEnd={onTransitionEnd}
      data-testid="sidebar-slot"
    >
      {(visible || animating) && children}
    </div>
  );
}

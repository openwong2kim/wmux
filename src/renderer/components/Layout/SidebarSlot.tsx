import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TransitionEvent } from 'react';
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
  const prevVisible = useRef(visible);

  // Layout effect: the hold must be in place before the first animated frame
  // reaches the panes' ResizeObservers.
  useLayoutEffect(() => {
    if (prevVisible.current === visible) return;
    prevVisible.current = visible;
    if (prefersReducedMotion()) {
      setAnimating(false);
      return;
    }
    holdFits(SIDEBAR_TOGGLE_FALLBACK_MS);
    setAnimating(true);
  }, [visible]);

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

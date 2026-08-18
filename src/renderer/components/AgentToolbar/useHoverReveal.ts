import { useCallback, useEffect, useRef, useState } from 'react';

/** Pointer must sit inside this bottom band of the host before the bar arms. */
export const HOVER_TRIGGER_ZONE_PX = 8;
/** Dwell before revealing — a pointer merely crossing the band must not summon it. */
export const HOVER_REVEAL_DELAY_MS = 150;
/** Grace before hiding, so the pointer can travel from the bar into its popover. */
export const HOVER_HIDE_DELAY_MS = 400;

interface HoverRevealOptions {
  /** Pinned bars ignore the pointer entirely and stay open. */
  pinned: boolean;
  /** Keep the bar up regardless of the pointer (a popover is open under it). */
  hold: boolean;
  /** Element whose bottom edge owns the trigger band. */
  hostRef: React.RefObject<HTMLElement | null>;
  /**
   * Band that KEEPS a revealed bar up, measured from the host's bottom edge.
   * Must cover the bar itself: the arming band is only 8px, so without this the
   * moment the bar appeared and the pointer rose onto one of its buttons it
   * left the band and scheduled its own hide — the bar bounced away from the
   * cursor reaching for it.
   */
  keepAlivePx: number;
}

interface HoverReveal {
  revealed: boolean;
  /** Spread onto the bar itself so hovering it keeps it up. */
  barHandlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
}

/**
 * Reveal-on-approach for the bottom agent toolbar.
 *
 * The terminal's own prompt line lives exactly where this bar appears, so the
 * naive "pointer near the bottom → show" rule fights the user. Three guards
 * keep it out of the way:
 *
 *   1. A dwell delay — crossing the band on the way somewhere else is not intent.
 *   2. Suppressed while a pointer button is down — dragging out the last output
 *      line must not summon a bar over the text being selected.
 *   3. Suppressed on keystrokes — the moment the user types, the prompt line
 *      matters more than the chrome, so the bar retreats until the pointer
 *      moves again.
 *
 * The pointer watch is a document listener measured against `hostRef` rather
 * than handlers on an overlay: an overlay that covered the grid would have to
 * be `pointer-events: none` to let clicks through, and such an element never
 * receives pointer events itself.
 */
export function useHoverReveal({ pinned, hold, hostRef, keepAlivePx }: HoverRevealOptions): HoverReveal {
  const [hovering, setHovering] = useState(false);
  // Read inside the pointer handler without making it a dependency — the
  // listener must not be torn down and re-added on every reveal.
  const hoveringRef = useRef(false);
  hoveringRef.current = hovering;
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set while a pointer button is held (drag-select) and while the user is
  // typing; both mean "do not summon". Refs, not state — these must not
  // re-render the toolbar on every keystroke.
  const draggingRef = useRef(false);
  const typingRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (revealTimer.current) { clearTimeout(revealTimer.current); revealTimer.current = null; }
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  }, []);

  const scheduleReveal = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (revealTimer.current) return;
    revealTimer.current = setTimeout(() => {
      revealTimer.current = null;
      if (draggingRef.current || typingRef.current) return;
      setHovering(true);
    }, HOVER_REVEAL_DELAY_MS);
  }, []);

  const scheduleHide = useCallback(() => {
    if (revealTimer.current) { clearTimeout(revealTimer.current); revealTimer.current = null; }
    if (hideTimer.current) return;
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setHovering(false);
    }, HOVER_HIDE_DELAY_MS);
  }, []);

  // Pointer position watch + the two suppressors. All three live on one effect
  // so they share the same capture-phase registration order.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      // A move re-arms the typing guard: the user reached for the mouse, so the
      // chrome is wanted again.
      typingRef.current = false;
      if (draggingRef.current) return;
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const insideX = e.clientX >= rect.left && e.clientX <= rect.right;
      // Hysteresis: a hidden bar needs the thin arming band, a revealed one
      // holds across its whole height so the pointer can reach its buttons.
      const band = hoveringRef.current ? keepAlivePx : HOVER_TRIGGER_ZONE_PX;
      const nearBottom = e.clientY >= rect.bottom - band && e.clientY <= rect.bottom;
      if (insideX && nearBottom) scheduleReveal();
      else scheduleHide();
    };
    const onDown = () => { draggingRef.current = true; };
    const onUp = () => { draggingRef.current = false; };
    const onKeyDown = (e: KeyboardEvent) => {
      // Modifier-only presses are not "typing" — ⌘/Ctrl chords reach the bar's
      // own shortcuts and must not make it flinch.
      if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt' || e.key === 'Shift') return;
      typingRef.current = true;
      clearTimers();
      setHovering(false);
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [hostRef, keepAlivePx, scheduleReveal, scheduleHide, clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const onBarEnter = useCallback(() => {
    typingRef.current = false;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setHovering(true);
  }, []);
  const onBarLeave = useCallback(() => { scheduleHide(); }, [scheduleHide]);

  return {
    revealed: pinned || hold || hovering,
    barHandlers: { onPointerEnter: onBarEnter, onPointerLeave: onBarLeave },
  };
}

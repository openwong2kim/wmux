import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Track an element's own width in CSS pixels.
 *
 * `useLayoutEffect` + a synchronous first read on purpose: the caller uses this
 * to decide whether chrome FITS, and measuring in a passive effect would paint
 * one frame of the wrong layout every mount — a visible flicker of buttons that
 * immediately collapse.
 *
 * Returns `null` until the first measurement, so a caller can tell "not measured
 * yet" from "measured as zero" (a hidden pane in a background workspace really
 * is 0 wide, and must not be treated as a narrow one).
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number | null] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const next = el.getBoundingClientRect().width;
      // Only re-render on a change: a ResizeObserver fires on every layout pass
      // its target participates in, and this sits inside every pane.
      setWidth((prev) => (prev === next ? prev : next));
    };
    measure();

    // jsdom has no ResizeObserver; the one synchronous read above still gives
    // tests a real number.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

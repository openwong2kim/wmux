// Chat View row windowing (plan PR-9, §6 memory policy).
//
// A pane's projection is capped at MAX_ROWS_IN_MEMORY (2000) rows; rendering
// all of them as DOM is what makes a long conversation heavy. This hook renders
// only the rows near the viewport plus a fixed overscan, and replaces the rest
// with two spacer heights so the scrollbar geometry is unchanged.
//
// Hand-rolled on purpose: the repo has NO virtualization dependency and this
// plan adds none. Rows are variable-height (a code chip row is not a one-line
// user turn), so heights are MEASURED on mount into a Map and unmeasured rows
// fall back to an estimate.
//
// Degradation rule: until the scroll container has been measured
// (viewportHeight <= 0 — first paint, display:none, jsdom) the window is the
// full list. Windowing is an optimization; it must never be the reason a row
// is missing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Rows kept rendered above and below the measured viewport. */
export const ROW_OVERSCAN = 20;

/** Height assumed for a row that has not been measured yet, in px. */
export const ESTIMATED_ROW_HEIGHT = 64;

export interface RowWindow {
  /** First rendered row index, inclusive. */
  startIndex: number;
  /** Last rendered row index, EXCLUSIVE. */
  endIndex: number;
  /** Spacer height standing in for rows before `startIndex`, in px. */
  padTop: number;
  /** Spacer height standing in for rows after `endIndex`, in px. */
  padBottom: number;
}

const FULL_WINDOW = (count: number): RowWindow => ({
  startIndex: 0,
  endIndex: count,
  padTop: 0,
  padBottom: 0,
});

/**
 * Pure slicing math. `heights[i]` is row i's height in px (measured or
 * estimated). Returns the rendered slice plus the two spacer heights.
 */
export function computeRowWindow(
  heights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number = ROW_OVERSCAN,
): RowWindow {
  const count = heights.length;
  if (count === 0) return FULL_WINDOW(0);
  // Unmeasured viewport → render everything rather than risk a blank list.
  if (!(viewportHeight > 0)) return FULL_WINDOW(count);

  const top = Math.max(0, scrollTop);
  const bottom = top + viewportHeight;

  let offset = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < count; i += 1) {
    const rowTop = offset;
    const rowBottom = offset + Math.max(0, heights[i] ?? 0);
    if (rowBottom > top && rowTop < bottom) {
      if (first === -1) first = i;
      last = i;
    }
    offset = rowBottom;
  }
  // Scrolled past the end (heights shrank under a stale scrollTop): anchor on
  // the tail so the newest turn is what stays rendered.
  if (first === -1) {
    first = count - 1;
    last = count - 1;
  }

  const startIndex = Math.max(0, first - overscan);
  const endIndex = Math.min(count, last + 1 + overscan);

  let padTop = 0;
  for (let i = 0; i < startIndex; i += 1) padTop += Math.max(0, heights[i] ?? 0);
  let padBottom = 0;
  for (let i = endIndex; i < count; i += 1) padBottom += Math.max(0, heights[i] ?? 0);

  return { startIndex, endIndex, padTop, padBottom };
}

export interface UseRowWindowResult<T> {
  /** Attach to the scrolling container. */
  scrollRef: (el: HTMLElement | null) => void;
  /** The rows to render. */
  visibleRows: T[];
  /** Index in the full list of `visibleRows[0]` — for absolute row numbering. */
  startIndex: number;
  padTop: number;
  padBottom: number;
  /** Ref callback factory: `ref={measureRow(row.id)}` on each rendered row. */
  measureRow: (id: string) => (el: HTMLElement | null) => void;
}

/**
 * Windowed view over `rows`. `keyOf` maps a row to the stable id used as its
 * measurement key (row ids survive re-renders; indices do not).
 */
export function useRowWindow<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  overscan: number = ROW_OVERSCAN,
): UseRowWindowResult<T> {
  const containerRef = useRef<HTMLElement | null>(null);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Bumped when a measurement lands so the window recomputes with real heights.
  const [measureTick, setMeasureTick] = useState(0);

  const scrollRef = useCallback((el: HTMLElement | null) => {
    containerRef.current = el;
    if (el) {
      setViewportHeight(el.clientHeight);
      setScrollTop(el.scrollTop);
    }
  }, []);

  // Scroll + resize are the only inputs to the window besides the heights.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = (): void => {
      if (frame) return; // coalesce to one recompute per frame
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => setViewportHeight(el.clientHeight))
      : undefined;
    ro?.observe(el);
    setViewportHeight(el.clientHeight);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rows.length]);

  const measureRow = useCallback(
    (id: string) => (el: HTMLElement | null): void => {
      if (!el) return;
      const h = el.offsetHeight;
      if (!(h > 0)) return;
      if (heightsRef.current.get(id) === h) return;
      heightsRef.current.set(id, h);
      setMeasureTick((n) => n + 1);
    },
    [],
  );

  const heights = useMemo(
    () => rows.map((row) => heightsRef.current.get(keyOf(row)) ?? ESTIMATED_ROW_HEIGHT),
    // measureTick is a deliberate dependency: heightsRef is mutable, so the
    // tick is what tells React the derived heights changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, keyOf, measureTick],
  );

  const window_ = useMemo(
    () => computeRowWindow(heights, scrollTop, viewportHeight, overscan),
    [heights, scrollTop, viewportHeight, overscan],
  );

  const visibleRows = useMemo(
    () => rows.slice(window_.startIndex, window_.endIndex),
    [rows, window_.startIndex, window_.endIndex],
  );

  return {
    scrollRef,
    visibleRows,
    startIndex: window_.startIndex,
    padTop: window_.padTop,
    padBottom: window_.padBottom,
    measureRow,
  };
}

export default useRowWindow;

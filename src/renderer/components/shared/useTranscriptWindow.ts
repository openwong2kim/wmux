// Adapted from OpenMausBot (milind-soni/OpenMausBot@0213b7435fc83a936f77c18475ba2a0d7b7c2de4, src/hooks/use-transcript-viewport.ts), Apache License 2.0, Copyright 2026 Milind Soni and OpenMausBot contributors. Modified by wmux: only the window technique is kept (follow the tail until the reader scrolls up, read earlier rows in near the top while holding the scroll position, a bounded range to reveal a hidden row), driven by the view's own scroll handler and bottom flag instead of their store, gestures and sentinel.
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  followWindowStart,
  resolveTranscriptWindow,
} from './transcriptWindow';

/** Within this many pixels of the top (or of the end of a cut window), more rows are read in. */
export const WINDOW_EDGE_PX = 250;

interface WindowState {
  /** The transcript this window belongs to: another one starts at its tail. */
  resetKey: string | undefined;
  start: number;
  /** null = through the newest row. */
  end: number | null;
  /** At the tail: the start moves with new turns. Off once the reader scrolls up. */
  follow: boolean;
  /** Key of the first row, to tell rows read in before it. */
  first: string | undefined;
}

/**
 * Mounts only a window of a long transcript: the tail while the reader
 * follows it, more rows above as they scroll up. A transcript at or under the
 * window size is shown whole. The view calls `onScroll` from its own scroll
 * handler with its own "at the bottom" flag.
 */
export function useTranscriptWindow<T>({ resetKey, items, keyOf, isTurnStart, scrollRef }: {
  resetKey: string | undefined;
  items: readonly T[];
  keyOf: (item: T) => string;
  /** A row that opens a turn (the owner's message): the followed window starts at one. */
  isTurnStart: (item: T) => boolean;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const first = items.length ? keyOf(items[0]) : undefined;
  const fresh = (): WindowState => ({ resetKey, start: followWindowStart(items, 0, isTurnStart), end: null, follow: true, first });
  const [state, setState] = useState(fresh);

  // Adjusted while rendering, so the rows shown never lag the rows given.
  let next = state;
  if (state.resetKey !== resetKey) next = fresh();
  else {
    if (state.first !== first) {
      // A page read in before the first row moves every index. A window that
      // showed the first row shows the page too, as the view did before.
      const shift = state.first === undefined ? -1 : items.findIndex((item) => keyOf(item) === state.first);
      const end = state.end === null || shift <= 0 ? state.end : state.end + shift;
      next = shift <= 0 ? { ...next, first } : state.start === 0 ? { ...next, end, follow: false, first } : { ...next, start: state.start + shift, end, first };
    }
    if (next.follow && next.end === null) {
      const start = followWindowStart(items, next.start, isTurnStart);
      if (start !== next.start) next = { ...next, start };
    }
  }
  if (next !== state) setState(next);

  const view = useMemo(() => resolveTranscriptWindow(items, next.start, TRANSCRIPT_WINDOW_SIZE, next.end), [items, next.start, next.end]);

  const lastTop = useRef(0);
  // The scroll position before rows were added above, restored once they are in.
  const held = useRef<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const before = held.current;
    held.current = null;
    if (!el || !before) return;
    // Set, not added: native scroll anchoring may already have moved it.
    el.scrollTop = before.top + (el.scrollHeight - before.height);
    lastTop.current = el.scrollTop;
  }, [view.startIndex, scrollRef]);

  const onScroll = (atBottom: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const up = top < lastTop.current;
    lastTop.current = top;
    if (atBottom && view.laterCount === 0) {
      if (!next.follow) setState((s) => ({ ...s, follow: true, end: null }));
      return;
    }
    if (up && next.follow) setState((s) => ({ ...s, follow: false }));
    if (top <= WINDOW_EDGE_PX && view.hiddenCount > 0 && !held.current) {
      held.current = { top, height: el.scrollHeight };
      const start = expandWindowStart(view.startIndex);
      setState((s) => ({ ...s, start, follow: false }));
    } else if (view.laterCount > 0 && el.scrollHeight - top - el.clientHeight <= WINDOW_EDGE_PX) {
      const end = Math.min(items.length, view.endIndex + TRANSCRIPT_WINDOW_SIZE);
      setState((s) => ({ ...s, end: end >= items.length ? null : end }));
    }
  };

  /** Widen the window to a bounded range around a row it hides (find). */
  const reveal = (index: number) => {
    if (index < 0 || (index >= view.startIndex && index < view.endIndex)) return;
    const range = focusWindowRange(items.length, index);
    setState((s) => ({ ...s, start: range.start, end: range.end >= items.length ? null : range.end, follow: false }));
  };

  return { ...view, onScroll, reveal };
}

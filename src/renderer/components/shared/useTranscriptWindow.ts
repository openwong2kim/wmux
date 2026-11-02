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
  /** Keys of the first and (with a finite end) last row shown, to keep them when rows land above. */
  startKey: string | undefined;
  endKey: string | undefined;
}

/**
 * The first row of the scroller's content (its first child holds the rows)
 * that reaches into view, and how far its top sits from the scroller's top.
 */
function rowInView(scroller: HTMLElement): { row: Element | null; offset: number } {
  const top = scroller.getBoundingClientRect().top;
  for (const row of Array.from(scroller.firstElementChild?.children ?? [])) {
    const box = row.getBoundingClientRect();
    if (box.bottom > top) return { row, offset: box.top - top };
  }
  return { row: null, offset: 0 };
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
  const keyAt = (index: number): string | undefined => (index >= 0 && index < items.length ? keyOf(items[index]) : undefined);
  const indexOf = (key: string): number => items.findIndex((item) => keyOf(item) === key);
  /** A window over `start`..`end`, with the keys that hold it in place. */
  const place = (start: number, end: number | null) => ({ start, end, startKey: keyAt(start), endKey: end === null ? undefined : keyAt(end - 1) });
  const fresh = (): WindowState => ({ resetKey, follow: true, ...place(followWindowStart(items, 0, isTurnStart), null) });
  const [state, setState] = useState(fresh);

  // Adjusted while rendering, so the rows shown never lag the rows given.
  let next = state;
  if (state.resetKey !== resetKey) next = fresh();
  else {
    // Rows that land above the window (an earlier page, a card inserted into
    // the timeline) move every index after them: the same rows stay in view.
    // A window that showed the first row shows rows read in before it too.
    if (state.startKey !== undefined && keyAt(state.start) !== state.startKey) {
      const at = indexOf(state.startKey);
      if (at > 0 && state.start === 0) next = { ...next, follow: false };
      else if (at >= 0) next = { ...next, start: at };
    }
    if (state.end !== null && state.endKey !== undefined && keyAt(state.end - 1) !== state.endKey) {
      const at = indexOf(state.endKey);
      if (at >= 0) next = { ...next, end: at + 1 };
    }
    if (next.follow && next.end === null) {
      const start = followWindowStart(items, next.start, isTurnStart);
      if (start !== next.start) next = { ...next, start };
    }
  }

  const view = useMemo(() => resolveTranscriptWindow(items, next.start, TRANSCRIPT_WINDOW_SIZE, next.end), [items, next.start, next.end]);
  const startKey = keyAt(view.startIndex);
  const endKey = next.end === null ? undefined : keyAt(view.endIndex - 1);
  if (startKey !== next.startKey || endKey !== next.endKey) next = { ...next, startKey, endKey };
  if (next !== state) setState(next);

  const lastTop = useRef(0);
  // The row in view before rows were added above, kept at the same offset once they are in.
  const held = useRef<{ row: Element | null; offset: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const before = held.current;
    held.current = null;
    if (!el || !before?.row?.isConnected) return;
    // Measured, not summed from heights: rows streamed in below and native
    // scroll anchoring do not move it twice.
    el.scrollTop += before.row.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
    lastTop.current = el.scrollTop;
  }, [view.startIndex, scrollRef]);

  const onScroll = (atBottom: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const up = top < lastTop.current;
    lastTop.current = top;
    if (atBottom && view.laterCount === 0) {
      if (!next.follow) setState((s) => ({ ...s, follow: true, end: null, endKey: undefined }));
      return;
    }
    if (up && next.follow) setState((s) => ({ ...s, follow: false }));
    if (top <= WINDOW_EDGE_PX && view.hiddenCount > 0 && !held.current) {
      held.current = rowInView(el);
      const start = expandWindowStart(view.startIndex);
      setState((s) => ({ ...s, ...place(start, s.end), follow: false }));
    } else if (view.laterCount > 0 && el.scrollHeight - top - el.clientHeight <= WINDOW_EDGE_PX) {
      // The end of a window cut short (find): everything after it.
      setState((s) => ({ ...s, end: null, endKey: undefined }));
    }
  };

  /** Widen the window to a bounded range around a row it hides (find). */
  const reveal = (index: number) => {
    if (index < 0 || (index >= view.startIndex && index < view.endIndex)) return;
    const range = focusWindowRange(items.length, index);
    setState((s) => ({ ...s, ...place(range.start, range.end >= items.length ? null : range.end), follow: false }));
  };

  /** Back to the tail, following it. */
  const toTail = () => setState((s) => ({ ...s, ...place(followWindowStart(items, 0, isTurnStart), null), follow: true }));

  return { ...view, onScroll, reveal, toTail };
}

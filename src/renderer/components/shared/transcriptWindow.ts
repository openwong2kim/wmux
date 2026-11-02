// Adapted from OpenMausBot (milind-soni/OpenMausBot@0213b7435fc83a936f77c18475ba2a0d7b7c2de4, src/lib/transcript-window.ts), Apache License 2.0, Copyright 2026 Milind Soni and OpenMausBot contributors. Modified by wmux: followWindowStart takes a turn-start predicate instead of a message role, and the code follows the repository's style.

/**
 * Which slice of a long transcript is mounted. A view renders the rows from
 * `startIndex` to `endIndex` and reads older rows in as the reader scrolls up.
 */

/** Rows mounted at the tail of a transcript. */
export const TRANSCRIPT_WINDOW_SIZE = 120;

export interface TranscriptWindow<T> {
  visible: T[];
  hiddenCount: number;
  laterCount: number;
  startIndex: number;
  endIndex: number;
}

export interface TranscriptWindowRange {
  start: number;
  end: number;
}

export function tailWindowStart(total: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, total - size);
}

/**
 * The window start while following the tail: the newest turn start within one
 * more window back, so a turn stays whole and the start does not move on every
 * appended row. Never earlier than `start`.
 */
export function followWindowStart<T>(items: readonly T[], start: number, isTurnStart: (item: T) => boolean): number {
  const tail = tailWindowStart(items.length);
  const oldest = Math.max(start, tail - TRANSCRIPT_WINDOW_SIZE);
  for (let index = items.length - 1; index >= oldest; index--) {
    if (isTurnStart(items[index])) return Math.min(tail, index);
  }
  return tail;
}

export function expandWindowStart(startIndex: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, startIndex - size);
}

/** A bounded window around `targetIndex`, to reveal a row the window hides. */
export function focusWindowRange(total: number, targetIndex: number, size: number = TRANSCRIPT_WINDOW_SIZE): TranscriptWindowRange {
  const safeTotal = Math.max(0, total);
  const safeSize = Math.max(1, size);
  const target = Math.max(0, Math.min(targetIndex, Math.max(0, safeTotal - 1)));
  const start = Math.max(0, Math.min(target - Math.floor(safeSize / 2), Math.max(0, safeTotal - safeSize)));
  return { start, end: Math.min(safeTotal, start + safeSize) };
}

/** `endIndex` null = through the newest row. A start past the end falls back to the tail window. */
export function resolveTranscriptWindow<T>(
  items: readonly T[],
  startIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  endIndex: number | null = null,
): TranscriptWindow<T> {
  const requestedEnd = endIndex === null ? items.length : Math.max(0, Math.min(items.length, endIndex));
  const invalidFiniteWindow = endIndex !== null && startIndex >= requestedEnd;
  const start = startIndex >= items.length || invalidFiniteWindow ? tailWindowStart(items.length, size) : Math.max(0, startIndex);
  const end = invalidFiniteWindow ? items.length : Math.max(start, requestedEnd);
  return {
    visible: items.slice(start, end),
    hiddenCount: start,
    laterCount: items.length - end,
    startIndex: start,
    endIndex: end,
  };
}

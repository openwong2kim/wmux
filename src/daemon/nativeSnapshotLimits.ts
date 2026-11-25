/**
 * What the native snapshot takes, shared by both snapshot backends and the
 * native candidate (RustSnapshot). The limits are the native grid's own, so a
 * request that fits is never refused here for its size: a larger ring or a
 * wider pane costs parse time, which the caller's budget bounds.
 */
import type { SnapshotRequest } from './HeadlessSnapshot';
import { RING_HARD_CAP_MB } from './ringLimits';

/** A full ring of the largest size plus its mode preamble: a bound on the
 * request itself, which a ring-sourced one always meets. */
export const NATIVE_SNAPSHOT_MAX_INPUT_BYTES = RING_HARD_CAP_MB * 1024 * 1024 + 64 * 1024;

/** NativeTerminal refuses a grid above four million cells, history included. */
export const NATIVE_CELL_LIMIT = 4_000_000;

/**
 * The most history rows the native grid can hold at every size the request
 * replays. A resize changes rows first, at the old width (NativeTerminal
 * resize), so each step's old width with its new rows counts too.
 */
export function nativeScrollbackCap(req: Pick<SnapshotRequest, 'cols' | 'rows' | 'geometry'>): number {
  const replayed = [...(req.geometry ? [req.geometry.start, ...req.geometry.changes] : []), req];
  const steps = replayed.slice(1).map((next, i) => ({ cols: replayed[i].cols, rows: next.rows }));
  return Math.min(...[...replayed, ...steps].map(({ cols, rows }) => Math.floor(NATIVE_CELL_LIMIT / Math.max(1, cols)) - rows));
}

/** Every size the request replays is one the native terminal accepts. */
export function nativeSizesAccepted(req: Pick<SnapshotRequest, 'cols' | 'rows' | 'geometry'>): boolean {
  return [req, ...(req.geometry ? [req.geometry.start, ...req.geometry.changes] : [])].every(({ cols, rows }) =>
    Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 1000 && rows >= 1 && rows <= 1000);
}

/**
 * The request with its history capped at what the native grid holds at every
 * size it replays (nativeScrollbackCap), for both engines: a wide pane keeps
 * fewer rows than the 100k an attach asks for, and the snapshot never has to
 * fall back to xterm for the rows past the cap. A size the native grid does
 * not accept keeps its request (xterm serves it). `fallback` is the depth the
 * snapshot uses when the request names none.
 */
export function capScrollbackToNative<T extends Pick<SnapshotRequest, 'cols' | 'rows' | 'geometry' | 'scrollback'>>(req: T, fallback: number): T {
  const scrollback = req.scrollback ?? fallback;
  if (!Number.isFinite(scrollback) || !nativeSizesAccepted(req)) return req;
  const cap = nativeScrollbackCap(req);
  return scrollback > cap ? { ...req, scrollback: cap } : req;
}

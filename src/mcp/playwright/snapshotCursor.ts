// ---------------------------------------------------------------------------
// Continuation cursors for a truncated snapshot.
//
// A snapshot that overflows its length budget used to leave the agent two ways
// forward, and BOTH re-capture the page: a bigger maxLength, or a narrower
// selector/q. The page moves under a re-capture, and a re-capture opens a new
// ref generation — so reading the second half of a big page cost the refs of
// the first half. A cursor instead serves the next WINDOW of the same stored
// capture: no page read, no new ref generation, and every ref in every window
// is one the single capture minted.
//
// Windows are cut at line boundaries. A snapshot line is one node with its
// ref, so half a line is not something an agent can act on — the length budget
// therefore bounds the window, and a line that is alone longer than the budget
// is still emitted whole (otherwise a cursor could never make progress).
//
// Mechanism credit: continuation-cursor pagination over one stored page
// capture is Tencent/BrowserSkill's (MIT); referenced as prior art. No code
// copied.
// ---------------------------------------------------------------------------
import {
  MAX_CAPTURE_CHARS,
  clearSnapshotCapturesFor,
  getSnapshotCapture,
  putSnapshotCapture,
} from './snapshotCache';

/**
 * Characters one window may hold. Matches generateSnapshot's default
 * `maxLength`, and applies to the WINDOW rather than the capture: the capture
 * is however long the page is, the window is what lands in the caller's
 * context.
 */
export const DEFAULT_SNAPSHOT_WINDOW_CHARS = 50_000;

/**
 * Room held back from the window budget for the trailer, so the result still
 * fits the budget once the "pass cursor:… to continue" line is on it.
 */
const TRAILER_ALLOWANCE = 200;

/** Said instead of a trailer once the last line of the capture has been sent. */
export const END_OF_CAPTURE_NOTE = '(end of capture)';

/**
 * Leading token of the error a dead cursor returns. Machine-checkable on
 * purpose: the agent's recovery is always the same (snapshot again), and a
 * prefix it can match beats parsing prose.
 */
export const CURSOR_EXPIRED_PREFIX = 'cursor_expired:';

const CURSOR_EXPIRED_TEXT =
  `${CURSOR_EXPIRED_PREFIX} that capture is gone — the surface was snapshotted again, it navigated, ` +
  'or the cursor sat unused too long. Take a fresh snapshot; refs from the old capture are stale too.';

export interface LineWindow {
  /** Whole lines only, joined back with newlines. */
  text: string;
  /** Index of the first line in the window (0-based). */
  from: number;
  /** One past the index of the last line in the window. */
  to: number;
  /** Lines in the whole capture. */
  total: number;
}

/**
 * Cut `text` into the window of whole lines that starts at `offset` and fits
 * `budget` characters.
 *
 * Always advances by at least one line: a single line wider than the budget is
 * emitted whole and overruns it, because splitting it would hand the agent a
 * `ref=` it cannot use and a cursor that never terminates is worse than one
 * oversized window.
 */
export function takeLineWindow(text: string, offset: number, budget: number): LineWindow {
  const lines = text.split('\n');
  const from = Math.min(Math.max(0, offset), lines.length);
  let to = from;
  let used = 0;
  while (to < lines.length) {
    // The newline that rejoins this line to the previous one is charged too.
    const cost = lines[to].length + (to > from ? 1 : 0);
    if (to > from && used + cost > budget) break;
    used += cost;
    to++;
  }
  return { text: lines.slice(from, to).join('\n'), from, to, total: lines.length };
}

/** `… truncated at line N of M. Pass cursor:"…" …` — the continuation offer. */
export function truncationTrailer(shownThrough: number, total: number, token: string): string {
  return (
    `… truncated at line ${shownThrough} of ${total}. ` +
    `Pass cursor:${JSON.stringify(token)} to continue this same capture (no re-read).`
  );
}

/**
 * Opaque continuation token: base64url of `captureId:lineOffset`.
 *
 * Opaque because neither half is the agent's business — the id is a server-side
 * handle and the offset is a position in text the agent never saw in full — and
 * because a token it cannot read is a token it cannot hand-edit into a window
 * of somebody else's capture.
 */
export function encodeSnapshotCursor(captureId: string, lineOffset: number): string {
  return Buffer.from(`${captureId}:${lineOffset}`, 'utf8').toString('base64url');
}

export function decodeSnapshotCursor(
  token: string,
): { captureId: string; lineOffset: number } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const at = decoded.lastIndexOf(':');
  if (at <= 0) return null;
  const captureId = decoded.slice(0, at);
  const lineOffset = Number(decoded.slice(at + 1));
  if (!/^[0-9a-f]+$/.test(captureId)) return null;
  if (!Number.isInteger(lineOffset) || lineOffset < 0) return null;
  return { captureId, lineOffset };
}

/**
 * Serve `text` as a snapshot result, storing the rest as a continuation
 * capture when it does not fit one window.
 *
 * `surfaceKey` is the BARE surface key (no `:tool:` suffix): a capture is a
 * frozen view of one surface, so the next snapshot of that surface — whichever
 * tool takes it — must retire it. That snapshot re-mints refs, which is exactly
 * what would make an older capture's ref numbers lie.
 */
export function windowSnapshotText(
  surfaceKey: string,
  text: string,
  url: string | undefined,
  budget: number = DEFAULT_SNAPSHOT_WINDOW_CHARS,
): string {
  if (text.length <= budget) {
    // Fits whole: there is nothing to continue, and leaving the previous
    // capture in place would let a stale cursor outlive the result it described.
    clearSnapshotCapturesFor(surfaceKey);
    return text;
  }
  const capture = putSnapshotCapture(surfaceKey, text, url);
  const window = takeLineWindow(capture.text, 0, Math.max(1, budget - TRAILER_ALLOWANCE));
  return renderWindow(capture.id, window, capture.capped);
}

/**
 * Serve the next window of a stored capture. Reads text only — no page, no CDP,
 * no new ref generation, and deliberately no diff: a window of a capture the
 * caller is already part-way through is not a new observation to compare.
 */
export function continueSnapshotCapture(
  token: string,
  budget: number = DEFAULT_SNAPSHOT_WINDOW_CHARS,
): { text: string; isError: boolean } {
  const parsed = decodeSnapshotCursor(token);
  const capture = parsed ? getSnapshotCapture(parsed.captureId) : null;
  if (!parsed || !capture) return { text: CURSOR_EXPIRED_TEXT, isError: true };
  const window = takeLineWindow(capture.text, parsed.lineOffset, Math.max(1, budget - TRAILER_ALLOWANCE));
  if (window.from >= window.total) {
    return { text: END_OF_CAPTURE_NOTE, isError: false };
  }
  return { text: renderWindow(capture.id, window, capture.capped), isError: false };
}

/**
 * One line naming the parameters a cursor call cannot honour, or '' when none
 * were passed. Said rather than dropped in silence: a caller that sent
 * `selector` alongside a cursor is reading a window of a capture that already
 * exists, not a freshly scoped read, and a result that looks scoped but is not
 * is the reading that sends an agent after an imaginary problem.
 */
export function cursorIgnoredNote(names: string[]): string {
  return names.length === 0
    ? ''
    : `(note: cursor continues the stored capture — ${names.join(', ')} ignored; snapshot again to change them)\n`;
}

/** The window plus whichever of the two closing lines applies. */
function renderWindow(captureId: string, window: LineWindow, capped: boolean): string {
  if (window.to >= window.total) {
    const note = capped
      ? `${END_OF_CAPTURE_NOTE} — the capture itself was cut at ${MAX_CAPTURE_CHARS} characters; snapshot again with a selector or q for the rest`
      : END_OF_CAPTURE_NOTE;
    return `${window.text}\n${note}`;
  }
  const trailer = truncationTrailer(
    window.to,
    window.total,
    encodeSnapshotCursor(captureId, window.to),
  );
  return `${window.text}\n${trailer}`;
}

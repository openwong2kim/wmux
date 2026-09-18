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
// ref, so half a line is not something an agent can act on — the budget
// therefore bounds the window, and a line that is alone longer than the budget
// is still emitted whole (otherwise a cursor could never make progress).
//
// The budget has TWO halves and a line must fit both. Characters, because that
// is what the snapshot's own maxLength counts; and UTF-8 bytes, because every
// tool result then passes the dispatch-layer cap (src/mcp/resultCap.ts), which
// elides the MIDDLE of an over-cap text block. A window that overran the byte
// cap would come back with a hole in it while its trailer still promised
// continuity from the line it ended on — lines no cursor could ever reach, and
// an "(end of capture)" that claimed otherwise. So the window is sized to the
// byte cap up front and the elision never fires.
//
// Mechanism credit: continuation-cursor pagination over one stored page
// capture is Tencent/BrowserSkill's (MIT); referenced as prior art. No code
// copied.
// ---------------------------------------------------------------------------
import { DEFAULT_RESULT_CAP_BYTES, clampResultCapBytes } from '../resultCap';
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
 * Room held back from both halves of the budget for what is added around the
 * window: the trailer, and the one-line ignored-parameters note a cursor call
 * can prepend.
 */
const WINDOW_OVERHEAD = 400;

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

/** Appended in place of the lines capCaptureText had to drop. */
const CAPTURE_CEILING_NOTE =
  `... (capture ceiling reached at ${MAX_CAPTURE_CHARS} characters — the rest of the page was never ` +
  'captured; snapshot again with a selector or q to reach it)';

/** What one window may hold. A line is admitted only while it fits both halves. */
export interface WindowBudget {
  chars: number;
  bytes: number;
}

/**
 * browser_snapshot's window budget: its own `maxLength` in characters, and the
 * default dispatch cap in bytes. That tool declares no `maxBytes`, so the byte
 * half is fixed and there is nothing for a caller to raise.
 */
export function windowBudget(): WindowBudget {
  return {
    chars: Math.max(1, DEFAULT_SNAPSHOT_WINDOW_CHARS - WINDOW_OVERHEAD),
    bytes: Math.max(1, DEFAULT_RESULT_CAP_BYTES - WINDOW_OVERHEAD),
  };
}

/**
 * The window budget for a tool whose only declared ceiling is `maxBytes`
 * (browser_smart_snapshot). Bytes bound BOTH halves — a UTF-8 string never has
 * more characters than bytes — so raising `maxBytes` really does buy bigger
 * windows instead of being overridden by a fixed character count that the
 * caller was given no way to move. Clamped, never rejected.
 */
export function windowBudgetForMaxBytes(maxBytes: unknown): WindowBudget {
  const cap = Math.max(1, clampResultCapBytes(maxBytes) - WINDOW_OVERHEAD);
  return { chars: cap, bytes: cap };
}

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
 * `budget`.
 *
 * Always advances by at least one line: a single line wider than the budget is
 * emitted whole and overruns it, because splitting it would hand the agent a
 * `ref=` it cannot use and a cursor that never terminates is worse than one
 * oversized window.
 */
export function takeLineWindow(text: string, offset: number, budget: WindowBudget): LineWindow {
  const lines = text.split('\n');
  const from = Math.min(Math.max(0, offset), lines.length);
  let to = from;
  let chars = 0;
  let bytes = 0;
  while (to < lines.length) {
    // The newline that rejoins this line to the previous one is charged too.
    const join = to > from ? 1 : 0;
    const lineChars = lines[to].length + join;
    const lineBytes = Buffer.byteLength(lines[to], 'utf8') + join;
    if (to > from && (chars + lineChars > budget.chars || bytes + lineBytes > budget.bytes)) break;
    chars += lineChars;
    bytes += lineBytes;
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
 * Bound the text a capture — and the diff baseline and the repl listing beside
 * it — may retain, replacing the lines it drops with a line that says so.
 *
 * Needed because `deferTruncation` hands the tool layer the whole assembled
 * tree, and the `aria` lane has no interactive strip to shrink it: a very large
 * document's tree would otherwise be held per surface for the baseline TTL. The
 * note is a line IN the capture, so it arrives in the last window like any other
 * line rather than having to be threaded out of the store.
 */
export function capCaptureText(text: string): string {
  if (text.length <= MAX_CAPTURE_CHARS) return text;
  const cut = text.lastIndexOf('\n', MAX_CAPTURE_CHARS);
  return `${text.slice(0, cut > 0 ? cut : MAX_CAPTURE_CHARS)}\n${CAPTURE_CEILING_NOTE}`;
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
  budget: WindowBudget = windowBudget(),
): string {
  const window = takeLineWindow(text, 0, budget);
  if (window.to >= window.total) {
    // Nothing to continue — either it fitted, or the overflow was one
    // unsplittable line that had to go out whole. Either way a capture would
    // only let a stale cursor outlive the result it described.
    clearSnapshotCapturesFor(surfaceKey);
    return text;
  }
  const capture = putSnapshotCapture(surfaceKey, text, url);
  return renderWindow(capture.id, takeLineWindow(capture.text, 0, budget));
}

/**
 * Serve the next window of a stored capture. Reads text only — no page, no CDP,
 * no new ref generation, and deliberately no diff: a window of a capture the
 * caller is already part-way through is not a new observation to compare.
 */
export function continueSnapshotCapture(
  token: string,
  budget: WindowBudget = windowBudget(),
): { text: string; isError: boolean } {
  const parsed = decodeSnapshotCursor(token);
  const capture = parsed ? getSnapshotCapture(parsed.captureId) : null;
  if (!parsed || !capture) return { text: CURSOR_EXPIRED_TEXT, isError: true };
  const window = takeLineWindow(capture.text, parsed.lineOffset, budget);
  if (window.from >= window.total) {
    return { text: END_OF_CAPTURE_NOTE, isError: false };
  }
  return { text: renderWindow(capture.id, window), isError: false };
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
function renderWindow(captureId: string, window: LineWindow): string {
  if (window.to >= window.total) return `${window.text}\n${END_OF_CAPTURE_NOTE}`;
  const trailer = truncationTrailer(
    window.to,
    window.total,
    encodeSnapshotCursor(captureId, window.to),
  );
  return `${window.text}\n${trailer}`;
}

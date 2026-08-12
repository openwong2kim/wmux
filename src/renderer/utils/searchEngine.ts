/**
 * Pure search engine over an xterm.js Buffer-shaped input.
 *
 * Used by the cross-pane search feature (T-C wires this up). Kept import-free
 * (no xterm/electron/react/window) so it can be unit-tested in vitest's
 * default `node` environment and runs deterministically for any conforming
 * duck-typed buffer.
 *
 * Wrap-coalescing
 * ---------------
 * xterm represents a soft-wrapped line as N physical rows where the 2..N
 * rows have `isWrapped === true`. For human-facing search ("find this URL
 * even though it spans 3 visual rows"), we coalesce those rows into a single
 * logical line before matching. The match's `physicalBaseY` keeps the index
 * of the FIRST physical row so callers can `terminal.scrollToLine(...)`.
 *
 * Caps applied (in this order)
 * ----------------------------
 * 1. `perBufferLineCap` on PHYSICAL row scan (default 20_000) — protects
 *    against runaway scrollback.
 * 2. `remainingBudget` on returned matches — caller decrements between panes
 *    for breadth-first cross-pane behavior.
 * 3. 500 char truncation on match text and each context line.
 */

/** Per-line truncation cap. Applied to match text and every context line. */
const LINE_CHAR_CAP = 500;

/** Default surrounding logical lines kept on each side of a match. */
const DEFAULT_CONTEXT_LINES = 2;

/** Default ceiling on physical rows scanned per buffer. */
const DEFAULT_BUFFER_LINE_CAP = 20_000;

/** Default tail window for cross-pane search (pane.search). */
export const SEARCH_TAIL_DEFAULT = 5_000;
/** Hard ceiling on the tail window — mirrors the per-buffer scan cap. */
export const SEARCH_TAIL_MAX = DEFAULT_BUFFER_LINE_CAP;

/**
 * Normalize a caller-supplied `searchTailLines` into the effective tail
 * window: floor, default 5,000, CLAMPED to the 20k scan cap. The clamp is
 * load-bearing for truncation honesty (3-way review: Codex+GLM): comparing a
 * buffer's length against an UNclamped request (say 50,000) reports
 * `truncated:false` while the engine actually scanned only the newest 20k
 * rows — a false completeness signal in exactly the "search deeper" case the
 * parameter exists for. Every consumer (live scan, parked fetch, truncation
 * checks) must use THIS value, never the raw request.
 */
export function normalizeSearchTailLines(raw: unknown): number {
  const n =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
      ? Math.floor(raw)
      : SEARCH_TAIL_DEFAULT;
  return Math.min(n, SEARCH_TAIL_MAX);
}

export interface SearchOpts {
  /**
   * Treat `query` as a JS RegExp pattern. Invalid patterns throw `SyntaxError`.
   *
   * Regex semantics: the pattern is fed to `new RegExp(query)` with NO flags.
   * That means matching is case-sensitive, unicode mode is off, and inline
   * flag groups like `(?i)` are NOT supported by JavaScript's RegExp — use
   * character classes for case-insensitivity (e.g. `[Ee]rror`) instead.
   */
  regex?: boolean;
  /** Logical lines kept on each side of a match. Defaults to 2. */
  contextLines?: number;
  /** Hard cap on physical rows scanned. Defaults to 20_000. */
  perBufferLineCap?: number;
  /**
   * Hard cap on matches returned. Caller (T-C) decrements between panes so
   * the global 200-result cap is enforced breadth-first across panes.
   */
  remainingBudget: number;
  /**
   * Scan only the LAST `tailRows` physical rows (the newest output) instead
   * of the legacy head-first scan. Bounded by `perBufferLineCap` — when both
   * are set the window is the last `min(tailRows, perBufferLineCap)` rows, so
   * both bounds hold and the scan always keeps the NEWEST rows (the head-first
   * cap kept the OLDEST 20k of a huge buffer, which is almost never what a
   * cross-pane search wants). A window that starts mid-wrap truncates that
   * logical line at the boundary — same explicit trade-off as the cap.
   */
  tailRows?: number;
}

export interface MatchInBuffer {
  /** Logical line index (after wrap-coalescing). */
  lineIdx: number;
  /**
   * Original buffer index of the FIRST physical row in the logical line.
   * Suitable input for `terminal.scrollToLine(physicalBaseY)`.
   */
  physicalBaseY: number;
  /** Matched logical line text, truncated to 500 chars. */
  text: string;
  /** Up to `contextLines` logical lines BEFORE the match, each 500-char capped. */
  contextBefore: string[];
  /** Up to `contextLines` logical lines AFTER the match, each 500-char capped. */
  contextAfter: string[];
}

/**
 * Minimal xterm.js BufferLine surface area we depend on. Declared locally
 * so this module stays import-free and easy to test with plain objects.
 */
export interface SearchableBufferLine {
  /**
   * `true` when this physical row is the continuation of a soft-wrapped line
   * that started on the previous row.
   */
  isWrapped: boolean;
  /**
   * Returns the row's text. xterm strips ANSI/SGR sequences and (when
   * `trimRight` is true) trailing whitespace produced by the terminal grid.
   */
  translateToString(trimRight: boolean): string;
}

/** Minimal xterm.js Buffer surface area we depend on. */
export interface SearchableBuffer {
  /** Total physical row count (scrollback + viewport). */
  length: number;
  /** Returns the row at `idx`, or `undefined` if out of range. */
  getLine(idx: number): SearchableBufferLine | undefined;
}

/** A coalesced logical line — one match candidate. */
interface LogicalLine {
  text: string;
  /** Index of the first physical row that composes this logical line. */
  physicalBaseY: number;
}

/**
 * Walk the buffer once, joining wrapped continuations into logical lines.
 *
 * Stops at `maxPhysicalRows` regardless of mid-wrap state — a wrapped chain
 * crossing the cap is truncated at the cap boundary. This is the explicit
 * trade-off documented in T-B's spec.
 */
function buildLogicalLines(
  buffer: SearchableBuffer,
  maxPhysicalRows: number,
  startRow = 0,
): LogicalLine[] {
  const lines: LogicalLine[] = [];
  const scanLimit = Math.min(buffer.length, startRow + maxPhysicalRows);

  let currentText = '';
  let currentBaseY = -1;

  for (let i = startRow; i < scanLimit; i++) {
    const row = buffer.getLine(i);
    if (!row) {
      // Defensive: if a row is unexpectedly missing, flush any in-progress
      // logical line and resume — we don't want to silently merge across a
      // gap, since `isWrapped` is unobservable for the missing row.
      if (currentBaseY !== -1) {
        lines.push({ text: currentText, physicalBaseY: currentBaseY });
        currentText = '';
        currentBaseY = -1;
      }
      continue;
    }

    const rowText = row.translateToString(true);

    // The scan's first row is by definition the start of a logical line
    // (row 0 is never wrapped; a tail window starting mid-wrap deliberately
    // truncates that chain at the boundary).
    const isContinuation = i > startRow && row.isWrapped;

    if (isContinuation && currentBaseY !== -1) {
      currentText += rowText;
    } else {
      // Flush the previous logical line (if any) before starting a new one.
      if (currentBaseY !== -1) {
        lines.push({ text: currentText, physicalBaseY: currentBaseY });
      }
      currentText = rowText;
      currentBaseY = i;
    }
  }

  if (currentBaseY !== -1) {
    lines.push({ text: currentText, physicalBaseY: currentBaseY });
  }

  return lines;
}

/** Cap a single string to `LINE_CHAR_CAP` chars. */
function capLine(s: string): string {
  return s.length > LINE_CHAR_CAP ? s.slice(0, LINE_CHAR_CAP) : s;
}

/**
 * Search a buffer for matches and return logical-line hits with context.
 *
 * Behavior summary (full spec in module docstring):
 * - Coalesces wrapped physical rows into logical lines.
 * - Substring match by default; pass `regex: true` for `new RegExp(query)`.
 * - Returns matches in ascending `physicalBaseY` order — caller does not
 *   re-sort.
 * - Stops early once `remainingBudget` matches are produced.
 * - Returns `[]` for an empty `query` rather than throwing — the RPC layer
 *   (T-A) is responsible for rejecting empty queries before this is called.
 *
 * Regex flags: `new RegExp(query)` is invoked with NO flags — case-sensitive,
 * unicode off. JavaScript's RegExp does NOT honor inline flag groups like
 * `(?i)`; that syntax raises a SyntaxError. To do case-insensitive matching
 * use a character class (e.g. `[Ee]rror`).
 *
 * @throws SyntaxError when `opts.regex` is true and `query` is not a valid
 *   JS regex pattern. The native `RegExp` constructor's error is allowed to
 *   propagate so callers can present it verbatim to the user.
 */
export function searchInBuffer(
  buffer: SearchableBuffer,
  query: string,
  opts: SearchOpts,
): MatchInBuffer[] {
  // Empty query is a no-op — guard mirrors T-A's RPC validation but stays
  // defensive in case the engine is invoked from another caller.
  if (query.length === 0) return [];

  const budget = opts.remainingBudget;
  if (budget <= 0) return [];

  const contextLines =
    typeof opts.contextLines === 'number' && opts.contextLines >= 0
      ? Math.floor(opts.contextLines)
      : DEFAULT_CONTEXT_LINES;
  const perBufferLineCap =
    typeof opts.perBufferLineCap === 'number' && opts.perBufferLineCap >= 0
      ? Math.floor(opts.perBufferLineCap)
      : DEFAULT_BUFFER_LINE_CAP;

  // `new RegExp` throws SyntaxError for invalid patterns; we deliberately
  // let it bubble per the engine contract (UI catches and styles the input).
  const matcher: (text: string) => boolean = opts.regex
    ? (() => {
        const re = new RegExp(query);
        return (text: string) => re.test(text);
      })()
    : (text: string) => text.includes(query);

  const tailRows =
    typeof opts.tailRows === 'number' && opts.tailRows > 0
      ? Math.floor(opts.tailRows)
      : undefined;
  // Tail mode: scan the last min(tailRows, cap) rows. Legacy mode: head-first
  // scan up to the cap (kept for callers that predate tail-bounding).
  const startRow =
    tailRows !== undefined
      ? Math.max(0, buffer.length - Math.min(tailRows, perBufferLineCap))
      : 0;

  const logical = buildLogicalLines(buffer, perBufferLineCap, startRow);
  if (logical.length === 0) return [];

  const results: MatchInBuffer[] = [];

  for (let i = 0; i < logical.length; i++) {
    const line = logical[i];
    if (!matcher(line.text)) continue;

    const before: string[] = [];
    if (contextLines > 0) {
      const start = Math.max(0, i - contextLines);
      for (let j = start; j < i; j++) {
        before.push(capLine(logical[j].text));
      }
    }

    const after: string[] = [];
    if (contextLines > 0) {
      const end = Math.min(logical.length, i + 1 + contextLines);
      for (let j = i + 1; j < end; j++) {
        after.push(capLine(logical[j].text));
      }
    }

    results.push({
      // Buffer-absolute, not window-relative (3-way review: Codex+Claude —
      // the search UI displays this as "matched line N" and a window-relative
      // index showed ~line 4000 for a match at row 9000). Exact logical index
      // in the legacy full scan (startRow 0). Under tailRows the rows BEFORE
      // the window are counted physically (their wrap structure is unknowable
      // without scanning them — the very work tail-bounding avoids), so the
      // value is an upper-bound approximation that stays monotonic, unique
      // per pane, and equal to the physical row anchor for unwrapped content.
      lineIdx: startRow + i,
      physicalBaseY: line.physicalBaseY,
      text: capLine(line.text),
      contextBefore: before,
      contextAfter: after,
    });

    if (results.length >= budget) break;
  }

  return results;
}

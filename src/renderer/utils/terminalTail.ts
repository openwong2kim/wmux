import { terminalRegistry } from '../hooks/useTerminal';

type ReadableBuffer = {
  length: number;
  baseY: number;
  cursorY: number;
  getLine(idx: number): { translateToString(trimRight?: boolean): string } | undefined;
};

/** Where a screen read ends. `endAtCursor` keeps the pre-#1595 cursor-anchored
 *  end for a caller that locates something relative to the cursor row. */
export interface ScreenReadOptions {
  endAtCursor?: boolean;
}

/**
 * The last buffer row a screen read must cover: the cursor row, or the lowest
 * non-empty viewport row below it (#1595). A TUI draws below the cursor — an
 * option picker parks the cursor on the highlighted choice while the other
 * choices and the footer sit underneath — so ending at the cursor dropped them.
 * Blank rows below the cursor are still excluded, so a tail window is not spent
 * on viewport padding. The scan is bounded by the viewport height
 * (buffer.length - 1 is the viewport's last row).
 *
 * Known limit: "non-empty" means text after trimming, so a row drawn only with
 * background-coloured spaces (a filled bar, a blank highlighted line) counts as
 * empty and does not extend the read.
 */
function lastScreenRow(buffer: ReadableBuffer, opts?: ScreenReadOptions): number {
  const cursorLine = Math.min(buffer.baseY + buffer.cursorY, buffer.length - 1);
  if (opts?.endAtCursor) return cursorLine;
  for (let i = buffer.length - 1; i > cursorLine; i--) {
    const line = buffer.getLine(i);
    if (line && line.translateToString(true) !== '') return i;
  }
  return cursorLine;
}

/**
 * How many of the last `returned` lines of a read (as produced by the readers
 * below) sit below the cursor row. On a live TUI those rows are part of what it
 * drew; after the program exits or crashes they can be leftovers of an earlier
 * frame, so a caller can tell the two cases apart.
 */
export function rowsBelowCursor(ptyId: string, returned: number): number {
  const terminal = terminalRegistry.get(ptyId);
  if (!terminal) return 0;
  const buffer = terminal.buffer.active;
  const cursorLine = Math.min(buffer.baseY + buffer.cursorY, buffer.length - 1);
  return Math.max(0, Math.min(lastScreenRow(buffer) - cursorLine, returned));
}

/**
 * Read a pane's live xterm buffer to plaintext lines (trailing empty lines
 * popped). This is the SINGLE buffer-read path shared by the MCP
 * `input.readScreen` RPC and the Fleet View live-output tail, so the two can
 * never diverge in how they translate a buffer to text.
 *
 * NO `offsetWidth` / `isConnected` guard — see `scrollbackDump.ts:86` for the
 * guard that must NOT be copied here. AppLayout mounts every background pane
 * with `display:none`, so every inactive pane's xterm element reports
 * `offsetWidth === 0`; copying that guard would blank the tail for the entire
 * background fleet (i.e. the majority of cards). The buffer contents are valid
 * regardless of whether the element is laid out, so we read unconditionally,
 * gated only on the ptyId being present in the registry.
 */
export function readPtyBufferLines(ptyId: string, opts?: ScreenReadOptions): string[] {
  const terminal = terminalRegistry.get(ptyId);
  if (!terminal) return [];
  const buffer = terminal.buffer.active;
  const lastLine = lastScreenRow(buffer, opts);
  const lines: string[] = [];
  for (let i = 0; i <= lastLine && i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The default cap for an `input.readScreen` (terminal_read) that names no
 *  explicit bound. Reads only the last N buffer rows in O(N) instead of walking
 *  the whole scrollback (up to 10,000 rows by default) on the renderer thread.
 *  RCA (2026-07-14 orchestrator lag): terminal_read went through
 *  readPtyBufferLines (0..baseY+cursorY, a full-scrollback synchronous walk with
 *  no bound). An orchestrator that bursts reads pinned the renderer thread —
 *  input/switch/paint starved ("terminal read 폭발할때"). The write path (#440
 *  terminalOutputScheduler) is budgeted; reads bypassed it entirely. Bounding
 *  the default to recent output aligns with the tool's own headline ("read the
 *  current visible text") and cuts per-read cost from O(scrollback) to O(N).
 *  Sized well above a viewport so an agent's recent turn is captured whole; a
 *  caller that genuinely needs the full backlog passes full_scrollback. */
export const DEFAULT_READ_TAIL_LINES = 300;

/**
 * The last `maxLines` buffer rows of a pane, trailing empty lines popped —
 * O(maxLines), NOT O(scrollback). This is the bounded read path behind
 * `input.readScreen`'s default (and its explicit `tail_lines`): we read only a
 * window ending at the last screen row rather than walking the whole buffer, so a
 * burst of reads (an orchestrator observing its fleet) cannot pin the renderer
 * thread parsing 10k-row backlogs. Interior empty lines between content are
 * preserved (matching the full read's semantics for the last N rows). A pane
 * whose cursor sits more than `maxLines` blank rows below its last content
 * yields a short/empty result — the same bounded-scan trade-off tailForPty
 * accepts; a caller that needs exactness reads with full_scrollback.
 */
export function readPtyBufferTail(ptyId: string, maxLines: number, opts?: ScreenReadOptions): string[] {
  const terminal = terminalRegistry.get(ptyId);
  if (!terminal) return [];
  if (maxLines <= 0) return [];
  const buffer = terminal.buffer.active;
  const lastLine = lastScreenRow(buffer, opts);
  if (lastLine < 0) return [];
  const start = Math.max(0, lastLine - maxLines + 1);
  const lines: string[] = [];
  for (let i = start; i <= lastLine; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Last `n` lines of a pane's live buffer (the Fleet View tail), trailing empty
 * lines skipped. A ptyId not in the registry yields `[]`.
 *
 * Unlike `readPtyBufferLines` (which walks the WHOLE buffer for the exact
 * `input.readScreen` read), this reads only a bounded window near the bottom so
 * the 750ms Fleet poll is O(SCAN_BOUND) per pane per tick, NOT O(scrollback).
 * We scan UP from the last screen row (lastScreenRow, the same end the
 * readScreen readers use) to find the last non-empty row, but cap the upward
 * walk at `SCAN_BOUND` rows. Once the content end is found, we collect
 * `lines[start..end]` (start = end - n + 1), which PRESERVES interior empty
 * lines between content — matching the full-read's `slice(-n)` semantics for
 * the common case.
 *
 * Bounded-scan trade-off: a pathological buffer whose cursor sits far below the
 * last content (more than SCAN_BOUND empty rows) yields a short / empty tail
 * instead of walking the whole scrollback. That is acceptable for a triage
 * glance at a card — `input.readScreen` remains exact when precision matters.
 */
export function tailForPty(ptyId: string, n = 3): string[] {
  const terminal = terminalRegistry.get(ptyId);
  if (!terminal) return [];
  const buffer = terminal.buffer.active;

  // Cap the upward scan so a mostly-empty tail can't walk the whole scrollback.
  // n rows of content + a 50-row cushion of trailing blanks is plenty for a
  // 3-line card glance; beyond that we accept a short/empty tail (see above).
  const SCAN_BOUND = n + 50;

  // `n <= 0` historically meant "every line"; defer to the exact full read for
  // that (unbounded) contract rather than silently bounding it.
  if (n <= 0) {
    const lines = readPtyBufferLines(ptyId);
    return lines;
  }

  const lastLine = lastScreenRow(buffer);
  if (lastLine < 0) return [];

  // Walk UP from the last screen row to the last non-empty row, bounded.
  const floor = Math.max(0, lastLine - SCAN_BOUND + 1);
  let end = -1;
  for (let i = lastLine; i >= floor; i--) {
    const line = buffer.getLine(i);
    if (line && line.translateToString(true) !== '') {
      end = i;
      break;
    }
  }
  if (end < 0) return []; // no content within the bounded window

  const start = Math.max(0, end - n + 1);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const line = buffer.getLine(i);
    // Preserve interior empties (line present but blank) between content rows.
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}

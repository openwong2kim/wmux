import { terminalRegistry } from '../hooks/useTerminal';

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
export function readPtyBufferLines(ptyId: string): string[] {
  const terminal = terminalRegistry.get(ptyId);
  if (!terminal) return [];
  const buffer = terminal.buffer.active;
  const lastLine = buffer.baseY + buffer.cursorY;
  const lines: string[] = [];
  for (let i = 0; i <= lastLine && i < buffer.length; i++) {
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
 * We scan UP from the cursor line to find the last non-empty row, but cap the
 * upward walk at `SCAN_BOUND` rows. Once the content end is found, we collect
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

  const lastLine = Math.min(buffer.baseY + buffer.cursorY, buffer.length - 1);
  if (lastLine < 0) return [];

  // Walk UP from the cursor line to the last non-empty row, bounded.
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

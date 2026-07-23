/**
 * On-demand headless terminal snapshot (phase 3 PR-B).
 *
 * Parses a session's raw ANSI history (ring buffer + live tee) through
 * `@xterm/headless` and serializes the resulting screen + scrollback into a
 * compact re-executable ANSI payload. The renderer paints this instead of
 * re-parsing the full 8 MB raw replay on reveal.
 *
 * There is deliberately NO persistent mirror: reveals are human-frequency, so
 * a terminal is constructed per request and disposed after (daemon
 * steady-state cost stays zero, resize needs no tracking — dims come from
 * `meta.cols/rows` at request time).
 *
 * System invariant ("slower, never wrong"): every condition the snapshot
 * cannot reproduce faithfully returns `{ ok: false }` so the caller degrades
 * to the raw-replay ladder:
 *  - alternate screen buffer active (vim & friends — DECSC, saved titles and
 *    other unserialized state make fidelity unprovable),
 *  - DECSTBM scroll margins in effect (not serialized by the addon),
 *  - the stream ends inside an escape sequence too large to re-ship,
 *  - the parse exceeded its time budget,
 *  - anything thrown by xterm itself.
 *
 * IMPORTANT (query safety): no `onData` handler is ever wired on the headless
 * terminal. It must never answer DA1/DSR/OSC color queries — the renderer's
 * xterm is the authoritative responder; a daemon-side reply would race ahead
 * of it and feed the shell wrong values.
 */

import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import {
  PartialSequenceTracker,
  MarginTracker,
  SgrMouseEncodingTracker,
  incompleteUtf8SuffixLength,
} from './util/ansiStreamScan';

export interface SnapshotRequest {
  cols: number;
  rows: number;
  /** Scrollback lines for the headless buffer (defaults to 5000, clamped). */
  scrollback?: number;
  /** Raw history captured at T0 (ring buffer readAll). */
  initial: Buffer;
  /**
   * Live-tee drain: returns (and removes) chunks that arrived since the last
   * call. Called repeatedly until it comes back empty. Omit for read-only
   * snapshots of quiescent sessions (dead-session serialize).
   */
  drainQueue?: () => Buffer[];
  /** Wall-clock budget for the whole parse+serialize (default 2000 ms). */
  budgetMs?: number;
}

export type SnapshotFallbackReason =
  | 'alt-screen'
  | 'margins'
  | 'partial-tail-overflow'
  | 'budget'
  | 'error';

export type SnapshotOutcome =
  | { ok: true; payload: Buffer; bytesIn: number; durationMs: number }
  | { ok: false; reason: SnapshotFallbackReason; detail?: string };

// Measured (resync probe, 2026-07-10): chunked parse runs ~4 MB/s, so a FULL
// 8 MB ring — the flagship flooded-pane case — needs ~2 s. A 2 s budget would
// degrade exactly that case to the 8 MB raw replay this module exists to
// avoid; 4 s keeps headroom while still bounding a pathological stream.
const DEFAULT_BUDGET_MS = 4000;
const DEFAULT_SCROLLBACK = 5000;
/** Lossless upper bound on serialized scrollback. Aligned with the Settings
 *  ceiling for `scrollbackLines` (SettingsPanel.tsx — the slider maxes at
 *  100k), so a compact attach snapshot never drops rows a raw replay would have
 *  kept for a user configured that high. The headless terminal is per-snapshot
 *  and disposed, so the peak cost is bounded. */
export const MAX_SCROLLBACK = 100_000;
/** Feed slice size — keeps each synchronous parse burst bounded so the daemon
 * event loop (input forwarding!) never stalls behind an 8 MB write.
 * Exported for the slice-boundary regression test. */
export const FEED_SLICE_BYTES = 256 * 1024;

/**
 * Global serialization queue (concurrency 1). Simultaneous reveals across
 * panes would otherwise multiply peak memory (one headless terminal each) and
 * fight for the event loop.
 */
let queueTail: Promise<unknown> = Promise.resolve();

/**
 * Acquire the global snapshot slot and run `job` while holding it. Exposed so
 * SessionPipe.reflush can put its ENTIRE suppress→snapshot→finalize window
 * inside the slot: a reflush that queued AFTER announcing RESYNC_BEGIN would
 * suppress its pane's live output for the whole queue wait (N×budget under
 * concurrent reveals) and blow past the renderer's resync timeout — the
 * suppression window must equal the work window, not the wait window.
 */
export function enqueueSnapshotJob<T>(job: () => Promise<T>): Promise<T> {
  const run = queueTail.then(job);
  // The queue must survive a rejected job (a defensive catch keeps one bug
  // from wedging all snapshots).
  queueTail = run.catch(() => undefined);
  return run;
}

export function generateSnapshot(req: SnapshotRequest): Promise<SnapshotOutcome> {
  return enqueueSnapshotJob(() => generateInner(req));
}

/** One physical row of a text snapshot — ANSI already stripped by xterm. */
export interface TextSnapshotRow {
  text: string;
  /** `true` when this row is the soft-wrap continuation of the row above. */
  wrapped: boolean;
}

export type TextSnapshotOutcome =
  | { ok: true; rows: TextSnapshotRow[]; bytesIn: number; durationMs: number }
  | { ok: false; reason: SnapshotFallbackReason; detail?: string };

/**
 * Plain-text variant of the snapshot used by the cold-park search/read
 * fallback (TASK-9): a parked pane has no renderer xterm buffer, so cross-pane
 * search and `input.readScreen` must read its content from the daemon ring
 * instead of silently skipping it. Feeds the ring through a headless terminal
 * (same chunked, budgeted, UTF-8-safe path as `generateInner`) and returns the
 * parsed grid as physical rows with wrap flags — the renderer rebuilds a
 * `SearchableBuffer` from these and runs the identical search engine.
 *
 * Unlike the ANSI snapshot this never fails on alt-screen/margins: the text of
 * the visible grid is still the honest answer for a read, and search over it is
 * strictly better than a silent miss. It only fails on budget/parse errors.
 * Runs on the shared concurrency-1 queue so it can't multiply peak memory.
 */
export function generateTextSnapshot(req: SnapshotRequest): Promise<TextSnapshotOutcome> {
  return enqueueSnapshotJob(() => generateTextInner(req));
}

/** Per-row structural JSON overhead for `,{"text":,"wrapped":false}`. */
const TEXT_ROW_JSON_OVERHEAD = 26;

/** Serialized cost of one row: the JSON-escaped text (quotes, backslashes — and
 *  Windows paths are backslash-heavy — DOUBLE under JSON.stringify, so measuring
 *  raw text.length would UNDER-estimate and could still blow the frame) plus the
 *  structural overhead. `.length` (UTF-16 code units) is the correct unit here:
 *  MAX_LINE_BUFFER is compared against the string `.length` after
 *  setEncoding('utf8') in BOTH DaemonPipeServer and DaemonClient — do NOT switch
 *  this to Buffer.byteLength (that would be a byte/code-unit mismatch). */
function rowSerializedCost(r: TextSnapshotRow): number {
  return JSON.stringify(r.text).length + TEXT_ROW_JSON_OVERHEAD;
}

/**
 * Cap serialized text rows to a budget for the control-pipe frame limit
 * (DaemonPipeServer/DaemonClient MAX_LINE_BUFFER is 1 MiB and CLEARS on
 * overflow — an oversized readSessionText response would time out and come back
 * empty). Drops the OLDEST rows (front) until the estimated size fits, since the
 * tail is the most relevant, and reports whether it trimmed.
 */
export function capTextRowsToFrameBudget(
  rows: TextSnapshotRow[],
  maxBytes: number,
): { rows: TextSnapshotRow[]; truncated: boolean } {
  const costs = rows.map(rowSerializedCost);
  let total = 0;
  for (const c of costs) total += c;
  if (total <= maxBytes) return { rows, truncated: false };
  let drop = 0;
  while (drop < rows.length && total > maxBytes) {
    total -= costs[drop];
    drop++;
  }
  return { rows: rows.slice(drop), truncated: true };
}

async function generateTextInner(req: SnapshotRequest): Promise<TextSnapshotOutcome> {
  const started = Date.now();
  const budgetMs = req.budgetMs ?? DEFAULT_BUDGET_MS;
  const scrollback = clamp(req.scrollback ?? DEFAULT_SCROLLBACK, 0, MAX_SCROLLBACK);

  const terminal = new Terminal({
    cols: req.cols,
    rows: req.rows,
    scrollback,
    allowProposedApi: true,
    logLevel: 'off',
  });
  try {
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';

    let utf8Carry: Buffer = Buffer.alloc(0);
    let bytesIn = 0;

    // Mirror generateInner's slice/retreat/carry discipline so an interior
    // 256 KB boundary through a CJK/emoji char never decodes as U+FFFD.
    const feed = async (raw: Buffer): Promise<boolean> => {
      bytesIn += raw.length;
      const buf = utf8Carry.length > 0 ? Buffer.concat([utf8Carry, raw]) : raw;
      utf8Carry = Buffer.alloc(0);
      for (let off = 0; off < buf.length; ) {
        const end = Math.min(off + FEED_SLICE_BYTES, buf.length);
        const isFinal = end === buf.length;
        let slice = buf.subarray(off, end);
        const pending = incompleteUtf8SuffixLength(slice);
        if (pending > 0) {
          slice = slice.subarray(0, slice.length - pending);
          if (isFinal) {
            utf8Carry = Buffer.from(buf.subarray(end - pending, end));
            off = end;
          } else {
            off = end - pending;
          }
        } else {
          off = end;
        }
        if (slice.length === 0) continue;
        await new Promise<void>((resolve) => terminal.write(slice.toString('utf8'), resolve));
        if (Date.now() - started > budgetMs) return false;
      }
      return true;
    };

    if (!(await feed(req.initial))) {
      return { ok: false, reason: 'budget' };
    }
    if (req.drainQueue) {
      for (;;) {
        const chunks = req.drainQueue();
        if (chunks.length === 0) break;
        for (const chunk of chunks) {
          if (!(await feed(chunk))) return { ok: false, reason: 'budget' };
        }
      }
    }

    const buffer = terminal.buffer.active;
    const rows: TextSnapshotRow[] = [];
    // Walk scrollback + viewport (0 .. baseY + rows). translateToString(true)
    // strips ANSI and trailing grid whitespace, matching the renderer's read.
    const limit = buffer.baseY + terminal.rows;
    for (let i = 0; i < limit; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      rows.push({ text: line.translateToString(true), wrapped: i > 0 && line.isWrapped });
    }
    // Drop trailing empty viewport rows: the grid is always `rows` tall, so a
    // short session leaves blank rows the live read path (readPtyBufferTail)
    // never returns — including them would make readScreen tail_lines come back
    // as blank lines.
    while (rows.length > 0 && rows[rows.length - 1].text === '') rows.pop();
    return { ok: true, rows, bytesIn, durationMs: Date.now() - started };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      terminal.dispose();
    } catch {
      /* already disposed on some error paths */
    }
  }
}

/**
 * Non-queued variant for callers that already hold the slot via
 * enqueueSnapshotJob (SessionPipe.reflush). Calling this without the slot
 * forfeits the memory/event-loop serialization the queue exists for.
 */
export function generateSnapshotUnqueued(req: SnapshotRequest): Promise<SnapshotOutcome> {
  return generateInner(req);
}

async function generateInner(req: SnapshotRequest): Promise<SnapshotOutcome> {
  const started = Date.now();
  const budgetMs = req.budgetMs ?? DEFAULT_BUDGET_MS;
  const scrollback = clamp(req.scrollback ?? DEFAULT_SCROLLBACK, 0, MAX_SCROLLBACK);

  const terminal = new Terminal({
    cols: req.cols,
    rows: req.rows,
    scrollback,
    allowProposedApi: true,
    logLevel: 'off',
  });
  const serializer = new SerializeAddon();
  try {
    terminal.loadAddon(serializer);
    // Width parity with the renderer (useTerminal sets the same): without
    // Unicode 11 tables, CJK/emoji rows advance the cursor differently here
    // than on screen and the snapshot paints cell-shifted tears.
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';

    const partialTail = new PartialSequenceTracker();
    const margins = new MarginTracker();
    const sgrMouse = new SgrMouseEncodingTracker();
    // Bytes at a chunk tail that form an incomplete UTF-8 char — carried into
    // the next chunk; whatever remains at finalize is appended raw after the
    // snapshot so the renderer's byte stream stays contiguous.
    let utf8Carry: Buffer = Buffer.alloc(0);
    let bytesIn = 0;

    const feed = async (raw: Buffer): Promise<boolean> => {
      bytesIn += raw.length;
      const buf = utf8Carry.length > 0 ? Buffer.concat([utf8Carry, raw]) : raw;
      utf8Carry = Buffer.alloc(0);
      for (let off = 0; off < buf.length; ) {
        const end = Math.min(off + FEED_SLICE_BYTES, buf.length);
        const isFinal = end === buf.length;
        let slice = buf.subarray(off, end);
        // EVERY slice end can split a multibyte char, not just the buffer end:
        // an interior 256 KB boundary through a CJK/emoji char would decode
        // both halves as U+FFFD. Interior boundaries simply retreat past the
        // incomplete lead so the next slice re-reads it whole; only bytes
        // pending at the END of the buffer leave via the cross-feed carry.
        const pending = incompleteUtf8SuffixLength(slice);
        if (pending > 0) {
          slice = slice.subarray(0, slice.length - pending);
          if (isFinal) {
            utf8Carry = Buffer.from(buf.subarray(end - pending, end));
            off = end;
          } else {
            off = end - pending; // interior retreat: strictly > previous off (slice ≫ 3 bytes)
          }
        } else {
          off = end;
        }
        if (slice.length === 0) continue;
        const text = slice.toString('utf8');
        partialTail.feed(text);
        margins.feed(text);
        sgrMouse.feed(text);
        // Await the parse callback: backpressure AND an event-loop yield per
        // slice (xterm completes writes asynchronously).
        await new Promise<void>((resolve) => terminal.write(text, resolve));
        if (Date.now() - started > budgetMs) return false;
      }
      return true;
    };

    if (!(await feed(req.initial))) {
      return { ok: false, reason: 'budget' };
    }
    if (req.drainQueue) {
      // Drain the live tee until we observe it empty. The check and the
      // caller's finalize both run synchronously relative to socket events,
      // so chunks that arrive after our last observation become the caller's
      // post-marker tail — never lost, never double-fed.
      for (;;) {
        const chunks = req.drainQueue();
        if (chunks.length === 0) break;
        for (const chunk of chunks) {
          if (!(await feed(chunk))) {
            return { ok: false, reason: 'budget' };
          }
        }
      }
    }

    if (terminal.buffer.active.type === 'alternate') {
      return { ok: false, reason: 'alt-screen' };
    }
    if (margins.active) {
      return { ok: false, reason: 'margins' };
    }
    const tail = partialTail.isPending ? partialTail.pendingTail : '';
    if (tail === null) {
      return { ok: false, reason: 'partial-tail-overflow' };
    }

    const core = serializer.serialize();
    const modesTail = buildModesTail(terminal, sgrMouse);
    const payload = Buffer.concat([
      Buffer.from(core + modesTail + tail, 'utf8'),
      utf8Carry,
    ]);
    return { ok: true, payload, bytesIn, durationMs: Date.now() - started };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      terminal.dispose();
    } catch {
      /* already disposed on some error paths */
    }
  }
}

/**
 * SerializeAddon restores content but not DECSET/mode state (F5): a lost
 * bracketed-paste mode turns a multi-line paste into line-by-line execution;
 * lost application-cursor mode breaks arrow keys. Rebuild the tail from the
 * headless terminal's public modes, plus the SGR mouse-encoding pair the
 * public API does not expose (tracked from the raw stream).
 *
 * Not covered (accepted): DECSC saved cursor, cursor visibility (DECTCEM) —
 * apps that use them are overwhelmingly alt-screen TUIs, which already fell
 * back to raw replay above.
 */
function buildModesTail(terminal: Terminal, sgrMouse: SgrMouseEncodingTracker): string {
  const modes = terminal.modes;
  let tail = '';
  if (modes.insertMode) tail += '\x1b[4h';
  if (!modes.wraparoundMode) tail += '\x1b[?7l';
  if (modes.originMode) tail += '\x1b[?6h';
  if (modes.reverseWraparoundMode) tail += '\x1b[?45h';
  if (modes.applicationCursorKeysMode) tail += '\x1b[?1h';
  if (modes.applicationKeypadMode) tail += '\x1b=';
  if (modes.sendFocusMode) tail += '\x1b[?1004h';
  if (modes.bracketedPasteMode) tail += '\x1b[?2004h';
  switch (modes.mouseTrackingMode) {
    case 'x10':
      tail += '\x1b[?9h';
      break;
    case 'vt200':
      tail += '\x1b[?1000h';
      break;
    case 'drag':
      tail += '\x1b[?1002h';
      break;
    case 'any':
      tail += '\x1b[?1003h';
      break;
    case 'none':
      break;
  }
  if (modes.mouseTrackingMode !== 'none') {
    if (sgrMouse.sgrPixels) tail += '\x1b[?1016h';
    else if (sgrMouse.sgr) tail += '\x1b[?1006h';
  }
  // Synchronized output: if the app was cut mid-batch, re-arming ?2026
  // matches the parser state; the closing 2026l arrives with the live bytes
  // (xterm has an internal timeout, so a crashed app cannot wedge painting).
  if (modes.synchronizedOutputMode) tail += '\x1b[?2026h';
  return tail;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

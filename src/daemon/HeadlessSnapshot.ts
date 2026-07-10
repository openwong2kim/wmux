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
const MAX_SCROLLBACK = 50_000;
/** Feed slice size — keeps each synchronous parse burst bounded so the daemon
 * event loop (input forwarding!) never stalls behind an 8 MB write. */
const FEED_SLICE_BYTES = 256 * 1024;

/**
 * Global serialization queue (concurrency 1). Simultaneous reveals across
 * panes would otherwise multiply peak memory (one headless terminal each) and
 * fight for the event loop.
 */
let queueTail: Promise<unknown> = Promise.resolve();

export function generateSnapshot(req: SnapshotRequest): Promise<SnapshotOutcome> {
  const run = queueTail.then(() => generateInner(req));
  // The queue must survive a rejected run (generateInner never rejects by
  // design, but a defensive catch keeps one bug from wedging all snapshots).
  queueTail = run.catch(() => undefined);
  return run;
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
      for (let off = 0; off < buf.length; off += FEED_SLICE_BYTES) {
        const end = Math.min(off + FEED_SLICE_BYTES, buf.length);
        let slice = buf.subarray(off, end);
        if (end === buf.length) {
          const pending = incompleteUtf8SuffixLength(slice);
          if (pending > 0) {
            utf8Carry = Buffer.from(slice.subarray(slice.length - pending));
            slice = slice.subarray(0, slice.length - pending);
          }
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

// Global terminal output scheduler — one cooperative drain loop for ALL panes.
//
// RCA (2026-07-10 multi-workspace stutter): every workspace's pane tree stays
// mounted (tmux-style persistence), and useTerminal wrote PTY data straight
// into each pane's xterm on every IPC event. xterm's internal WriteBuffer
// schedules parse/render callbacks PER TERMINAL, so N busy hidden agents run
// N independent write pipelines on the shared renderer thread and the focused
// pane's input echo and paint starve between them. Repaint-side work (#333)
// cannot fix this — the contention is in the write/parse path.
//
// This module serializes all pane writes through a single budgeted drain:
//
//   - Visible pane, empty queue, bounded chunk → DIRECT write (byte-identical
//     to the old path; the focused pane pays zero added latency in steady
//     state).
//   - Visible pane, queued bytes OR one oversized chunk → enqueue as priority
//     + drain(0), so per-terminal byte order is never violated AND a visible
//     pane's OWN output flood (e.g. the agent you are watching printing a
//     torrent) is chunked under the drain budget instead of blocking the
//     renderer in a single parse.
//   - Hidden pane → enqueue; drained in the background cadence.
//   - Drain tick: at most MAX_WRITES_PER_DRAIN hand-offs of CHUNK_CHARS each
//     under a hard DRAIN_TIME_BUDGET_MS wall-clock budget, priority entries
//     first, round-robin across terminals.
//
// NOTHING is ever dropped. On overflow (a hidden pane flooding past
// MAX_QUEUE_CHARS) the queue is flushed straight into xterm — that is exactly
// the pre-scheduler behavior, so the worst case degrades to the old baseline
// instead of losing output. (A lossy cap needs a main-side screen mirror to
// rehydrate from; that is a separate, later stage.)

/** Minimal surface the scheduler needs — keeps the module xterm-agnostic and
 *  unit-testable with plain fakes. */
export interface SchedulableTerminal {
  write(data: string): void;
}

interface WriteOptions {
  /** Pane visibility at receive time. Visible panes keep the old direct-write
   *  latency; hidden panes get batched. */
  foreground: boolean;
  /** Fires with the char count each time bytes are actually handed to
   *  terminal.write (glyph-repaint cadence tracks WRITE calls, not IPC
   *  receipt — see glyphRepaint.ts header). */
  onWritten?: (chars: number) => void;
}

interface QueueEntry {
  terminal: SchedulableTerminal;
  /** Queued segments in arrival order. Consumed via chunkIndex to avoid
   *  O(n²) shift() on long queues; compacted periodically. */
  chunks: string[];
  chunkIndex: number;
  queuedChars: number;
  /** True when foreground bytes are queued (visible pane briefly behind) —
   *  drained ahead of background entries and at the faster cadence. */
  priority: boolean;
  onWritten?: (chars: number) => void;
}

// Cadence: hidden output is invisible, so its first hand-off can wait a
// batch window; the drain itself stays on a frame-ish rhythm with a hard
// wall-clock budget so xterm parsing can never pin the renderer thread.
const BACKGROUND_FLUSH_DELAY_MS = 50;
const DRAIN_INTERVAL_MS = 16;
const PRIORITY_DRAIN_INTERVAL_MS = 4;
const CHUNK_CHARS = 16 * 1024;
// A single foreground write larger than this is routed through the batch path
// (chunked under the drain budget) rather than written directly, so a visible
// pane's own output flood cannot pin the renderer in one oversized parse.
// Sized above ordinary keystroke echo and TUI redraws so those keep the
// zero-latency direct path; only genuine torrents cross it.
const FOREGROUND_DIRECT_MAX_CHARS = 64 * 1024;
const MAX_WRITES_PER_DRAIN = 2;
const DRAIN_TIME_BUDGET_MS = 8;
/** Backlogs past this promote the drain to the priority cadence so a single
 *  chatty hidden pane cannot sit on a growing queue for seconds. */
const LARGE_BACKLOG_CHARS = 512 * 1024;
/** Bounded scheduler memory. Overflow flushes the whole queue into xterm —
 *  the pre-scheduler baseline — rather than dropping bytes. */
const MAX_QUEUE_CHARS = 2 * 1024 * 1024;
/** Compact consumed chunk slots once the dead prefix grows past this. */
const COMPACT_THRESHOLD = 64;

const queue = new Map<SchedulableTerminal, QueueEntry>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let drainDelayMs: number | null = null;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function scheduleDrain(delayMs: number): void {
  if (drainTimer !== null) {
    // Keep the earlier deadline; only reschedule when the new request is sooner.
    if (drainDelayMs !== null && drainDelayMs <= delayMs) return;
    clearTimeout(drainTimer);
  }
  drainTimer = setTimeout(drainQueuedOutput, delayMs);
  drainDelayMs = delayMs;
}

function getOrCreateEntry(
  terminal: SchedulableTerminal,
  options: WriteOptions,
): QueueEntry {
  let entry = queue.get(terminal);
  if (!entry) {
    entry = { terminal, chunks: [], chunkIndex: 0, queuedChars: 0, priority: false };
    queue.set(terminal, entry);
  }
  // Latest registration wins — the hook closure belongs to the current mount.
  entry.onWritten = options.onWritten;
  return entry;
}

function compactConsumedChunks(entry: QueueEntry): void {
  if (entry.chunkIndex === entry.chunks.length) {
    entry.chunks.length = 0;
    entry.chunkIndex = 0;
  } else if (entry.chunkIndex >= COMPACT_THRESHOLD) {
    entry.chunks.splice(0, entry.chunkIndex);
    entry.chunkIndex = 0;
  }
}

/** Take up to `limit` chars off the head of the queue, preserving order. */
function takeQueuedChunk(entry: QueueEntry, limit: number): string {
  let data = '';
  let remaining = limit;
  while (remaining > 0 && entry.chunkIndex < entry.chunks.length) {
    const chunk = entry.chunks[entry.chunkIndex];
    if (chunk.length <= remaining) {
      data += chunk;
      remaining -= chunk.length;
      entry.queuedChars -= chunk.length;
      entry.chunkIndex += 1;
    } else {
      data += chunk.slice(0, remaining);
      entry.chunks[entry.chunkIndex] = chunk.slice(remaining);
      entry.queuedChars -= remaining;
      remaining = 0;
    }
  }
  compactConsumedChunks(entry);
  return data;
}

function hasQueuedChunks(entry: QueueEntry): boolean {
  return entry.chunkIndex < entry.chunks.length;
}

/** Hand one bounded chunk to xterm. Returns false when the terminal is gone
 *  (disposed mid-flight) and the entry should be abandoned. */
function writeQueuedChunk(entry: QueueEntry): boolean {
  const data = takeQueuedChunk(entry, CHUNK_CHARS);
  if (!data) return true;
  try {
    entry.terminal.write(data);
    entry.onWritten?.(data.length);
    return true;
  } catch {
    // terminal.dispose() raced a queued late chunk. Drop this entry only —
    // the scheduler must keep draining the other panes.
    entry.chunks.length = 0;
    entry.chunkIndex = 0;
    entry.queuedChars = 0;
    return false;
  }
}

function hasPriorityBacklog(): boolean {
  for (const entry of queue.values()) {
    if (entry.priority || entry.queuedChars > LARGE_BACKLOG_CHARS) return true;
  }
  return false;
}

/** Pick the next entry to drain: priority entries first, otherwise Map
 *  insertion order. Removing + re-inserting after a partial drain rotates the
 *  entry to the tail, which is what gives round-robin fairness. */
function takeNextEntry(): QueueEntry | null {
  let fallback: QueueEntry | null = null;
  for (const entry of queue.values()) {
    if (entry.priority) {
      queue.delete(entry.terminal);
      return entry;
    }
    fallback ??= entry;
  }
  if (fallback) queue.delete(fallback.terminal);
  return fallback;
}

function drainQueuedOutput(): void {
  drainTimer = null;
  drainDelayMs = null;
  const startedAt = now();
  let writes = 0;

  while (queue.size > 0 && writes < MAX_WRITES_PER_DRAIN) {
    const entry = takeNextEntry();
    if (!entry) break;
    if (writeQueuedChunk(entry)) {
      writes += 1;
      if (hasQueuedChunks(entry)) {
        queue.set(entry.terminal, entry); // rotate to tail, keep remainder
      } else {
        entry.priority = false;
      }
    }
    // Cooperative: xterm parsing shares the renderer thread with input and
    // paint. One over-budget tick yields; the reschedule below continues.
    if (writes > 0 && now() - startedAt >= DRAIN_TIME_BUDGET_MS) break;
  }

  if (queue.size > 0) {
    scheduleDrain(hasPriorityBacklog() ? PRIORITY_DRAIN_INTERVAL_MS : DRAIN_INTERVAL_MS);
  }
}

/**
 * Route one PTY data event into a terminal.
 *
 * Visible pane with nothing queued → direct write (identical to the
 * pre-scheduler path). Anything else is enqueued so per-terminal byte order
 * is always preserved, and drained on the appropriate cadence.
 */
export function writeTerminalOutput(
  terminal: SchedulableTerminal,
  data: string,
  options: WriteOptions,
): void {
  if (!data) return;

  const existing = queue.get(terminal);

  // Direct path only for a bounded chunk with nothing already queued. An
  // oversized foreground chunk falls through to the priority-enqueue path
  // below so it is handed to xterm in CHUNK_CHARS slices under the drain
  // budget — a visible pane's own flood no longer blocks the renderer in one
  // parse, while byte order stays intact (nothing was queued, so this chunk
  // is first in line and drains at the priority cadence).
  if (
    options.foreground &&
    (!existing || !hasQueuedChunks(existing)) &&
    data.length <= FOREGROUND_DIRECT_MAX_CHARS
  ) {
    try {
      terminal.write(data);
      options.onWritten?.(data.length);
    } catch {
      // Disposed-terminal race — nothing to clean up on the direct path.
    }
    return;
  }

  const entry = getOrCreateEntry(terminal, options);
  entry.chunks.push(data);
  entry.queuedChars += data.length;

  if (entry.queuedChars > MAX_QUEUE_CHARS) {
    // Bounded memory without data loss: hand everything to xterm now. This
    // is exactly the old always-write behavior, so a flooding hidden pane
    // degrades to the previous baseline instead of losing output.
    flushTerminalOutput(terminal);
    return;
  }

  if (options.foreground) {
    entry.priority = true;
    scheduleDrain(0);
  } else {
    scheduleDrain(
      entry.priority || entry.queuedChars > LARGE_BACKLOG_CHARS
        ? 0
        : BACKGROUND_FLUSH_DELAY_MS,
    );
  }
}

/**
 * Synchronously hand ALL queued bytes for this terminal to xterm (in
 * CHUNK_CHARS slices, order preserved). Used on reveal (hidden → visible
 * catch-up), on queue overflow, and before operations that assume bytes have
 * already reached xterm (reconnect replay / terminal.reset()).
 *
 * "Synchronous" means synchronous HAND-OFF: xterm's own write buffer still
 * parses asynchronously, exactly as it did when useTerminal wrote directly.
 */
export function flushTerminalOutput(terminal: SchedulableTerminal): void {
  const entry = queue.get(terminal);
  if (!entry) return;
  queue.delete(terminal);
  while (hasQueuedChunks(entry)) {
    if (!writeQueuedChunk(entry)) return;
  }
  entry.priority = false;
}

/** Drop everything queued for this terminal (teardown path — the terminal is
 *  being disposed, parsing the backlog would be wasted work). */
export function discardTerminalOutput(terminal: SchedulableTerminal): void {
  queue.delete(terminal);
}

/** Test/debug: chars currently queued for a terminal (0 when absent). */
export function getQueuedCharCount(terminal: SchedulableTerminal): number {
  return queue.get(terminal)?.queuedChars ?? 0;
}

/** Test only: reset all module state. */
export function __resetTerminalOutputSchedulerForTests(): void {
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  drainDelayMs = null;
  queue.clear();
}

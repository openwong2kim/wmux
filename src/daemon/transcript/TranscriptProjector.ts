// TranscriptProjector — the daemon's read-only projection of a pane's Claude
// Code transcript into `TurnEvent`s, plus the push side that tells subscribed
// clients when there is more.
//
// Why the daemon owns this: the transcript path is only known from the resume
// binding the hook pipeline persists (`meta.resumeBinding.transcriptPath`), the
// daemon is the always-on process (so the projection survives a GUI close), and
// the phone surface (`WebTerminalServer`) can then call these same methods
// in-process instead of a second normalizer being written for it.
//
// Two independent triggers, both load-bearing:
//   1. hook nudges — `HookIngest` calls `nudge()` on every resolved signal.
//      Free, and the only trigger that knows a turn ENDED.
//   2. fs.watch — if the Claude plugin is not installed there are no nudges at
//      all, so the watch is the floor, not a nicety.
//
// Three hard rules, each from a specific failure this code would otherwise
// cause:
//   - A3, byte budget. `DaemonClient` drops its ENTIRE control buffer past 1MB,
//     so one oversized append would destroy an unrelated `session.died` on the
//     same socket. Every payload is fitted under BUDGET_BYTES by reading LESS,
//     never by shipping more; the remainder arrives on the next read.
//   - A4, watch the DIRECTORY. `gitContextWatch.ts` documents that file-watching
//     goes silent after an atomic rename with no error event to re-arm on, and
//     a transcript is rewritten that way. Match on basename, `persistent:false`,
//     unref'd debounce, and a polling fallback for the setups where fs.watch
//     cannot arm at all (network home dirs).
//   - A6, unicast. Subscriptions are keyed by (clientId, sessionId) and dropped
//     when the socket closes, so a renderer reload cannot leak watchers and a
//     non-subscriber never receives conversation content.

import fs from 'node:fs';
import path from 'node:path';
import {
  parseTranscriptLineDetailed,
} from './parseEntry';
import {
  TAIL_BYTES,
  isLineBoundary,
  readTranscriptDelta,
  readTranscriptLineAt,
  readTranscriptPage,
  statTranscript,
  transcriptBasename,
  transcriptSessionId,
} from './readTail';
import type { AgentSignalKind, CodeBlockRequest, TranscriptProjectorDeps } from './types';
import type {
  TranscriptAppendData,
  TranscriptPage,
  TranscriptStatus,
  TurnEvent,
} from '../../shared/transcript/turnEvents';

/**
 * A3 — hard serialized-byte budget for one RPC response and for one emitted
 * append. Chosen well under main's 1MB control-buffer cap so several in flight
 * still cannot approach it. When a window does not fit, we read a SMALLER
 * window; we never return a bigger payload.
 */
export const BUDGET_BYTES = 128 * 1024;

/** Smallest window the budget loop will shrink to before giving up. */
const MIN_READ_BYTES = 8 * 1024;

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_POLL_MS = 3000;

/**
 * D3 — delay between the budgeted reads that drain a burst. Long enough to hand
 * the event loop back between two 128KB reads (the daemon serves every pane on
 * this loop), short enough that a large burst still lands in one visible beat
 * instead of waiting for the next fs event.
 */
const DRAIN_DELAY_MS = 10;

/**
 * D1(b) — ceiling on the backoff applied while an oversized record at the
 * cursor has no terminating newline yet. Every nudge would otherwise re-run the
 * same fruitless read.
 */
const MAX_STALL_BACKOFF_MS = 5000;

/** Only Claude Code publishes a transcript wmux can project today. */
const SUPPORTED_AGENT = 'claude';

/** One budget-fitted read, ready to become an append event. */
interface BudgetedRead {
  events: TurnEvent[];
  cursor: TranscriptPage['cursor'];
  reset: boolean;
  /** See `TranscriptDelta.stalled` — nothing was consumed; back off. */
  stalled?: boolean;
}

interface WatchState {
  /** Subscribers, keyed by pipe clientId. Empty ⇒ tear the watch down. */
  clients: Set<string>;
  transcriptPath: string;
  watcher: fs.FSWatcher | null;
  poller: ReturnType<typeof setInterval> | null;
  debounce: ReturnType<typeof setTimeout> | null;
  /** Cursor of the last append we emitted; -1 until the first read. */
  tailOffset: number;
  seq: number;
  /** Set by a session_start nudge — the next append must replace, not append. */
  forceReset: boolean;
  /** Last size/mtime seen by the poller, so polling is a cheap no-op. */
  lastSize: number;
  lastMtimeMs: number;
  /** Inode of the file the cursor belongs to; a change means it was replaced. */
  lastIno: number;
  /**
   * Consecutive reads that consumed nothing because an oversized record at the
   * cursor is still unterminated. Drives the D1(b) backoff.
   */
  stallCount: number;
}

export class TranscriptProjector {
  private readonly deps: TranscriptProjectorDeps;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly watches = new Map<string, WatchState>();
  private disposed = false;

  constructor(deps: TranscriptProjectorDeps) {
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  }

  /**
   * Is Chat View available for this pane, and if not, WHY. The reasons are
   * distinct because the UI says something different for each: an agent that
   * publishes no transcript is a permanent no, while `no-transcript-path` just
   * means the first turn has not ended yet (SessionStart fires before the
   * `.jsonl` exists and carries no path — only the first Stop fills it in).
   */
  status(sessionId: string): TranscriptStatus {
    const resolved = this.resolvePath(sessionId);
    if (!resolved.ok) return { available: false, reason: resolved.reason };
    const stat = statTranscript(resolved.transcriptPath);
    const basename = transcriptBasename(resolved.transcriptPath);
    if (!stat) {
      // Purged, rotated away, or on an unmounted volume.
      return { available: false, reason: 'unreadable', transcriptBasename: basename };
    }
    return {
      available: true,
      reason: 'ok',
      transcriptBasename: basename,
      agentSessionId: transcriptSessionId(resolved.transcriptPath),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  /**
   * A page of the conversation: the tail by default, or the window ending at
   * `before` (a previous `cursor.headOffset`) when paging backward.
   */
  snapshot(sessionId: string, opts?: { before?: number }): TranscriptPage | null {
    const resolved = this.resolvePath(sessionId);
    if (!resolved.ok) return null;

    let maxBytes = TAIL_BYTES;
    let page = readTranscriptPage(resolved.transcriptPath, { ...opts, maxBytes });
    while (page && maxBytes > MIN_READ_BYTES && !withinBudget(page.events)) {
      // A3: shrink the WINDOW, never the honesty of the cursor. The events we
      // did not return are still reachable — the caller pages backward for
      // older ones, and the delta path carries newer ones.
      maxBytes = Math.max(MIN_READ_BYTES, Math.floor(maxBytes / 2));
      page = readTranscriptPage(resolved.transcriptPath, { ...opts, maxBytes });
    }
    if (page && !withinBudget(page.events)) {
      // One entry alone exceeds the budget. Report the cursor truthfully with
      // no rows rather than blow past the control-buffer cap.
      this.deps.log?.('warn', `[transcript] snapshot for ${sessionId} exceeded the byte budget; returning an empty page`);
      return { ...page, events: [] };
    }
    return page;
  }

  /**
   * Subscribe `clientId` to this pane's appends. Refcounted per client, so an
   * unopened Chat surface costs nothing and two windows watching the same pane
   * arm one watcher.
   */
  subscribe(clientId: string, sessionId: string): TranscriptStatus {
    const status = this.status(sessionId);
    if (this.disposed) return status;

    let state = this.watches.get(sessionId);
    if (!state) {
      const resolved = this.resolvePath(sessionId);
      // Still register the subscription when the path is not usable YET: a
      // fresh pane has no transcriptPath until its first turn ends, and the
      // session_start / stop nudge is what fills it in. Dropping the
      // subscription here would mean the client never hears about that.
      state = {
        clients: new Set(),
        transcriptPath: resolved.ok ? resolved.transcriptPath : '',
        watcher: null,
        poller: null,
        debounce: null,
        tailOffset: -1,
        seq: 0,
        forceReset: false,
        lastSize: -1,
        lastMtimeMs: -1,
        lastIno: -1,
        stallCount: 0,
      };
      this.watches.set(sessionId, state);
    }
    state.clients.add(clientId);
    this.arm(sessionId, state);
    // Push the current tail without waiting for a write. A client that only
    // subscribed (no separate snapshot call) still gets the conversation, and a
    // client that did call snapshot dedups on the stable event ids.
    this.schedule(sessionId, state);
    return status;
  }

  /** Drop one client's subscription; the watch dies with the last subscriber. */
  unsubscribe(clientId: string, sessionId: string): void {
    const state = this.watches.get(sessionId);
    if (!state) return;
    state.clients.delete(clientId);
    if (state.clients.size === 0) {
      this.teardown(state);
      this.watches.delete(sessionId);
    }
  }

  /**
   * Drop EVERY subscription held by one client. Wired to pipe-socket close: a
   * renderer that reloads without unsubscribing must not leave a watcher (and a
   * poll timer) behind for the life of the daemon.
   */
  dropClient(clientId: string): void {
    for (const sessionId of [...this.watches.keys()]) {
      this.unsubscribe(clientId, sessionId);
    }
  }

  /**
   * Called by HookIngest on every resolved signal. Cheap when nobody is
   * subscribed — a pane with no Chat surface open does no IO here.
   *
   * The kinds that matter:
   *   agent.stop / agent.subagent_stop — turn boundary; the binding was just
   *     refreshed, so this is the first nudge that can carry a transcriptPath
   *     on a fresh session.
   *   agent.activity — PostToolUse, the mid-turn liveness nudge. Already
   *     throttled at the source (the bridge's ACTIVITY_STAMP_THROTTLE_MS), so
   *     no second throttle here: the daemon stays dumb.
   *   agent.awaiting_input — a permission prompt; read so the last assistant
   *     line is on screen by the time the composer locks.
   *   agent.session_start — a reused pane must not keep showing the previous
   *     conversation, so the next append is forced to `reset:true`.
   */
  nudge(sessionId: string, kind: AgentSignalKind): void {
    const state = this.watches.get(sessionId);
    if (!state || this.disposed) return;
    if (kind === 'agent.session_start') {
      state.forceReset = true;
      state.tailOffset = -1;
      state.transcriptPath = '';
    }
    // A binding that only just arrived (or changed session) is picked up here.
    this.refreshPath(sessionId, state);
    this.schedule(sessionId, state);
  }

  /**
   * The body of one code block, re-extracted from the transcript line it came
   * from. Bodies are never broadcast (A3) and never cached: the ref carries the
   * source offset, so this is a single bounded read.
   */
  codeBlock(sessionId: string, req: CodeBlockRequest): { body: string } | null {
    const resolved = this.resolvePath(sessionId);
    if (!resolved.ok) return null;
    if (!Number.isFinite(req.srcOffset) || req.srcOffset < 0) return null;
    if (!Number.isFinite(req.n) || req.n < 1) return null;

    const line = readTranscriptLineAt(resolved.transcriptPath, Math.floor(req.srcOffset));
    if (line === null) return null;
    const parsed = parseTranscriptLineDetailed(line, Math.floor(req.srcOffset));

    if (req.eventId) {
      // The file may have rotated since the ref was minted; without this check
      // the offset would happily answer with a different conversation's code.
      const bodies = parsed.bodies.get(req.eventId);
      const body = bodies?.get(Math.floor(req.n));
      return body === undefined ? null : { body };
    }
    for (const bodies of parsed.bodies.values()) {
      const body = bodies.get(Math.floor(req.n));
      if (body !== undefined) return { body };
    }
    return null;
  }

  /** Wire to session:died / session:destroyed — the pane's rows are moot. */
  dropPty(sessionId: string): void {
    const state = this.watches.get(sessionId);
    if (!state) return;
    this.teardown(state);
    this.watches.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.watches.values()) this.teardown(state);
    this.watches.clear();
  }

  /** Live watch count — observability / tests only. */
  get watchCount(): number {
    return this.watches.size;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private resolvePath(
    sessionId: string,
  ): { ok: true; transcriptPath: string } | { ok: false; reason: string } {
    let binding;
    try {
      binding = this.deps.getResumeBinding(sessionId);
    } catch {
      return { ok: false, reason: 'no-binding' };
    }
    if (!binding) return { ok: false, reason: 'no-binding' };
    if (binding.agent !== SUPPORTED_AGENT) return { ok: false, reason: 'not-claude' };
    if (!binding.transcriptPath) return { ok: false, reason: 'no-transcript-path' };
    return { ok: true, transcriptPath: binding.transcriptPath };
  }

  /**
   * Re-read the binding. A pane's transcript path appears late (first Stop) and
   * changes on `/clear` or a new session, and the watch has to follow it.
   */
  private refreshPath(sessionId: string, state: WatchState): void {
    const resolved = this.resolvePath(sessionId);
    const next = resolved.ok ? resolved.transcriptPath : '';
    if (next === state.transcriptPath) return;
    state.transcriptPath = next;
    state.tailOffset = -1;
    state.forceReset = true;
    state.lastSize = -1;
    state.lastMtimeMs = -1;
    state.lastIno = -1;
    state.stallCount = 0;
    // Re-arm on the new file's directory (usually the same one, but a `/clear`
    // can move a session into a different project slug).
    this.disarmWatch(state);
    this.arm(sessionId, state);
  }

  /**
   * A4 — watch the DIRECTORY that holds the transcript and match on basename.
   *
   * Watching the file itself goes silent after an atomic rename with no error
   * event to re-arm on (the repo's own gitContextWatch.ts documents this), and
   * Claude Code rewrites transcripts that way. `persistent:false` so the watch
   * can never keep the daemon alive on its own.
   */
  private arm(sessionId: string, state: WatchState): void {
    if (this.disposed || state.clients.size === 0) return;
    if (!state.transcriptPath) return;
    if (state.watcher || state.poller) return;

    const dir = path.dirname(state.transcriptPath);
    const basename = transcriptBasename(state.transcriptPath);
    try {
      const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        // The directory holds every session for this project slug, so the
        // basename filter is what keeps a sibling pane's writes from waking us.
        // A null filename (some platforms drop it) is treated as "maybe ours".
        if (filename && path.basename(String(filename)) !== basename) return;
        this.schedule(sessionId, state);
      });
      watcher.on('error', () => {
        // The directory vanished or the backend gave up. Fall back to polling
        // rather than going silent — a Chat surface with a dead watcher looks
        // exactly like an idle agent.
        this.disarmWatch(state);
        this.startPolling(sessionId, state);
      });
      state.watcher = watcher;
    } catch {
      // No watch backend for this path at all (some network home dirs, some
      // containerized mounts). Polling is the documented floor.
      this.startPolling(sessionId, state);
    }
  }

  /** ~3s size/mtime poll. Only ever runs while a client is subscribed. */
  private startPolling(sessionId: string, state: WatchState): void {
    if (this.disposed || state.poller || state.clients.size === 0) return;
    const poller = setInterval(() => {
      if (!state.transcriptPath) return;
      const stat = statTranscript(state.transcriptPath);
      if (!stat) return;
      if (stat.size === state.lastSize && stat.mtimeMs === state.lastMtimeMs) return;
      state.lastSize = stat.size;
      state.lastMtimeMs = stat.mtimeMs;
      this.schedule(sessionId, state);
    }, this.pollMs);
    poller.unref?.();
    state.poller = poller;
    this.deps.log?.('info', `[transcript] fs.watch unavailable for ${sessionId}; polling every ${this.pollMs}ms`);
  }

  /** Trailing debounce: an append is many small writes, and we want one read. */
  private schedule(sessionId: string, state: WatchState): void {
    this.scheduleIn(sessionId, state, this.debounceMs);
  }

  /** `schedule` with an explicit delay — the drain and backoff paths. */
  private scheduleIn(sessionId: string, state: WatchState, delayMs: number): void {
    if (this.disposed) return;
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => {
      state.debounce = null;
      this.readAndEmit(sessionId, state);
    }, delayMs);
    // Never hold the daemon open for a pending transcript read.
    state.debounce.unref?.();
  }

  private readAndEmit(sessionId: string, state: WatchState): void {
    if (this.disposed || state.clients.size === 0) return;
    if (!state.transcriptPath) {
      this.refreshPath(sessionId, state);
      if (!state.transcriptPath) return;
    }

    // A replaced file at the same path (an atomic rotation, or `/clear` landing
    // on the same slug) can be LARGER than the old cursor, in which case the
    // shrink test in readTranscriptDelta would not fire and we would read from
    // an offset that belongs to a conversation that no longer exists.
    const stat = statTranscript(state.transcriptPath);
    if (stat && state.lastIno >= 0 && stat.ino !== state.lastIno) {
      state.tailOffset = -1;
      state.forceReset = true;
    }
    if (stat) state.lastIno = stat.ino;
    // ...and an in-place truncate-and-rewrite past the old cursor changes
    // neither size-vs-cursor nor the inode. The cursor's own line boundary is
    // the check that catches it.
    if (state.tailOffset > 0 && !isLineBoundary(state.transcriptPath, state.tailOffset)) {
      state.tailOffset = -1;
      state.forceReset = true;
    }

    const first = state.tailOffset < 0;
    const previousTail = state.tailOffset;
    const budgeted = first
      ? this.readSnapshotForAppend(state)
      : this.readDeltaForAppend(state);
    if (!budgeted) return;

    if (budgeted.stalled) {
      // D1(b) — an oversized record with no newline yet. The cursor deliberately
      // did not move, so re-reading at the debounce interval would spin on every
      // nudge (and a mid-turn agent nudges often). Back off geometrically until
      // the writer finishes the record; any real append resets the counter.
      state.stallCount += 1;
      const delay = Math.min(this.debounceMs * 2 ** state.stallCount, MAX_STALL_BACKOFF_MS);
      this.scheduleIn(sessionId, state, delay);
      return;
    }
    state.stallCount = 0;

    const reset = state.forceReset || first || budgeted.reset;
    // "Nothing changed" is the common case (a watch fires on mtime too), and a
    // reset with no rows still has to reach the client — that is how it learns
    // to clear a conversation that was replaced.
    if (budgeted.events.length === 0 && !reset) {
      state.tailOffset = budgeted.cursor.tailOffset;
      this.maybeDrain(sessionId, state, budgeted.cursor, previousTail);
      return;
    }

    state.tailOffset = budgeted.cursor.tailOffset;
    state.forceReset = false;
    state.seq += 1;
    const data: TranscriptAppendData = {
      seq: state.seq,
      ...(reset ? { reset: true } : {}),
      events: budgeted.events,
      cursor: budgeted.cursor,
    };
    try {
      this.deps.emitAppend(sessionId, data, [...state.clients]);
    } catch (err) {
      this.deps.log?.('warn', `[transcript] append emit failed for ${sessionId}: ${String(err)}`);
    }
    this.maybeDrain(sessionId, state, budgeted.cursor, previousTail);
  }

  /**
   * D3 — a read fitted to the A3 byte budget stops short of EOF, and the next
   * fs event may be a whole turn away (a burst is written faster than the
   * debounce, and the hook nudge for the turn has already fired). Keep reading
   * until the cursor reaches the size we just observed.
   *
   * Two guards keep this from becoming a busy loop: the cursor must have
   * ADVANCED (a read that consumed nothing never reschedules — that case is
   * either the stall path or a no-op read), and the drain rides the same single
   * debounce timer, so an fs event arriving mid-drain simply replaces it.
   */
  private maybeDrain(
    sessionId: string,
    state: WatchState,
    cursor: TranscriptPage['cursor'],
    previousTail: number,
  ): void {
    if (this.disposed || state.clients.size === 0) return;
    if (cursor.tailOffset <= previousTail) return;
    if (cursor.tailOffset >= cursor.fileSize) return;
    this.scheduleIn(sessionId, state, DRAIN_DELAY_MS);
  }

  /** First read after subscribe / reset: a bounded tail, fitted to the budget. */
  private readSnapshotForAppend(
    state: WatchState,
  ): BudgetedRead | null {
    const page = this.fit((maxBytes) => {
      const p = readTranscriptPage(state.transcriptPath, { maxBytes });
      return p && { events: p.events, cursor: p.cursor, reset: false };
    });
    return page;
  }

  private readDeltaForAppend(
    state: WatchState,
  ): BudgetedRead | null {
    return this.fit((maxBytes) => {
      const delta = readTranscriptDelta(state.transcriptPath, state.tailOffset, maxBytes);
      return delta && {
        events: delta.events,
        cursor: delta.cursor,
        reset: delta.reset,
        ...(delta.stalled ? { stalled: true } : {}),
      };
    });
  }

  /**
   * A3 in one place: halve the read window until the serialized events fit the
   * budget. Reading less is always safe — the cursor reflects exactly what was
   * consumed, so the remainder arrives on the next nudge or watch event.
   */
  private fit<T extends { events: TurnEvent[] }>(read: (maxBytes: number) => T | null): T | null {
    let maxBytes = TAIL_BYTES;
    let result = read(maxBytes);
    while (result && maxBytes > MIN_READ_BYTES && !withinBudget(result.events)) {
      maxBytes = Math.max(MIN_READ_BYTES, Math.floor(maxBytes / 2));
      result = read(maxBytes);
    }
    if (result && !withinBudget(result.events)) {
      // A single entry over the budget. Advance the cursor with no rows rather
      // than risk main's control buffer; the row is lost, the stream is not.
      this.deps.log?.('warn', '[transcript] one entry exceeded the byte budget and was skipped');
      return { ...result, events: [] };
    }
    return result;
  }

  private disarmWatch(state: WatchState): void {
    if (state.watcher) {
      try {
        state.watcher.close();
      } catch {
        // Already closed.
      }
      state.watcher = null;
    }
  }

  private teardown(state: WatchState): void {
    if (state.debounce) {
      clearTimeout(state.debounce);
      state.debounce = null;
    }
    if (state.poller) {
      clearInterval(state.poller);
      state.poller = null;
    }
    this.disarmWatch(state);
    state.clients.clear();
  }
}

/** Serialized size of the rows we are about to ship, against the A3 budget. */
function withinBudget(events: TurnEvent[]): boolean {
  if (events.length === 0) return true;
  return Buffer.byteLength(JSON.stringify(events), 'utf8') <= BUDGET_BYTES;
}

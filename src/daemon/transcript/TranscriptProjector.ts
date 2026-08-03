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
import { checkTranscriptPath } from '../hooks/transcriptPathGuard';
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
  /**
   * The agent session id a `session_start` nudge invalidated. While it is set,
   * the binding it names must NOT be re-adopted — see `nudge`.
   */
  staleAgentSessionId: string | null;
}

export class TranscriptProjector {
  private readonly deps: TranscriptProjectorDeps;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly watches = new Map<string, WatchState>();
  /** Keys already logged by `warnOnce`. */
  private readonly warned = new Set<string>();
  private disposed = false;

  constructor(deps: TranscriptProjectorDeps) {
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  }

  /**
   * Is Chat View available for this pane, and if not, WHY. The reasons are
   * distinct because the UI says something different for each: an agent that
   * publishes no transcript is a permanent no (`not-claude`), while
   * `no-transcript-path` just means the first turn has not ended yet
   * (SessionStart fires before the `.jsonl` exists and carries no path — only
   * the first Stop fills it in). An absent binding splits into `no-hook` (no
   * agent detected — install the hooks) vs `stale-session` (an agent is running
   * but the binding has not landed yet).
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
   * Forward delta the phone reads after its snapshot. STATELESS by contract
   * (#782): unlike `subscribe()`, this never touches the shared `WatchState`,
   * because a late subscriber's force-reset would scramble every desktop Chat
   * View row that shares the session. The phone passes back the cursor it
   * received so a replaced/truncated transcript is answered with a reset
   * snapshot instead of bytes stitched from a different conversation.
   *
   * Reset checks mirror `readAndEmit` but use mtimeMs+fileSize instead of inode
   * — the wire cursor cannot carry inode without depending on FS-specific ino
   * stability (NFS etc.), and mtime changes on every rewrite/rotation the inode
   * check was added for (plan D1: an accepted, narrow detection regression).
   * `budgetDropped` is surfaced so the phone can render an "omitted" seam
   * instead of the silent hole `fit` left the push path with. */
  delta(
    sessionId: string,
    fromOffset: number,
    opts?: { cursorMtimeMs?: number; cursorFileSize?: number },
  ): { events: TurnEvent[]; cursor: TranscriptPage['cursor']; reset: boolean; budgetDropped?: boolean } | null {
    const resolved = this.resolvePath(sessionId);
    if (!resolved.ok) return null;
    const stat = statTranscript(resolved.transcriptPath);
    if (!stat) return null;

    let reset = false;
    if (opts?.cursorFileSize !== undefined && stat.size !== opts.cursorFileSize) reset = true;
    if (opts?.cursorMtimeMs !== undefined && stat.mtimeMs !== opts.cursorMtimeMs) reset = true;
    if (fromOffset > 0 && !isLineBoundary(resolved.transcriptPath, fromOffset)) reset = true;
    // A shrunk file (stat.size < from) is readTranscriptDelta's own reset path.

    if (reset) {
      const page = this.snapshot(sessionId);
      if (!page) return null;
      return { events: page.events, cursor: page.cursor, reset: true };
    }

    const { result, budgetDropped } = this.fitWithReceipt((maxBytes) => {
      const d = readTranscriptDelta(resolved.transcriptPath, fromOffset, maxBytes);
      return d && { events: d.events, cursor: d.cursor, ...(d.reset ? { reset: true } : {}) };
    });
    if (!result) return null;
    const r = result as { events: TurnEvent[]; cursor: TranscriptPage['cursor']; reset?: boolean };
    return {
      events: r.events,
      cursor: r.cursor,
      reset: r.reset === true,
      ...(budgetDropped ? { budgetDropped: true } : {}),
    };
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
        staleAgentSessionId: null,
      };
      this.watches.set(sessionId, state);
    }
    const joinedExistingWatch = !state.clients.has(clientId) && state.tailOffset >= 0;
    state.clients.add(clientId);
    this.arm(sessionId, state);
    // Push the current tail without waiting for a write. A client that only
    // subscribed (no separate snapshot call) still gets the conversation, and a
    // client that did call snapshot dedups on the stable event ids.
    //
    // A client joining an EXISTING watch needs more than that push: the shared
    // cursor is already at EOF, so the scheduled delta is empty and the new
    // client would start with nothing but future appends — the exact promise
    // the comment above makes would hold only for the first subscriber. Rewind
    // the cursor so the next emit is a reset SNAPSHOT (the forceReset +
    // tailOffset=-1 pair every other reset site here uses); it reaches every
    // client, and the established ones replace their rows with identical
    // content (stable event ids), which is the reset contract they implement.
    if (joinedExistingWatch) {
      state.forceReset = true;
      state.tailOffset = -1;
    }
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
   *
   * `agentSessionId` is the id the signal itself carried (the #12235-safe
   * transcript-derived one). Only `session_start` uses it, and only to tell a
   * genuinely NEW session apart from a resume of the standing one.
   */
  nudge(sessionId: string, kind: AgentSignalKind, agentSessionId?: string): void {
    const state = this.watches.get(sessionId);
    if (!state || this.disposed) return;
    if (kind === 'agent.session_start') {
      state.forceReset = true;
      state.tailOffset = -1;
      state.transcriptPath = '';
      // A SessionStart in a REUSED pane (`/clear`, or a fresh claude in the same
      // pane) fires before its `.jsonl` exists, so it carries no transcript path
      // and daemon/index.ts refuses the provisional capture — which leaves the
      // PREVIOUS session's binding standing. Clearing the path above and then
      // letting `refreshPath` re-read that same binding would re-adopt the old
      // transcript and force-reset the client with the finished conversation
      // presented as the new session's, until the first Stop of the new session
      // lands. So remember which binding was just invalidated and refuse to
      // re-adopt it; a genuine binding refresh (a different agent session, or
      // one whose transcript path finally arrived) releases the hold.
      //
      // A resume of the SAME agent session is the one case where the standing
      // binding is still the right one, and the signal's own agentSessionId is
      // what distinguishes it. A caller that supplies no id gets the old
      // behaviour — it has told us nothing to hold ON.
      const current = this.resolvePath(sessionId);
      const currentId = current.ok ? current.agentSessionId : '';
      state.staleAgentSessionId = agentSessionId && currentId && currentId !== agentSessionId
        ? currentId
        : null;
    }
    // A binding that only just arrived (or changed session) is picked up here.
    this.refreshPath(sessionId, state);
    this.schedule(sessionId, state);
  }

  /**
   * The pane's binding changed OUTSIDE the hook path — `TranscriptDiscovery`
   * found `<agentSessionId>.jsonl` before any `agent.stop` carried a path. Same
   * tail as `nudge`, minus the session_start bookkeeping: re-read the binding
   * and push whatever is there.
   *
   * Deliberately does NOT clear `staleAgentSessionId`: `refreshPath` is still
   * the one place that decides whether the standing binding is the held-stale
   * one, so a discovery that somehow re-produced the OLD id is refused exactly
   * as a hook refresh of it would be.
   *
   * A no-op when nobody is subscribed — availability itself is answered by
   * `status()`, which re-reads the binding on every call.
   */
  rebind(sessionId: string): void {
    const state = this.watches.get(sessionId);
    if (!state || this.disposed) return;
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

    const offset = Math.floor(req.srcOffset);
    // #782 — readTranscriptLineAt reads at an arbitrary offset with no boundary
    // check, so a stale or hostile offset would slice the MIDDLE of an unrelated
    // entry and serve it as this block's body. A ref minted by this projector is
    // always a line start, but the ref crossed the wire from a client; verify
    // before reading and refuse (empty body) when the offset is mid-line.
    if (offset > 0 && !isLineBoundary(resolved.transcriptPath, offset)) return null;
    const line = readTranscriptLineAt(resolved.transcriptPath, offset);
    if (line === null) return null;
    const parsed = parseTranscriptLineDetailed(line, offset);

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
  ):
    | { ok: true; transcriptPath: string; agentSessionId: string }
    | { ok: false; reason: string } {
    let binding;
    try {
      binding = this.deps.getResumeBinding(sessionId);
    } catch {
      return { ok: false, reason: this.absentBindingReason(sessionId) };
    }
    if (!binding) return { ok: false, reason: this.absentBindingReason(sessionId) };
    if (binding.agent !== SUPPORTED_AGENT) return { ok: false, reason: 'not-claude' };
    if (!binding.transcriptPath) return { ok: false, reason: 'no-transcript-path' };
    // The containment guard belongs HERE, at the single point every read goes
    // through, not only on the hook path that happens to be validated today.
    // The binding has several writers — the daemon's own hook ingest, the
    // `daemon.setResumeBinding` RPC (which main's hooks.signal fallback calls
    // with the raw payload path), main's resume spool, and the restored state
    // file — and any one of them landing an unchecked path would otherwise turn
    // the projector back into "open this file and render it as a conversation".
    // Refusal degrades exactly like a missing path: Chat View is unavailable.
    const check = checkTranscriptPath(
      binding.transcriptPath,
      binding.sessionId,
      this.deps.getSessionEnv?.(sessionId),
    );
    if (!check.ok) {
      this.warnOnce(
        `${sessionId} ${binding.transcriptPath}`,
        `[transcript] refused transcript path for ${sessionId}: ${check.reason}`,
      );
      return { ok: false, reason: 'unsafe-transcript-path' };
    }
    return {
      ok: true,
      transcriptPath: binding.transcriptPath,
      agentSessionId: binding.sessionId,
    };
  }

  /**
   * Split the old catch-all `no-binding` into the two cases the phone surfaces
   * differently: an agent IS running but no binding was captured (`stale-session`
   * — the session started before the hooks were armed, or its first Stop has not
   * landed yet, so the binding will appear) vs no agent detected at all (`no-hook`
   * — the wmux hooks are not installed here, and `wmux setup-hooks` is the fix).
   * Without a detector wired this degrades to `no-hook`, the pre-split behaviour.
   */
  private absentBindingReason(sessionId: string): string {
    return this.deps.getDetectedAgent?.(sessionId) ? 'stale-session' : 'no-hook';
  }

  /**
   * `resolvePath` runs on every read (watch events, polls, nudges), so a refused
   * path must not log once per beat. Keyed by pane+path and bounded, because the
   * daemon outlives every pane it ever ran.
   */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    if (this.warned.size >= 256) this.warned.clear();
    this.warned.add(key);
    this.deps.log?.('warn', message);
  }

  /**
   * Re-read the binding. A pane's transcript path appears late (first Stop) and
   * changes on `/clear` or a new session, and the watch has to follow it.
   */
  private refreshPath(sessionId: string, state: WatchState): void {
    const resolved = this.resolvePath(sessionId);
    if (resolved.ok && state.staleAgentSessionId) {
      // The binding a session_start invalidated is still the one on file — the
      // provisional capture for the NEW session was refused for having no
      // transcript path. Keep waiting rather than replay the old conversation.
      if (resolved.agentSessionId === state.staleAgentSessionId) return;
      state.staleAgentSessionId = null;
    }
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
   *
   * `fitWithReceipt` also reports `budgetDropped` when a single entry exceeds
   * the budget (cursor advances with no rows). The stateless delta path (#782)
   * surfaces that to the phone so it can render an "omitted" seam instead of a
   * silent hole; the push-path `fit` wrapper keeps its old null-or-T contract.
   */
  private fitWithReceipt<T extends { events: TurnEvent[] }>(
    read: (maxBytes: number) => T | null,
  ): { result: T | null; budgetDropped: boolean } {
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
      return { result: { ...result, events: [] }, budgetDropped: true };
    }
    return { result, budgetDropped: false };
  }

  private fit<T extends { events: TurnEvent[] }>(read: (maxBytes: number) => T | null): T | null {
    return this.fitWithReceipt(read).result;
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

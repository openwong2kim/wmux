// TranscriptDiscovery — find a session's transcript `.jsonl` by NAME, so Chat
// View becomes available as soon as the file exists instead of only after the
// first turn ends.
//
// The gap it closes (F9): `agent.session_start` proves claude is running in a
// pane and carries `signal.agentSessionId`, but Claude Code does not create the
// transcript yet and the payload has no `transcript_path` — only `agent.stop`
// carries one. So the pane holds a binding with no path, `resolvePath` answers
// `no-transcript-path`, and the operator has to send a message AND wait for the
// turn to finish before Chat opens.
//
// What is actually missing is only the DIRECTORY. The basename is already
// known: `transcriptPathGuard` validates exactly `${agentSessionId}.jsonl`, so
// the id the SessionStart carried IS the filename. Deriving the directory from
// the pane's cwd is deliberately NOT an option — `agentResume.ts` rejects the
// cwd→project-slug mapping as version-drift-prone, and that judgment stands.
// So this module does not derive anything: it LOOKS FOR THE FILE BY NAME under
// the Claude projects root and adopts it the moment it appears.
//
// Three properties, each load-bearing:
//   - BOUNDED. Only the projects root's immediate subdirectories are examined
//     (one `readdirSync` + one `statSync` per project dir, capped at
//     MAX_PROJECT_DIRS), never a recursive walk. Every search has a deadline
//     and stops on the first hit, on session end, or on a superseding session.
//   - WATCH, NOT SPIN. `fs.watch` on each root (directory-level, `persistent:
//     false`, unref'd debounce — the same shape TranscriptProjector uses) plus
//     a bounded poll, because a file created inside an EXISTING project
//     directory raises no event on the root itself.
//   - STILL VALIDATED. A discovered path goes through `checkTranscriptPath`
//     exactly like a hook-supplied one. This is a convenience for discovery,
//     never a bypass of the trust boundary — which is why a symlinked project
//     directory pointing out of the root is refused here even though the scan
//     happily walked into it.
//
// The hook stays authoritative: the caller cancels the search the moment a real
// `transcript_path` lands, and a discovered path is applied through the very
// same `applyResumeBinding` a hook path goes through.

import fs from 'node:fs';
import path from 'node:path';
import { checkTranscriptPath, claudeProjectRoots } from '../hooks/transcriptPathGuard';

/** Only Claude Code publishes a transcript wmux can discover today. */
export const DISCOVERABLE_AGENT = 'claude';

/**
 * Immediate subdirectories examined per root, per scan. A projects root holds
 * one directory per project the user has ever opened; a few hundred is already
 * unusual and a walk of an unbounded directory is not something the always-on
 * process should do once a second.
 */
export const MAX_PROJECT_DIRS = 512;

/** Matches collected per scan before the validation pass. */
const MAX_CANDIDATES = 8;

/** Poll interval — the floor for a file created inside an EXISTING project dir. */
const DEFAULT_POLL_MS = 1000;

/**
 * How long one search runs before giving up. The window this exists for is the
 * few seconds-to-minutes between `claude` starting and its first output; past
 * that the first `agent.stop` delivers the real path anyway, so a longer
 * deadline would only buy idle polling.
 */
const DEFAULT_DEADLINE_MS = 5 * 60_000;

/** fs.watch trailing debounce, mirroring TranscriptProjector's. */
const DEFAULT_DEBOUNCE_MS = 150;

export interface TranscriptDiscoveryDeps {
  /**
   * The pane's environment. Consulted for the SAME reason the projector
   * consults it: a workspace profile may set `CLAUDE_CONFIG_DIR`, which
   * relocates the projects root — so both the scan and the containment check
   * must be resolved from the PANE's env, not the daemon's.
   */
  getSessionEnv?: (sessionId: string) => Record<string, string> | undefined;
  /**
   * A validated transcript path appeared for `sessionId`. The caller persists
   * it through the normal resume-binding path; this module never writes state.
   */
  onFound: (found: {
    sessionId: string;
    agentSessionId: string;
    transcriptPath: string;
    cwd: string;
  }) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  pollMs?: number;
  deadlineMs?: number;
  debounceMs?: number;
}

interface SearchState {
  /** The id whose `<id>.jsonl` we are looking for. */
  agentSessionId: string;
  /** The pane cwd the SessionStart carried, replayed into the found binding. */
  cwd: string;
  watchers: fs.FSWatcher[];
  poller: ReturnType<typeof setInterval> | null;
  debounce: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null;
}

/**
 * Every `<agentSessionId>.jsonl` sitting one level under a Claude projects
 * root, newest-root-first. Pure apart from the filesystem read, and exported so
 * the boundedness (one level, capped fan-out) is directly testable.
 *
 * Symlinked entries ARE followed — a relocated project directory is a real
 * setup — because containment is judged afterwards by `checkTranscriptPath` on
 * the RESOLVED path, which is the only check that can decide it safely.
 */
export function scanForTranscript(
  agentSessionId: string,
  sessionEnv?: Record<string, string>,
): string[] {
  if (!agentSessionId) return [];
  // A traversal-shaped id would turn `path.join` into a directory escape before
  // the guard ever sees it. The guard would still refuse the result, but the
  // scan has no business generating the candidate in the first place.
  if (/[\\/\0]/.test(agentSessionId)) return [];
  const target = `${agentSessionId}.jsonl`;
  const found: string[] = [];
  for (const root of claudeProjectRoots(sessionEnv)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      // Root not created yet, or unreadable. The poll retries.
      continue;
    }
    let examined = 0;
    for (const entry of entries) {
      if (examined >= MAX_PROJECT_DIRS) break;
      // One level only: a project directory is never descended into beyond the
      // single candidate stat below.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      examined += 1;
      const candidate = path.join(root, entry.name, target);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      found.push(candidate);
      if (found.length >= MAX_CANDIDATES) return found;
    }
  }
  return found;
}

export class TranscriptDiscovery {
  private readonly deps: TranscriptDiscoveryDeps;
  private readonly pollMs: number;
  private readonly deadlineMs: number;
  private readonly debounceMs: number;
  private readonly searches = new Map<string, SearchState>();
  private readonly warned = new Set<string>();
  private disposed = false;

  constructor(deps: TranscriptDiscoveryDeps) {
    this.deps = deps;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Begin (or keep) a search for `<agentSessionId>.jsonl` on behalf of `sessionId`.
   *
   * Re-calling with the SAME id is a no-op, so a hook storm costs nothing. A
   * DIFFERENT id supersedes: that is a `/clear` or a fresh claude in the same
   * pane, and the previous session's file is no longer the one to adopt.
   */
  start(sessionId: string, agentSessionId: string, cwd: string): void {
    if (this.disposed || !sessionId || !agentSessionId) return;
    const existing = this.searches.get(sessionId);
    if (existing) {
      if (existing.agentSessionId === agentSessionId) return;
      this.stop(existing);
    }
    const state: SearchState = {
      agentSessionId,
      cwd,
      watchers: [],
      poller: null,
      debounce: null,
      deadline: null,
    };
    this.searches.set(sessionId, state);
    // Usually a miss (SessionStart fires before the file exists), but a resumed
    // or already-warm session can land immediately.
    if (this.tryAdopt(sessionId, state)) return;
    this.arm(sessionId, state);
  }

  /**
   * Abandon this pane's search. Called when the hook delivers a real
   * `transcript_path` (the hook is authoritative — there is nothing left to
   * discover) and when the pane dies.
   */
  cancel(sessionId: string): void {
    const state = this.searches.get(sessionId);
    if (!state) return;
    this.stop(state);
    this.searches.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.searches.values()) this.stop(state);
    this.searches.clear();
  }

  /** Live search count — observability / tests only. */
  get activeCount(): number {
    return this.searches.size;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Scan, validate, and (on success) finish the search. Returns true if done. */
  private tryAdopt(sessionId: string, state: SearchState): boolean {
    const env = this.deps.getSessionEnv?.(sessionId);
    for (const candidate of scanForTranscript(state.agentSessionId, env)) {
      const check = checkTranscriptPath(candidate, state.agentSessionId, env);
      if (!check.ok) {
        // A same-named file reachable through the root but resolving OUTSIDE it
        // (a symlinked project directory). Refused exactly as a forged hook path
        // is; keep scanning in case a legitimate one also exists.
        this.warnOnce(
          `${sessionId} ${candidate}`,
          `[transcript] refused discovered transcript for ${sessionId}: ${check.reason}`,
        );
        continue;
      }
      this.stop(state);
      this.searches.delete(sessionId);
      try {
        this.deps.onFound({
          sessionId,
          agentSessionId: state.agentSessionId,
          transcriptPath: candidate,
          cwd: state.cwd,
        });
      } catch (err) {
        this.deps.log?.('warn', `[transcript] discovery adopt failed for ${sessionId}: ${String(err)}`);
      }
      return true;
    }
    return false;
  }

  /**
   * Watch every root (a brand-new project directory shows up as an event there)
   * and poll (a file created inside an EXISTING project directory does not),
   * both under a hard deadline.
   */
  private arm(sessionId: string, state: SearchState): void {
    if (this.disposed) return;
    for (const root of claudeProjectRoots(this.deps.getSessionEnv?.(sessionId))) {
      try {
        const watcher = fs.watch(root, { persistent: false }, () => {
          this.schedule(sessionId, state);
        });
        // A vanished root just leaves the poll as the only trigger.
        watcher.on('error', () => { /* poll covers it */ });
        state.watchers.push(watcher);
      } catch {
        // No watch backend for this path; the poll is the documented floor.
      }
    }
    const poller = setInterval(() => {
      this.tryAdopt(sessionId, state);
    }, this.pollMs);
    poller.unref?.();
    state.poller = poller;

    const deadline = setTimeout(() => {
      // Give up quietly. The first `agent.stop` still delivers the real path,
      // so this costs the early availability, never the feature.
      this.cancel(sessionId);
    }, this.deadlineMs);
    deadline.unref?.();
    state.deadline = deadline;
  }

  /** Trailing debounce: a directory event usually arrives in small bursts. */
  private schedule(sessionId: string, state: SearchState): void {
    if (this.disposed) return;
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => {
      state.debounce = null;
      this.tryAdopt(sessionId, state);
    }, this.debounceMs);
    state.debounce.unref?.();
  }

  private stop(state: SearchState): void {
    for (const watcher of state.watchers) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
    state.watchers = [];
    if (state.poller) {
      clearInterval(state.poller);
      state.poller = null;
    }
    if (state.debounce) {
      clearTimeout(state.debounce);
      state.debounce = null;
    }
    if (state.deadline) {
      clearTimeout(state.deadline);
      state.deadline = null;
    }
  }

  /** A refused candidate is re-found on every poll; log it once. */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    if (this.warned.size >= 256) this.warned.clear();
    this.warned.add(key);
    this.deps.log?.('warn', message);
  }
}

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { hostLocation, toHostAccessiblePath } from '../../shared/sessionLocation';
import {
  hostCommandTarget,
  preparePaneCommand,
  type PaneCommandTarget,
} from '../git/paneCommand';

/**
 * X1 workspace-context sidebar — git branch tracking via fs.watch.
 *
 * Frozen contract (docs/internal/fable-window-schema-freeze.md §2):
 *   - `gitBranch`/`gitIsWorktree` come from an fs.watch on `<cwd>/.git/HEAD`
 *     (with linked-worktree `gitdir:` indirection). **No polling.**
 *   - Daemon broadcasts `{ type: 'context.git', sessionId,
 *     data: { branch: string | null, isWorktree: boolean } }`.
 *
 * Shared between the daemon (DaemonSessionManager wiring in daemon/index.ts)
 * and local-mode main (localContextWatch) exactly like cwdDetect — both PTY
 * ownership modes must emit the identical shape.
 */

export interface GitContext {
  branch: string | null;
  isWorktree: boolean;
}

interface ResolvedRepo {
  /** Directory whose HEAD file describes the checked-out branch. */
  gitDir: string;
  isWorktree: boolean;
}

/** Walk-up ceiling — a cwd nested deeper than this inside a repo is absurd. */
const MAX_WALK_UP = 24;
/** Re-read debounce after an fs.watch event (HEAD is rewritten via rename). */
const REREAD_DEBOUNCE_MS = 50;

/**
 * Resolve the git dir owning `startDir`, following the linked-worktree
 * `.git`-file indirection. Returns null when `startDir` is not inside a
 * repository (or anything on the way is unreadable — best-effort by design;
 * a permission error must never break PTY bookkeeping).
 */
export function resolveRepo(startDir: string): ResolvedRepo | null {
  let dir = startDir;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const dotGit = path.join(dir, '.git');
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) {
        return { gitDir: dotGit, isWorktree: false };
      }
      if (st.isFile()) {
        // Linked worktree: `.git` is a file `gitdir: <abs-or-rel path>`
        const content = fs.readFileSync(dotGit, 'utf8');
        const m = content.match(/^gitdir:\s*(.+)\s*$/m);
        if (m) {
          const target = path.resolve(dir, m[1].trim());
          // A submodule also uses the gitdir file (…/.git/modules/…); only
          // `…/worktrees/<name>` is a linked worktree. Either way the HEAD
          // at the target describes this checkout.
          const isWorktree = /[\\/]worktrees[\\/]/.test(target);
          return { gitDir: target, isWorktree };
        }
        return null;
      }
    } catch {
      // ENOENT and friends — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Parse a HEAD file's content into a branch label (short SHA when detached). */
export function parseHead(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const ref = trimmed.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (ref) return ref[1];
  // Detached HEAD — show the short commit id.
  if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.slice(0, 8);
  // Other refs (refs/tags/… via symbolic-ref) — last path segment.
  const otherRef = trimmed.match(/^ref:\s*refs\/(.+)$/);
  if (otherRef) return otherRef[1].split('/').pop() ?? null;
  return null;
}

/** Read the current branch out of a resolved repo. Best-effort. */
export function readGitContext(repo: ResolvedRepo): GitContext {
  try {
    const content = fs.readFileSync(path.join(repo.gitDir, 'HEAD'), 'utf8');
    return { branch: parseHead(content), isWorktree: repo.isWorktree };
  } catch {
    return { branch: null, isWorktree: repo.isWorktree };
  }
}

interface SessionWatch {
  cwd: string;
  repo: ResolvedRepo | null;
  watcher: fs.FSWatcher | null;
  debounce: NodeJS.Timeout | null;
  /** Last emitted value, JSON-encoded, to suppress no-op re-emits. */
  lastEmitted: string | null;
}

/**
 * Tracks the git branch per PTY session with fs.watch (no polling).
 *
 * Events:
 *  - 'git' → { sessionId: string, branch: string | null, isWorktree: boolean }
 *
 * `update(sessionId, cwd)` is called on session create and on every cwd
 * change (OSC 7 / prompt scrape). When the cwd is outside any repository the
 * watcher arms on the cwd itself so a later `git init` is picked up without
 * polling.
 */
export class GitContextWatcher extends EventEmitter {
  private sessions = new Map<string, SessionWatch>();

  update(sessionId: string, input: PaneCommandTarget | string): void {
    const target = typeof input === 'string'
      ? { ...hostCommandTarget(input), sessionId }
      : input;
    const cwd = this.watchPath(sessionId, target);
    if (!cwd) {
      const existing = this.sessions.get(sessionId);
      if (existing) this.teardown(existing);
      this.sessions.delete(sessionId);
      return;
    }
    const existing = this.sessions.get(sessionId);
    const repo = resolveRepo(cwd);

    if (existing && existing.cwd === cwd && existing.repo?.gitDir === repo?.gitDir) {
      return; // same checkout — keep the live watcher.
    }
    if (existing) this.teardown(existing);

    const watch: SessionWatch = {
      cwd,
      repo,
      watcher: null,
      debounce: null,
      lastEmitted: existing?.lastEmitted ?? null,
    };
    this.sessions.set(sessionId, watch);
    this.arm(sessionId, watch);
    this.readAndEmit(sessionId, watch);
  }

  private watchPath(sessionId: string, target: PaneCommandTarget): string | null {
    if (target.sessionId !== sessionId) return null;
    if (target.location.domain === 'host') return target.location.cwd;
    if (target.location.domain === 'msys') {
      const converted = toHostAccessiblePath(target.location, target.location.cwd);
      return converted.ok ? converted.path : null;
    }
    // Reuse command preparation as the active-session/distro gate. The watcher
    // itself uses the host-accessible UNC path and does not launch a subprocess.
    if (!preparePaneCommand(target, 'git', ['rev-parse', '--git-dir']).ok) return null;
    const location = target.location.distro
      ? target.location
      : { ...target.location, distro: target.activeContext?.distro };
    const converted = toHostAccessiblePath(location, location.cwd);
    return converted.ok ? converted.path : null;
  }

  remove(sessionId: string): void {
    const watch = this.sessions.get(sessionId);
    if (!watch) return;
    this.teardown(watch);
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    for (const watch of this.sessions.values()) this.teardown(watch);
    this.sessions.clear();
    this.removeAllListeners();
  }

  /** Current session count — observability/testing only. */
  get size(): number {
    return this.sessions.size;
  }

  private teardown(watch: SessionWatch): void {
    if (watch.debounce) { clearTimeout(watch.debounce); watch.debounce = null; }
    try { watch.watcher?.close(); } catch { /* already closed */ }
    watch.watcher = null;
  }

  /**
   * Arm the fs.watch. Inside a repo, watch the directory that holds HEAD —
   * git rewrites HEAD atomically via rename, and watching the file directly
   * loses tracking after the rename on some platforms. Outside a repo, watch
   * the cwd itself so a `.git` appearing (git init/clone into cwd) triggers a
   * re-resolve.
   */
  private arm(sessionId: string, watch: SessionWatch): void {
    const target = watch.repo ? watch.repo.gitDir : watch.cwd;
    try {
      watch.watcher = fs.watch(target, (_event, filename) => {
        if (watch.repo) {
          // Only HEAD transitions matter (HEAD.lock → HEAD rename included).
          if (filename && !/^HEAD(\.lock)?$/i.test(String(filename))) return;
        } else if (filename && String(filename) !== '.git') {
          return;
        }
        if (watch.debounce) clearTimeout(watch.debounce);
        watch.debounce = setTimeout(() => {
          watch.debounce = null;
          if (!watch.repo) {
            // `.git` may have just appeared — re-resolve and re-arm.
            // The watched host path is already resolved. Re-arm it without
            // reconstructing a WSL execution context.
            this.update(sessionId, { sessionId, location: hostLocation(watch.cwd) });
            return;
          }
          this.readAndEmit(sessionId, watch);
        }, REREAD_DEBOUNCE_MS);
        watch.debounce.unref?.();
      });
      watch.watcher.on('error', () => {
        // Directory vanished (worktree pruned, repo deleted) — drop the
        // watcher; the next cwd update re-arms.
        this.teardown(watch);
      });
    } catch {
      // Watch target unreadable — degrade to "value at update time" only.
      watch.watcher = null;
    }
  }

  private readAndEmit(sessionId: string, watch: SessionWatch): void {
    const ctx: GitContext = watch.repo
      ? readGitContext(watch.repo)
      : { branch: null, isWorktree: false };
    const encoded = JSON.stringify(ctx);
    if (encoded === watch.lastEmitted) return;
    watch.lastEmitted = encoded;
    this.emit('git', { sessionId, ...ctx });
  }
}

// ─── Per-worker private temp directory for fan-out tasks ────────────────────
//
// Every fan-out task pane gets its own owner-only scratch directory, exported
// as TMPDIR / TMP / TEMP, so N workers in N worktrees never share (or read)
// each other's temp files, and the setup hook writes to the same place.
//
// Creation and the env triple are adapted from MonoCode
// (hardbeat920/monocode@6bd432ca, src-tauri/src/control.rs —
// create_worker_scratch / configure_worker_scratch), MIT License,
// Copyright (c) 2026 Nick.
//
// Placement: directly under os.tmpdir(), never under the worktree or the task
// meta dir. Unix socket paths cap at ~104 bytes on macOS; a long TMPDIR breaks
// tools that put sockets there (tmux, ssh-agent, language servers).
//
// Windows: os.tmpdir() is the per-user %LOCALAPPDATA%\Temp, whose inherited ACL
// already limits it to the user; mkdtemp's mode is ignored there and no ACL is
// written here.
//
// Cleanup: a task workspace is closed through the renderer store, and the only
// lifecycle signal main receives is the workspace mirror push. The registry
// maps an owner key (the task workspace id, or `task:<id>` when the spawn
// failed and no workspace exists) → temp dir, and is persisted so a restart
// keeps it. Each push reconciles it. The fail-safe direction is to LEAK:
//   - nothing is removed within TEMPDIR_BOOT_GRACE_MS of the first push;
//   - an owner must stay absent for TEMPDIR_ABSENT_GRACE_MS (that clock is
//     in memory only, so a restart restarts it);
//   - right before removal the daemon is asked for its live sessions, and a
//     dir any non-dead session still has as TMPDIR/TMP/TEMP is kept — a
//     workspace can close while its session lives on, and a failed spawn can
//     still have created one. No answer from the daemon = keep;
//   - removal itself only touches a real directory named with our prefix that
//     is a direct child of the real os.tmpdir(), and runs off the push handler
//     on an async queue.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSONSync } from '../../daemon/util/atomicWrite';

/** Every temp-dir variable a POSIX tool, Node, Python or a Windows tool reads. */
export const FANOUT_TEMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

/** Basename prefix; removal refuses anything that does not carry it. */
export const FANOUT_TEMPDIR_PREFIX = 'wmux-task-';

export const FANOUT_TEMPDIR_REGISTRY_FILENAME = 'fanout-tempdirs.json';

/** How long an owner must stay absent before its dir is removed. */
export const TEMPDIR_ABSENT_GRACE_MS = 60_000;

/** No removal at all this soon after the first push (session restore). */
export const TEMPDIR_BOOT_GRACE_MS = 120_000;

/**
 * Create a fresh owner-only (0700) directory under `root` and return its real
 * path (on macOS os.tmpdir() sits behind the /var → /private/var link, and
 * tools that compare realpaths should see the same string the env carries).
 */
export function createWorkerTempDir(root: string = os.tmpdir()): string {
  const dir = fs.mkdtempSync(path.join(root, FANOUT_TEMPDIR_PREFIX));
  // mkdtemp already uses 0700 on POSIX; say so explicitly so a umask or a
  // platform difference can never widen it.
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return fs.realpathSync(dir);
}

/** The env entries that point a worker's temp files at `dir`. */
export function workerTempEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of FANOUT_TEMP_ENV_KEYS) env[key] = dir;
  return env;
}

/** Temp dirs that non-dead daemon sessions still point their temp vars at. */
export function liveTempDirsFromSessions(
  sessions: ReadonlyArray<{ state?: string; env?: Record<string, string> | null }>,
): Set<string> {
  const live = new Set<string>();
  for (const s of sessions) {
    if (s.state === 'dead' || !s.env) continue;
    for (const key of FANOUT_TEMP_ENV_KEYS) {
      const value = s.env[key];
      if (typeof value === 'string' && value.length > 0) live.add(value);
    }
  }
  return live;
}

/**
 * - 'removed' / 'gone' — the dir no longer exists;
 * - 'refused' — the path is not one of ours (wrong name, not a direct child of
 *   the real temp root, a symlink, not a directory) and is never touched;
 * - 'failed'  — ours, but the delete failed (EBUSY/EPERM…); retry later.
 */
export type RemoveOutcome = 'removed' | 'gone' | 'refused' | 'failed';

export async function removeWorkerTempDir(dir: string, root: string = os.tmpdir()): Promise<RemoveOutcome> {
  if (!path.isAbsolute(dir) || !path.basename(dir).startsWith(FANOUT_TEMPDIR_PREFIX)) return 'refused';
  const parent = path.dirname(dir);
  try {
    const [realParent, realRoot] = await Promise.all([fs.promises.realpath(parent), fs.promises.realpath(root)]);
    // The parent must BE the real temp root, spelled without any link in it:
    // a registry entry routed through a symlinked parent is refused.
    if (realParent !== realRoot || parent !== realParent) return 'refused';
    const st = await fs.promises.lstat(dir);
    if (!st.isDirectory()) return 'refused';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'refused';
  }
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return 'removed';
  } catch {
    return 'failed';
  }
}

interface TempDirEntry {
  dir: string;
  /** When the dir was registered (ms). */
  at: number;
}

type Registry = Record<string, TempDirEntry>;

/** A torn or unreadable registry reads as empty — the dirs leak, nothing is
 *  deleted on a guess. Unknown fields (an older build's `missingSince`) are
 *  dropped on load. */
function readRegistry(file: string): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Registry = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const v = value as Partial<TempDirEntry> | null;
      if (v && typeof v.dir === 'string' && typeof v.at === 'number') out[id] = { dir: v.dir, at: v.at };
    }
    return out;
  } catch {
    return {};
  }
}

export interface WorkerTempDirSweeperOptions {
  /** Registry file. Defaults to `<wmux dir>/fanout-tempdirs.json`. */
  file?: string;
  /** Temp root the dirs must be direct children of. */
  root?: string;
  /** Temp dirs live sessions use, or null when that cannot be answered. */
  liveTempDirs?: () => Promise<Set<string> | null>;
  now?: () => number;
}

/** Owns the registry: an in-memory copy (loaded once), written through. */
export class WorkerTempDirSweeper {
  private readonly file: string;
  private readonly root: string;
  private readonly now: () => number;
  private liveTempDirs: () => Promise<Set<string> | null>;
  private registry: Registry | null = null;
  private readonly missingSince = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private firstPushAt: number | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: WorkerTempDirSweeperOptions = {}) {
    this.file = opts.file ?? path.join(getWmuxDir(), FANOUT_TEMPDIR_REGISTRY_FILENAME);
    this.root = opts.root ?? os.tmpdir();
    this.now = opts.now ?? Date.now;
    this.liveTempDirs = opts.liveTempDirs ?? (async () => null);
  }

  setLiveTempDirs(fn: () => Promise<Set<string> | null>): void {
    this.liveTempDirs = fn;
  }

  private reg(): Registry {
    if (!this.registry) this.registry = readRegistry(this.file);
    return this.registry;
  }

  private persist(): void {
    try {
      atomicWriteJSONSync(this.file, this.reg());
    } catch (err) {
      console.warn(`[fanout] temp-dir registry write failed: ${String(err)}`);
    }
  }

  /** Record `owner` (a task workspace id, or `task:<taskId>`) as the dir's owner. */
  register(owner: string, dir: string): void {
    this.reg()[owner] = { dir, at: this.now() };
    this.missingSince.delete(owner);
    this.persist();
  }

  /**
   * Reconcile against the live workspace ids from one mirror push. Cheap and
   * synchronous (in-memory), so every push runs it and an owner that comes
   * back clears its clock at once; removals go to the async queue. Returns how
   * many removals were queued.
   */
  reconcile(liveWorkspaceIds: Iterable<string>): number {
    const alive = new Set<string>();
    for (const id of liveWorkspaceIds) if (typeof id === 'string' && id.length > 0) alive.add(id);
    // The renderer always keeps one workspace; an empty set is a bad frame.
    if (alive.size === 0) return 0;
    const now = this.now();
    if (this.firstPushAt === null) this.firstPushAt = now;
    const due: Array<[string, TempDirEntry]> = [];
    for (const [owner, entry] of Object.entries(this.reg())) {
      if (alive.has(owner)) {
        this.missingSince.delete(owner);
        continue;
      }
      // A push already in flight when the task spawned describes a tree without it.
      if (now - entry.at < TEMPDIR_ABSENT_GRACE_MS) continue;
      const since = this.missingSince.get(owner);
      if (since === undefined) {
        this.missingSince.set(owner, now);
        continue;
      }
      if (now - since < TEMPDIR_ABSENT_GRACE_MS) continue;
      if (now - this.firstPushAt < TEMPDIR_BOOT_GRACE_MS) continue;
      if (this.inFlight.has(owner)) continue;
      due.push([owner, entry]);
    }
    if (due.length === 0) return 0;
    for (const [owner] of due) this.inFlight.add(owner);
    this.queue = this.queue.then(() => this.removeDue(due)).catch((err) => {
      console.warn(`[fanout] temp-dir sweep failed: ${String(err)}`);
    });
    return due.length;
  }

  /** Test seam: resolves when every queued removal has settled. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async removeDue(due: Array<[string, TempDirEntry]>): Promise<void> {
    try {
      let live: Set<string> | null = null;
      try {
        live = await this.liveTempDirs();
      } catch {
        live = null;
      }
      if (!live) return; // cannot prove nothing uses them — keep all
      let changed = false;
      for (const [owner, entry] of due) {
        // Re-read: a register() for the same owner may have replaced it.
        if (this.reg()[owner] !== entry) continue;
        if (live.has(entry.dir)) continue;
        const outcome = await removeWorkerTempDir(entry.dir, this.root);
        if (outcome === 'failed') continue;
        delete this.reg()[owner];
        this.missingSince.delete(owner);
        changed = true;
      }
      if (changed) this.persist();
    } finally {
      for (const [owner] of due) this.inFlight.delete(owner);
    }
  }
}

let sweeper: WorkerTempDirSweeper | null = null;

/** The app-wide sweeper (the registry file is shared by every fan-out). */
export function getWorkerTempDirSweeper(): WorkerTempDirSweeper {
  if (!sweeper) sweeper = new WorkerTempDirSweeper();
  return sweeper;
}

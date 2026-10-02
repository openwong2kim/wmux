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
// Cleanup (wmux's own): a task workspace is closed through the renderer store,
// and the only lifecycle signal main receives is the workspace mirror push.
// The registry below maps task workspace id → temp dir on disk (it must survive
// a restart), and each push reconciles it. Fail-safe direction is to LEAK: a
// dir is removed only after its workspace has been absent from non-empty
// snapshots for TEMPDIR_ABSENT_GRACE_MS, so an early boot frame (before the
// session restore) or a renderer reload never deletes a live worker's files.

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

/** How long a task workspace must stay absent before its dir is removed. Two
 *  periodic mirror refreshes (30 s each) fit inside it. */
export const TEMPDIR_ABSENT_GRACE_MS = 60_000;

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

/**
 * Remove a worker temp dir. Refuses anything that is not a real directory named
 * with our prefix (never follows a symlink planted in its place). Best-effort:
 * returns false instead of throwing.
 */
export function removeWorkerTempDir(dir: string): boolean {
  if (!path.isAbsolute(dir) || !path.basename(dir).startsWith(FANOUT_TEMPDIR_PREFIX)) return false;
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    // Already gone is success; anything else is a leak we can live with.
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

interface TempDirEntry {
  dir: string;
  /** When the dir was registered (ms). */
  at: number;
  /** First reconcile that did not see the workspace (in-memory semantics, but
   *  persisted so a restart does not reset the clock). */
  missingSince?: number;
}

type Registry = Record<string, TempDirEntry>;

function registryPath(): string {
  return path.join(getWmuxDir(), FANOUT_TEMPDIR_REGISTRY_FILENAME);
}

/** A torn or unreadable registry reads as empty — the dirs leak, nothing is
 *  deleted on a guess. */
function readRegistry(file: string): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Registry = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const v = value as Partial<TempDirEntry> | null;
      if (v && typeof v.dir === 'string' && typeof v.at === 'number') {
        out[id] = { dir: v.dir, at: v.at, ...(typeof v.missingSince === 'number' ? { missingSince: v.missingSince } : {}) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Record which task workspace owns `dir`. */
export function registerWorkerTempDir(
  workspaceId: string,
  dir: string,
  now: number = Date.now(),
  file: string = registryPath(),
): void {
  const reg = readRegistry(file);
  reg[workspaceId] = { dir, at: now };
  atomicWriteJSONSync(file, reg);
}

/**
 * Reconcile the registry against the live workspace ids from a mirror push.
 * Removes the dirs of workspaces that have been gone for the grace window.
 * Returns how many dirs were removed.
 */
export function reconcileWorkerTempDirs(
  liveWorkspaceIds: Iterable<string>,
  now: number = Date.now(),
  file: string = registryPath(),
): number {
  const alive = new Set<string>();
  for (const id of liveWorkspaceIds) if (typeof id === 'string' && id.length > 0) alive.add(id);
  // The renderer always keeps one workspace; an empty set is a bad frame.
  if (alive.size === 0) return 0;
  if (!fs.existsSync(file)) return 0;
  const reg = readRegistry(file);
  let changed = false;
  let removed = 0;
  for (const [id, entry] of Object.entries(reg)) {
    if (alive.has(id)) {
      if (entry.missingSince !== undefined) {
        delete entry.missingSince;
        changed = true;
      }
      continue;
    }
    // A push already in flight when the task spawned describes a tree without it.
    if (now - entry.at < TEMPDIR_ABSENT_GRACE_MS) continue;
    if (entry.missingSince === undefined) {
      entry.missingSince = now;
      changed = true;
      continue;
    }
    if (now - entry.missingSince < TEMPDIR_ABSENT_GRACE_MS) continue;
    if (removeWorkerTempDir(entry.dir)) removed++;
    delete reg[id];
    changed = true;
  }
  if (changed) atomicWriteJSONSync(file, reg);
  return removed;
}

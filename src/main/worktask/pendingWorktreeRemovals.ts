// ─── Task worktree removals that have not finished (#2388) ─────────────────
//
// A task close records its worktree here before anything is stopped or
// removed, and forgets it once the folder is gone. When `git worktree remove`
// drops the worktree's record but leaves part of the folder (a file still
// held open on Windows) and the leftover could not be finished at once, the
// record is what is left: the folder is no longer a worktree, so the task's
// next close could not tell which repository it came from and would close the
// task around it. With the record, that close (and the sweep at start,
// TaskWorktreeManager.finishPendingRemoval) finishes the removal under the
// same checks as the first attempt. Persisted as
// `<wmuxDir>/worktask/pending-removals.json`.

import fs from 'node:fs';
import path from 'node:path';
import { createFilePersister, readVersionedFile, type FilePersister } from '../factory/versionedFile';

export const PENDING_REMOVALS_FILENAME = 'pending-removals.json';
export const PENDING_REMOVALS_VERSION = 1 as const;
/** Records kept (oldest dropped first). */
export const PENDING_REMOVALS_MAX = 500;

export interface PendingWorktreeRemoval {
  /** The worktree folder, as the removal named it (absolute). */
  path: string;
  repoRoot: string;
  repoHash: string;
  /** The commit the worktree had checked out when it was found clean: what a
   *  leftover folder is compared with before it is deleted. */
  head?: string;
  at: number;
}

function isRecord(v: unknown): v is PendingWorktreeRemoval {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.path === 'string' && path.isAbsolute(r.path) && typeof r.repoRoot === 'string' && typeof r.repoHash === 'string'
    && (r.head === undefined || (typeof r.head === 'string' && /^[0-9a-f]{40,64}$/.test(r.head)))
    && typeof r.at === 'number';
}

/** The key of a folder: resolved, compared without case on Windows and macOS. */
export function pendingRemovalKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

export interface PendingRemovalStore {
  get(worktreePath: string): PendingWorktreeRemoval | null;
  all(): PendingWorktreeRemoval[];
  put(rec: PendingWorktreeRemoval): Promise<void>;
  delete(worktreePath: string): Promise<void>;
}

export class PendingWorktreeRemovals implements PendingRemovalStore {
  private readonly records = new Map<string, PendingWorktreeRemoval>();
  private readonly persister: FilePersister;

  constructor(private readonly file: string) {
    this.persister = createFilePersister(file, () => ({ version: PENDING_REMOVALS_VERSION, removals: [...this.records.values()] }));
  }

  static at(wmuxDir: string): PendingWorktreeRemovals {
    return new PendingWorktreeRemovals(path.join(wmuxDir, 'worktask', PENDING_REMOVALS_FILENAME));
  }

  /** Read the file (missing → empty). A file of another version throws. */
  load(): void {
    this.records.clear();
    const raw = readVersionedFile(this.file, PENDING_REMOVALS_VERSION);
    const list = raw && Array.isArray(raw.removals) ? raw.removals : [];
    for (const r of list) if (isRecord(r)) this.records.set(pendingRemovalKey(r.path), r);
  }

  get(worktreePath: string): PendingWorktreeRemoval | null {
    const r = this.records.get(pendingRemovalKey(worktreePath));
    return r ? { ...r } : null;
  }

  all(): PendingWorktreeRemoval[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  put(rec: PendingWorktreeRemoval): Promise<void> {
    const key = pendingRemovalKey(rec.path);
    this.records.delete(key);
    this.records.set(key, { ...rec });
    for (const k of this.records.keys()) {
      if (this.records.size <= PENDING_REMOVALS_MAX) break;
      if (k !== key) this.records.delete(k);
    }
    return this.write();
  }

  delete(worktreePath: string): Promise<void> {
    if (!this.records.delete(pendingRemovalKey(worktreePath))) return Promise.resolve();
    return this.write();
  }

  private async write(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await this.persister.schedule();
  }
}

/** What the sweep at start needs (TaskWorktreeManager and the daemon). */
export interface PendingSweepPorts {
  /** The folders whose removal is recorded as pending. */
  paths(): string[];
  /** The daemon's sessions, and whether its start-up recovery is done; null
   *  when the daemon cannot be asked. */
  sessions(): Promise<{ sessions: Array<{ id: string; spawnCwd?: string; cwd?: string; wslTarget?: { distribution?: unknown } }>; recoveryDone: boolean } | null>;
  /** The ids of `sessions` started in `folder` or below it, or working
   *  there now (their current directory). */
  startedIn(folder: string, sessions: Array<{ id: string; spawnCwd?: string; cwd?: string; wslTarget?: { distribution?: unknown } }>): Promise<string[]>;
  /** TaskWorktreeManager.finishPendingRemoval, with nothing to stop. */
  finish(folder: string): Promise<{ ok: boolean; error?: string } | null>;
  log?(message: string): void;
}

/**
 * The sweep at start (#2388): finish each removal a close left part way.
 * Only once the daemon has recovered its sessions, never for a folder a
 * session was started in or works in now (the task's next close stops it
 * first), and only through finishPendingRemoval's checks (the second layer);
 * a folder any check cannot prove keeps its record. One log line per
 * decision. Returns false when it should run again later (the daemon is not
 * ready).
 */
export async function sweepPendingRemovals(ports: PendingSweepPorts): Promise<boolean> {
  const log = (m: string): void => ports.log?.(`[worktask] pending removal sweep: ${m}`);
  const paths = ports.paths();
  if (paths.length === 0) return true;
  const listed = await ports.sessions().catch(() => null);
  if (!listed || !listed.recoveryDone) {
    log(`${paths.length} folder(s) wait: ${listed ? 'the daemon is still recovering its sessions' : 'the daemon cannot be asked'}`);
    return false;
  }
  for (const folder of paths) {
    const inUse = await ports.startedIn(folder, listed.sessions);
    if (inUse.length > 0) {
      log(`kept ${folder}: ${inUse.length} session(s) were started or work in it`);
      continue;
    }
    const r = await ports.finish(folder).catch((err: unknown) => ({ ok: false, error: String(err) }));
    if (r === null) log(`${folder}: no pending removal is recorded any more`);
    else if (r.ok) log(`removed ${folder}`);
    else log(`kept ${folder}: ${r.error ?? 'unknown'}`);
  }
  return true;
}

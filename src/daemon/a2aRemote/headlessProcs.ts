import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parsePsIdentityRows, type PosixProcRow } from '../automation/verifiedTreeKill';
import type { HeadlessSurvivor } from './headlessStartStore';

/**
 * When a headless agent's session is ended and its process tree could not
 * be proven gone (the tree kill was refused, or it reported survivors), the
 * start is held: its worktree is not removed and it is not counted as ended.
 * What holds it:
 *   - the processes of the agent's tree as they were right before the kill
 *     (`snapshotTree`), each tracked by pid AND start time, so a reused pid
 *     neither holds forever nor releases early;
 *   - any process whose current folder is in the worktree (an orphan that was
 *     never in the snapshot).
 * The hold is released only when both are known to be clear. Whatever cannot
 * be read keeps it: the process table, a tracked pid's row (one whose start
 * time cannot be compared counts as the same process), a missing snapshot.
 * Without /proc (macOS) only the snapshot can be checked, and its being gone
 * releases the hold.
 */

export interface HeadlessProcDeps {
  /** The process table (pid, ppid, stat, lstart); throws when it cannot be read. */
  listProcesses(): Promise<PosixProcRow[]>;
  /** Where the per-process folders are (`/proc`). */
  procRoot: string;
}

export const defaultHeadlessProcDeps: HeadlessProcDeps = {
  listProcesses: () =>
    new Promise((resolve, reject) => {
      execFile('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, output) => {
        if (error) reject(error);
        else resolve(parsePsIdentityRows(output ?? ''));
      });
    }),
  procRoot: '/proc',
};

const TREE_MAX = 256;

/**
 * The live processes of the tree under `rootPid` (itself included), each with
 * its start time; null when the table cannot be read or the root is gone.
 */
export async function snapshotTree(rootPid: number, deps: HeadlessProcDeps = defaultHeadlessProcDeps): Promise<HeadlessSurvivor[] | null> {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return null;
  let rows: PosixProcRow[];
  try {
    rows = await deps.listProcesses();
  } catch {
    return null;
  }
  const live = rows.filter((r) => !r.stat.startsWith('Z'));
  if (!live.some((r) => r.pid === rootPid)) return null;
  const out: HeadlessSurvivor[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0 && out.length < TREE_MAX) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = live.find((r) => r.pid === pid);
    if (!row) continue;
    out.push({ pid, startTime: row.start, reason: 'in the agent process tree when it was ended' });
    for (const child of live) if (child.ppid === pid) queue.push(child.pid);
  }
  return out;
}

/**
 * Of the processes holding a start, those that keep holding it. Empty only
 * when every tracked process is gone (or its pid now names another process)
 * and nothing works in `worktreePath`; otherwise every entry stays (a hold is
 * released whole or not at all).
 */
export async function stillHeld(
  survivors: readonly HeadlessSurvivor[],
  worktreePath: string | undefined,
  deps: HeadlessProcDeps = defaultHeadlessProcDeps,
): Promise<HeadlessSurvivor[]> {
  if (survivors.length === 0) return [];
  const all = [...survivors];
  // No snapshot of the tree (the table could not be read at the kill): it cannot be told, the hold stays.
  if (survivors.some((s) => s.unverified || s.startTime === undefined)) return all;
  const tracked = survivors;
  let rows: PosixProcRow[];
  try {
    rows = await deps.listProcesses();
  } catch {
    return all;
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const anyAlive = tracked.some((s) => {
    const row = byPid.get(s.pid);
    if (!row || row.stat.startsWith('Z')) return false;
    // Unreadable start time: it may be the same process.
    return !row.start || row.start === s.startTime;
  });
  if (anyAlive || !worktreePath) return all;
  // The whole tree as it was before the kill is gone. Where /proc can be read,
  // nothing may work in the worktree either (an orphan started after the
  // snapshot); without /proc (macOS) the snapshot is what there is, so its
  // being gone releases the hold rather than holding it for good.
  const busy = await processesWorkingIn(worktreePath, deps.procRoot);
  return busy === true ? all : [];
}

/**
 * Whether any process of this user works inside `dir` (its current folder is
 * `dir` or below it), read from /proc. Null where it cannot be told (no /proc,
 * as on macOS). A process whose folder cannot be read is another user's (the
 * agent runs as the daemon's user) and is skipped; the agent's own tree is
 * tracked by pid and start time instead (`stillHeld`).
 */
export async function processesWorkingIn(dir: string, procRoot = '/proc'): Promise<boolean | null> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(procRoot);
  } catch {
    return null;
  }
  const inside = (p: string): boolean => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let cwd: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- one link at a time keeps the scan cheap
      cwd = await fs.promises.readlink(path.join(procRoot, name, 'cwd'));
    } catch {
      continue;
    }
    if (inside(cwd.replace(/ \(deleted\)$/, ''))) return true;
  }
  return false;
}

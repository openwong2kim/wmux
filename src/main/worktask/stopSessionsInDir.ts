// Stop the panes that were started inside a task worktree before it is removed.
//
// A shell or agent running in the worktree holds file handles, and on Windows
// `git worktree remove` then deregisters the worktree but leaves part of the
// folder behind. Task panes live in the daemon, so the sessions are found and
// destroyed there, and the removal waits until their processes are gone.
//
// Only `spawnCwd` decides: `cwd` comes from OSC 7, i.e. whatever a program in
// the pane printed, and must never pick what gets killed (daemon/types.ts).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeWorktreePath } from '../../shared/workTask';
import { wslPathToHost } from '../../mcp/wslPaths';

export interface SessionsInDirPort {
  listSessions(): Promise<Array<{ id: string; pid?: number; spawnCwd?: string; wslTarget?: { distribution?: unknown } }>>;
  destroySession(id: string): Promise<void>;
  /** Whether `pid` is still running. */
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  /** Canonical path (symlinks resolved) when it exists; the resolved input otherwise. */
  realpath?(p: string): string;
  log?(message: string): void;
  platform?: NodeJS.Platform;
}

const EXIT_WAIT_MS = 5000;
const EXIT_POLL_MS = 100;

export class PanesStillRunningError extends Error {
  constructor(readonly pids: number[]) {
    super(`${pids.length} process(es) started in the worktree are still running`);
    this.name = 'PanesStillRunningError';
  }
}

function defaultRealpath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isInside(dir: string, root: string, port: Pick<SessionsInDirPort, 'realpath'>, platform: NodeJS.Platform): boolean {
  const real = port.realpath ?? defaultRealpath;
  const d = normalizeWorktreePath(real(dir), platform);
  const r = normalizeWorktreePath(real(root), platform);
  return d === r || d.startsWith(r + '/');
}

/**
 * A session's directory as this process names it. A WSL pane records the
 * Linux path it was started in (`/mnt/c/…`, resolveWslCwd), which never
 * matches the Windows folder it is (#2254); on win32 no Windows path starts
 * with a single `/`, so such a path is translated. One that cannot be (a
 * distro path with no distro known) comes back as given.
 */
export function sessionHostDir(dir: string, session: { wslTarget?: { distribution?: unknown } }, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || !dir.startsWith('/') || dir.startsWith('//')) return dir;
  const distro = typeof session.wslTarget?.distribution === 'string' ? session.wslTarget.distribution : undefined;
  const host = wslPathToHost(dir, distro);
  return 'path' in host ? host.path : dir;
}

/** Ids of the sessions started in any of `dirs` (or below them). */
export async function sessionsStartedIn(dirs: readonly string[], port: Pick<SessionsInDirPort, 'listSessions' | 'realpath' | 'platform'>): Promise<string[]> {
  const platform = port.platform ?? process.platform;
  const sessions = await port.listSessions();
  return sessions
    .filter((s) => typeof s.spawnCwd === 'string' && s.spawnCwd.length > 0
      && dirs.some((d) => isInside(sessionHostDir(s.spawnCwd as string, s, platform), d, port, platform)))
    .map((s) => s.id);
}

/**
 * Destroy every daemon session that was started in `dir` or below it, then wait
 * (up to 5 s) for their processes to exit. Returns the ids it destroyed. Throws
 * when a session cannot be destroyed or a process is still running, so the
 * caller keeps the worktree instead of removing it half-way.
 */
export async function stopSessionsInDir(dir: string, port: SessionsInDirPort): Promise<string[]> {
  const platform = port.platform ?? process.platform;
  const sessions = await port.listSessions();
  const inside = sessions.filter((s) => typeof s.spawnCwd === 'string' && s.spawnCwd.length > 0
    && isInside(sessionHostDir(s.spawnCwd, s, platform), dir, port, platform));
  const unknown = sessions.filter((s) => !s.spawnCwd).length;
  if (unknown > 0) port.log?.(`[worktask] ${unknown} session(s) have no spawn directory recorded; left running`);

  for (const s of inside) await port.destroySession(s.id);

  const pids = inside.map((s) => s.pid).filter((p): p is number => typeof p === 'number' && p > 0);
  for (let waited = 0; waited < EXIT_WAIT_MS && pids.some((p) => port.isAlive(p)); waited += EXIT_POLL_MS) {
    await port.sleep(EXIT_POLL_MS);
  }
  const survivors = pids.filter((p) => port.isAlive(p));
  if (survivors.length > 0) throw new PanesStillRunningError(survivors);
  return inside.map((s) => s.id);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

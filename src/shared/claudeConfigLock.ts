// The lock Claude Code saves its config file under, taken the way it takes it
// (read from Claude Code 2.1.316, whose bundled proper-lockfile does this): a
// directory at `<realpath of the file>.lock`, made with mkdir, held while it
// stands and let go by removing it. A lock untouched for longer than the stale
// time was left by a holder that died, and is taken over.
//
// Adapted from yetone/magpie@c7ebb6f8d (internal/claudelock/claudelock.go), MIT

import * as fs from 'fs';
import * as path from 'path';
import { resolveWriteTarget } from './settingsFile';

const CONFIG_STALE_MS = 10_000;
/** Long enough to outlast a save, which takes milliseconds. The protocol can
 *  drift between Claude Code releases and callers include the main process, so
 *  this stays short: past it the edit is refused, not forced. */
const WAIT_MS = 3_000;
const POLL_MS = 100;

/** Another holder kept the lock past the wait. The edit was not made. */
export class ClaudeConfigLockedError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`Claude Code is saving its config (${lockPath} is held). Nothing was changed; try again in a moment.`);
    this.name = 'ClaudeConfigLockedError';
    this.lockPath = lockPath;
  }
}

export interface ClaudeConfigLockDeps {
  now?: () => number;
  sleep?: (ms: number) => void;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rmdir, not a recursive remove: a lock is an empty directory, and anything
 *  else standing at this path is not ours to delete. */
function removeIfStale(lockPath: string, now: number): boolean {
  try {
    if (now - fs.statSync(lockPath).mtimeMs <= CONFIG_STALE_MS) return false;
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** A directory being removed refuses a new mkdir on Windows for a moment. */
function isTransient(code: string | undefined): boolean {
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
}

/**
 * Run a read-modify-write of `filePath` while holding Claude Code's lock on it.
 * Throws {@link ClaudeConfigLockedError} without calling `edit` when a live
 * holder keeps the lock past the wait. A file whose folder does not exist yet
 * has no lock to wait for.
 *
 * Unlike a long-lived holder this never refreshes the lock's mtime: `edit` is
 * synchronous, runs for milliseconds and is far inside the stale time.
 */
export function withClaudeConfigLock<T>(filePath: string, edit: () => T, deps: ClaudeConfigLockDeps = {}): T {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepSync;
  const target = resolveWriteTarget(filePath);
  try {
    if (!fs.statSync(path.dirname(target)).isDirectory()) return edit();
  } catch {
    return edit();
  }

  const lockPath = `${target}.lock`;
  const deadline = now() + WAIT_MS;
  for (;;) {
    let failure: NodeJS.ErrnoException;
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (err) {
      failure = err as NodeJS.ErrnoException;
    }
    const held = failure.code === 'EEXIST';
    if (!held && !isTransient(failure.code)) throw failure;
    if (held && removeIfStale(lockPath, now())) continue;
    if (now() >= deadline) throw held ? new ClaudeConfigLockedError(lockPath) : failure;
    sleep(POLL_MS);
  }
  try {
    return edit();
  } finally {
    try {
      fs.rmdirSync(lockPath);
    } catch {
      /* already taken over or gone; it reads as stale to the next holder */
    }
  }
}

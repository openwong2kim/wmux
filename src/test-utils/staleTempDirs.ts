import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Sweep the temp dirs a killed test run left behind for one mkdtemp prefix.
 *
 * A suite removes its own temp dir in afterAll, which never runs when the
 * worker or the whole run is killed (a cancelled job, SIGKILL, a timeout
 * teardown). Those dirs then stay in a long-lived TMPDIR until something
 * removes them; this is that something, run before the next dir of the same
 * prefix is made. It removes a dir only when all of these hold:
 *
 * - the temp dir's realpath is a dir no other user can rename entries in (not
 *   world-writable, or sticky);
 * - the dir's name is exactly `prefix` plus mkdtemp's six characters, directly
 *   in that realpath (no other prefix, no nested path);
 * - lstat says it is a real directory, not a link, its realpath is that same
 *   path, and, outside Windows, it is owned by this user and closed to others
 *   (mode 0700, as mkdtemp makes it);
 * - it and everything in it (links not followed) are older than `maxAgeMs`;
 * - nothing uses it (`inUse`; by default no live Chrome holds its lock);
 * - a second lstat right before the removal sees the same dir (dev, ino).
 *
 * The removal does not follow links inside the dir (fs.rmSync unlinks a link
 * rather than descending into it). Anything it cannot check or remove is kept.
 */

/** Leftovers older than this are swept: far longer than any test run. */
export const STALE_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000;

/** A dir with more entries than this is kept rather than walked in full. */
const MAX_WALKED_ENTRIES = 50_000;

const MKDTEMP_SUFFIX = '[A-Za-z0-9]{6}';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ownUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/** Not world-writable, or sticky: no other user can swap an entry in it. */
function rootClosed(st: fs.Stats, uid: number | null): boolean {
  return st.isDirectory() && (uid === null || (st.mode & 0o002) === 0 || (st.mode & 0o1000) !== 0);
}

/** Owned by this user and closed to everyone else; not checked on Windows. */
function ownedAndClosed(st: fs.Stats, uid: number | null): boolean {
  return uid === null || (st.uid === uid && (st.mode & 0o077) === 0);
}

/** The newest mtime in the tree at `dir`, links not followed; null when it cannot tell. */
function newestMtimeMs(dir: string): number | null {
  try {
    let newest = 0;
    let walked = 0;
    const stack = [dir];
    while (stack.length > 0) {
      const p = stack.pop() as string;
      if (++walked > MAX_WALKED_ENTRIES) return null;
      const st = fs.lstatSync(p);
      newest = Math.max(newest, st.mtimeMs);
      if (st.isDirectory()) for (const name of fs.readdirSync(p)) stack.push(path.join(p, name));
    }
    return newest;
  } catch {
    return null;
  }
}

/** Alive unless the kernel says no such process; any other answer counts as alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Whether a Chrome may be running on the profile at `dir`. Chrome keeps a lock
 * in its user-data-dir while it runs: outside Windows a `SingletonLock` link
 * whose target is `<host>-<pid>`, on Windows a `lockfile`. Only a lock naming
 * this host and a pid that is gone counts as free; a live pid, another host, a
 * target of any other shape, a lock that cannot be read, or a Windows lockfile
 * counts as in use.
 */
export function chromeHoldsProfile(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return fs.existsSync(path.join(dir, 'lockfile'));
  const lock = path.join(dir, 'SingletonLock');
  let target: string;
  try {
    target = fs.readlinkSync(lock);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const dash = target.lastIndexOf('-');
  const host = target.slice(0, dash);
  const pidText = target.slice(dash + 1);
  if (dash <= 0 || host !== os.hostname() || !/^[1-9][0-9]{0,9}$/.test(pidText)) return true;
  const pid = Number(pidText);
  return pid > 0x7fffffff || pidAlive(pid);
}

export interface SweepOptions {
  /** The temp dir to sweep; os.tmpdir() by default. */
  root?: string;
  now?: number;
  maxAgeMs?: number;
  /** Whether something still uses the dir; such a dir is kept. */
  inUse?: (dir: string) => boolean;
}

/** Remove the stale dirs of `prefix`; returns the paths removed. Never throws. */
export function sweepStaleTempDirs(prefix: string, opts: SweepOptions = {}): string[] {
  const removed: string[] = [];
  if (!/^[A-Za-z0-9._-]+-$/.test(prefix)) return removed;
  const uid = ownUid();
  let root: string;
  try {
    root = fs.realpathSync(opts.root ?? os.tmpdir());
    if (!rootClosed(fs.statSync(root), uid)) return removed;
  } catch {
    return removed;
  }
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? STALE_TEMP_DIR_AGE_MS;
  const inUse = opts.inUse ?? ((dir: string) => chromeHoldsProfile(dir));
  const pattern = new RegExp(`^${escape(prefix)}${MKDTEMP_SUFFIX}$`);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const dir = path.join(root, name);
    try {
      const first = fs.lstatSync(dir);
      if (!first.isDirectory() || !ownedAndClosed(first, uid)) continue;
      if (fs.realpathSync(dir) !== dir) continue;
      const newest = newestMtimeMs(dir);
      if (newest === null || now - newest < maxAgeMs) continue;
      if (inUse(dir)) continue;
      const again = fs.lstatSync(dir);
      if (!again.isDirectory() || again.dev !== first.dev || again.ino !== first.ino) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Kept: whatever could not be checked or removed stays for a later sweep.
    }
  }
  return removed;
}

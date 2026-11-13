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
 * - its name is exactly `prefix` plus mkdtemp's six characters, directly in
 *   the temp dir (no other prefix, no nested path);
 * - lstat says it is a real directory, not a link, and its realpath is that
 *   same path inside the temp dir's realpath;
 * - the dir and every entry directly in it are older than `maxAgeMs`;
 * - no live Chrome holds it (`inUse`).
 *
 * The removal does not follow links inside the dir (fs.rmSync unlinks a link
 * rather than descending into it). Anything it cannot check or remove is kept.
 */

/** Leftovers older than this are swept: far longer than any test run. */
export const STALE_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000;

const MKDTEMP_SUFFIX = '[A-Za-z0-9]{6}';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function newestMtimeMs(dir: string): number | null {
  try {
    let newest = fs.lstatSync(dir).mtimeMs;
    for (const name of fs.readdirSync(dir)) {
      newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs);
    }
    return newest;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a Chrome may be running on the profile at `dir`. Chrome keeps a lock
 * in its user-data-dir while it runs: outside Windows a `SingletonLock` link
 * whose target is `<host>-<pid>`, on Windows a `lockfile`. A lock whose pid is
 * alive, a Windows lockfile, or a lock that cannot be read counts as in use.
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
  const pid = Number(target.slice(target.lastIndexOf('-') + 1));
  return !Number.isSafeInteger(pid) || pid <= 0 || pidAlive(pid);
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
  let root: string;
  try {
    root = fs.realpathSync(opts.root ?? os.tmpdir());
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
      if (!fs.lstatSync(dir).isDirectory()) continue;
      if (fs.realpathSync(dir) !== dir) continue;
      const newest = newestMtimeMs(dir);
      if (newest === null || now - newest < maxAgeMs) continue;
      if (inUse(dir)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Kept: whatever could not be checked or removed stays for a later sweep.
    }
  }
  return removed;
}

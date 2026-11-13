import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Sweep the temp dirs a killed test run left behind for one mkdtemp prefix.
 *
 * A suite removes its own temp dir in afterAll, which never runs when the
 * worker or the whole run is killed (a cancelled job, SIGKILL, a timeout
 * teardown). Those dirs then stay in a long-lived TMPDIR until something
 * removes them; this is that something, run by makeSweepableTempDir before the
 * first dir of a prefix in a process is made. It removes a dir only when all of
 * these hold:
 *
 * - the temp dir's realpath is a dir no other user can rename entries in (not
 *   group- or world-writable, or sticky);
 * - the dir's name is exactly `prefix` plus mkdtemp's six characters, directly
 *   in that realpath (no other prefix, no nested path);
 * - lstat says it is a real directory, not a link, its realpath is that same
 *   path, and, outside Windows, it is owned by this user and closed to others
 *   (mode 0700, as mkdtemp makes it);
 * - it holds SWEEP_MARKER, a regular file of this user's, which only
 *   makeSweepableTempDir writes: a dir anything else made is never a
 *   candidate, whatever its name;
 * - nothing uses it (`inUse`; by default no live Chrome holds its lock);
 * - it and everything in it (links not followed) are older than `maxAgeMs`;
 * - a second lstat right before the removal sees the same dir (dev, ino).
 *
 * Every removal goes through removeTempDirInside. Anything it cannot check or
 * remove is kept.
 */

/** Leftovers older than this are swept: far longer than any test run. */
export const STALE_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000;

/** The file makeSweepableTempDir writes in each dir; the sweep removes no dir without it. */
export const SWEEP_MARKER = '.wmux-sweepable-test-dir';

const MKDTEMP_SUFFIX = '[A-Za-z0-9]{6}';
const ownUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/** Not group- or world-writable, or sticky: no other user can swap an entry in it. */
function rootClosed(st: fs.Stats, uid: number | null): boolean {
  return st.isDirectory() && (uid === null || (st.mode & 0o022) === 0 || (st.mode & 0o1000) !== 0);
}

/** Slack for clock adjustments when comparing a lock's time with the boot time. */
const BOOT_SLACK_MS = 60_000;

/** Owned by this user and closed to everyone else; not checked on Windows. */
function ownedAndClosed(st: fs.Stats, uid: number | null): boolean {
  return uid === null || (st.uid === uid && (st.mode & 0o077) === 0);
}

/** The dir holds the marker as a regular file of this user's (not a link or a dir). */
function hasMarker(dir: string, uid: number | null): boolean {
  try {
    const st = fs.lstatSync(path.join(dir, SWEEP_MARKER));
    return st.isFile() && (uid === null || st.uid === uid);
  } catch {
    return false;
  }
}

/**
 * The sweep's one removal path. Removes `dir` only when it sits directly in
 * `root`'s realpath, lstat says it is a real directory (not a link), its
 * realpath is itself, and, when `expected` is given, it is still that dir
 * (dev, ino). fs.rmSync unlinks the links inside instead of following them.
 * Returns whether it removed the dir; never throws.
 */
export function removeTempDirInside(root: string, dir: string, expected?: { dev: number; ino: number }): boolean {
  try {
    if (path.dirname(dir) !== fs.realpathSync(root)) return false;
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return false;
    if (expected && (st.dev !== expected.dev || st.ino !== expected.ino)) return false;
    if (fs.realpathSync(dir) !== dir) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether everything in the tree at `dir`, links not followed, changed before
 * `cutoffMs`. Stops at the first newer entry; false when it cannot tell.
 */
function allOlderThan(dir: string, cutoffMs: number): boolean {
  try {
    const stack = [dir];
    while (stack.length > 0) {
      const p = stack.pop() as string;
      const st = fs.lstatSync(p);
      if (st.mtimeMs >= cutoffMs) return false;
      if (st.isDirectory()) for (const name of fs.readdirSync(p)) stack.push(path.join(p, name));
    }
    return true;
  } catch {
    return false;
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
 * whose target is `<host>-<pid>`, on Windows a `lockfile`. A lock made before
 * the last boot is free: no process from then is alive, whatever pid or host
 * it names. Otherwise only a lock naming this host and a pid that is gone
 * counts as free; a live pid, another host, a target of any other shape, a
 * lock that cannot be read, or a Windows lockfile counts as in use.
 */
export function chromeHoldsProfile(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  bootTimeMs: number = Date.now() - os.uptime() * 1000,
): boolean {
  if (platform === 'win32') return fs.existsSync(path.join(dir, 'lockfile'));
  const lock = path.join(dir, 'SingletonLock');
  let target: string;
  try {
    target = fs.readlinkSync(lock);
    if (fs.lstatSync(lock).mtimeMs < bootTimeMs - BOOT_SLACK_MS) return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const dash = target.lastIndexOf('-');
  const host = target.slice(0, dash);
  const pidText = target.slice(dash + 1);
  // Seven digits hold any pid (Linux's pid_max is at most 2^22); a longer one is not a pid.
  if (dash <= 0 || host !== os.hostname() || !/^[1-9][0-9]{0,6}$/.test(pidText)) return true;
  return pidAlive(Number(pidText));
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
  // The prefix check above leaves '.' as its only regex metacharacter.
  const pattern = new RegExp(`^${prefix.replace(/\./g, '\\.')}${MKDTEMP_SUFFIX}$`);
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
      if (!first.isDirectory() || !ownedAndClosed(first, uid) || !hasMarker(dir, uid)) continue;
      if (fs.realpathSync(dir) !== dir) continue;
      if (inUse(dir) || !allOlderThan(dir, now - maxAgeMs)) continue;
      if (removeTempDirInside(root, dir, first)) removed.push(dir);
    } catch {
      // Kept: whatever could not be checked or removed stays for a later sweep.
    }
  }
  return removed;
}

/** Temp dir and prefix pairs this process has swept already. */
const swept = new Set<string>();

/**
 * mkdtemp under os.tmpdir(), with SWEEP_MARKER written in it so a later sweep
 * may remove it once it is stale. The first call for a prefix in a process
 * sweeps that prefix's stale dirs before making the new one.
 */
export function makeSweepableTempDir(prefix: string): string {
  const key = `${os.tmpdir()}\0${prefix}`;
  if (!swept.has(key)) {
    swept.add(key);
    sweepStaleTempDirs(prefix);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fs.writeFileSync(path.join(dir, SWEEP_MARKER), '', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    removeTempDirInside(os.tmpdir(), dir);
    throw err;
  }
  return dir;
}

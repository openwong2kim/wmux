import * as fs from 'fs';

/**
 * What sits at the broker's socket path before a stale-socket cleanup:
 * lstat, so a symlink is reported as one and never followed.
 */
export function staleSocketKind(p: string): 'socket' | 'missing' | 'unreadable' | 'file' | 'symlink' | 'directory' | 'other' {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    // A failed look (EACCES, EIO) says nothing about what is there.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (st.isSocket()) return 'socket';
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'other';
}

/**
 * The identity of the socket at `p`, or null when there is no socket there:
 * device, inode, and the change, birth and modification times in nanoseconds,
 * since a filesystem such as ext4 can hand a freed inode to the next file at
 * once. Taken before the stale probe and again before the unlink, so a socket
 * another broker bound in between is never the one removed.
 *
 * The times alone can still match: Linux stamps files from a coarse clock, so
 * two binds a few milliseconds apart can share every one of them. The broker
 * therefore gives each socket it binds a random modification time
 * (`stampSocket`), which a rebind does not repeat.
 */
export function socketIdentity(p: string): string | null {
  try {
    const st = fs.lstatSync(p, { bigint: true });
    return st.isSocket() ? `${st.dev}:${st.ino}:${st.ctimeNs}:${st.birthtimeNs}:${st.mtimeNs}` : null;
  } catch {
    return null;
  }
}

/**
 * Give the socket the broker just bound at `p` a modification time with a
 * random fraction of a second, so `socketIdentity` tells it apart from the one
 * it replaced. `stampS` is that time in seconds; tests pass their own. Best
 * effort: a socket left unstamped keeps its bind-time identity.
 */
export function stampSocket(p: string, stampS: number = Math.floor(Date.now() / 1000) + Math.random()): void {
  try {
    fs.utimesSync(p, stampS, stampS);
  } catch { /* the identity falls back to the bind times */ }
}

/** What the broker does after its probe of an in-use socket path failed. */
export type StaleSocketAction =
  | { action: 'listen'; unlink: boolean }
  | { action: 'exit'; code: number; message: string };

/**
 * The stale-socket decision, given what the probe saw:
 * - `unreadable` → exit 1, path left alone (the supervisor retries);
 * - not a socket → exit 78 (`pathOccupiedCode`), path left alone, no restart;
 * - a socket whose connect was not refused → exit 75 (stand down);
 * - a socket that changed between the probe and now → exit 75;
 * - otherwise unlink the stale socket (or nothing, when it is gone) and listen.
 */
export function staleSocketAction(input: {
  pipeName: string;
  kind: ReturnType<typeof staleSocketKind>;
  errCode: string | undefined;
  before: string | null;
  now: string | null;
  pathOccupiedCode: number;
}): StaleSocketAction {
  const { pipeName, kind, errCode, before, now } = input;
  if (kind === 'unreadable') {
    return { action: 'exit', code: 1, message: `could not inspect ${pipeName}; leaving it` };
  }
  if (kind !== 'socket' && kind !== 'missing') {
    return { action: 'exit', code: input.pathOccupiedCode, message: `${pipeName} is a ${kind}, not a socket; refusing to remove it` };
  }
  if (kind === 'missing') return { action: 'listen', unlink: false };
  if (errCode !== 'ECONNREFUSED') {
    return { action: 'exit', code: 75, message: `socket at ${pipeName} did not refuse (${errCode ?? 'error'}); standing down` };
  }
  if (before === null || now !== before) {
    return { action: 'exit', code: 75, message: `the socket at ${pipeName} changed during the check; standing down` };
  }
  return { action: 'listen', unlink: true };
}

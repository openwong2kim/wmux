import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Where the pipe relay (CdpPipeRelay) puts its Unix socket, and how it checks
// one. A socket lives in its own private dir (0700) made under a temp root;
// the socket itself is 0600. The dir also records its owner's pid, so a later
// start can tell a dir left by a process that is gone from one still in use
// (the installed app and an isolated instance share one temp root).
// Windows has no candidate: the relay uses a named pipe there (relayPipeWin).
// ---------------------------------------------------------------------------

export const RELAY_DIR_PREFIX = 'wmux-cdp-';
const SOCKET_NAME = 'r.sock';
const OWNER_NAME = 'owner';
/**
 * The ws client takes a ws+unix socket path from the URL without decoding it,
 * so only characters that need no encoding work; 100 bytes stays under every
 * platform's sun_path limit (104 on macOS).
 */
const SAFE_PATH = /^[A-Za-z0-9/._-]+$/;
export const RELAY_SOCKET_MAX_BYTES = 100;
/** mkdtemp's six-character suffix. */
const DIR_SUFFIX_LENGTH = 6;

export interface RelaySocketDir {
  readonly dir: string;
  readonly socketPath: string;
}

/** The socket's identity once checked: a later lstat with another dev/ino is not this socket. */
export interface RelaySocketId {
  readonly dev: number;
  readonly ino: number;
}

/** Temp roots to try, in order. None on Windows. */
export function relaySocketRoots(): string[] {
  if (process.platform === 'win32') return [];
  return [...new Set([os.tmpdir(), '/tmp'])];
}

const ownUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/** A root no other user can rename entries in: not world-writable, or sticky. */
function rootUsable(root: string): boolean {
  try {
    const st = fs.statSync(root);
    return st.isDirectory() && ((st.mode & 0o002) === 0 || (st.mode & 0o1000) !== 0);
  } catch {
    return false;
  }
}

/** A fresh private dir under `root` for the socket, or null when `root` can't hold one. */
export function makeRelaySocketDir(root: string): RelaySocketDir | null {
  const expected = path.join(root, `${RELAY_DIR_PREFIX}${'x'.repeat(DIR_SUFFIX_LENGTH)}`, SOCKET_NAME);
  if (!SAFE_PATH.test(expected) || Buffer.byteLength(expected) > RELAY_SOCKET_MAX_BYTES) return null;
  if (!rootUsable(root)) return null;
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(root, RELAY_DIR_PREFIX));
  } catch {
    return null;
  }
  try {
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(path.join(dir, OWNER_NAME), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  } catch {
    removeRelaySocketDir(dir);
    return null;
  }
  return { dir, socketPath: path.join(dir, SOCKET_NAME) };
}

/** Owned by this user, of the right type, and closed to everyone else. */
function closedToOthers(st: fs.Stats, uid: number | null): boolean {
  return (uid === null || st.uid === uid) && (st.mode & 0o077) === 0;
}

/** Check a listening socket and its dir; the socket's identity, or null if either is not as made. */
export function verifyRelaySocket(place: RelaySocketDir): RelaySocketId | null {
  const uid = ownUid();
  try {
    const dir = fs.lstatSync(place.dir);
    const sock = fs.lstatSync(place.socketPath);
    if (!dir.isDirectory() || !closedToOthers(dir, uid) || !sock.isSocket() || !closedToOthers(sock, uid)) return null;
    return { dev: sock.dev, ino: sock.ino };
  } catch {
    return null;
  }
}

/** Whether the socket at `socketPath` is still the one `id` names. */
export function relaySocketIntact(socketPath: string, id: RelaySocketId): boolean {
  try {
    const st = fs.lstatSync(socketPath);
    return st.isSocket() && st.dev === id.dev && st.ino === id.ino;
  } catch {
    return false;
  }
}

/** Remove a dir this process made (best effort). */
export function removeRelaySocketDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* left for a later sweep */ }
}

function pidGone(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM: the pid exists (another user's). Only ESRCH says no such process.
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Resolves true when nothing accepts on `socketPath`. */
function nobodyListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (gone: boolean) => {
      socket.destroy();
      resolve(gone);
    };
    socket.once('connect', () => done(false));
    socket.once('error', (err: NodeJS.ErrnoException) => done(err.code === 'ECONNREFUSED' || err.code === 'ENOENT'));
    socket.setTimeout(1_000, () => done(false));
  });
}

/**
 * Remove relay dirs under `root` left by a process that is gone: this user's,
 * a real dir (not a link), its recorded owner pid no longer running, and
 * nothing accepting on its socket. Anything less certain is left alone.
 * Returns the dirs removed.
 */
export async function sweepDeadRelayDirs(root: string): Promise<string[]> {
  const uid = ownUid();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(RELAY_DIR_PREFIX) || name.length !== RELAY_DIR_PREFIX.length + DIR_SUFFIX_LENGTH) continue;
    const dir = path.join(root, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || (uid !== null && st.uid !== uid)) continue;
      const owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_NAME), 'utf8')) as { pid?: unknown };
      if (owner.pid === process.pid || !pidGone(owner.pid)) continue;
      if (!(await nobodyListening(path.join(dir, SOCKET_NAME)))) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      /* unreadable or half-made: not provably dead, left alone */
    }
  }
  return removed;
}

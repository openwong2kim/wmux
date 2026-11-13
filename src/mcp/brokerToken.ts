/**
 * The token the broker checks each shim handshake against.
 *
 * The broker reads the token file again at every handshake, as the per-session
 * servers and the shims do, so a new token on disk takes effect for the next
 * session with no broker restart. A file it cannot use refuses the session;
 * the broker keeps running. Nothing here logs or returns token text: a
 * refusal carries only its reason.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';

/** Why the token file could not be used. */
export type TokenFileProblem = 'missing' | 'unreadable' | 'not-a-file' | 'owner' | 'mode' | 'too-large' | 'empty';

export type TokenRead = { ok: true; token: string } | { ok: false; problem: TokenFileProblem };

/** Larger than any token wmux writes (a UUID); a bigger file is not one. */
const MAX_TOKEN_FILE_BYTES = 4096;

/**
 * Read the token file. Outside Windows the file must be a regular file owned
 * by `ownUid` with no group or other permission bits, as wmux writes it
 * (0600). On Windows the file's ACL is set by wmux and not checked here.
 */
export function readTokenFile(file: string, ownUid: number | null, platform: NodeJS.Platform = process.platform): TokenRead {
  let fd: number;
  try {
    // Non-blocking, so a FIFO in the file's place cannot stall the open; the
    // check below refuses anything but a regular file.
    fd = fs.openSync(file, platform === 'win32' ? 'r' : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    return { ok: false, problem: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    // Checked on the open descriptor, so the bytes read are the file checked.
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, problem: 'not-a-file' };
    if (platform !== 'win32') {
      if (ownUid !== null && st.uid !== ownUid) return { ok: false, problem: 'owner' };
      if ((st.mode & 0o077) !== 0) return { ok: false, problem: 'mode' };
    }
    // One byte more than the cap: a file that fills it is too large, even if
    // it grew after the stat.
    const buf = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
    let length = 0;
    for (let n = -1; n !== 0 && length < buf.length; length += n) {
      n = fs.readSync(fd, buf, length, buf.length - length, null);
    }
    if (length > MAX_TOKEN_FILE_BYTES) return { ok: false, problem: 'too-large' };
    const token = buf.subarray(0, length).toString('utf8').trim();
    return token ? { ok: true, token } : { ok: false, problem: 'empty' };
  } catch {
    return { ok: false, problem: 'unreadable' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

export interface BrokerTokenSource {
  /** The expected token for one handshake; null when there is no source at all. */
  read: (() => TokenRead) | null;
  /** Why the token file could not be used when the broker started, if it could not. */
  startProblem: TokenFileProblem | null;
}

/**
 * Where the broker gets the expected token. The token file, read again at
 * every handshake. A WMUX_AUTH_TOKEN from the environment stands in only
 * until the file is first usable: a broker that started without a usable
 * file, on that token, moves to the file for good once it can read it.
 */
export function brokerTokenSource(
  file: string,
  envToken: string | undefined,
  ownUid: number | null,
  platform: NodeJS.Platform = process.platform,
): BrokerTokenSource {
  const first = readTokenFile(file, ownUid, platform);
  const startProblem = first.ok ? null : first.problem;
  if (!first.ok && !envToken) return { read: null, startProblem };
  let fileSeen = first.ok;
  const read = (): TokenRead => {
    const r = readTokenFile(file, ownUid, platform);
    if (r.ok) fileSeen = true;
    if (r.ok || fileSeen || !envToken) return r;
    return { ok: true, token: envToken };
  };
  return { read, startProblem };
}

const digest = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();

/**
 * Whether the handshake's token is the expected one. Both sides are hashed to
 * a fixed length and compared with crypto.timingSafeEqual, so the time taken
 * says nothing about either token, its length included.
 */
export function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

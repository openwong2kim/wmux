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
export type TokenFileProblem = 'missing' | 'unreadable' | 'not-a-file' | 'owner' | 'mode' | 'empty';

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
    fd = fs.openSync(file, 'r');
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
    if (st.size > MAX_TOKEN_FILE_BYTES) return { ok: false, problem: 'unreadable' };
    const token = fs.readFileSync(fd, 'utf8').trim();
    return token ? { ok: true, token } : { ok: false, problem: 'empty' };
  } catch {
    return { ok: false, problem: 'unreadable' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Where the broker gets the expected token, chosen once at start: the token
 * file when it is usable then (wmux writes it before it spawns the broker),
 * read again at each handshake; otherwise a WMUX_AUTH_TOKEN from the
 * environment, fixed for the broker's life. Null when there is neither.
 */
export function brokerTokenSource(
  file: string,
  envToken: string | undefined,
  ownUid: number | null,
  platform: NodeJS.Platform = process.platform,
): (() => TokenRead) | null {
  if (readTokenFile(file, ownUid, platform).ok) return () => readTokenFile(file, ownUid, platform);
  if (envToken) return () => ({ ok: true, token: envToken });
  return null;
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

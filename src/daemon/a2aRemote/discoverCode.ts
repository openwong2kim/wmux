import crypto from 'node:crypto';
import { normalizeFingerprint256 } from '../../shared/a2aRemote';

/**
 * The 6-digit code both PCs show during tailnet discovery.
 *
 *   commit = SHA256("wmux-a2a-discover-commit/1" || Nr)
 *   code   = uint64be(HKDF-SHA256(ikm = Ns || Nr, salt = "wmux-a2a-discover/1",
 *                                 info = Fs || "|" || Fr || "|" || hostId_r, L = 8)) mod 10^6
 *
 * Nr is the requester's nonce, Ns the server's, Fs the server certificate's
 * fingerprint as the requester observed and pinned it, Fr the requester's
 * own, hostId_r the requester's HostId. The requester commits to Nr before it
 * learns Ns, and the server picks Ns only after it holds the commit, so a man
 * in the middle (who must present another Fs) gets one 1-in-10^6 guess per
 * request. The code itself never travels.
 */

export const DISCOVER_COMMIT_LABEL = 'wmux-a2a-discover-commit/1';
export const DISCOVER_CODE_SALT = 'wmux-a2a-discover/1';
const SECRET_BYTES = 32;
/** base64url of 32 bytes, unpadded. */
const B64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url: a nonce or a request token. */
export function randomSecret(): string {
  return crypto.randomBytes(SECRET_BYTES).toString('base64url');
}

/** The 32 bytes of a base64url nonce, commit or token; null unless it is exactly that. */
export function decodeSecret(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !B64URL_32_RE.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  // Canonical only: the unused low bits of the last character must be zero.
  return bytes.length === SECRET_BYTES && bytes.toString('base64url') === value ? bytes : null;
}

/** The commit to `nonceR`. Throws when it is not a 32-byte base64url nonce. */
export function discoverCommit(nonceR: string): string {
  const nr = decodeSecret(nonceR);
  if (!nr) throw new Error('discover: malformed nonce');
  return crypto.createHash('sha256').update(DISCOVER_COMMIT_LABEL, 'utf8').update(nr).digest('base64url');
}

/** Does `nonceR` open `commit`? Constant-time; false for anything malformed. */
export function commitMatches(commit: string, nonceR: string): boolean {
  const want = decodeSecret(commit);
  if (!want || !decodeSecret(nonceR)) return false;
  const got = Buffer.from(discoverCommit(nonceR), 'base64url');
  return crypto.timingSafeEqual(want, got);
}

/** The code, zero-padded to 6 digits. Throws on a malformed nonce or fingerprint. */
export function discoverCode(p: {
  nonceS: string;
  nonceR: string;
  fingerprintS: string;
  fingerprintR: string;
  hostIdR: string;
}): string {
  const ns = decodeSecret(p.nonceS);
  const nr = decodeSecret(p.nonceR);
  const fs = normalizeFingerprint256(p.fingerprintS);
  const fr = normalizeFingerprint256(p.fingerprintR);
  if (!ns || !nr) throw new Error('discover: malformed nonce');
  if (!fs || !fr) throw new Error('discover: malformed fingerprint');
  const okm = crypto.hkdfSync('sha256', Buffer.concat([ns, nr]), DISCOVER_CODE_SALT, `${fs}|${fr}|${p.hostIdR}`, 8);
  return (Buffer.from(okm).readBigUInt64BE(0) % 1_000_000n).toString().padStart(6, '0');
}

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Resolve the current user's SID (e.g. `S-1-5-21-...-1001`) so the ACL grant can
 * name the owner by SID instead of by SAM account name. Returns the bare SID
 * string, or null if it can't be determined.
 *
 * Why this exists: passing `%USERNAME%` to icacls breaks for non-ASCII profile
 * names (e.g. a Korean account like `홍길동`). icacls parses its argv as the
 * console's legacy OEM codepage, so the name is mangled into a ghost principal
 * such as `홍길동\` — icacls happily grants Full control to that non-existent
 * account while the REAL owner SID gets nothing. Combined with `/inheritance:r`
 * stripping every inherited ACE, the owner is locked out of their own token
 * file. A SID is pure ASCII, so it round-trips through any codepage intact.
 *
 * `whoami /user` is used rather than a richer API because it ships in
 * %SystemRoot%\System32 on every Windows install and its SID output is ASCII —
 * even when the account display name in the same output is non-ASCII garbage.
 */
function getCurrentUserSid(): string | null {
  try {
    const whoami = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\whoami.exe`;
    const out = execFileSync(whoami, ['/user', '/fo', 'list'], {
      windowsHide: true,
    }).toString('utf8');
    const match = out.match(/S-1-[0-9-]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * Apply a restrictive Windows ACL to an existing file: strip inheritance and
 * grant Full control to ONLY the current user. Throws on failure (callers
 * decide whether that is fatal). Shared by the write path (secureWriteTokenFile)
 * and the re-harden path (reHardenTokenFileAcl).
 *
 * Backs the docs/SECURITY.md §1.2 + PROTOCOL.md §5 token-file ACL guarantee —
 * keep the icacls argv in sync with them.
 *
 * Two correctness rules encoded in the argv order and principal choice:
 *   1. Identify the owner by SID (`*S-1-5-...`) when resolvable, not by
 *      `%USERNAME%` — see getCurrentUserSid for the non-ASCII lock-out bug. If
 *      the SID is unresolvable, fall back to the account name ONLY when it is
 *      pure ASCII; refuse a non-ASCII/empty name rather than re-introduce the
 *      mangle.
 *   2. `/grant:r` comes BEFORE `/inheritance:r`. icacls applies operations
 *      left-to-right; stripping inheritance first removes the owner's WRITE_DAC
 *      and the subsequent grant can fail silently (the RCA documented in
 *      docs/SECURITY.md §1.2). Granting explicit Full control first keeps the
 *      owner's right to edit the DACL through the inheritance strip.
 */
function applyRestrictiveWindowsAcl(filePath: string): void {
  const icacls = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\icacls.exe`;
  const sid = getCurrentUserSid();
  // icacls accepts a SID principal when prefixed with `*` (ASCII, codepage-proof
  // — always preferred). Fall back to the account name ONLY when the SID can't
  // be resolved (e.g. a stripped-down system where whoami is unavailable) AND
  // that name is pure ASCII.
  //
  // Never fall back to a non-ASCII (or empty/undefined) USERNAME: icacls would
  // mangle it in the console OEM codepage into a ghost principal, granting Full
  // control to a non-existent account while `/inheritance:r` strips the real
  // owner's ACEs — the exact lock-out getCurrentUserSid exists to prevent, and
  // re-applied on every token load. Refuse and throw instead so callers fail
  // safe: secureWriteTokenFile deletes the token and rethrows;
  // reHardenTokenFileAcl returns false without touching the existing ACL — both
  // strictly better than silently re-locking the owner out.
  let principal: string;
  if (sid) {
    principal = `*${sid}`;
  } else {
    const username = process.env.USERNAME;
    // A non-ASCII char is >1 UTF-8 byte, so byteLength === length iff pure ASCII.
    if (!username || Buffer.byteLength(username, 'utf8') !== username.length) {
      throw new Error(
        `Cannot harden ${filePath}: owner SID unresolved and USERNAME is ` +
          `${username ? 'non-ASCII' : 'unset'}. Passing it to icacls would mangle ` +
          `the principal and lock the owner out; refusing to apply a ` +
          `mangling-prone ACL.`,
      );
    }
    principal = username;
  }
  execFileSync(icacls, [
    filePath,
    '/grant:r',
    `${principal}:F`,
    '/inheritance:r',
  ], { windowsHide: true });
}

export function secureWriteTokenFile(filePath: string, token: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600 });

  if (process.platform === 'win32') {
    try {
      applyRestrictiveWindowsAcl(filePath);
    } catch (aclErr) {
      console.warn('[secureWriteTokenFile] Could not set file ACL:', aclErr);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best effort cleanup of an insecure token file.
      }
      const message = aclErr instanceof Error ? aclErr.message : String(aclErr);
      throw new Error(`Failed to set secure ACL on ${filePath}: ${message}`);
    }
  }
}

/**
 * RCA A12 — re-harden the ACL/permissions of an ALREADY-EXISTING token file
 * WITHOUT rewriting its contents.
 *
 * Why this exists: secureWriteTokenFile only locks permissions when a token is
 * freshly WRITTEN. A token loaded from disk (the common path on every run after
 * first launch) kept whatever ACL it already had — including broad inherited
 * ACLs that granted read to Administrators / SYSTEM / other local accounts.
 * Real incident evidence in this very repo: the `~/.wmux-backup-acl-broken-*`
 * directories. A leaked daemon/main auth token lets any local process drive the
 * RPC surface (spawn PTYs, read sessions, navigate the browser).
 *
 * Best-effort by design: a live daemon/app must NOT fail to start just because
 * it couldn't tighten an existing file's permissions. Logs and returns false on
 * failure so callers can surface it without aborting. Returns true when the
 * restrictive ACL/mode was successfully (re)applied.
 */
export function reHardenTokenFileAcl(filePath: string): boolean {
  try {
    if (process.platform === 'win32') {
      applyRestrictiveWindowsAcl(filePath);
    } else {
      // POSIX: ensure owner-only read/write on the existing file.
      fs.chmodSync(filePath, 0o600);
    }
    return true;
  } catch (err) {
    console.warn(`[reHardenTokenFileAcl] could not re-harden ${filePath}:`, err);
    return false;
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Apply a restrictive Windows ACL to an existing file: strip inheritance and
 * grant Full control to ONLY the current user. Throws on failure (callers
 * decide whether that is fatal). Shared by the write path (secureWriteTokenFile)
 * and the re-harden path (reHardenTokenFileAcl).
 */
function applyRestrictiveWindowsAcl(filePath: string): void {
  const icacls = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\icacls.exe`;
  execFileSync(icacls, [
    filePath,
    '/inheritance:r',
    '/grant:r',
    `${process.env.USERNAME}:F`,
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

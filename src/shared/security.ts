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
 * PowerShell helper executed by applyRestrictiveWindowsAcl.
 *
 * It rebuilds the file DACL instead of relying on icacls' `/grant:r` semantics:
 * `/grant:r` only replaces ACEs for the named principal and leaves explicit
 * grants for other principals (for example Everyone/Users) intact. Rebuilding
 * the DACL removes those stale explicit grants and then adds back exactly one
 * FullControl ACE for the current owner identity.
 */
const RESTRICTIVE_WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$targetPath = [string]$payload.filePath

if ($payload.sid) {
  $identity = New-Object System.Security.Principal.SecurityIdentifier([string]$payload.sid)
} elseif ($payload.username) {
  $identity = New-Object System.Security.Principal.NTAccount([string]$payload.username)
} else {
  throw 'No owner identity supplied for ACL hardening.'
}

$acl = Get-Acl -LiteralPath $targetPath
# Disable inheritance and discard inherited ACEs.
$acl.SetAccessRuleProtection($true, $false)
# Remove every explicit ACE before adding the owner-only grant. This is the
# critical step that prevents retained explicit Everyone/Users grants.
foreach ($rule in @($acl.Access)) {
  [void]$acl.RemoveAccessRuleAll($rule)
}
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $targetPath -AclObject $acl
`;

/**
 * Apply a restrictive Windows ACL to an existing file: strip inheritance,
 * remove every explicit grant, and grant Full control to ONLY the current user.
 * Throws on failure (callers decide whether that is fatal). Shared by the write
 * path (secureWriteTokenFile) and the re-harden path (reHardenTokenFileAcl).
 *
 * Backs the docs/SECURITY.md §1.2 + PROTOCOL.md §5 token-file ACL guarantee —
 * keep the ACL operation in sync with them.
 *
 * Correctness rules encoded below:
 *   1. Identify the owner by SID when resolvable, not by `%USERNAME%` — see
 *      getCurrentUserSid for the non-ASCII lock-out bug. If the SID is
 *      unresolvable, fall back to the account name ONLY when it is pure ASCII;
 *      refuse a non-ASCII/empty name rather than re-introduce the mangle.
 *   2. Rebuild the DACL rather than using `icacls /grant:r`: `/grant:r` only
 *      replaces grants for the named principal and does not remove explicit
 *      Everyone/Users grants already present on an existing token file.
 */
function applyRestrictiveWindowsAcl(filePath: string): void {
  const sid = getCurrentUserSid();
  // Prefer the SID (ASCII, codepage-proof). Fall back to the account name ONLY
  // when the SID can't be resolved (e.g. a stripped-down system where whoami is
  // unavailable) AND that name is pure ASCII.
  //
  // Never fall back to a non-ASCII (or empty/undefined) USERNAME: any native ACL
  // tool may mangle it in the console OEM codepage into a ghost principal,
  // granting Full control to a non-existent account while stripping the real
  // owner's inherited ACEs — the exact lock-out getCurrentUserSid exists to
  // prevent, and re-applied on every token load. Refuse and throw instead so
  // callers fail safe: secureWriteTokenFile deletes the token and rethrows;
  // reHardenTokenFileAcl returns false without touching the existing ACL — both
  // strictly better than silently re-locking the owner out.
  let username: string | undefined;
  if (!sid) {
    username = process.env.USERNAME;
    // A non-ASCII char is >1 UTF-8 byte, so byteLength === length iff pure ASCII.
    if (!username || Buffer.byteLength(username, 'utf8') !== username.length) {
      throw new Error(
        `Cannot harden ${filePath}: owner SID unresolved and USERNAME is ` +
          `${username ? 'non-ASCII' : 'unset'}. Passing it to a native ACL tool ` +
          `would mangle the principal and lock the owner out; refusing to apply ` +
          `a mangling-prone ACL.`,
      );
    }
  }

  const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const encodedScript = Buffer.from(RESTRICTIVE_WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64');
  const payload = JSON.stringify({ filePath, sid, username });
  execFileSync(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedScript,
  ], { input: payload, windowsHide: true });
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

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
    const match = out.match(/^\s*SID\s*:\s*(S-\d-(?:\d+|0x[0-9a-fA-F]+)(?:-\d+)+)\s*$/im);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Well-known broad principals the icacls FALLBACK explicitly strips by SID.
 * These are the realistic "world-readable" vectors a redirected/roamed/MDM
 * profile can stamp as an EXPLICIT ACE on the token file:
 *   S-1-1-0      Everyone
 *   S-1-5-32-545 BUILTIN\Users
 *   S-1-5-11     Authenticated Users
 *   S-1-5-4      INTERACTIVE
 * (icacls cannot enumerate-and-remove a DACL generically, and a blind
 * remove-every-ACE loop locks the owner out — see issue #124 dynamic probes.
 * The PRIMARY .NET path strips ALL non-owner ACEs including custom SIDs; this
 * list only bounds the fallback used when PowerShell is unavailable.)
 */
const WELL_KNOWN_BROAD_SIDS = ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-4'];

/**
 * PowerShell snippet executed via `-EncodedCommand` to rebuild the file DACL
 * using the .NET `FileInfo.SetAccessControl(FileSecurity)` overload.
 *
 * Why this overload and NOT `icacls /grant:r` or the `Set-Acl` cmdlet:
 *   - `icacls /grant:r *<sid>:F /inheritance:r` only REPLACES the named
 *     principal's ACE and only strips INHERITED ACEs; a pre-existing EXPLICIT
 *     broad ACE (e.g. Everyone:(R) from a redirected profile) SURVIVES, leaving
 *     the token world-readable. This is the original leak (issue #124).
 *   - The `Set-Acl` cmdlet reads Owner+Group+DACL via `Get-Acl` and tries to
 *     write back ALL of those sections; re-stamping the Owner/Group on the
 *     already-`/inheritance:r`-protected on-disk state requires
 *     SeSecurityPrivilege/SeRestorePrivilege that a normal user process does
 *     NOT hold — it throws PrivilegeNotHeldException 10/10 on the real
 *     upgrade-from-icacls token (the v2.14.0+ installed base). Verified in
 *     scripts/issue-124-acl-dynamic.mjs.
 *   - `FileInfo.SetAccessControl($fs)` with a FRESH FileSecurity object writes
 *     ONLY the sections that object has modified — the DACL — never Owner/Group/
 *     SACL. So it needs no privilege, succeeds 10/10 on the upgrade state, and
 *     `SetAccessRuleProtection($true,$false)` discards inheritance while the
 *     single owner FullControl ACE is the ONLY surviving DACL entry. Every other
 *     ACE — inherited or explicit, well-known or custom — is dropped.
 *
 * Reads a JSON `{ sid?, username? }` payload from stdin (so the identity never
 * lands in argv where the console OEM codepage could mangle a non-ASCII name).
 */
const DACL_ONLY_REBUILD_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = $env:WMUX_ACL_TARGET
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($payload.sid) {
  $id = New-Object System.Security.Principal.SecurityIdentifier([string]$payload.sid)
} elseif ($payload.username) {
  $id = New-Object System.Security.Principal.NTAccount([string]$payload.username)
} else {
  throw 'No owner identity supplied for ACL hardening.'
}
$fi = Get-Item -LiteralPath $p -Force
# Fresh FileSecurity => Set-AccessControl writes ONLY the DACL, never Owner/Group/SACL.
$fs = New-Object System.Security.AccessControl.FileSecurity
$fs.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $id,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$fs.AddAccessRule($rule)
$fi.SetAccessControl($fs)
`;

/**
 * Resolve the owner principal for the ACL, applying the #90 codepage-safety
 * rules. Returns `{ sid }` when resolvable (always preferred — pure ASCII), or
 * `{ username }` ONLY when the SID is unresolvable AND the name is pure ASCII.
 * Throws otherwise so callers fail safe rather than mangle a non-ASCII name.
 */
function resolveOwnerIdentity(filePath: string): { sid: string | null; username?: string } {
  const sid = getCurrentUserSid();
  if (sid) {
    return { sid };
  }
  // Fall back to the account name ONLY when the SID can't be resolved (e.g. a
  // stripped-down system where whoami is unavailable) AND that name is pure
  // ASCII. Never fall back to a non-ASCII (or empty/undefined) USERNAME: native
  // ACL tooling would mangle it in the console OEM codepage into a ghost
  // principal, granting Full control to a non-existent account while the real
  // owner's ACEs are stripped — the exact lock-out getCurrentUserSid exists to
  // prevent, re-applied on every token load. Refuse and throw instead so callers
  // fail safe: secureWriteTokenFile deletes the token and rethrows;
  // reHardenTokenFileAcl returns false without touching the existing ACL — both
  // strictly better than silently re-locking the owner out.
  const username = process.env.USERNAME;
  // A non-ASCII char is >1 UTF-8 byte, so byteLength === length iff pure ASCII.
  if (!username || Buffer.byteLength(username, 'utf8') !== username.length) {
    throw new Error(
      `Cannot harden ${filePath}: owner SID unresolved and USERNAME is ` +
        `${username ? 'non-ASCII' : 'unset'}. Passing it to a native ACL tool ` +
        `would mangle the principal and lock the owner out; refusing to apply ` +
        `a mangling-prone ACL.`,
    );
  }
  return { sid: null, username };
}

/**
 * FALLBACK ACL primitive for when PowerShell is unavailable (Server Core /
 * hardened / PS-removed SKUs). icacls.exe is in %SystemRoot%\System32 on EVERY
 * Windows install, so this always runs.
 *
 * Grants the owner Full control, strips inheritance, then explicitly removes the
 * well-known broad principals (Everyone/Users/Authenticated Users/INTERACTIVE)
 * by SID. The owner grant is applied BEFORE `/inheritance:r` so the owner keeps
 * WRITE_DAC through the strip, and the `/remove:g` of broad SIDs never touches
 * the owner ACE.
 *
 * Caveat vs the primary path: this strips only the well-known broad SIDs, not an
 * ARBITRARY custom explicit SID. That is an accepted bound — the realistic
 * world-readable vectors are the well-known groups, and a single icacls invocation
 * cannot enumerate a DACL. The primary .NET path (used whenever PowerShell is
 * present, i.e. virtually always) strips ALL non-owner ACEs including custom ones.
 */
function applyRestrictiveAclViaIcacls(filePath: string, principal: string): void {
  const icacls = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\icacls.exe`;
  // Order matters: icacls applies args left-to-right. Grant the owner Full
  // control FIRST so the owner holds an explicit WRITE_DAC ACE, THEN strip
  // inheritance. If `/inheritance:r` ran first, a caller whose edit rights came
  // only from inherited ACEs would lose them mid-command and the `/grant:r`
  // could fail, locking the owner out (caught by codex on PR #140).
  const args = [
    filePath,
    '/grant:r',
    `${principal}:F`,
    '/inheritance:r',
  ];
  for (const broadSid of WELL_KNOWN_BROAD_SIDS) {
    args.push('/remove:g', `*${broadSid}`);
  }
  execFileSync(icacls, args, { windowsHide: true });
}

/**
 * Apply a restrictive Windows ACL to an existing file: rebuild the DACL so the
 * ONLY surviving entry is Full control for the current user — inherited AND
 * pre-existing explicit ACEs (Everyone/Users/etc.) are removed. Owner/Group/SACL
 * are never touched. Throws on failure (callers decide whether that is fatal).
 * Shared by the write path (secureWriteTokenFile) and the re-harden path
 * (reHardenTokenFileAcl).
 *
 * Backs the docs/SECURITY.md §1.2 + PROTOCOL.md §5 token-file ACL guarantee —
 * keep the behavior in sync with them.
 *
 * Primitive choice (issue #124): a DACL-only rebuild via .NET
 * `FileInfo.SetAccessControl`, invoked through `powershell.exe -EncodedCommand`.
 * See DACL_ONLY_REBUILD_SCRIPT for why this is correct where `icacls /grant:r`
 * (leaks explicit ACEs) and the `Set-Acl` cmdlet (PrivilegeNotHeldException on
 * the upgrade-from-icacls state) are not. icacls is the fallback for any SKU
 * where the PRIMARY path is unavailable — powershell.exe absent, OR present but
 * blocked (AppLocker / Constrained Language Mode can fail the .NET ACL calls).
 * The fallback still strips the common broad ACEs, so a hardened endpoint is
 * left strictly better off than the un-hardened token (see
 * applyRestrictiveAclViaIcacls). We only fail (and let the caller delete the
 * token) when BOTH primitives fail.
 *
 * Owner identity rule (issue #90): prefer the SID (pure ASCII, codepage-proof);
 * fall back to %USERNAME% ONLY when it is pure ASCII; refuse a non-ASCII/empty
 * name rather than re-introduce the icacls codepage mangle.
 */
function applyRestrictiveWindowsAcl(filePath: string): void {
  const { sid, username } = resolveOwnerIdentity(filePath);

  // PRIMARY: DACL-only rebuild via .NET FileInfo.SetAccessControl. The target
  // path goes through an environment variable (not argv) so a non-ASCII path is
  // not subject to console OEM-codepage mangling, and the identity goes through
  // stdin for the same reason.
  //
  // If powershell.exe is missing, OR present but throws (AppLocker / Constrained
  // Language Mode blocking the .NET calls), fall through to the icacls fallback
  // rather than abort — on a hardened endpoint the previous main implementation
  // used icacls directly, and stripping the common broad ACEs there beats
  // deleting the freshly-written token. Only when icacls ALSO fails do we throw.
  const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (fs.existsSync(powershell)) {
    try {
      const encoded = Buffer.from(DACL_ONLY_REBUILD_SCRIPT, 'utf16le').toString('base64');
      execFileSync(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        {
          input: JSON.stringify({ sid, username }),
          env: { ...process.env, WMUX_ACL_TARGET: filePath },
          windowsHide: true,
          // stdin carries the identity payload; stdout is ignored so the child's
          // CLIXML progress stream never leaks into the daemon's own stdout;
          // stderr is captured so a real failure message rides the thrown error.
          stdio: ['pipe', 'ignore', 'pipe'],
        },
      );
      return;
    } catch (psErr) {
      // PowerShell present but unusable — degrade to icacls below.
      console.warn(
        `[applyRestrictiveWindowsAcl] PowerShell DACL rebuild failed for ${filePath}; ` +
          `falling back to icacls:`,
        psErr,
      );
    }
  }

  // FALLBACK: icacls is always present in %SystemRoot%\System32. It accepts a
  // SID principal when prefixed with `*` (ASCII, codepage-proof);
  // resolveOwnerIdentity already guaranteed any username fallback is pure ASCII.
  // If this throws too, it propagates — the caller fails closed.
  const principal = sid ? `*${sid}` : (username as string);
  applyRestrictiveAclViaIcacls(filePath, principal);
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

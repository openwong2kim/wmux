import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync, spawn } from 'child_process';

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
    return parseSidFromWhoami(out);
  } catch {
    return null;
  }
}

function parseSidFromWhoami(out: string): string | null {
  const match = out.match(/^\s*SID\s*:\s*(S-\d-(?:\d+|0x[0-9a-fA-F]+)(?:-\d+)+)\s*$/im);
  return match ? match[1] : null;
}

/** Async twin of getCurrentUserSid — used by the deferred re-harden path so
 *  the whoami shell-out never blocks the event loop. */
function getCurrentUserSidAsync(): Promise<string | null> {
  return new Promise((resolve) => {
    const whoami = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\whoami.exe`;
    execFile(whoami, ['/user', '/fo', 'list'], { windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(parseSidFromWhoami(stdout.toString()));
    });
  });
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
  return validateAsciiUsernameFallback(filePath);
}

/** Async twin of resolveOwnerIdentity (same #90 rules) for the deferred
 *  re-harden path. */
async function resolveOwnerIdentityAsync(
  filePath: string,
): Promise<{ sid: string | null; username?: string }> {
  const sid = await getCurrentUserSidAsync();
  if (sid) {
    return { sid };
  }
  return validateAsciiUsernameFallback(filePath);
}

/**
 * Fall back to the account name ONLY when the SID can't be resolved (e.g. a
 * stripped-down system where whoami is unavailable) AND that name is pure
 * ASCII. Never fall back to a non-ASCII (or empty/undefined) USERNAME: native
 * ACL tooling would mangle it in the console OEM codepage into a ghost
 * principal, granting Full control to a non-existent account while the real
 * owner's ACEs are stripped — the exact lock-out getCurrentUserSid exists to
 * prevent, re-applied on every token load. Refuse and throw instead so callers
 * fail safe: secureWriteTokenFile deletes the token and rethrows;
 * reHardenTokenFileAcl returns false without touching the existing ACL — both
 * strictly better than silently re-locking the owner out.
 */
function validateAsciiUsernameFallback(filePath: string): { sid: null; username: string } {
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
  // Boot-phase diagnostics (S-A): this function shells out synchronously to
  // whoami.exe + powershell.exe (or icacls) and runs on EVERY cold start in
  // both the main process (PipeServer ctor → loadOrCreateToken) and the
  // daemon (DaemonPipeServer.start → loadOrCreateToken). PowerShell process
  // start under AV is a known multi-second tax — log the duration so boot
  // traces can attribute it.
  const aclStart = Date.now();
  try {
    applyRestrictiveWindowsAclInner(filePath);
  } finally {
    console.log(`[security] token ACL harden took ${Date.now() - aclStart}ms (${path.basename(filePath)})`);
  }
}

function applyRestrictiveWindowsAclInner(filePath: string): void {
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
  if (tryPowershellDaclRebuildSync(filePath, sid, username)) {
    return;
  }

  // FALLBACK: icacls is always present in %SystemRoot%\System32. It accepts a
  // SID principal when prefixed with `*` (ASCII, codepage-proof);
  // resolveOwnerIdentity already guaranteed any username fallback is pure ASCII.
  // If this throws too, it propagates — the caller fails closed.
  const principal = sid ? `*${sid}` : (username as string);
  applyRestrictiveAclViaIcacls(filePath, principal);
}

function powershellPath(): string {
  return `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function powershellDaclArgs(): string[] {
  const encoded = Buffer.from(DACL_ONLY_REBUILD_SCRIPT, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

/**
 * Environment for the Windows PowerShell 5.1 child. PSModulePath is STRIPPED:
 * when wmux is launched from a PowerShell 7 shell (Store install), the
 * inherited PSModulePath leads with pwsh 7's Core-edition Modules directory —
 * the 5.1 child then auto-loads the CORE Microsoft.PowerShell.Management/
 * Security modules for cmdlets like Get-Item, fails
 * (CommandNotFoundException: "module could not be loaded"), and the DACL
 * rebuild silently degrades to the icacls fallback, weakening the #124
 * explicit-ACE protection. With the variable absent, 5.1 reconstructs its own
 * default module path and the .NET rebuild works regardless of which shell
 * spawned us. (Found via the S-A boot traces: the measured "harden" time on a
 * pwsh7-launched dev box was actually a failing PowerShell + icacls fallback.)
 */
function childPsEnv(filePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WMUX_ACL_TARGET: filePath };
  // Case-insensitive strip: Windows env vars are case-insensitive, and the
  // spread above copies whichever single casing the parent happened to set
  // (PSModulePath / psmodulepath / ...). A cased `delete` would miss variants.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  return env;
}

/** Synchronous PowerShell DACL rebuild. Returns true on success, false when
 *  PowerShell is absent or failed (caller decides on the fallback). */
function tryPowershellDaclRebuildSync(
  filePath: string,
  sid: string | null,
  username?: string,
): boolean {
  const powershell = powershellPath();
  if (!fs.existsSync(powershell)) return false;
  try {
    execFileSync(powershell, powershellDaclArgs(), {
      input: JSON.stringify({ sid, username }),
      env: childPsEnv(filePath),
      windowsHide: true,
      // stdin carries the identity payload; stdout is ignored so the child's
      // CLIXML progress stream never leaks into the daemon's own stdout;
      // stderr is captured so a real failure message rides the thrown error.
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    return true;
  } catch (psErr) {
    // PowerShell present but unusable — degrade to icacls.
    console.warn(
      `[applyRestrictiveWindowsAcl] PowerShell DACL rebuild failed for ${filePath}; ` +
        `falling back to icacls:`,
      psErr,
    );
    return false;
  }
}

/** Async twin of tryPowershellDaclRebuildSync for the deferred re-harden path.
 *  spawn (not execFile) because the identity payload goes over stdin. */
function tryPowershellDaclRebuildAsync(
  filePath: string,
  sid: string | null,
  username?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const powershell = powershellPath();
    if (!fs.existsSync(powershell)) { resolve(false); return; }
    let settled = false;
    const settle = (ok: boolean, why?: unknown) => {
      if (settled) return;
      settled = true;
      if (!ok && why !== undefined) {
        console.warn(
          `[applyRestrictiveWindowsAcl] async PowerShell DACL rebuild failed for ${filePath}; ` +
            `falling back to icacls:`,
          why,
        );
      }
      resolve(ok);
    };
    try {
      const child = spawn(powershell, powershellDaclArgs(), {
        env: childPsEnv(filePath),
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => settle(false, err));
      child.on('close', (code) => {
        if (code === 0) settle(true);
        else settle(false, new Error(`powershell exited ${code}: ${stderr.slice(0, 500)}`));
      });
      child.stdin?.on('error', () => { /* surfaced via 'close' with non-zero code */ });
      child.stdin?.write(JSON.stringify({ sid, username }));
      child.stdin?.end();
    } catch (err) {
      settle(false, err);
    }
  });
}

/** Async icacls fallback for the deferred re-harden path. */
function applyRestrictiveAclViaIcaclsAsync(filePath: string, principal: string): Promise<void> {
  const icacls = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\icacls.exe`;
  const args = [filePath, '/grant:r', `${principal}:F`, '/inheritance:r'];
  for (const broadSid of WELL_KNOWN_BROAD_SIDS) {
    args.push('/remove:g', `*${broadSid}`);
  }
  return new Promise((resolve, reject) => {
    execFile(icacls, args, { windowsHide: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Fast hardening for a token file that did NOT exist before we wrote it
 * (cold-start S-A optimization). icacls-FIRST, PowerShell fallback —
 * deliberately inverted from applyRestrictiveWindowsAclInner.
 *
 * Why icacls is sufficient here and only here: the issue #124 leak is that
 * `icacls /grant:r /inheritance:r` cannot remove a PRE-EXISTING EXPLICIT broad
 * ACE (e.g. Everyone:(R) stamped by a redirected profile). A file we just
 * created carries only INHERITED ACEs — `/inheritance:r` strips all of those,
 * leaving exactly the owner FullControl grant. The explicit-ACE failure mode
 * is unreachable on a just-created file, so the fast primitive (~50-100ms
 * process start) is security-equivalent to the PowerShell rebuild (~1-2s under
 * AV) on this path. Overwrites of an EXISTING file (token rotation, empty-file
 * repair) must keep the PowerShell-first path — see secureWriteTokenFile.
 *
 * Fail-closed contract preserved: if icacls fails AND the PowerShell rebuild
 * fails, this throws and the caller deletes the token.
 */
function applyRestrictiveWindowsAclForFreshFile(filePath: string): void {
  const aclStart = Date.now();
  try {
    const { sid, username } = resolveOwnerIdentity(filePath);
    const principal = sid ? `*${sid}` : (username as string);
    try {
      applyRestrictiveAclViaIcacls(filePath, principal);
      return;
    } catch (icaclsErr) {
      console.warn(
        `[applyRestrictiveWindowsAcl] icacls fast path failed for fresh ${filePath}; ` +
          `falling back to PowerShell DACL rebuild:`,
        icaclsErr,
      );
    }
    if (!tryPowershellDaclRebuildSync(filePath, sid, username)) {
      throw new Error(`both icacls and PowerShell ACL hardening failed for ${filePath}`);
    }
  } finally {
    console.log(`[security] fresh token ACL harden took ${Date.now() - aclStart}ms (${path.basename(filePath)})`);
  }
}

/**
 * Rename delays for the win32 commit retry, mirroring
 * `daemon/util/atomicWrite/core.ts`.
 *
 * NOT imported from there: `shared/` is consumed by the renderer and preload
 * and must not depend on `daemon/`, and that module's writer unconditionally
 * rotates the previous file to `.bak` — which for a token file would leave a
 * second, unhardened copy of live credentials on disk. The retry POLICY is
 * what transfers; the writer around it is not.
 */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160];

/** Rename failures that antivirus holding a just-written handle produces. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Block without burning CPU. Matches atomicWrite's sync sleep. */
function sleepSyncMs(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/**
 * `fs.renameSync` with the retry the platform actually needs.
 *
 * On Windows a scanner can hold the handle of a file we JUST wrote — and this
 * path guarantees a scan, because it runs icacls over the temp file
 * immediately beforehand. A bare rename therefore throws intermittently in
 * exactly the environment this whole function exists to serve. Documented in
 * `atomicWrite/core.ts` against the same failure (#658).
 *
 * POSIX has no such contention: rename is atomic and does not fail on a busy
 * file, so the loop exits on the first attempt there.
 */
function renameWithTransientRetrySync(from: string, to: string): void {
  const delays = process.platform === 'win32' ? RENAME_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const transient = code !== undefined && TRANSIENT_RENAME_CODES.has(code);
      if (!transient || attempt >= delays.length) throw err;
      sleepSyncMs(delays[attempt]!);
    }
  }
}

/**
 * Replace a token file that is written REPEATEDLY, without paying the
 * overwrite penalty and without opening a deferred-hardening window.
 *
 * `secureWriteTokenFile` writes in place, and an in-place overwrite is exactly
 * what forces the expensive branch: `writeFileSync` preserves the existing
 * file's ACL, so any broad EXPLICIT ACE already on it survives, and only the
 * PowerShell DACL rebuild removes one. That rebuild measures 1.8-3.8s under AV,
 * which is fine once at first creation and not fine on every mutation — a
 * registry the user edits from a modal would stall the process for seconds per
 * click.
 *
 * The way out is to stop overwriting. Writing a NEW inode and renaming it over
 * the target sidesteps the reason the slow path exists: a freshly created file
 * carries only INHERITED ACEs, which is precisely the case
 * `applyRestrictiveWindowsAclForFreshFile` is documented as security-equivalent
 * for. The DACL travels with the file through the rename, so the replacement is
 * already hardened the moment it becomes visible under the real name.
 *
 * Deliberately NOT the deferred re-harden `DeviceStore` uses. That store can
 * afford a window between rename and hardening because its file holds no
 * secret — salts and scrypt outputs are useless without a secret that is never
 * written down. A token file cannot afford it: the bytes on disk ARE the
 * credential, so the hardening happens synchronously, BEFORE the rename
 * publishes them.
 *
 * Fail-closed, and the failure cannot damage what is already there: everything
 * happens on the temp file, and any error deletes it and throws with the
 * previous file untouched. The rename is atomic, so a crash mid-write can no
 * longer leave a half-written registry — which plain `writeFileSync` could.
 */
export function secureReplaceTokenFile(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // First write ever: there is nothing to replace, and `secureWriteTokenFile`
  // already takes the fresh-file fast path. Delegating keeps one definition of
  // what a freshly created token file must look like.
  if (!fs.existsSync(filePath)) {
    secureWriteTokenFile(filePath, contents);
    return;
  }

  // Same directory: rename is only atomic within a volume, and the temp file
  // must inherit the SAME ACEs the real file would, or hardening it would be
  // measuring the wrong parent.
  //
  // The name is RANDOM, not pid+timestamp. A predictable path in a directory an
  // attacker can write to is a symlink-plant: they pre-create the name, our
  // write follows the link, and the credential lands wherever they pointed it.
  // Cheap to remove as a question, so it is removed.
  const tmp = `${filePath}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    // O_EXCL is the real guard: creation FAILS if the path already exists,
    // including as a symlink, so a planted link is refused rather than
    // followed. O_NOFOLLOW is belt-and-braces on POSIX (0 on Windows). The
    // 0600 mode applies to the inode at birth, so there is no instant where
    // the file exists more permissively on POSIX.
    fd = fs.openSync(
      tmp,
      // eslint-disable-next-line no-bitwise
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );

    // HARDEN BEFORE CONTENT, on Windows specifically.
    //
    // The in-place path never had an exposure window: it wrote into a file
    // that was already hardened, because writeFileSync preserves the existing
    // ACL. Creating a fresh inode gives up that property — a brand-new file
    // carries only the parent's inherited ACEs, which may be broad. Writing
    // the token first and hardening second would open a window this function
    // is supposed to be closing, so the order is inverted: the empty file is
    // locked down, and only then does the credential go into it.
    if (process.platform === 'win32') {
      applyRestrictiveWindowsAclForFreshFile(tmp);
    }

    fs.writeFileSync(fd, contents, { encoding: 'utf8' });
    // Durability before the rename: without it, "a crash can no longer leave a
    // half-written registry" is not a claim this function can make. A
    // write+rename with no fsync can surface as a zero-length file after a
    // crash on ext4 data=ordered or APFS — and `load()` folds a parse failure
    // into an empty list, so the operator would just see every remote host
    // gone. Mirrors `atomicWrite/core.ts`'s durable path.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    renameWithTransientRetrySync(tmp, filePath);

    // Durability of the directory ENTRY the rename created. Skipped on win32,
    // which does not support directory-handle fsync — the file itself is
    // already durable there via the fsync above. Best-effort: the data is
    // committed either way.
    if (process.platform !== 'win32') {
      try {
        const dirFd = fs.openSync(dir, 'r');
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        // Directory fsync is unavailable on some filesystems; not fatal.
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed, or never validly opened.
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch (unlinkErr) {
      // NOT silent. If this fails on Windows — a scanner still holding the
      // handle — a copy of the credential registry stays on disk under the
      // temp name. It is owner-only (hardened before the content went in), but
      // the operator should still be told it is there. `sweepStaleTokenTemps`
      // clears it on the next load.
      const code = (unlinkErr as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        console.warn(`[secureReplaceTokenFile] could not remove temp file ${tmp}:`, unlinkErr);
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to securely replace ${filePath}: ${message}`);
  }
}

/**
 * Delete leftover `secureReplaceTokenFile` temp files next to a token file.
 *
 * A crash between write and rename, or an unlink that lost a race with a
 * scanner, leaves a full copy of the credentials under a temp name. They are
 * created owner-only so the exposure is bounded, but "bounded" is not "gone" —
 * nothing else in the tree ever looks at these, so without a sweep they
 * accumulate for the life of the install.
 *
 * Best-effort by design: called from a load path, where failing to tidy up
 * must never stop the caller from reading its file.
 */
export function sweepStaleTokenTemps(filePath: string): void {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // Still held, or already gone. The next load tries again.
    }
  }
}

export function secureWriteTokenFile(filePath: string, token: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // The fresh-vs-overwrite distinction is security-relevant (S-A cold-start):
  // writeFileSync PRESERVES the ACL of an existing file, so an overwrite
  // (token rotation, empty-file repair) may carry pre-existing EXPLICIT broad
  // ACEs that only the PowerShell DACL rebuild removes (#124). A file that
  // did not exist before this write has only inherited ACEs, where the fast
  // icacls primitive is security-equivalent.
  const existedBefore = fs.existsSync(filePath);

  fs.writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600 });

  if (process.platform === 'win32') {
    try {
      if (existedBefore) {
        applyRestrictiveWindowsAcl(filePath);
      } else {
        applyRestrictiveWindowsAclForFreshFile(filePath);
      }
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
  } else {
    // `mode` only affects a newly-created inode. An overwrite of a file that
    // was restored or externally loosened to 0644 must repair it too.
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (modeErr) {
      console.warn('[secureWriteTokenFile] Could not set file mode:', modeErr);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best effort cleanup of an insecure token file.
      }
      const message = modeErr instanceof Error ? modeErr.message : String(modeErr);
      throw new Error(`Failed to set secure mode on ${filePath}: ${message}`);
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

/**
 * Deferred, fully-async variant of reHardenTokenFileAcl (cold-start S-A).
 *
 * Why this exists: the synchronous re-harden shells out to whoami.exe +
 * powershell.exe with execFileSync — measured 1.8-3.8s per process under AV
 * (main PipeServer ctor + daemon pipe start), ~70% of the entire cold start.
 * The re-harden target is an EXISTING token whose VALUE does not change: an
 * attacker able to read it during a deferred-harden window could equally have
 * read it at any point of its prior on-disk lifetime under the very ACL state
 * the re-harden exists to repair. Deferring the tightening by a second adds
 * nothing material to an exposure window that was already unbounded — while
 * the RPC surface itself stays protected by the token VALUE (timing-safe
 * compare), not by the file ACL.
 *
 * Fully async (execFile/spawn, never *Sync): merely scheduling a sync harden
 * with setImmediate would still freeze the event loop for seconds when it
 * runs — in the daemon that would stall the just-opened control pipe and time
 * out the launcher's first ping.
 *
 * Same best-effort contract as reHardenTokenFileAcl: failures are logged,
 * never thrown. Same primitive order as the sync path: PowerShell DACL
 * rebuild first (#124 — only it removes pre-existing explicit broad ACEs),
 * icacls fallback.
 */
export function scheduleTokenFileReHarden(filePath: string): void {
  setImmediate(() => {
    void (async () => {
      const aclStart = Date.now();
      try {
        if (process.platform !== 'win32') {
          await fs.promises.chmod(filePath, 0o600);
          return;
        }
        const { sid, username } = await resolveOwnerIdentityAsync(filePath);
        if (await tryPowershellDaclRebuildAsync(filePath, sid, username)) {
          return;
        }
        const principal = sid ? `*${sid}` : (username as string);
        await applyRestrictiveAclViaIcaclsAsync(filePath, principal);
      } catch (err) {
        console.warn(`[scheduleTokenFileReHarden] could not re-harden ${filePath}:`, err);
      } finally {
        console.log(
          `[security] deferred token ACL re-harden took ${Date.now() - aclStart}ms (${path.basename(filePath)})`,
        );
      }
    })();
  });
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';

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
 * Well-known broad principals stripped by SID on top of `/inheritance:r`.
 *   S-1-1-0      Everyone
 *   S-1-5-32-545 BUILTIN\Users
 *   S-1-5-11     Authenticated Users
 *   S-1-5-4      INTERACTIVE
 *
 * On a FRESH inode these are redundant — the file carries only inherited ACEs
 * and `/inheritance:r` drops all of them. They are kept as belt-and-braces for
 * the case where a parent directory somehow yields an explicit ACE at creation,
 * and they cost nothing: they ride along in the same single icacls invocation.
 */
const WELL_KNOWN_BROAD_SIDS = ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-4'];

/** Prefix-suffix for staging inodes used by the fresh-inode rewrite. The full
 *  staging name is per-operation unique — see stagingPathFor. */
const HARDEN_TMP_SUFFIX = '.harden-tmp';

/** Bounded attempts for the final swap. A rename over a file another process
 *  briefly holds open (AV scan, backup tool) fails with EPERM/EBUSY and
 *  usually clears within milliseconds. */
const SWAP_RETRY_ATTEMPTS = 3;

/** A staging inode this much older than "now" cannot belong to a live harden
 *  (they finish in well under a second) — it is a crash leftover. */
const STALE_STAGING_MS = 60_000;

let stagingSeq = 0;

/**
 * Per-operation unique staging path. A FIXED staging name let a deferred
 * async harden and a synchronous token rotation of the same file delete,
 * rewrite, or rename each other's staging inode — installing the wrong
 * payload in the worst interleaving (3-reviewer consensus finding).
 */
function stagingPathFor(filePath: string): string {
  stagingSeq += 1;
  return `${filePath}${HARDEN_TMP_SUFFIX}.${process.pid}.${stagingSeq}`;
}

/**
 * Remove crash leftovers: staging inodes for this file older than
 * STALE_STAGING_MS. Age-gated so a concurrent in-flight harden's staging
 * inode (milliseconds old) is never swept out from under it. Leftovers are
 * owner-only and hold STALE content (the staging inode is hardened while
 * still empty), so leaving them for up to a minute exposes nothing.
 * `recursive` so a directory squatting on a staging name cannot wedge
 * hardening forever (EISDIR on every subsequent rm without it).
 */
function sweepStaleStaging(filePath: string): void {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}${HARDEN_TMP_SUFFIX}`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).mtimeMs > cutoff) continue;
      fs.rmSync(p, { force: true, recursive: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Outcome of a hardening attempt. Replaces the old boolean, which conflated
 * very different states and wired all of them to destructive fail-closed
 * branches.
 *
 *   'hardened'  — the DACL is now owner-only.
 *   'unchanged' — the rebuilt copy could not be swapped in, AND one of two
 *                 verified conditions holds: (a) the original file's DACL was
 *                 READ BACK and confirmed owner-only (icacls /save SDDL), or
 *                 (b) a newer write superseded this harden mid-flight — that
 *                 writer hardens its own output (secureWriteTokenFile) or has
 *                 re-armed its own deferred harden (DeviceStore). Either way
 *                 the file on disk is NOT weaker than documented. This is
 *                 never claimed on faith: an unverifiable swap failure is
 *                 'failed', not 'unchanged' (review finding — an upgrade boot
 *                 is exactly when the original ACL is the weak one).
 *   'failed'    — no locked-down file could be produced AND the original
 *                 could not be verified owner-only. THIS is the state
 *                 fail-closed callers must react to (discard the secret).
 */
export type HardenOutcome = 'hardened' | 'unchanged' | 'failed';

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
 * fail safe: secureWriteTokenFile aborts without ever writing the new token
 * (the previous file stays untouched); reHardenTokenFileAcl reports 'failed'
 * without touching the existing ACL — both strictly better than silently
 * re-locking the owner out.
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
function icaclsPath(): string {
  return `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\icacls.exe`;
}

/**
 * Read a file's DACL back as SDDL via `icacls <leaf> /save <out>` and check it
 * is EXACTLY owner-only: protected (P, optionally AI/AR), a single Allow ACE,
 * FullControl, for `sid`. Anything else — extra ACEs, deny ACEs, unresolvable
 * output, no SID to compare against — is NOT verified (returns false).
 *
 * This is what lets a swap failure honestly claim 'unchanged': the claim is
 * backed by reading the actual on-disk DACL, not by the assumption that
 * "we didn't touch it so it must be fine" (which is exactly wrong on an
 * upgrade boot, where the pre-existing ACL is the weak one).
 *
 * icacls /save resolves every principal to a raw SID in the SDDL, so the
 * comparison is codepage-proof (#90). Runs with cwd = the file's directory
 * because /save records the given (relative) name in its output header.
 */
function verifyOwnerOnlyDaclSync(filePath: string, sid: string | null): boolean {
  if (!sid) return false;
  stagingSeq += 1;
  const saveFile = path.join(os.tmpdir(), `wmux-dacl-verify-${process.pid}-${stagingSeq}`);
  try {
    execFileSync(icaclsPath(), [path.basename(filePath), '/save', saveFile], {
      cwd: path.dirname(filePath),
      windowsHide: true,
    });
    return sddlIsOwnerOnly(fs.readFileSync(saveFile, 'utf16le'), sid);
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(saveFile, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Async twin of verifyOwnerOnlyDaclSync for the deferred re-harden path. */
async function verifyOwnerOnlyDaclAsync(filePath: string, sid: string | null): Promise<boolean> {
  if (!sid) return false;
  stagingSeq += 1;
  const saveFile = path.join(os.tmpdir(), `wmux-dacl-verify-${process.pid}-${stagingSeq}`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        icaclsPath(),
        [path.basename(filePath), '/save', saveFile],
        { cwd: path.dirname(filePath), windowsHide: true },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return sddlIsOwnerOnly(await fs.promises.readFile(saveFile, 'utf16le'), sid);
  } catch {
    return false;
  } finally {
    try {
      await fs.promises.rm(saveFile, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** `icacls /save` output: a name line, then the SDDL line. Owner-only means
 *  D:P (optionally AI/AR) with exactly ONE Allow-FullControl ACE for `sid`. */
function sddlIsOwnerOnly(saveOutput: string, sid: string): boolean {
  const lines = saveOutput
    .split(/\r?\n/)
    .map((l) => l.replace(/^\uFEFF/, '').trim())
    .filter(Boolean);
  const sddl = lines.find((l) => l.startsWith('D:'));
  if (!sddl) return false;
  const m = sddl.match(/^D:P(?:AI|AR)?\(A;;FA;;;(S-[0-9-]+)\)$/);
  return m !== null && m[1] === sid;
}

function applyRestrictiveAclViaIcacls(filePath: string, principal: string): void {
  const icacls = icaclsPath();
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
 * Primitive choice (issue #124, revisited): the DACL is rebuilt by writing the
 * content through a FRESH inode rather than editing the live file's ACL.
 * `writeFileSync` PRESERVES an existing file's DACL — that is exactly why an
 * in-place write can never drop a pre-existing EXPLICIT broad ACE. A file that
 * did not exist before we created it carries only INHERITED ACEs, so
 * `/inheritance:r` on that fresh inode is sufficient and the custom-explicit-ACE
 * case becomes unreachable by construction.
 *
 * Why NOT the previous `powershell.exe -EncodedCommand` .NET rebuild:
 *   - Constrained Language Mode (AppLocker/WDAC, standard on managed fleets)
 *     blocks arbitrary .NET method invocation, so the script died on its FIRST
 *     call — `[Console]::In.ReadToEnd()` — with
 *     MethodInvocationNotSupportedInConstrainedLanguage. Measured 22/22 failures
 *     on a real corporate box, every one silently falling back to plain icacls,
 *     which leaves custom explicit ACEs in place. The whole installed base
 *     behind such a policy ran with weaker ACLs than SECURITY.md documents.
 *   - Norton Behavioral Protection flags the
 *     `-ExecutionPolicy Bypass -EncodedCommand` shape as IDP.HELU.PSE85 and
 *     blocks powershell.exe outright (GHSA-8fj2-47w9-jxq3).
 *   - The FIRST powershell.exe spawn inside an Electron process measured
 *     1.8-2.3 s (75-78 % of daemon cold start); this path measures ~42 ms.
 *
 * Why NOT `icacls /restore` with a hand-built DACL-only SDDL: it fails with
 * "Not all privileges or groups referenced are assigned to the caller" and
 * processes 0 files — the same privilege wall that rules out `Set-Acl`.
 *
 * Owner identity rule (issue #90): prefer the SID (pure ASCII, codepage-proof);
 * fall back to %USERNAME% ONLY when it is pure ASCII; refuse a non-ASCII/empty
 * name rather than re-introduce the icacls codepage mangle.
 */
function applyRestrictiveWindowsAcl(filePath: string): HardenOutcome {
  // Boot-phase diagnostics (S-A): this runs on EVERY cold start in both the
  // main process (PipeServer ctor → loadOrCreateToken) and the daemon
  // (DaemonPipeServer.start → loadOrCreateToken). Keep the timing log — it is
  // what attributed the old multi-second PowerShell tax in the boot traces.
  const aclStart = Date.now();
  try {
    return rewriteThroughFreshInode(filePath);
  } finally {
    console.log(`[security] token ACL harden took ${Date.now() - aclStart}ms (${path.basename(filePath)})`);
  }
}

/**
 * Stage a locked-down replacement beside the target, then swap it in.
 *
 *   discard stale tmp ─▶ create empty tmp ─▶ icacls owner-only ─▶ write payload ─▶ rename
 *                                                 │                    │
 *                                                 └── harden BEFORE ───┘
 *                                                     the secret lands, so a
 *                                                     crash mid-write never
 *                                                     leaves it readable
 *
 * Throws when no locked-down file could be produced ('failed' territory).
 * Returns 'unchanged' when only the final swap failed — the original file and
 * its ACL are untouched, which is NOT a security failure. See HardenOutcome.
 */
function rewriteThroughFreshInode(filePath: string): HardenOutcome {
  const { sid, username } = resolveOwnerIdentity(filePath);
  const principal = sid ? `*${sid}` : (username as string);
  const content = fs.readFileSync(filePath);
  sweepStaleStaging(filePath);
  const tmp = stagingPathFor(filePath);

  try {
    fs.writeFileSync(tmp, '', { mode: 0o600 });
    applyRestrictiveAclViaIcacls(tmp, principal);
    fs.writeFileSync(tmp, content);
  } catch (err) {
    discardStagingInode(tmp);
    throw err;
  }

  // Commit. The compare + rename pair runs in one synchronous block, so no
  // other in-process writer — sync or async — can interleave between them
  // (JS is single-threaded; only an `await` yields). This is what prevents
  // the lost-update race where a deferred harden renames a STALE snapshot
  // over a token that PipeServer.rotateToken() just rewrote.
  for (let attempt = 0; attempt < SWAP_RETRY_ATTEMPTS; attempt++) {
    try {
      if (!fs.readFileSync(filePath).equals(content)) {
        // A newer write superseded this harden. That writer owns the file
        // now and hardens its own output — installing our stale snapshot
        // would be the bug, not the fix.
        discardStagingInode(tmp);
        return 'unchanged';
      }
      fs.renameSync(tmp, filePath);
      return 'hardened';
    } catch {
      /* transient EPERM/EBUSY (AV/backup holding the file) — retry */
    }
  }

  discardStagingInode(tmp);
  if (verifyOwnerOnlyDaclSync(filePath, sid)) {
    console.warn(
      `[applyRestrictiveWindowsAcl] could not swap in the hardened copy of ${filePath}, ` +
        `but its current DACL was read back and verified owner-only.`,
    );
    return 'unchanged';
  }
  console.warn(
    `[applyRestrictiveWindowsAcl] could not swap in the hardened copy of ${filePath} ` +
      `and its current DACL could NOT be verified owner-only — reporting failure.`,
  );
  return 'failed';
}

/** Remove a staging inode. Best effort: it is already owner-only, so a leftover
 *  is not an exposure — sweepStaleStaging collects it after STALE_STAGING_MS.
 *  `recursive` so a directory squatting on the name cannot wedge cleanup. */
function discardStagingInode(tmp: string): void {
  try {
    fs.rmSync(tmp, { force: true, recursive: true });
  } catch {
    /* best effort */
  }
}

/** Async twin of rewriteThroughFreshInode for the deferred re-harden path.
 *  The EXPENSIVE steps (whoami, icacls, payload write) are fully async so the
 *  daemon's control pipe never stalls. The final COMMIT is deliberately a
 *  synchronous compare+rename block: that pair must be un-interleavable
 *  w.r.t. other in-process writers, and the two syscalls cost well under a
 *  millisecond. Same staging order as the sync twin — the staging inode is
 *  locked down BEFORE the payload lands in it. */
async function rewriteThroughFreshInodeAsync(filePath: string): Promise<HardenOutcome> {
  const { sid, username } = await resolveOwnerIdentityAsync(filePath);
  const principal = sid ? `*${sid}` : (username as string);
  const content = await fs.promises.readFile(filePath);
  sweepStaleStaging(filePath);
  const tmp = stagingPathFor(filePath);

  try {
    await fs.promises.writeFile(tmp, '', { mode: 0o600 });
    await applyRestrictiveAclViaIcaclsAsync(tmp, principal);
    await fs.promises.writeFile(tmp, content);
  } catch (err) {
    await discardStagingInodeAsync(tmp);
    throw err;
  }

  for (let attempt = 0; attempt < SWAP_RETRY_ATTEMPTS; attempt++) {
    // Synchronous commit block — see rewriteThroughFreshInode. An awaited
    // rename here would reopen the lost-update window: a sync write landing
    // between the compare and the rename's completion would be clobbered by
    // our stale snapshot.
    try {
      if (!fs.readFileSync(filePath).equals(content)) {
        await discardStagingInodeAsync(tmp);
        return 'unchanged'; // superseded by a newer write — see sync twin
      }
      fs.renameSync(tmp, filePath);
      return 'hardened';
    } catch {
      /* transient EPERM/EBUSY — back off and retry */
    }
    await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
  }

  await discardStagingInodeAsync(tmp);
  if (await verifyOwnerOnlyDaclAsync(filePath, sid)) {
    console.warn(
      `[scheduleTokenFileReHarden] could not swap in the hardened copy of ${filePath}, ` +
        `but its current DACL was read back and verified owner-only.`,
    );
    return 'unchanged';
  }
  console.warn(
    `[scheduleTokenFileReHarden] could not swap in the hardened copy of ${filePath} ` +
      `and its current DACL could NOT be verified owner-only — reporting failure.`,
  );
  return 'failed';
}

async function discardStagingInodeAsync(tmp: string): Promise<void> {
  try {
    await fs.promises.rm(tmp, { force: true, recursive: true });
  } catch {
    /* best effort — see discardStagingInode */
  }
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
 * Write `content` through a FRESH inode that is locked down BEFORE the payload
 * lands in it.
 *
 * This replaces the old fresh-vs-overwrite split. `writeFileSync` PRESERVES an
 * existing file's DACL, so overwriting in place could carry a pre-existing
 * EXPLICIT broad ACE straight through the write — the #124 leak. Staging a new
 * inode makes that unreachable: a file that did not exist before we created it
 * has only INHERITED ACEs, which `/inheritance:r` strips completely.
 *
 * Ordering is load-bearing: the staging inode is hardened while it is still
 * EMPTY, so a crash between the harden and the payload write can never leave a
 * readable secret behind.
 *
 * Fail-closed: the target is never touched until the rename, so a failure here
 * leaves no half-written, unhardened token on disk.
 */
function writeThroughHardenedFreshInode(filePath: string, content: string): void {
  const aclStart = Date.now();
  try {
    const { sid, username } = resolveOwnerIdentity(filePath);
    const principal = sid ? `*${sid}` : (username as string);
    sweepStaleStaging(filePath);
    const tmp = stagingPathFor(filePath);
    try {
      fs.writeFileSync(tmp, '', { mode: 0o600 });
      applyRestrictiveAclViaIcacls(tmp, principal);
      fs.writeFileSync(tmp, content, { encoding: 'utf8' });
    } catch (err) {
      discardStagingInode(tmp);
      throw err;
    }
    // Intentional replace — no content compare (unlike the re-harden path).
    // Bounded retries because the common failure is a transient EPERM/EBUSY
    // from an AV or backup tool briefly holding the target open.
    let lastErr: unknown;
    for (let attempt = 0; attempt < SWAP_RETRY_ATTEMPTS; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    discardStagingInode(tmp);
    throw lastErr;
  } finally {
    console.log(`[security] fresh token ACL harden took ${Date.now() - aclStart}ms (${path.basename(filePath)})`);
  }
}

export function secureWriteTokenFile(filePath: string, token: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (process.platform === 'win32') {
    try {
      writeThroughHardenedFreshInode(filePath, token);
    } catch (aclErr) {
      console.warn('[secureWriteTokenFile] Could not set file ACL:', aclErr);
      // Do NOT delete the file at filePath. The target only ever receives new
      // content via the atomic rename, so on failure it still holds the
      // PREVIOUS token under its previous ACL — untouched by us. The old
      // in-place implementation had to unlink here because the target already
      // held the NEW token under an unhardened ACL; deleting a working token
      // over a transient rename collision (3-reviewer consensus finding)
      // would lock the user out for no security gain.
      const message = aclErr instanceof Error ? aclErr.message : String(aclErr);
      throw new Error(`Failed to set secure ACL on ${filePath}: ${message}`);
    }
    return;
  }

  fs.writeFileSync(filePath, token, { encoding: 'utf8', mode: 0o600 });

  {
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
 * it couldn't tighten an existing file's permissions. Logs and reports the
 * outcome so callers can surface it without aborting.
 *
 * Returns a HardenOutcome, NOT a boolean. The distinction matters because the
 * fail-closed callers (PeerStore.persist unlinks the peer store;
 * loadOrCreateMachineKey regenerates the HMAC key, which invalidates the peer
 * file's MAC and drops every pairing) must fire on a real security failure and
 * NOT on "the swap didn't happen but nothing got weaker".
 *
 * NOTE (contract change): on win32 this now rewrites the file through a fresh
 * inode, so the file's identity changes even though its VALUE does not. Readers
 * see either the old or the new inode — the rename is atomic — and both hold
 * identical bytes.
 */
export function reHardenTokenFileAcl(filePath: string): HardenOutcome {
  try {
    if (process.platform === 'win32') {
      return applyRestrictiveWindowsAcl(filePath);
    }
    // POSIX: ensure owner-only read/write on the existing file.
    fs.chmodSync(filePath, 0o600);
    return 'hardened';
  } catch (err) {
    console.warn(`[reHardenTokenFileAcl] could not re-harden ${filePath}:`, err);
    return 'failed';
  }
}

/**
 * Deferred, fully-async variant of reHardenTokenFileAcl (cold-start S-A).
 *
 * Why this exists: the re-harden target is an EXISTING token whose VALUE does
 * not change. An attacker able to read it during a deferred-harden window could
 * equally have read it at any point of its prior on-disk lifetime under the very
 * ACL state the re-harden exists to repair. Deferring the tightening adds
 * nothing material to an exposure window that was already unbounded — while the
 * RPC surface itself stays protected by the token VALUE (timing-safe compare),
 * not by the file ACL.
 *
 * The deferral mattered far more when this shelled out to powershell.exe
 * (1.8-3.8 s per call, ~70 % of cold start). The fresh-inode rewrite costs
 * ~42 ms, so the async path is now cheap insurance rather than a necessity —
 * see the TODO about collapsing the sync/async split.
 *
 * Fully async (never *Sync): a sync harden merely deferred with setImmediate
 * would still freeze the event loop when it runs — in the daemon that would
 * stall the just-opened control pipe and time out the launcher's first ping.
 *
 * Same best-effort contract as reHardenTokenFileAcl: failures are logged, never
 * thrown.
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
        await rewriteThroughFreshInodeAsync(filePath);
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

import * as crypto from 'crypto';
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

/** Prefix-suffix for staging DIRECTORIES used by the fresh-inode rewrite.
 *  The full staging name is per-operation unique — see stagingPathFor;
 *  the staged payload lives at `<staging-dir>/staged`. */
const HARDEN_TMP_SUFFIX = '.harden-tmp';

/** Bounded attempts for the final swap. A rename over a file another process
 *  briefly holds open (AV scan, backup tool) fails with EPERM/EBUSY and
 *  usually clears within milliseconds. */
const SWAP_RETRY_ATTEMPTS = 3;

/** A staging inode this much older than "now" cannot belong to a live harden
 *  — it is a crash leftover. Generous (10 min) on purpose: a harden stalled
 *  behind a pathological AV scan must never have its staging swept out from
 *  under it by the NEXT harden of the same file (that rm would turn a slow
 *  harden into a destructive 'failed'). */
const STALE_STAGING_MS = 600_000;

/** Synchronous bounded sleep for swap retries. Atomics.wait is permitted on
 *  the Node main thread (unlike browsers); if SharedArrayBuffer is ever
 *  unavailable, skip the backoff rather than fail the harden. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* best effort */
  }
}

let stagingSeq = 0;

/** Trailing shape of a generated staging name after HARDEN_TMP_SUFFIX:
 *  `.<pid>.<seq>.<12 hex>`. The sweep matches this EXACTLY so a user file that
 *  merely starts with `<name>.harden-tmp` (e.g. a manual `...harden-tmp.backup`)
 *  is never treated as a crash artifact and deleted (codex round-3 P2). */
const STAGING_NAME_RE = /^\.\d+\.\d+\.[0-9a-f]{12}$/;

/**
 * Per-operation unique staging path. A FIXED staging name let a deferred
 * async harden and a synchronous token rotation of the same file delete,
 * rewrite, or rename each other's staging inode — installing the wrong
 * payload in the worst interleaving (3-reviewer consensus finding). The
 * random suffix additionally makes the name unguessable, so a principal with
 * create rights in the parent directory cannot pre-create the staging area
 * at a predicted name (codex round-3 P1).
 */
function stagingPathFor(filePath: string): string {
  stagingSeq += 1;
  const rand = crypto.randomBytes(6).toString('hex');
  return `${filePath}${HARDEN_TMP_SUFFIX}.${process.pid}.${stagingSeq}.${rand}`;
}

/**
 * Remove crash leftovers: staging areas for this file older than
 * STALE_STAGING_MS. Age-gated so a concurrent in-flight harden's staging
 * (seconds old at most) is never swept out from under it — that rm would
 * turn a merely slow harden into a destructive 'failed'. Leftovers hold
 * STALE content on owner-only inodes (files are born owner-only inside the
 * pre-hardened staging directory), so leaving them for the grace period
 * exposes nothing. `recursive` because staging areas ARE directories, and so
 * a file/dir squatting on a staging name cannot wedge cleanup forever.
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
    // Only names WE generate — never a user's `<name>.harden-tmp.backup`.
    if (!STAGING_NAME_RE.test(name.slice(prefix.length))) continue;
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
 *   'hardened'  — the file on disk now carries the owner-only DACL. Either the
 *                 rebuilt copy was swapped in, or — after a swap collision —
 *                 the IN-PLACE strip repaired the original and the DACL was
 *                 read back and verified owner-only. (ACL edits need only
 *                 WRITE_DAC, not exclusive access, so the in-place strip
 *                 succeeds even while an AV/backup tool still holds the file —
 *                 which is why the pre-rewrite implementation never collided.
 *                 The strip cannot remove a CUSTOM explicit ACE; verification
 *                 decides whether it was enough.)
 *   'unchanged' — a newer write superseded this harden mid-flight AND the
 *                 file's current DACL was read back and verified owner-only.
 *                 Never claimed on faith: an unverifiable superseding write
 *                 reports 'failed' (codex round-3 — an external writer could
 *                 otherwise smuggle a broad-ACL replacement past fail-closed).
 *   'failed'    — no owner-only file could be produced or verified. THIS is
 *                 the state fail-closed callers must react to (discard the
 *                 secret).
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
 * fail safe: secureWriteTokenFile aborts without ever writing the new token,
 * and — since an unresolved SID also makes the PREVIOUS token unverifiable —
 * removes that previous token rather than leave a file it cannot vouch for;
 * reHardenTokenFileAcl reports 'failed' without touching the existing ACL —
 * both strictly better than silently re-locking the owner out.
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
/** Exported for scripts/issue-124-acl-dynamic.mjs, which asserts this parser
 *  against REAL `icacls /save` output on a live machine \u2014 the guard that keeps
 *  sddlIsOwnerOnly honest across icacls format variations. @internal */
export function verifyOwnerOnlyDaclSync(filePath: string, sid: string | null): boolean {
  if (!sid) return false;
  let tmpDir: string | null = null;
  try {
    // mkdtemp: the save path must be unpredictable \u2014 a fixed/sequential name in
    // a world-writable tmpdir is a hardlink-plant target (GLM round-2 P3).
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-dacl-'));
    const saveFile = path.join(tmpDir, 'sddl');
    execFileSync(icaclsPath(), [path.basename(filePath), '/save', saveFile], {
      cwd: path.dirname(filePath),
      windowsHide: true,
    });
    return sddlIsOwnerOnly(fs.readFileSync(saveFile, 'utf16le'), sid);
  } catch {
    return false;
  } finally {
    if (tmpDir !== null) {
      try {
        fs.rmSync(tmpDir, { force: true, recursive: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/** Async twin of verifyOwnerOnlyDaclSync for the deferred re-harden path. */
async function verifyOwnerOnlyDaclAsync(filePath: string, sid: string | null): Promise<boolean> {
  if (!sid) return false;
  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wmux-dacl-'));
    const saveFile = path.join(tmpDir, 'sddl');
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
    if (tmpDir !== null) {
      try {
        await fs.promises.rm(tmpDir, { force: true, recursive: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * `icacls /save` output: a name line, then the SDDL line. Owner-only means the
 * DACL is protected (control flags contain P, with AI/AR tolerated in any
 * combination) and holds exactly ONE ACE: Allow, no ACE flags, FullControl,
 * for `sid`. Anything unrecognized fails CLOSED (returns false) \u2014 a false
 * negative costs a fail-closed regeneration, a false positive would bless a
 * weak ACL. Structural parse rather than one exact-match regex so real-world
 * control-flag orderings do not turn transient collisions destructive
 * (GLM round-2 P2); the dynamic harness pins this against live icacls output.
 */
function sddlIsOwnerOnly(saveOutput: string, sid: string): boolean {
  const lines = saveOutput
    .split(/\r?\n/)
    .map((l) => l.replace(/^\uFEFF/, '').trim())
    .filter(Boolean);
  const sddl = lines.find((l) => l.startsWith('D:'));
  if (!sddl) return false;
  const m = sddl.match(/^D:([A-Z]*)\((.+)\)$/);
  if (!m) return false;
  const flags = m[1];
  if (!flags.includes('P')) return false; // must be inheritance-protected
  if (!/^(?:P|AI|AR)+$/.test(flags)) return false; // no unknown control flags
  const aces = m[2].split(')(');
  return aces.length === 1 && aces[0] === `A;;FA;;;${sid}`;
}

function applyRestrictiveAclViaIcacls(
  filePath: string,
  principal: string,
  opts: { inheritable?: boolean } = {},
): void {
  // Order matters: icacls applies args left-to-right. Grant the owner Full
  // control FIRST so the owner holds an explicit WRITE_DAC ACE, THEN strip
  // inheritance. If `/inheritance:r` ran first, a caller whose edit rights came
  // only from inherited ACEs would lose them mid-command and the `/grant:r`
  // could fail, locking the owner out (caught by codex on PR #140).
  //
  // `inheritable` targets a STAGING DIRECTORY: (OI)(CI) makes the owner-only
  // grant inherit to files created inside it, so a staged secret is owner-only
  // from the very instant its inode exists.
  const grant = opts.inheritable ? `${principal}:(OI)(CI)F` : `${principal}:F`;
  const args = [filePath, '/grant:r', grant, '/inheritance:r'];
  for (const broadSid of WELL_KNOWN_BROAD_SIDS) {
    args.push('/remove:g', `*${broadSid}`);
  }
  execFileSync(icaclsPath(), args, { windowsHide: true });
}

/**
 * Create a hardened staging area for `filePath` and return the staging file
 * path inside it.
 *
 * Why a DIRECTORY and not a bare sibling file: a staging FILE created directly
 * in the token's directory carries that directory's inherited ACEs for the
 * window between creation and its own icacls. A process that opens a handle in
 * that window KEEPS it \u2014 Windows ACL changes do not revoke open handles \u2014 and
 * can read the secret written afterwards (codex round-2 P1; the old in-place
 * write never had this window because it wrote into the already-hardened
 * target inode). The empty directory is hardened first (nothing to leak), and
 * the file is then BORN owner-only via the (OI)(CI) inherited grant.
 */
function createHardenedStagingSync(filePath: string, principal: string): { dir: string; file: string } {
  sweepStaleStaging(filePath);
  const dir = stagingPathFor(filePath);
  fs.mkdirSync(dir);
  try {
    applyRestrictiveAclViaIcacls(dir, principal, { inheritable: true });
  } catch (err) {
    discardStagingInode(dir);
    throw err;
  }
  return { dir, file: path.join(dir, 'staged') };
}

/** Async twin of createHardenedStagingSync. */
async function createHardenedStagingAsync(
  filePath: string,
  principal: string,
): Promise<{ dir: string; file: string }> {
  sweepStaleStaging(filePath);
  const dir = stagingPathFor(filePath);
  await fs.promises.mkdir(dir);
  try {
    await applyRestrictiveAclViaIcaclsAsync(dir, principal, { inheritable: true });
  } catch (err) {
    await discardStagingInodeAsync(dir);
    throw err;
  }
  return { dir, file: path.join(dir, 'staged') };
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
 *   mkdir staging dir ─▶ icacls dir owner-only ─▶ write payload ─▶ icacls file ─▶ commit
 *   (empty, leaks        (OI)(CI): children       (file is BORN     (explicit,     (compare+
 *    nothing)             inherit owner-only)      owner-only)       protected)     rename)
 *
 * The payload never exists on an inode that was ever broad-readable: the dir
 * is hardened while empty, and the file inherits owner-only at creation. A
 * staging FILE hardened after creation would leave a window in which another
 * process could open a handle — Windows ACL changes do not revoke open
 * handles (codex round-2 P1).
 *
 * Throws when no locked-down file could be produced ('failed' territory).
 * Returns 'unchanged' only under a VERIFIED condition — see HardenOutcome.
 */
function rewriteThroughFreshInode(filePath: string): HardenOutcome {
  const { sid, username } = resolveOwnerIdentity(filePath);
  const principal = sid ? `*${sid}` : (username as string);

  // A file opened with FILE_SHARE_NONE — what several AV and backup products
  // do while scanning — cannot be READ at all, so the staged rewrite is
  // impossible before it even begins. Live dogfood caught this: the snapshot
  // read threw EBUSY and the whole harden reported 'failed', re-arming the
  // very self-DoS the collision handling exists to prevent (PeerStore then
  // unlinks the store / regenerates the machine key and drops every pairing).
  // Reading the SECURITY DESCRIPTOR is not blocked by share modes, and an ACL
  // edit needs only WRITE_DAC, so the in-place path still works here.
  let content: Buffer;
  try {
    content = fs.readFileSync(filePath);
  } catch (readErr) {
    console.warn(
      `[applyRestrictiveWindowsAcl] ${filePath} is locked against reads; ` +
        `skipping the staged rewrite and repairing the DACL in place:`,
      readErr,
    );
    return repairInPlaceAndVerifySync(filePath, principal, sid);
  }

  const { dir, file } = createHardenedStagingSync(filePath, principal);

  try {
    // Born owner-only via the staging dir's (OI)(CI) grant; `wx` (exclusive
    // create) makes an attacker-pre-created file or planted hardlink at this
    // name an immediate failure instead of a write into a hostile inode
    // (codex round-3 P1). The explicit per-file harden then makes the final
    // DACL identical to the documented shape (protected, one explicit owner
    // ACE) with no exposure window.
    fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    applyRestrictiveAclViaIcacls(file, principal);
  } catch (err) {
    discardStagingInode(dir);
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
        // now — installing our stale snapshot would be the bug, not the
        // fix. But "a newer write exists" is not proof it is SAFE: an
        // in-process writer hardens its own output, an external one may
        // not. Verify before reporting 'unchanged' (codex round-3 P1).
        discardStagingInode(dir);
        return verifyOwnerOnlyDaclSync(filePath, sid) ? 'unchanged' : 'failed';
      }
      fs.renameSync(file, filePath);
      discardStagingInode(dir);
      return 'hardened';
    } catch {
      /* transient EPERM/EBUSY (AV/backup holding the file) — retry */
    }
    // Backoff between attempts (never after the last): back-to-back retries
    // finish before a tens-of-ms AV hold clears, which turned transient
    // collisions into destructive 'failed's (codex+GLM round-2 consensus).
    if (attempt < SWAP_RETRY_ATTEMPTS - 1) sleepSync(30 * (attempt + 1));
  }

  discardStagingInode(dir);
  return repairInPlaceAndVerifySync(filePath, principal, sid);
}

/**
 * LAST RESORT (GLM round-3): repair the DACL IN PLACE, then read it back.
 *
 * ACL edits need only WRITE_DAC, not exclusive access, and reading a security
 * descriptor is not subject to file share modes — so this works on a file that
 * an AV or backup tool holds open, which is exactly the case that defeats both
 * the snapshot read and the rename. (It is also why the pre-rewrite in-place
 * implementation never collided at all.)
 *
 * For the dominant collision case — a fresh inode carrying ONLY inherited ACEs,
 * e.g. the one atomicWriteJSONSync just renamed in — the strip is
 * security-equivalent to the staged rewrite, turning what would be a
 * destructive 'failed' into an honest 'hardened'. It cannot remove a CUSTOM
 * explicit ACE (#124), so the read-back is what decides: unverified stays
 * 'failed' and the fail-closed callers fire as designed.
 */
function repairInPlaceAndVerifySync(
  filePath: string,
  principal: string,
  sid: string | null,
): HardenOutcome {
  try {
    applyRestrictiveAclViaIcacls(filePath, principal);
  } catch {
    /* verification decides */
  }
  if (verifyOwnerOnlyDaclSync(filePath, sid)) {
    console.warn(
      `[applyRestrictiveWindowsAcl] staged swap unavailable for ${filePath}; DACL repaired ` +
        `in place and read back owner-only.`,
    );
    return 'hardened';
  }
  console.warn(
    `[applyRestrictiveWindowsAcl] could not swap in or repair ${filePath}, and its current ` +
      `DACL could NOT be verified owner-only — reporting failure.`,
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

  // Read-locked target (FILE_SHARE_NONE) — see the sync twin.
  let content: Buffer;
  try {
    content = await fs.promises.readFile(filePath);
  } catch (readErr) {
    console.warn(
      `[scheduleTokenFileReHarden] ${filePath} is locked against reads; ` +
        `skipping the staged rewrite and repairing the DACL in place:`,
      readErr,
    );
    return repairInPlaceAndVerifyAsync(filePath, principal, sid);
  }

  const { dir, file } = await createHardenedStagingAsync(filePath, principal);

  try {
    await fs.promises.writeFile(file, content, { mode: 0o600, flag: 'wx' });
    await applyRestrictiveAclViaIcaclsAsync(file, principal);
  } catch (err) {
    await discardStagingInodeAsync(dir);
    throw err;
  }

  for (let attempt = 0; attempt < SWAP_RETRY_ATTEMPTS; attempt++) {
    // Synchronous commit block — see rewriteThroughFreshInode. An awaited
    // rename here would reopen the lost-update window: a sync write landing
    // between the compare and the rename's completion would be clobbered by
    // our stale snapshot.
    try {
      if (!fs.readFileSync(filePath).equals(content)) {
        // Superseded by a newer write — verify before trusting (sync twin).
        await discardStagingInodeAsync(dir);
        return (await verifyOwnerOnlyDaclAsync(filePath, sid)) ? 'unchanged' : 'failed';
      }
      fs.renameSync(file, filePath);
      await discardStagingInodeAsync(dir);
      return 'hardened';
    } catch {
      /* transient EPERM/EBUSY — back off and retry */
    }
    // Never sleep after the final attempt — the in-place repair follows.
    if (attempt < SWAP_RETRY_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }

  await discardStagingInodeAsync(dir);
  return repairInPlaceAndVerifyAsync(filePath, principal, sid);
}

/** Async twin of repairInPlaceAndVerifySync — same rationale. */
async function repairInPlaceAndVerifyAsync(
  filePath: string,
  principal: string,
  sid: string | null,
): Promise<HardenOutcome> {
  try {
    await applyRestrictiveAclViaIcaclsAsync(filePath, principal);
  } catch {
    /* verification decides */
  }
  if (await verifyOwnerOnlyDaclAsync(filePath, sid)) {
    console.warn(
      `[scheduleTokenFileReHarden] staged swap unavailable for ${filePath}; DACL repaired ` +
        `in place and read back owner-only.`,
    );
    return 'hardened';
  }
  console.warn(
    `[scheduleTokenFileReHarden] could not swap in or repair ${filePath}, and its current ` +
      `DACL could NOT be verified owner-only — reporting failure.`,
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

/** Async twin of applyRestrictiveAclViaIcacls. */
function applyRestrictiveAclViaIcaclsAsync(
  filePath: string,
  principal: string,
  opts: { inheritable?: boolean } = {},
): Promise<void> {
  const grant = opts.inheritable ? `${principal}:(OI)(CI)F` : `${principal}:F`;
  const args = [filePath, '/grant:r', grant, '/inheritance:r'];
  for (const broadSid of WELL_KNOWN_BROAD_SIDS) {
    args.push('/remove:g', `*${broadSid}`);
  }
  return new Promise((resolve, reject) => {
    execFile(icaclsPath(), args, { windowsHide: true }, (err) => {
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
 * Ordering is load-bearing: the staging DIRECTORY is hardened while it is
 * still empty and the payload file is born owner-only inside it (inherited
 * (OI)(CI) grant), so at no instant does the secret exist on a broad-readable
 * inode — see createHardenedStagingSync.
 *
 * Fail-closed: the target is never touched until the rename, so a failure here
 * leaves no half-written, unhardened token on disk.
 */
function writeThroughHardenedFreshInode(filePath: string, content: string): void {
  const aclStart = Date.now();
  // The fail-closed decision on failure needs the owner SID; capture whatever
  // identity resolution produced so the decision never re-shells to whoami —
  // a re-query can transiently fail and delete a perfectly safe previous
  // token (GLM round-3 P2).
  let sid: string | null = null;
  try {
    try {
      const identity = resolveOwnerIdentity(filePath);
      sid = identity.sid;
      const principal = sid ? `*${sid}` : (identity.username as string);
      const { dir, file } = createHardenedStagingSync(filePath, principal);
      try {
        fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        applyRestrictiveAclViaIcacls(file, principal);
      } catch (err) {
        discardStagingInode(dir);
        throw err;
      }
      // Intentional replace — no content compare (unlike the re-harden path).
      // Bounded retries with backoff because the common failure is a transient
      // EPERM/EBUSY from an AV or backup tool briefly holding the target open.
      let lastErr: unknown;
      for (let attempt = 0; attempt < SWAP_RETRY_ATTEMPTS; attempt++) {
        try {
          fs.renameSync(file, filePath);
          discardStagingInode(dir);
          return;
        } catch (err) {
          lastErr = err;
        }
        if (attempt < SWAP_RETRY_ATTEMPTS - 1) sleepSync(30 * (attempt + 1));
      }
      discardStagingInode(dir);
      throw lastErr;
    } catch (err) {
      // The target only ever receives new content via the atomic rename, so
      // on failure it holds the PREVIOUS token — untouched by us. Keep it
      // ONLY when its DACL verifies owner-only: deleting a verified-safe
      // token over a transient collision locks the user out for nothing
      // (round-1 review), while silently keeping an UNVERIFIED one would let
      // a broad-readable leftover (backup restore, pre-#124 build) survive
      // the very write path that used to fail closed on it (GLM round-2 P2).
      let previousVerified = false;
      try {
        previousVerified = fs.existsSync(filePath) && verifyOwnerOnlyDaclSync(filePath, sid);
      } catch {
        /* unverifiable → fail closed below */
      }
      if (!previousVerified) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Best effort cleanup of an unverifiable token file.
        }
      }
      throw err;
    }
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
      // The fail-closed keep-or-unlink decision already ran inside
      // writeThroughHardenedFreshInode, with the identity it resolved.
      console.warn('[secureWriteTokenFile] Could not set file ACL:', aclErr);
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
 * identical bytes. Inode-identity side effects (GLM round-3): an fs.watch on
 * the file sees a rename event; a hardlink or cached fd keeps pointing at the
 * OLD inode. No wmux consumer does either today — token/key readers are
 * open-read-close and the only fs.watch users target .git/HEAD and transcript
 * dirs — but a future watcher on a token file must account for this.
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

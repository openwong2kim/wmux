#!/usr/bin/env node
/**
 * Issue #124 dynamic verification — Windows token-file DACL hardening.
 *
 * Drives the REAL compiled src/shared/security.ts (not mocks: the vitest unit
 * tests stub execFileSync, so they prove argv shape but NEVER actually rebuild
 * a DACL or hit the SeSecurityPrivilege failure that sank PR #124). This harness
 * compiles security.ts to a temp ESM module, imports the genuine
 * `reHardenTokenFileAcl` / `secureWriteTokenFile`, and runs them against three
 * seeded on-disk states:
 *
 *   (a) fresh-inherited        — a file with ONLY inherited ACEs (first-launch
 *                                happy path under %USERPROFILE%).
 *   (b) shipped-icacls-state   — D:PAI(A;;FA;;;<owner>), i.e. the DACL the
 *                                v2.14.0+ `icacls /grant:r *<sid>:F /inheritance:r`
 *                                flow leaves. This is the EXACT state where the
 *                                closed PR #124 `Set-Acl` rebuild threw
 *                                PrivilegeNotHeldException (SeSecurityPrivilege)
 *                                10/10 — the decisive regression.
 *   (c) explicit-everyone      — fresh + an EXPLICIT Everyone:(R) ACE (the
 *                                world-readable leak the old icacls /grant:r
 *                                could not strip).
 *
 * For each state it asserts, against the real function:
 *   1. it does NOT throw (esp. the (b) upgrade case),
 *   2. the resulting DACL contains exactly ONE access rule — owner FullControl,
 *      no Everyone / Users / SYSTEM / Administrators / inherited entries,
 *   3. the owner can still READ the token back (no self-lockout).
 *
 * It also asserts the original LEAK is real by checking that the old
 * `icacls /grant:r *<sid>:F /inheritance:r` flow leaves Everyone:(R) intact on
 * state (c) BEFORE the fix runs.
 *
 * Windows-only. On non-win32 it prints SKIP and exits 0.
 *
 * Run: node scripts/issue-124-acl-dynamic.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// import.meta.dirname is undefined before Node 20.11; package.json supports
// node >=18, so derive the script directory from the module URL instead.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SECURITY_TS = path.join(REPO_ROOT, 'src', 'shared', 'security.ts');
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const ICACLS = path.join(SYS32, 'icacls.exe');
const POWERSHELL = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

if (process.platform !== 'win32') {
  console.log('issue-124-acl-dynamic: SKIP (not win32 — ACL semantics are Windows-only)');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Resolve the current owner SID exactly as the code under test will see it
// (security.ts uses `whoami /user /fo list`; this is the same value).
// ---------------------------------------------------------------------------
function currentSid() {
  const out = execFileSync(path.join(SYS32, 'whoami.exe'), ['/user', '/fo', 'list'], {
    windowsHide: true,
  }).toString('utf8');
  const m = out.match(/^\s*SID\s*:\s*(S-\S+)\s*$/im);
  if (!m) throw new Error('could not resolve current SID via whoami');
  return m[1];
}
const OWNER_SID = currentSid();

// ---------------------------------------------------------------------------
// Compile the REAL security.ts to a temp ESM module and import it. esbuild keeps
// it dependency-free (only node builtins), so the genuine functions run here.
// ---------------------------------------------------------------------------
async function loadRealSecurityModule() {
  const require = (await import('node:module')).createRequire(import.meta.url);
  const esbuild = require('esbuild');
  const outFile = path.join(os.tmpdir(), `wmux-security-${process.pid}-${Date.now()}.mjs`);
  esbuild.buildSync({
    entryPoints: [SECURITY_TS],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outFile).href);
  fs.rmSync(outFile, { force: true });
  return mod;
}

// ---------------------------------------------------------------------------
// PowerShell helpers to seed + inspect on-disk ACL state. These set up the
// world the code under test then operates on; they are NOT the thing being
// verified (the code under test is the imported security.ts function).
// ---------------------------------------------------------------------------
// `targetPath`, when given, is passed to the script as $env:WMUX_DT_PATH rather
// than interpolated into the command string — a path containing an apostrophe
// (e.g. C:\Users\O'Neil\...) would otherwise break a single-quoted PS literal.
// Scripts read the file via `-LiteralPath $env:WMUX_DT_PATH`.
function ps(script, targetPath) {
  // $ProgressPreference suppresses the CLIXML progress records PowerShell
  // otherwise streams for Get-Acl/Set-Acl, which only clutters this harness'
  // output (the seeding/inspection is scaffolding, not the code under test).
  return execFileSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ProgressPreference='SilentlyContinue'; ${script}`],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: targetPath === undefined ? process.env : { ...process.env, WMUX_DT_PATH: targetPath },
    },
  ).toString('utf8').trim();
}

function makeTempToken() {
  const p = path.join(os.tmpdir(), `wmux-tok-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, 'secret-token-xyz', { encoding: 'utf8', mode: 0o600 });
  return p;
}

function seedExplicitEveryoneRead(p) {
  ps(
    `$p = $env:WMUX_DT_PATH;` +
      `$a = Get-Acl -LiteralPath $p;` +
      `$e = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::WorldSid, $null);` +
      `$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($e,'Read','Allow')));` +
      `Set-Acl -LiteralPath $p -AclObject $a`,
    p,
  );
}

// Reproduce the shipped v2.14.0+ on-disk state with the OLD icacls flow.
function seedShippedIcaclsState(p) {
  execFileSync(ICACLS, [p, '/grant:r', `*${OWNER_SID}:F`, '/inheritance:r'], { windowsHide: true });
}

// Returns the DACL as an array of { sid, rights, type, inherited }.
function readDacl(p) {
  const json = ps(
    `$acl = Get-Acl -LiteralPath $env:WMUX_DT_PATH;` +
      `$acl.Access | ForEach-Object {` +
      `  $s = try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $_.IdentityReference.Value };` +
      `  [pscustomobject]@{ sid=$s; rights=[int]$_.FileSystemRights; type=[string]$_.AccessControlType; inherited=$_.IsInherited }` +
      `} | ConvertTo-Json -Compress`,
    p,
  );
  if (!json) return [];
  const parsed = JSON.parse(json);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function ownerCanRead(p) {
  try {
    return fs.readFileSync(p, 'utf8') === 'secret-token-xyz';
  } catch {
    return false;
  }
}

const FILE_FULL_CONTROL = 0x1f01ff; // FileSystemRights.FullControl

// ---------------------------------------------------------------------------
function assertOwnerOnly(label, p) {
  const dacl = readDacl(p);
  const nonOwner = dacl.filter((a) => a.sid !== OWNER_SID);
  const ownerAces = dacl.filter((a) => a.sid === OWNER_SID && a.type === 'Allow');
  const ownerHasFullControl = ownerAces.some((a) => (a.rights & FILE_FULL_CONTROL) === FILE_FULL_CONTROL);
  check(
    `${label}: DACL is owner-only (1 ACE, owner FullControl, no inherited/broad)`,
    dacl.length === 1 && nonOwner.length === 0 && ownerHasFullControl && !dacl[0].inherited,
    `aces=${JSON.stringify(dacl)}`,
  );
  check(`${label}: owner can still read the token back`, ownerCanRead(p));
}

async function main() {
  console.log(`issue-124-acl-dynamic — owner SID ${OWNER_SID}`);
  console.log(`PowerShell present: ${fs.existsSync(POWERSHELL)} (primary .NET path)\n`);
  const { reHardenTokenFileAcl, secureWriteTokenFile } = await loadRealSecurityModule();

  // ---- (a) fresh-inherited: secureWriteTokenFile (the write path) ----
  console.log('CASE (a) fresh-inherited — secureWriteTokenFile then reHarden');
  {
    const p = path.join(os.tmpdir(), `wmux-fresh-${process.pid}-${Math.random().toString(36).slice(2)}`);
    let threw = null;
    try {
      secureWriteTokenFile(p, 'secret-token-xyz'); // real write path: writes + hardens
    } catch (e) {
      threw = e;
    }
    check('(a) secureWriteTokenFile did NOT throw', threw === null, threw ? String(threw.message) : '');
    if (!threw) {
      assertOwnerOnly('(a)', p);
      // and the re-harden path on the now-hardened file is idempotent + no throw
      const ok = reHardenTokenFileAcl(p);
      check('(a) reHardenTokenFileAcl returned true (idempotent re-harden)', ok === true);
      assertOwnerOnly('(a) after re-harden', p);
    }
    fs.rmSync(p, { force: true });
  }

  // ---- (b) shipped-icacls-state: the decisive upgrade case ----
  console.log('\nCASE (b) shipped-icacls-state — the upgrade path that threw SeSecurityPrivilege in PR #124');
  {
    const p = makeTempToken();
    seedShippedIcaclsState(p);
    const before = readDacl(p);
    check(
      '(b) precondition: file is in shipped icacls state (owner-only, protected)',
      before.length === 1 && before[0].sid === OWNER_SID && !before[0].inherited,
      `before=${JSON.stringify(before)}`,
    );
    let threw = null;
    let ret;
    try {
      ret = reHardenTokenFileAcl(p); // REAL re-harden — must NOT throw, must return true
    } catch (e) {
      threw = e;
    }
    check('(b) reHardenTokenFileAcl did NOT throw (no SeSecurityPrivilege)', threw === null, threw ? String(threw.message) : '');
    check('(b) reHardenTokenFileAcl returned true (success, not fail-soft)', ret === true);
    assertOwnerOnly('(b)', p);
    fs.rmSync(p, { force: true });
  }

  // ---- (c) explicit-everyone: the world-readable leak ----
  console.log('\nCASE (c) explicit-everyone — the leak old icacls /grant:r could not strip');
  {
    // First PROVE the leak is real: old icacls flow leaves Everyone:(R) intact.
    const leakProbe = makeTempToken();
    seedExplicitEveryoneRead(leakProbe);
    seedShippedIcaclsState(leakProbe); // old flow: grant owner + /inheritance:r
    const afterOldFlow = readDacl(leakProbe);
    const everyoneSurvivesOld = afterOldFlow.some((a) => a.sid === 'S-1-1-0');
    check('(c) LEAK CONFIRMED: old icacls /grant:r leaves explicit Everyone:(R)', everyoneSurvivesOld, `dacl=${JSON.stringify(afterOldFlow)}`);
    fs.rmSync(leakProbe, { force: true });

    // Now the fix: seed explicit Everyone, run the REAL re-harden, expect owner-only.
    const p = makeTempToken();
    seedExplicitEveryoneRead(p);
    let threw = null;
    let ret;
    try {
      ret = reHardenTokenFileAcl(p);
    } catch (e) {
      threw = e;
    }
    check('(c) reHardenTokenFileAcl did NOT throw', threw === null, threw ? String(threw.message) : '');
    check('(c) reHardenTokenFileAcl returned true', ret === true);
    assertOwnerOnly('(c) — Everyone:(R) removed', p);
    fs.rmSync(p, { force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exit(1);
  }
  console.log('ALL PASS — DACL-only rebuild is owner-only across (a)/(b)/(c), no SeSecurityPrivilege on the upgrade path.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

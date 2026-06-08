#!/usr/bin/env node
/**
 * PR #140 real-profile dynamic verification — Windows token-file DACL hardening
 * run against the REAL `%USERPROFILE%\.wmux\` directory rather than `%TEMP%`.
 *
 * Why this exists: `scripts/issue-124-acl-dynamic.mjs` proves the genuine
 * `secureWriteTokenFile` / `reHardenTokenFileAcl` produce an owner-only DACL
 * across the (a) fresh-inherited / (b) shipped-icacls / (c) explicit-Everyone
 * states — but it seeds those files under `%TEMP%` (…\AppData\Local\Temp), whose
 * parent inheritance descriptor can differ from the actual `.wmux` directory the
 * daemon writes the auth token into. SECURITY.md §1.1 mandates the real-profile
 * descriptor for any Windows token-ACL change (precedent: #41/#43 passed isolated
 * tests then locked the owner out in real dogfood).
 *
 * This harness compiles the REAL src/shared/security.ts and runs the genuine
 * functions against uniquely-named PROBE files created INSIDE the real
 * `%USERPROFILE%\.wmux\` directory (never the live `daemon-auth-token` — so a
 * running daemon is untouched). It exercises the same three on-disk states with
 * the real parent-directory inheritance the daemon actually inherits, and the
 * decisive (c) case proves the new DACL-only rebuild strips a pre-existing
 * EXPLICIT broad ACE on the real profile path. Probe files are removed on exit.
 *
 * Windows-only. On non-win32 it prints SKIP and exits 0.
 *
 * Run: node scripts/pr140-realprofile-acl-dynamic.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SECURITY_TS = path.join(REPO_ROOT, 'src', 'shared', 'security.ts');
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const ICACLS = path.join(SYS32, 'icacls.exe');
const POWERSHELL = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// The REAL profile directory the daemon writes the auth token into.
const WMUX_DIR = path.join(os.homedir(), '.wmux');
const LIVE_TOKEN = path.join(WMUX_DIR, 'daemon-auth-token');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

if (process.platform !== 'win32') {
  console.log('pr140-realprofile-acl-dynamic: SKIP (not win32 — ACL semantics are Windows-only)');
  process.exit(0);
}

function currentSid() {
  const out = execFileSync(path.join(SYS32, 'whoami.exe'), ['/user', '/fo', 'list'], {
    windowsHide: true,
  }).toString('utf8');
  const m = out.match(/^\s*SID\s*:\s*(S-\S+)\s*$/im);
  if (!m) throw new Error('could not resolve current SID via whoami');
  return m[1];
}
const OWNER_SID = currentSid();

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

function ps(script, targetPath) {
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

// Probe files live in the REAL .wmux dir, uniquely named so they can never
// collide with the live token a running daemon owns.
const probes = [];
function makeProbeToken() {
  const p = path.join(WMUX_DIR, `pr140-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, 'secret-token-xyz', { encoding: 'utf8', mode: 0o600 });
  probes.push(p);
  return p;
}
function cleanupProbes() {
  for (const p of probes) {
    try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
  }
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

function seedShippedIcaclsState(p) {
  execFileSync(ICACLS, [p, '/grant:r', `*${OWNER_SID}:F`, '/inheritance:r'], { windowsHide: true });
}

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

const FILE_FULL_CONTROL = 0x1f01ff;

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

// Snapshot the parent dir's inherited ACEs so the operator can see the real
// descriptor this probe inherits from (the thing %TEMP% can't reproduce).
function describeParentInheritance() {
  try {
    const json = ps(
      `$acl = Get-Acl -LiteralPath $env:WMUX_DT_PATH;` +
        `$acl.Access | Where-Object { $_.IsInherited } | ForEach-Object {` +
        `  $s = try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $_.IdentityReference.Value };` +
        `  [pscustomobject]@{ sid=$s; rights=[int]$_.FileSystemRights }` +
        `} | ConvertTo-Json -Compress`,
      WMUX_DIR,
    );
    return json || '[]';
  } catch (e) {
    return `(could not read: ${e.message})`;
  }
}

async function main() {
  console.log(`pr140-realprofile-acl-dynamic — owner SID ${OWNER_SID}`);
  console.log(`real .wmux dir: ${WMUX_DIR}`);
  console.log(`live token present: ${fs.existsSync(LIVE_TOKEN)} (NEVER touched by this harness)`);
  console.log(`PowerShell present: ${fs.existsSync(POWERSHELL)} (primary .NET path)`);
  console.log(`.wmux inherited ACEs (the real descriptor a probe inherits): ${describeParentInheritance()}\n`);

  if (!fs.existsSync(WMUX_DIR)) {
    console.log('FAIL: real .wmux dir does not exist — cannot run real-profile probe.');
    process.exit(1);
  }

  const { reHardenTokenFileAcl, secureWriteTokenFile } = await loadRealSecurityModule();

  // ---- (a) fresh write into the REAL .wmux dir ----
  console.log('CASE (a) fresh write in real .wmux — secureWriteTokenFile then reHarden');
  {
    const p = path.join(WMUX_DIR, `pr140-fresh-${process.pid}-${Math.random().toString(36).slice(2)}`);
    probes.push(p);
    let threw = null;
    try {
      secureWriteTokenFile(p, 'secret-token-xyz');
    } catch (e) {
      threw = e;
    }
    check('(a) secureWriteTokenFile did NOT throw', threw === null, threw ? String(threw.message) : '');
    if (!threw) {
      assertOwnerOnly('(a)', p);
      const ok = reHardenTokenFileAcl(p);
      check('(a) reHardenTokenFileAcl returned true (idempotent re-harden)', ok === true);
      assertOwnerOnly('(a) after re-harden', p);
    }
  }

  // ---- (b) shipped-icacls upgrade state in the REAL dir ----
  console.log('\nCASE (b) shipped-icacls-state in real .wmux — the upgrade path that threw SeSecurityPrivilege in PR #124');
  {
    const p = makeProbeToken();
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
      ret = reHardenTokenFileAcl(p);
    } catch (e) {
      threw = e;
    }
    check('(b) reHardenTokenFileAcl did NOT throw (no SeSecurityPrivilege)', threw === null, threw ? String(threw.message) : '');
    check('(b) reHardenTokenFileAcl returned true (success, not fail-soft)', ret === true);
    assertOwnerOnly('(b)', p);
  }

  // ---- (c) explicit-everyone in the REAL dir — the decisive leak case ----
  console.log('\nCASE (c) explicit-everyone in real .wmux — the leak old icacls /grant:r could not strip');
  {
    const leakProbe = makeProbeToken();
    seedExplicitEveryoneRead(leakProbe);
    seedShippedIcaclsState(leakProbe);
    const afterOldFlow = readDacl(leakProbe);
    const everyoneSurvivesOld = afterOldFlow.some((a) => a.sid === 'S-1-1-0');
    check('(c) LEAK CONFIRMED: old icacls /grant:r leaves explicit Everyone:(R)', everyoneSurvivesOld, `dacl=${JSON.stringify(afterOldFlow)}`);

    const p = makeProbeToken();
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
  }

  cleanupProbes();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exit(1);
  }
  console.log('ALL PASS — DACL-only rebuild is owner-only on the REAL %USERPROFILE%\\.wmux descriptor across (a)/(b)/(c).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(cleanupProbes);

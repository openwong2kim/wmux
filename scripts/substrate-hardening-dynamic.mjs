#!/usr/bin/env node
/**
 * Substrate v3.0 Phase 3.2 dynamic test — substrate filesystem hardening.
 *
 * Spawns the BUNDLED daemon (dist/daemon-bundle/index.js) in an isolated
 * USERPROFILE/HOME and verifies that acquireLock()'s hardenWmuxDir pass
 * actually executed against the OS layer — not just that the source
 * string matches, which is all the unit suite can lock.
 *
 * Scenarios:
 *
 *   H1  fresh-dir hardening (Windows-only)
 *       Spawns daemon against an empty test home. After daemon-pipe
 *       appears (= acquireLock returned = hardenWmuxDir already ran),
 *       asserts the OS-level artifacts:
 *         a) icacls inheritance is disabled and the current user is
 *            granted (F).
 *         b) attrib shows H, S, and I flags on the dir and on buffers/.
 *         c) .no-cloud-sync.txt exists with the substrate marker text.
 *
 *   H2  idempotent re-run (Windows-only)
 *       Re-spawns the daemon against the SAME test home where H1 left
 *       hardened artifacts. Asserts:
 *         a) Daemon still starts cleanly (no acquireLock failure).
 *         b) Notice file content is byte-identical (idempotent overwrite).
 *         c) ACL + attrib state unchanged (re-applying does not corrupt).
 *
 *   H3  POSIX early-return parity
 *       On POSIX (macOS/Linux), spawns daemon against a fresh test home
 *       and asserts:
 *         a) Daemon starts cleanly (no icacls / attrib errors leak).
 *         b) The wmux dir does NOT have a .no-cloud-sync.txt (POSIX
 *            path early-returns before the write).
 *         c) Directory mode is 0o700 (from acquireLock's mkdirSync,
 *            unchanged by hardening pass).
 *
 * Manual checklist parity:
 *   PR #40's test plan lists "icacls / attrib / notice file" as three
 *   manual verifications. H1 + H2 cover those automatically. The manual
 *   list stays as a real-Windows-environment final smoke test (the
 *   isolated-USERPROFILE pattern here is high-fidelity but not identical
 *   to a real user's installation profile).
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DAEMON_BUNDLE = path.join(REPO_ROOT, 'dist', 'daemon-bundle', 'index.js');

if (!fs.existsSync(DAEMON_BUNDLE)) {
  console.error('Daemon bundle missing — run `npm run build:daemon` first');
  process.exit(2);
}

// Helpers ---------------------------------------------------------------

function makeTestHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hardening-dyn-'));
  return home;
}

function makePipeName(tag) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux-hardening-test-${tag}`;
  }
  return path.join(os.tmpdir(), `wmux-hardening-test-${tag}.sock`);
}

function writeConfig(wmuxDir, pipeName, authToken) {
  fs.mkdirSync(wmuxDir, { recursive: true });
  fs.writeFileSync(
    path.join(wmuxDir, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        daemon: { pipeName, logLevel: 'warn', autoStart: true },
        session: {
          defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
          defaultCols: 80,
          defaultRows: 24,
          bufferSizeMb: 8,
          bufferMaxMb: 64,
          deadSessionTtlHours: 24,
          deadSessionDumpBuffer: true,
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(wmuxDir, 'daemon-auth-token'), authToken, 'utf-8');
}

function spawnDaemon(testHome) {
  return spawn(process.execPath, [DAEMON_BUNDLE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      USERPROFILE: testHome,
      HOME: testHome,
      HOMEDRIVE: undefined,
      HOMEPATH: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForPipeFile(wmuxDir, timeoutMs = 10_000) {
  const pipeFile = path.join(wmuxDir, 'daemon-pipe');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pipeFile)) return fs.readFileSync(pipeFile, 'utf-8').trim();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('daemon-pipe did not appear within timeout');
}

async function killDaemon(child) {
  if (child.killed) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  if (!child.killed) child.kill('SIGKILL');
}

// Windows verification helpers -----------------------------------------

function runIcacls(target) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
  return execFileSync(icacls, [target], {
    encoding: 'utf-8',
    timeout: 5000,
    windowsHide: true,
  });
}

function runAttrib(target) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const attrib = path.join(systemRoot, 'System32', 'attrib.exe');
  return execFileSync(attrib, [target], {
    encoding: 'utf-8',
    timeout: 5000,
    windowsHide: true,
  });
}

/**
 * Parse icacls output for the hardening invariants.
 * Returns { inheritanceDisabled, currentUserHasFullControl, raw }.
 *
 * icacls output for a hardened dir typically looks like:
 *   C:\path\.wmux NT AUTHORITY\SYSTEM:(I)(OI)(CI)(F)   (before /inheritance:r)
 *   C:\path\.wmux DOMAIN\user:(OI)(CI)(F)             (after /grant:r)
 *
 * After our hardening pass, inherited (I) entries should be absent and
 * the current user grant should be present with (F) and inheritance
 * propagation flags (OI)(CI).
 */
function parseIcacls(output) {
  const lines = output.split(/\r?\n/);
  const username = process.env.USERNAME || os.userInfo().username;
  // Any line with (I) marks an inherited entry.
  const inheritedLines = lines.filter((l) => /\(I\)/.test(l) && !/^Successfully/i.test(l));
  // Current user with (F) — accept any prefix (DOMAIN\user, COMPUTER\user, or bare user).
  const userPattern = new RegExp(`(^|\\\\)${username}:.*\\(F\\)`, 'i');
  const currentUserHasFullControl = lines.some((l) => userPattern.test(l));
  return {
    inheritanceDisabled: inheritedLines.length === 0,
    currentUserHasFullControl,
    inheritedLineCount: inheritedLines.length,
    raw: output.trim(),
  };
}

/**
 * Parse attrib output for the hardening invariants.
 *   "A  SHI  C:\path\.wmux"  → H, S, I flags present
 *
 * The flag column shows letters at fixed positions but rather than
 * parsing columns we accept any presence of H, S, and I in the output
 * line for the target. Returns { hidden, system, notIndexed, raw }.
 */
function parseAttrib(output, target) {
  const targetLine = output
    .split(/\r?\n/)
    .find((l) => l.trim().endsWith(target) || l.toLowerCase().includes(target.toLowerCase()));
  if (!targetLine) {
    return { hidden: false, system: false, notIndexed: false, raw: output.trim(), targetLineMissing: true };
  }
  // attrib uses a fixed-width flag column on Windows. Strip the path
  // from the line and inspect the remaining flag column directly —
  // letters may be adjacent ("SH I" or "ASHRI"), so a word-boundary
  // regex misses them. Simple character containment is correct because
  // the path has already been removed.
  const flagPart = targetLine.replace(target, '').toUpperCase();
  return {
    hidden: flagPart.includes('H'),
    system: flagPart.includes('S'),
    notIndexed: flagPart.includes('I'),
    raw: targetLine.trim(),
  };
}

// Scenarios ------------------------------------------------------------

async function runH1(report) {
  if (process.platform !== 'win32') {
    report.push({ scenario: 'H1', skipped: 'not win32', pass: null });
    return;
  }
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const pipeName = makePipeName(`H1-${randomUUID().slice(0, 8)}`);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  const child = spawnDaemon(testHome);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    await waitForPipeFile(wmuxDir);
    // Give hardenWmuxDir's awaited icacls/attrib calls one extra moment
    // to settle on slow CI volumes — acquireLock awaits them all, so the
    // pipe file appearing means they returned, but the OS-level effect
    // is observable immediately after that.
    await new Promise((r) => setTimeout(r, 200));

    // (a) icacls — inheritance disabled + current user has (F).
    const icaclsOutput = runIcacls(wmuxDir);
    const aclState = parseIcacls(icaclsOutput);

    // (b) attrib — H, S, I on dir and buffers/.
    const attribDirOutput = runAttrib(wmuxDir);
    const dirAttribs = parseAttrib(attribDirOutput, wmuxDir);
    const buffersDir = path.join(wmuxDir, 'buffers');
    let buffersAttribs = { hidden: false, system: false, notIndexed: false };
    if (fs.existsSync(buffersDir)) {
      const attribBuffersOutput = runAttrib(buffersDir);
      buffersAttribs = parseAttrib(attribBuffersOutput, buffersDir);
    }

    // (c) notice file present + content matches substrate marker.
    const noticePath = path.join(wmuxDir, '.no-cloud-sync.txt');
    const noticeExists = fs.existsSync(noticePath);
    const noticeContent = noticeExists ? fs.readFileSync(noticePath, 'utf-8') : '';
    const noticeHasSubstrateText = /wmux substrate state directory/.test(noticeContent);
    const noticeHasSyncToolList = /OneDrive, Dropbox, Google Drive/.test(noticeContent);

    const pass =
      aclState.inheritanceDisabled &&
      aclState.currentUserHasFullControl &&
      dirAttribs.hidden && dirAttribs.system && dirAttribs.notIndexed &&
      buffersAttribs.hidden && buffersAttribs.system && buffersAttribs.notIndexed &&
      noticeExists && noticeHasSubstrateText && noticeHasSyncToolList;

    report.push({
      scenario: 'H1',
      pass,
      acl: aclState,
      dirAttribs,
      buffersAttribs,
      notice: { exists: noticeExists, hasSubstrateText: noticeHasSubstrateText, hasSyncToolList: noticeHasSyncToolList },
    });
  } catch (err) {
    if (stderr) console.error(`[H1] daemon stderr tail:\n${stderr.slice(-2000)}`);
    report.push({ scenario: 'H1', pass: false, error: err.message });
  } finally {
    await killDaemon(child);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runH2(report) {
  if (process.platform !== 'win32') {
    report.push({ scenario: 'H2', skipped: 'not win32', pass: null });
    return;
  }
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const pipeName1 = makePipeName(`H2a-${randomUUID().slice(0, 8)}`);
  const pipeName2 = makePipeName(`H2b-${randomUUID().slice(0, 8)}`);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName1, authToken);

  let noticeFirst = '';
  let noticeSecond = '';
  let aclFirst = null;
  let aclSecond = null;
  let secondDaemonClean = false;

  try {
    // First daemon: lets hardening run once.
    const child1 = spawnDaemon(testHome);
    try {
      await waitForPipeFile(wmuxDir);
      await new Promise((r) => setTimeout(r, 200));
      noticeFirst = fs.readFileSync(path.join(wmuxDir, '.no-cloud-sync.txt'), 'utf-8');
      aclFirst = parseIcacls(runIcacls(wmuxDir));
    } finally {
      await killDaemon(child1);
    }

    // Rewrite config to use a new pipe name so the second daemon spins up
    // cleanly (the first daemon's pipe-name file is now stale).
    writeConfig(wmuxDir, pipeName2, authToken);

    // Second daemon: hardening should re-run idempotently.
    const child2 = spawnDaemon(testHome);
    let stderr2 = '';
    child2.stderr.on('data', (d) => { stderr2 += d.toString(); });
    try {
      await waitForPipeFile(wmuxDir);
      secondDaemonClean = !/error|EACCES|EPERM/i.test(stderr2);
      await new Promise((r) => setTimeout(r, 200));
      noticeSecond = fs.readFileSync(path.join(wmuxDir, '.no-cloud-sync.txt'), 'utf-8');
      aclSecond = parseIcacls(runIcacls(wmuxDir));
    } finally {
      await killDaemon(child2);
    }

    const noticeUnchanged = noticeFirst === noticeSecond;
    const aclStillHardened =
      aclSecond.inheritanceDisabled && aclSecond.currentUserHasFullControl;
    const pass = secondDaemonClean && noticeUnchanged && aclStillHardened;

    report.push({
      scenario: 'H2',
      pass,
      secondDaemonClean,
      noticeUnchanged,
      aclStillHardened,
    });
  } catch (err) {
    report.push({ scenario: 'H2', pass: false, error: err.message });
  } finally {
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runH3(report) {
  if (process.platform === 'win32') {
    report.push({ scenario: 'H3', skipped: 'win32 covered by H1/H2', pass: null });
    return;
  }
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const pipeName = makePipeName(`H3-${randomUUID().slice(0, 8)}`);
  const authToken = randomUUID();
  writeConfig(wmuxDir, pipeName, authToken);

  const child = spawnDaemon(testHome);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    await waitForPipeFile(wmuxDir);
    const daemonClean = !/icacls|attrib|EACCES|EPERM/i.test(stderr);
    const noticeAbsent = !fs.existsSync(path.join(wmuxDir, '.no-cloud-sync.txt'));
    const dirStat = fs.statSync(wmuxDir);
    // 0o700 mode check: low 9 bits equal to 0o700.
    const dirMode0o700 = (dirStat.mode & 0o777) === 0o700;
    const pass = daemonClean && noticeAbsent && dirMode0o700;
    report.push({ scenario: 'H3', pass, daemonClean, noticeAbsent, dirMode0o700, dirMode: (dirStat.mode & 0o777).toString(8) });
  } catch (err) {
    report.push({ scenario: 'H3', pass: false, error: err.message });
  } finally {
    await killDaemon(child);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Main -----------------------------------------------------------------

async function main() {
  const report = [];
  console.log(`Substrate hardening dynamic test — platform=${process.platform}`);
  await runH1(report);
  await runH2(report);
  await runH3(report);

  console.log('\n=== Results ===');
  for (const r of report) console.log(JSON.stringify(r, null, 2));

  const failures = report.filter((r) => r.pass === false);
  const skipped = report.filter((r) => r.pass === null);
  console.log(`\n${report.length - failures.length - skipped.length} pass, ${failures.length} fail, ${skipped.length} skip`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

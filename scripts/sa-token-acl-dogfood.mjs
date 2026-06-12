#!/usr/bin/env node
/**
 * S-A token-ACL cold-start optimization — dynamic dogfood.
 *
 * The perf bench only exercises the FRESH-create path (every run gets a new
 * HOME). This harness verifies the RE-HARDEN path against the packaged exe by
 * booting the SAME isolated HOME twice:
 *
 *   boot #1 (fresh):    tokens created → fast icacls path
 *     - main stderr shows "[security] fresh token ACL harden took"
 *   boot #2 (existing): tokens loaded → DEFERRED async re-harden
 *     - main stderr shows "[security] deferred token ACL re-harden took"
 *     - the daemon log shows the deferred line AFTER "Daemon ready" (i.e. the
 *       harden ran off the launcher-blocked critical path)
 *     - both token files converge to an owner-only DACL (icacls inspection)
 *
 * Isolation: same WMUX_DATA_SUFFIX + temp-HOME pattern as scripts/perf-bench.mjs
 * (re-keys pipes, tokens, userData), so it can run beside a live wmux.
 *
 * Run: npm run package && node scripts/sa-token-acl-dogfood.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const APP_EXE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const ICACLS = path.join(SYS32, 'icacls.exe');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'win32') {
  console.log('sa-token-acl-dogfood: SKIP (win32-only)');
  process.exit(0);
}
if (!fs.existsSync(APP_EXE)) {
  console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`);
  process.exit(2);
}

// --- isolated instance environment (perf-bench pattern) ---
const suffix = `-acldog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-acldog-'));
const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  HOMEDRIVE: undefined,
  HOMEPATH: undefined,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  WMUX_DATA_SUFFIX: suffix,
  WMUX_NO_DIALOG: '1',
  WMUX_DISABLE_CDP: 'true', // no CDP needed here — keep boots lean
};
fs.mkdirSync(env.APPDATA, { recursive: true });
fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
const userDataDir = path.join(env.APPDATA, `wmux${suffix}`);
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');

const wmuxDir = path.join(home, `.wmux${suffix}`);
// getAuthTokenPath() is suffix-aware: ~/.wmux<suffix>-auth-token
const mainTokenPath = path.join(home, `.wmux${suffix}-auth-token`);
const daemonTokenPath = path.join(home, '.wmux', 'daemon-auth-token'); // NOT suffix-aware (bench comment)
const daemonLogDir = path.join(wmuxDir, 'logs');

function readDaemonPid() {
  try {
    const pid = Number(fs.readFileSync(path.join(wmuxDir, 'daemon.pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function pipeAlive(pipeName) {
  return new Promise((resolve) => {
    const sock = net.createConnection(pipeName);
    const done = (v) => { try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

async function bootOnce(label, { collectMs }) {
  const stderrLines = [];
  const proc = spawn(APP_EXE, [], {
    cwd: REPO_ROOT, env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  let buf = '';
  const onChunk = (b) => {
    buf += b.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      stderrLines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  };
  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);

  // Wait for the daemon pipe file (daemon fully started), then keep collecting
  // output for a while so the DEFERRED harden (which by design runs after
  // boot) has time to complete and log.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !fs.existsSync(path.join(wmuxDir, 'daemon-pipe'))) {
    await sleep(150);
  }
  const daemonUp = fs.existsSync(path.join(wmuxDir, 'daemon-pipe'));
  check(`${label}: daemon pipe file appeared`, daemonUp);
  await sleep(collectMs);

  // Graceful-ish teardown: kill the app, then the detached daemon (pid file
  // lives inside OUR temp home — cannot target a foreign process).
  try { proc.kill(); } catch { /* */ }
  const exitDeadline = Date.now() + 5000;
  while (proc.exitCode === null && Date.now() < exitDeadline) await sleep(100);
  if (proc.exitCode === null) { try { proc.kill('SIGKILL'); } catch { /* */ } }
  const dpid = readDaemonPid();
  if (dpid && pidAlive(dpid)) {
    try { process.kill(dpid); } catch { /* */ }
    await sleep(400);
    if (pidAlive(dpid)) { try { process.kill(dpid, 'SIGKILL'); } catch { /* */ } }
  }
  // wait for the daemon pipe to actually go away before the next boot
  const pipeName = (() => {
    try { return fs.readFileSync(path.join(wmuxDir, 'daemon-pipe'), 'utf8').trim(); } catch { return null; }
  })();
  if (pipeName) {
    const pdl = Date.now() + 5000;
    while (Date.now() < pdl && await pipeAlive(pipeName)) await sleep(150);
  }
  return stderrLines;
}

function readDaemonLog() {
  try {
    const files = fs.readdirSync(daemonLogDir).filter((f) => f.startsWith('daemon-'));
    return files.map((f) => fs.readFileSync(path.join(daemonLogDir, f), 'utf8')).join('\n');
  } catch { return ''; }
}

function daclIsOwnerOnly(p, ownerSid, ownerName) {
  // icacls output lists one "<principal>:(...)" per ACE. Owner-only means a
  // single ACE AND that ACE's principal is the current user — a single ACE
  // belonging to SYSTEM/another account must FAIL (that is exactly the
  // guarantee this dogfood verifies). icacls prints the friendly account name
  // (MACHINE\user) when resolvable and the raw SID otherwise, so accept either
  // form of the owner identity, case-insensitively.
  const out = execFileSync(ICACLS, [p], { windowsHide: true, env: { ...process.env } }).toString('utf8');
  const aceLines = out.split('\n').map((l) => l.trim()).filter((l) => l.includes(':('));
  const principalOf = (line) => line.slice(0, line.indexOf(':(')).split(' ').pop().toLowerCase();
  const ownerForms = [ownerSid.toLowerCase(), ownerName.toLowerCase()];
  const isOwnerAce = aceLines.length === 1 && ownerForms.includes(principalOf(aceLines[0]));
  return { ownerOnly: isOwnerAce, aces: aceLines };
}

const { OWNER_SID, OWNER_NAME } = (() => {
  // SID via `/user /fo list`: the "SID:" label is ASCII on every locale.
  // Account name via bare `whoami` (no args): prints only MACHINE\user with
  // no label at all — localized Windows (e.g. Korean "사용자 이름:") breaks
  // any label-based parse of the /fo list output.
  const out = execFileSync(path.join(SYS32, 'whoami.exe'), ['/user', '/fo', 'list'], { windowsHide: true }).toString('utf8');
  const name = execFileSync(path.join(SYS32, 'whoami.exe'), [], { windowsHide: true }).toString('utf8').trim();
  return {
    OWNER_SID: out.match(/^\s*SID\s*:\s*(S-\S+)\s*$/im)[1],
    OWNER_NAME: name,
  };
})();

async function main() {
  console.log(`sa-token-acl-dogfood — exe=${APP_EXE}`);
  console.log(`home=${home} suffix=${suffix}\n`);

  // ---- boot #1: fresh tokens ----
  console.log('boot #1 (fresh HOME — token creation path)');
  const lines1 = await bootOnce('boot#1', { collectMs: 3000 });
  const fresh1 = lines1.filter((l) => l.includes('[security] fresh token ACL harden took'));
  check('boot#1: fresh-create fast path used (main stderr)', fresh1.length >= 1, fresh1[0] ?? 'no fresh-harden line');
  const deferred1 = lines1.filter((l) => l.includes('deferred token ACL re-harden'));
  check('boot#1: no deferred re-harden on the create path', deferred1.length === 0);

  // Locate the actual main token file (suffix-aware path may differ).
  const mainTokenCandidates = [mainTokenPath, path.join(home, `.wmux-auth-token${suffix}`), path.join(home, '.wmux-auth-token')];
  const mainToken = mainTokenCandidates.find((p) => fs.existsSync(p));
  check('boot#1: main token file exists', !!mainToken, mainToken ?? `tried ${mainTokenCandidates.join(', ')}`);
  const daemonTokenCandidates = [path.join(wmuxDir, 'daemon-auth-token'), daemonTokenPath];
  const daemonToken = daemonTokenCandidates.find((p) => fs.existsSync(p));
  check('boot#1: daemon token file exists', !!daemonToken, daemonToken ?? `tried ${daemonTokenCandidates.join(', ')}`);

  // ---- boot #2: existing tokens → deferred re-harden ----
  console.log('\nboot #2 (same HOME — existing-token re-harden path)');
  const lines2 = await bootOnce('boot#2', { collectMs: 6000 });
  const deferred2 = lines2.filter((l) => l.includes('[security] deferred token ACL re-harden took'));
  check('boot#2: deferred re-harden ran in main (stderr)', deferred2.length >= 1, deferred2[0] ?? 'no deferred line in main');
  const fresh2 = lines2.filter((l) => l.includes('fresh token ACL harden took'));
  check('boot#2: fresh-create path NOT taken again', fresh2.length === 0);

  // Daemon side: the deferred line must appear AFTER "Daemon ready" in its log
  // (i.e. the harden left the launcher-blocked critical path).
  const dlog = readDaemonLog();
  const readyIdx = dlog.lastIndexOf('Daemon ready');
  const defIdx = dlog.lastIndexOf('deferred token ACL re-harden took');
  check('boot#2: daemon logged the deferred re-harden', defIdx >= 0);
  check('boot#2: daemon deferred re-harden logged AFTER "Daemon ready" (off critical path)',
    readyIdx >= 0 && defIdx > readyIdx,
    `readyIdx=${readyIdx} defIdx=${defIdx}`);

  // ---- final DACL state: owner-only on both tokens ----
  console.log('\nfinal DACL state');
  for (const [label, p] of [['main token', mainToken], ['daemon token', daemonToken]]) {
    if (!p) continue;
    const { ownerOnly, aces } = daclIsOwnerOnly(p, OWNER_SID, OWNER_NAME);
    check(`${label} DACL is single-ACE owner-only`, ownerOnly, JSON.stringify(aces));
  }

  // ---- cleanup ----
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

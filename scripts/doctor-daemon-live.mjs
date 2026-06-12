/**
 * Live re-verification for the `wmux doctor` daemon-pipe fix.
 *
 * Boots the PACKAGED app (out/wmux-win32-x64/wmux.exe from the MAIN repo — the
 * daemon binary is unchanged by this CLI-only fix) in a fully isolated env
 * (fresh temp HOME + unique WMUX_DATA_SUFFIX), waits for the detached daemon to
 * come up, then runs the WORKTREE's freshly built CLI bundle `doctor` against
 * the same env and asserts:
 *   - daemon section OK with real pid / uptime / sessions / eventLoopLagMs
 *   - daemon bootTrace phase table (lock acquire / boot id / config load /
 *     recovery / pipe start) rendered
 *   - exit code 0
 * Then shuts the daemon down and asserts doctor reports it down with exit 1.
 * Cleans up (daemon shutdown, app kill, temp removal, pipe-gone + zombie check).
 *
 * Usage: node scripts/doctor-daemon-live.mjs
 */
import { spawn, execFile, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(__dirname, '..');
// The packaged app normally lives in this checkout's own out/. When running
// from a git worktree (which shares no out/ with the main checkout), point
// WMUX_APP_ROOT at the checkout that ran `npm run package`.
const APP_ROOT = process.env.WMUX_APP_ROOT || WORKTREE_ROOT;
const APP_EXE = path.join(APP_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
const CLI_BUNDLE = path.join(WORKTREE_ROOT, 'dist', 'cli-bundle', 'index.js');
const USERNAME = os.userInfo().username || 'default';
const POWERSHELL_EXE = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pipeAlive(pipeName) {
  return new Promise((resolve) => {
    const sock = net.createConnection(pipeName);
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 300);
  });
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor(label, fn, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - start >= timeoutMs) throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

// Minimal raw JSON-RPC client for the daemon pipe (shutdown only).
class PipeClient {
  constructor(pipeName, token) { this.pipeName = pipeName; this.token = token; this.sock = null; this.buf = ''; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.pipeName);
      let settled = false;
      sock.setEncoding('utf8');
      sock.once('connect', () => { settled = true; this.sock = sock; resolve(); });
      sock.once('error', (e) => { if (!settled) { settled = true; reject(e); } });
      sock.on('data', (c) => this._onData(c));
      sock.on('close', () => { for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('closed')); } this.pending.clear(); });
    });
  }
  _onData(c) {
    this.buf += c; let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1);
      if (!line) continue; let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id); if (!p) continue;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(String(msg.error))); else p.resolve(msg.result ?? msg);
    }
  }
  call(method, params = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('not connected'));
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, method, params, token: this.token }) + '\n');
    });
  }
  close() { try { this.sock?.destroy(); } catch {} }
}

function runDoctor(env, args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI_BUNDLE, 'doctor', ...args], { env, windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout: stdout || '', stderr: stderr || '' });
      });
  });
}

function readDaemonPid(wmuxDir) {
  try { const p = Number(fs.readFileSync(path.join(wmuxDir, 'daemon.pid'), 'utf8').trim()); return Number.isInteger(p) && p > 0 ? p : null; } catch { return null; }
}
function readDaemonPipe(wmuxDir, fallback) {
  try { const n = fs.readFileSync(path.join(wmuxDir, 'daemon-pipe'), 'utf8').trim(); return n || fallback; } catch { return fallback; }
}
function readDaemonToken(home, wmuxDir) {
  for (const p of [path.join(home, '.wmux', 'daemon-auth-token'), path.join(wmuxDir, 'daemon-auth-token')]) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch {}
  }
  return null;
}

let FAILED = false;
function assert(cond, msg) {
  if (cond) { console.log(`  PASS: ${msg}`); } else { console.log(`  FAIL: ${msg}`); FAILED = true; }
}

async function main() {
  if (!fs.existsSync(APP_EXE)) { console.error(`Missing app exe: ${APP_EXE}`); process.exit(2); }
  if (!fs.existsSync(CLI_BUNDLE)) { console.error(`Missing CLI bundle: ${CLI_BUNDLE} (build it first)`); process.exit(2); }

  const suffix = `-doctorlive${process.pid}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-doctorlive-'));
  const wmuxDir = path.join(home, `.wmux${suffix}`);
  const env = {
    ...process.env,
    USERPROFILE: home, HOME: home, HOMEDRIVE: undefined, HOMEPATH: undefined,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    WMUX_DATA_SUFFIX: suffix, WMUX_NO_DIALOG: '1',
  };
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  const userDataDir = path.join(env.APPDATA, `wmux${suffix}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');

  const mainPipe = `\\\\.\\pipe\\wmux${suffix}-${USERNAME}`;
  const daemonPipeFallback = `\\\\.\\pipe\\wmux-daemon${suffix}-${USERNAME}`;

  console.log(`[setup] home=${home}`);
  console.log(`[setup] suffix=${suffix}`);
  console.log(`[setup] app=${APP_EXE}`);
  console.log(`[setup] cli=${CLI_BUNDLE}`);

  let proc = null;
  try {
    console.log('\n[boot] spawning app...');
    proc = spawn(APP_EXE, [], { cwd: MAIN_REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    proc.on('exit', (c) => console.log(`[app] main process exited (code ${c})`));

    // Wait for the daemon to be reachable: daemon-pipe file written + pipe alive.
    await waitFor('daemon-pipe file', () => fs.existsSync(path.join(wmuxDir, 'daemon-pipe')), 45000, 200);
    const daemonPipe = readDaemonPipe(wmuxDir, daemonPipeFallback);
    console.log(`[boot] daemon-pipe = ${daemonPipe}`);
    await waitFor('daemon pipe alive', () => pipeAlive(daemonPipe), 30000, 200);
    const token = readDaemonToken(home, wmuxDir);
    assert(!!token, 'daemon auth token present on disk');
    // Confirm the daemon answers daemon.ping over its own pipe (ground truth).
    await waitFor('daemon.ping ok', async () => {
      try { const dc = new PipeClient(daemonPipe, token); await dc.connect(); const r = await dc.call('daemon.ping', {}, 3000); dc.close(); return r && r.status === 'ok'; } catch { return false; }
    }, 30000, 250);
    console.log('[boot] daemon is up and answering daemon.ping');

    // === Scenario 1: daemon ALIVE → doctor must report OK + exit 0 ===
    console.log('\n[test 1] doctor with daemon ALIVE');
    const r1 = await runDoctor(env);
    console.log('----- doctor (human) -----');
    console.log(r1.stdout.trimEnd());
    console.log('--------------------------');
    if (r1.stderr.trim()) console.log(`[stderr] ${r1.stderr.trim()}`);

    assert(r1.code === 0, `exit code 0 (got ${r1.code})`);
    assert(/\[ OK \] daemon/.test(r1.stdout), 'daemon section is [ OK ]');
    assert(/daemon: up \(pid \d+\)/.test(r1.stdout), 'daemon line shows up (pid N)');
    assert(/uptime: /.test(r1.stdout), 'uptime line present');
    assert(/sessions: \d+/.test(r1.stdout), 'sessions line present with a number');
    assert(/event-loop lag: \d+ms/.test(r1.stdout), 'event-loop lag line present with ms value');
    assert(/app \(main process\) pipe reachable: yes/.test(r1.stdout), 'app main-process pipe reachable: yes');
    // bootTrace phase table — the lines that NEVER rendered under the old defect.
    assert(/lock acquire\s+\d+ms/.test(r1.stdout), 'daemon bootTrace: lock acquire phase rendered');
    assert(/boot id\s+\d+ms/.test(r1.stdout), 'daemon bootTrace: boot id phase rendered');
    assert(/config load\s+\d+ms/.test(r1.stdout), 'daemon bootTrace: config load phase rendered');
    assert(/recovery\s+\d+ms/.test(r1.stdout), 'daemon bootTrace: recovery phase rendered');
    assert(/pipe start \/ token ACL\s+\d+ms/.test(r1.stdout), 'daemon bootTrace: pipe start phase rendered');
    assert(/daemon \(ms since start\):/.test(r1.stdout), 'daemon anchor row rendered');
    assert(!/Unknown method/.test(r1.stdout), 'no "Unknown method: daemon.ping" anywhere');

    // JSON mode sanity — daemon verdict OK + bootTrace present.
    const r1json = await runDoctor(env, ['--json']);
    assert(r1json.code === 0, `--json exit code 0 (got ${r1json.code})`);
    let parsed = null; try { parsed = JSON.parse(r1json.stdout); } catch {}
    assert(parsed && parsed.daemon && parsed.daemon.verdict === 'OK', '--json daemon.verdict === OK');
    assert(parsed && parsed.bootPhases && Array.isArray(parsed.bootPhases.daemon) && parsed.bootPhases.daemon.length >= 5, '--json bootPhases.daemon has >=5 phase rows');

    // === Scenario 2: daemon DOWN → doctor must report down + exit 1 ===
    console.log('\n[test 2] shutting daemon down, then doctor with daemon DOWN');
    const daemonPid = readDaemonPid(wmuxDir);
    // Kill the main app first so it cannot re-spawn the daemon, then shut the daemon.
    if (proc && !proc.killed) { try { proc.kill(); } catch {} }
    await sleep(1500);
    try {
      const dc = new PipeClient(daemonPipe, token);
      await dc.connect();
      await dc.call('daemon.shutdown', {}, 5000).catch(() => {});
      dc.close();
    } catch {}
    // Wait until the daemon pipe is truly gone.
    try { await waitFor('daemon pipe gone', async () => !(await pipeAlive(daemonPipe)), 12000, 250); } catch {}
    if (daemonPid) { const dl = Date.now() + 6000; while (pidAlive(daemonPid) && Date.now() < dl) await sleep(150); if (pidAlive(daemonPid)) { try { process.kill(daemonPid); } catch {} } }

    const r2 = await runDoctor(env);
    console.log('----- doctor (daemon down) -----');
    console.log(r2.stdout.trimEnd());
    console.log('--------------------------------');
    assert(r2.code === 1, `exit code 1 when daemon down (got ${r2.code})`);
    assert(/\[FAIL\] daemon/.test(r2.stdout), 'daemon section is [FAIL] when down');
    assert(/daemon: down/.test(r2.stdout), 'daemon line shows down');
    assert(/recovery:/.test(r2.stdout), 'recovery steps rendered when down');
    assert(/not running/.test(r2.stdout), 'down hint mentions "not running" (true connect failure, not Unknown method)');
  } finally {
    // === Cleanup ===
    console.log('\n[cleanup]');
    const daemonPid = readDaemonPid(wmuxDir);
    const daemonPipe = readDaemonPipe(wmuxDir, daemonPipeFallback);
    const token = readDaemonToken(home, wmuxDir);
    if (token && await pipeAlive(daemonPipe)) {
      try { const dc = new PipeClient(daemonPipe, token); await dc.connect(); await dc.call('daemon.shutdown', {}, 5000).catch(() => {}); dc.close(); } catch {}
    }
    if (daemonPid && pidAlive(daemonPid)) {
      const dl = Date.now() + 6000; while (pidAlive(daemonPid) && Date.now() < dl) await sleep(150);
      if (pidAlive(daemonPid)) { try { process.kill(daemonPid); } catch {} await sleep(300); if (pidAlive(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} } }
    }
    if (proc && proc.exitCode === null && !proc.killed) { try { proc.kill('SIGKILL'); } catch {} }
    await sleep(500);
    const mainGone = !(await pipeAlive(mainPipe));
    const daemonGone = !(await pipeAlive(daemonPipe));
    console.log(`  main pipe gone:   ${mainGone}`);
    console.log(`  daemon pipe gone: ${daemonGone}`);
    // Zombie check: any wmux/daemon process referencing our suffix still alive?
    // Exclude PowerShell itself — the scan's OWN CommandLine contains the suffix
    // string (self-match false positive), as do any shell wrappers around it.
    let zombies = '';
    try {
      zombies = execFileSync(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${suffix}*' -and $_.Name -notlike '*powershell*' -and $_.Name -notlike '*pwsh*' } | Select-Object ProcessId,Name | ConvertTo-Json -Compress`],
        { windowsHide: true, timeout: 8000 }).toString().trim();
    } catch {}
    const zombieCount = zombies && zombies !== '' ? (zombies.startsWith('[') ? JSON.parse(zombies).length : 1) : 0;
    console.log(`  suffix-tagged processes still alive: ${zombieCount}`);
    assert(zombieCount === 0, 'zero zombie processes for our suffix');
    try { fs.rmSync(home, { recursive: true, force: true }); console.log('  temp home removed'); } catch (e) { console.log(`  temp home removal warning: ${e.message}`); }
  }

  console.log(`\n=== ${FAILED ? 'LIVE VERIFICATION FAILED' : 'LIVE VERIFICATION PASSED'} ===`);
  process.exit(FAILED ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

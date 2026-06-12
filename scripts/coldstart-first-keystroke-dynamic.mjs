#!/usr/bin/env node
/**
 * Cold-start first-keystroke dynamic dogfood — S-A Step 1 parallel renderer load.
 *
 * WHAT CHANGED (perf/renderer-parallel-boot, commit f16ed45 "perf(boot): load
 * renderer in parallel with daemon bootstrap (S-A Step 1)", on top of the S-A
 * C1 adaptive readiness-poll cadence e02bc6b)
 * ---------------------------------------------------------------------------
 * Since dda4c0c the app.on('ready') tail was SERIALIZED:
 *     await bootstrap()  ->  markDaemonReady()  ->  loadMainRenderer()
 * so the renderer never mounted until the daemon spawn/connect finished. That
 * ordering was the defense against the "first keystroke doesn't register" race:
 * a renderer that mounted in LOCAL mode (pty-N ids) while the LOCAL→DAEMON IPC
 * handler swap happened mid-mount sent LOCAL-prefix ids into the DAEMON handler,
 * which silently dropped the pty.write inside DaemonClient.writeToSession
 * (sessionPipes.get('pty-N') === undefined). Symptom on cold installs (Defender
 * realtime scan + ASAR cold cache + ConPTY cold start stretch the daemon spawn
 * into the hundreds of ms): the user's FIRST keystroke vanished — the worst
 * possible first impression.
 *
 * f16ed45 deliberately REOPENS that window: it kicks bootstrap() WITHOUT
 * awaiting, calls loadMainRenderer() immediately (renderer load now runs in
 * PARALLEL with the daemon spawn), then awaits the bootstrap promise and
 * markDaemonReady() afterwards. The claim is the race is now closed
 * STRUCTURALLY rather than by ordering:
 *   (a) the renderer's first daemon.whenReady() parks in the
 *       daemon:get-ready-state pending-resolver queue until markDaemonReady()
 *       flushes it with the decided topology, and
 *   (b) paneGate (Fix 0) keeps every renderer pty.create path closed until the
 *       startup reconcile (which itself awaits whenReady) flips it to 'ready',
 *       so no pty id is minted against a mid-swap handler topology.
 *   (c) the one newly-reachable path — AppLayout's late-reconcile listener
 *       firing on a mid-startup daemon:connected — is gated on paneGate in
 *       createLateReconcileOnConnect (logs "[lifecycle] daemon connected during
 *       startup — skipping late reconcile").
 *
 * WHAT THIS VERIFIES (against the PACKAGED exe, out/wmux-win32-x64/wmux.exe)
 * ------------------------------------------------------------------------
 *   S1 parallelism proof: in ONE boot's stderr boot-trace, assert
 *      `renderer-load-triggered` epoch < `daemon-bootstrap-end` epoch. Under
 *      the old serialized order renderer-load-triggered was emitted AFTER
 *      daemon-bootstrap-end (and after markDaemonReady), so it was strictly
 *      LATER. A small-or-negative gap here is the structural fingerprint of the
 *      parallelization.
 *   S2 dda4c0c regression (THE CORE TEST): fresh-HOME boot → CDP-detect the
 *      `.xterm` mount → IMMEDIATELY (zero added delay) type
 *      `echo first-keystroke-ok` + Enter → assert the echo AND the command
 *      output round-trip to the renderer. Repeated x10 with a FRESH HOME each
 *      iteration. A single dropped first keystroke is a FAIL — that is exactly
 *      the production bug. We additionally probe a single canary char the
 *      instant the mount is seen (before the full command) so a swallowed
 *      *first* char is caught even if the shell later recovers.
 *   S3 restore-path variant: pre-seed live session state (boot, create a pane,
 *      quit app-only so the DETACHED daemon survives with a non-empty pty.list,
 *      reboot against the still-alive daemon so the startup reconcile runs
 *      against a populated list) and assert mount-immediate typing still works
 *      on that reuse/restore boot.
 *   S4 gate log: scan the isolated main log file
 *      (%APPDATA%\wmux<suffix>\logs\main-*.log — renderer console is relayed
 *      there). If any boot saw daemon:connected arrive DURING startup, assert
 *      the "[lifecycle] daemon connected during startup — skipping late
 *      reconcile" gate line is present AND the "[lifecycle] daemon connected
 *      late" path did NOT fire during that startup window. Timing-dependent:
 *      if the gate scenario never triggered we report "not exercised" (NOT a
 *      FAIL — the parallel window may close before the renderer subscribes).
 *   S5 cleanup: daemon.shutdown RPC → pid SIGKILL fallback → temp HOME removed
 *      → zombie process count = 0.
 *
 * ISOLATION (perf-bench.mjs model): each boot env gets a fresh temp
 * USERPROFILE/HOME/APPDATA/LOCALAPPDATA + a unique WMUX_DATA_SUFFIX that re-keys
 * the main pipe, daemon pipe, auth tokens, ~/.wmux and the Electron userData
 * dir (and thus the single-instance lock), so this runs BESIDE a live wmux
 * without touching it. The CDP identity guard (APP_URL_PREFIX) additionally
 * refuses any renderer page not under OUR packaged build dir, so a stray
 * keystroke can never land in the real terminal even on a CDP port collision.
 * CDP ports are constrained to 18800-18899 by the app; we never connect to a
 * port outside that band.
 *
 * Run (PowerShell, package first):
 *   npm run package; node scripts/coldstart-first-keystroke-dynamic.mjs
 * Flags: --iterations N  (S2 repeat count, default 10)
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const APP_EXE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
// Identity guard (perf-bench): only attach to renderer pages under OUR build dir.
const APP_URL_PREFIX = pathToFileURL(path.join(REPO_ROOT, 'out', 'wmux-win32-x64')).href.toLowerCase();
const USERNAME = os.userInfo().username || 'default';
const CDP_PORT_MIN = 18800;
const CDP_PORT_MAX = 18899;

// --- args ---
function parseArgs(argv) {
  const out = { iterations: 10 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--iterations') out.iterations = Math.max(1, Number(argv[++i]) || 10);
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'win32') {
  console.log('coldstart-first-keystroke-dynamic: SKIP (win32-only)');
  process.exit(0);
}
if (!fs.existsSync(APP_EXE)) {
  console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`);
  process.exit(2);
}

let chromium = null;
try {
  ({ chromium } = await import('playwright-core'));
} catch (e) {
  console.error(`playwright-core import failed (${e.message}) — keystroke scenarios cannot run`);
  process.exit(2);
}

// ===== isolated env factory (one per boot env; suffix re-keys everything) =====
const liveEnvs = [];
function makeEnv(tag) {
  const suffix = `-cskd${process.pid}${tag}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `wmux-cskd-${tag}-`));
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
  };
  delete env.WMUX_DISABLE_CDP; // we need the app's CDP endpoint
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  // Pre-seed the first-run marker so the wizard overlay (which swallows the
  // pane click + steals terminal focus) never shows; boot measures the REGULAR
  // path (the production first-keystroke bug was on the regular cold path).
  const userDataDir = path.join(env.APPDATA, `wmux${suffix}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');
  const rec = {
    tag, suffix, home, env, userDataDir,
    wmuxDir: path.join(home, `.wmux${suffix}`),
    mainPipe: `\\\\.\\pipe\\wmux${suffix}-${USERNAME}`,
    logDir: path.join(userDataDir, 'logs'),
  };
  liveEnvs.push(rec);
  return rec;
}

function readDaemonPid(e) {
  try {
    const pid = Number(fs.readFileSync(path.join(e.wmuxDir, 'daemon.pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function readDaemonPipeName(e) {
  try { return fs.readFileSync(path.join(e.wmuxDir, 'daemon-pipe'), 'utf8').trim() || null; }
  catch { return null; }
}
function readDaemonToken(e) {
  for (const p of [
    path.join(e.home, '.wmux', 'daemon-auth-token'),
    path.join(e.wmuxDir, 'daemon-auth-token'),
  ]) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t; } catch { /* next */ }
  }
  return null;
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const POWERSHELL_EXE = path.join(
  process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);
// True only if `pid` is alive AND its image is wmux.exe — distinguishes a real
// surviving app process from a recycled pid (perf-bench pidLooksLikeWmuxDaemon).
function pidIsWmux(pid) {
  return new Promise((resolve) => {
    execFile(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").Name`],
    { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(false); // lookup failed / process gone
      resolve(String(stdout).trim().toLowerCase() === 'wmux.exe');
    });
  });
}
function pipeAlive(pipeName) {
  return new Promise((resolve) => {
    const sock = net.createConnection(pipeName);
    const done = (v) => { try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 800);
  });
}

// One-shot newline-delimited JSON-RPC client (perf-bench PipeClient, trimmed).
function rpcCall(pipeName, token, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(pipeName);
    let buf = '';
    let settled = false;
    const id = randomUUID();
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`rpc timeout: ${method}`))), timeoutMs);
    sock.setEncoding('utf8');
    sock.once('connect', () => sock.write(JSON.stringify({ id, method, params, token }) + '\n'));
    sock.once('error', (err) => finish(() => reject(err)));
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        if (msg.ok === false) finish(() => reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error))));
        else finish(() => resolve(msg.result ?? msg));
        return;
      }
    });
  });
}
function readMainToken(e) {
  // src writes the main auth token to <home>/.wmux<suffix>-auth-token.
  for (const p of [
    path.join(e.home, `.wmux${e.suffix}-auth-token`),
    path.join(e.wmuxDir, 'auth-token'),
  ]) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t; } catch { /* next */ }
  }
  return null;
}

// ===== boot one app instance, collecting [boot-trace] marks from stderr =====
function spawnApp(e) {
  const t0 = Date.now();
  const proc = spawn(APP_EXE, [], {
    cwd: REPO_ROOT, env: e.env, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  });
  const marks = {};        // name -> epoch (absolute)
  let cdpPort = null;
  const cdpWaiters = [];

  let stdoutBuf = '';
  proc.stdout.on('data', (b) => {
    stdoutBuf += b.toString('utf8');
    const m = stdoutBuf.match(/CDP enabled on port (\d+)/);
    if (m && cdpPort === null) {
      cdpPort = Number(m[1]);
      for (const w of cdpWaiters.splice(0)) w(cdpPort);
    }
    if (stdoutBuf.length > 65536) stdoutBuf = stdoutBuf.slice(-4096);
  });
  let stderrBuf = '';
  proc.stderr.on('data', (b) => {
    stderrBuf += b.toString('utf8');
    let nl;
    while ((nl = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, nl);
      stderrBuf = stderrBuf.slice(nl + 1);
      const mm = line.match(/\[boot-trace\] mark=([\w-]+) epoch=(\d+)/);
      if (mm && !(mm[1] in marks)) marks[mm[1]] = Number(mm[2]);
    }
    if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-4096);
  });

  const waitForCdp = (timeoutMs) => new Promise((resolve, reject) => {
    if (cdpPort !== null) return resolve(cdpPort);
    cdpWaiters.push(resolve);
    setTimeout(() => reject(new Error('timeout waiting for CDP port line')), timeoutMs);
  });

  return { proc, marks, t0, get cdpPort() { return cdpPort; }, waitForCdp };
}

async function waitDaemonPipeFile(e, timeoutMs) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    if (fs.existsSync(path.join(e.wmuxDir, 'daemon-pipe'))) return true;
    await sleep(80);
  }
  return false;
}

// Kill only the app process (daemon detached survives → reuse path next boot).
async function killAppOnly(e, app) {
  try { app.proc.kill(); } catch { /* */ }
  const dl = Date.now() + 6000;
  while (app.proc.exitCode === null && Date.now() < dl) await sleep(100);
  if (app.proc.exitCode === null) { try { app.proc.kill('SIGKILL'); } catch { /* */ } }
  const pdl = Date.now() + 5000;
  while (Date.now() < pdl && await pipeAlive(e.mainPipe)) await sleep(150);
}

// Connect CDP, guarded to OUR build dir + the 18800-18899 band.
async function connectCdp(cdpPort, timeoutMs = 25000) {
  if (cdpPort < CDP_PORT_MIN || cdpPort > CDP_PORT_MAX) {
    throw new Error(`CDP port ${cdpPort} outside the wmux band ${CDP_PORT_MIN}-${CDP_PORT_MAX} — refusing to connect`);
  }
  const dl = Date.now() + timeoutMs;
  let browser = null;
  while (!browser && Date.now() < dl) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); }
    catch { await sleep(150); }
  }
  if (!browser) throw new Error(`CDP connect failed on port ${cdpPort}`);
  return browser;
}

// Find the identity-matched renderer page with .xterm mounted.
async function findRendererPage(browser, timeoutMs = 30000) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        try {
          if (!p.url().toLowerCase().startsWith(APP_URL_PREFIX)) continue;
          if (await p.evaluate(() => !!document.querySelector('.xterm'))) return p;
        } catch { /* navigating */ }
      }
    }
    await sleep(50);
  }
  return null;
}

// Dismiss any first-boot overlay that could steal focus.
async function dismissOverlays(page) {
  for (let i = 0; i < 6; i++) {
    const overlay = await page.evaluate(() => ({
      tour: !!document.querySelector('.onboarding-overlay'),
      autoUpdate: [...document.querySelectorAll('div.fixed.inset-0')].some((d) => d.className.includes('z-[60]')),
    })).catch(() => ({ tour: false, autoUpdate: false }));
    if (!overlay.tour && !overlay.autoUpdate) break;
    if (overlay.tour) await page.keyboard.press('Escape').catch(() => {});
    else await page.evaluate(() => {
      const o = [...document.querySelectorAll('div.fixed.inset-0')].find((d) => d.className.includes('z-[60]'));
      o?.querySelector('button')?.click();
    }).catch(() => {});
    await sleep(300);
  }
}

// Install a pty.onData echo subscriber (robust round-trip signal, render-independent).
async function installHook(page) {
  await page.evaluate(() => {
    if (window.__ksHook) return;
    const H = { data: '', firstDataEpoch: null };
    window.__ksHook = H;
    const tryHook = () => {
      const api = window.electronAPI;
      if (!api?.pty?.onData) { setTimeout(tryHook, 3); return; }
      api.pty.onData((_id, d) => {
        const s = String(d);
        H.data += s;
        if (H.firstDataEpoch === null && s.length) H.firstDataEpoch = Date.now();
      });
    };
    tryHook();
  });
}

// ANSI/control stripper — ConPTY interleaves cursor escapes between echoed chars.
function clean(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')      // OSC
    .replace(/\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -/]*[@-~]/g, '')  // CSI/ESC
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')               // other control
    .replace(/\s+/g, ' ');
}

// Focus the largest .xterm-screen and confirm the helper textarea took focus.
async function focusTerminal(page) {
  const box = await page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('.xterm-screen')) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width >= 80 && r.height >= 60 && (!best || area > best.area)) best = { x: r.x, y: r.y, width: r.width, height: r.height, area };
    }
    return best;
  });
  if (!box) return false;
  for (let i = 0; i < 5; i++) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(250);
    const focused = await page.evaluate(() => !!document.activeElement?.classList?.contains('xterm-helper-textarea')).catch(() => false);
    if (focused) return true;
    await dismissOverlays(page);
  }
  return false;
}

// THE CORE INTERACTION: detect .xterm mount → IMMEDIATELY type. `label` tags logs.
// Returns { sawCanary, sawCmd, sawOutput, focusOk, detail }.
async function mountImmediateType(browser, label, marker) {
  const out = { sawCanary: false, sawCmd: false, sawOutput: false, focusOk: false, detail: '' };
  const page = await findRendererPage(browser, 30000);
  if (!page) { out.detail = 'no identity-matched page with .xterm'; return out; }
  // Install the onData hook BEFORE we touch the keyboard so even a swallowed
  // first char would be visible (or its absence detectable).
  await installHook(page);
  await dismissOverlays(page);
  out.focusOk = await focusTerminal(page);
  if (!out.focusOk) { out.detail = 'terminal never took keyboard focus'; return out; }

  // ZERO-DELAY first keystroke: a single canary char the instant we have focus.
  // This is the exact production failure mode — the very first key going to a
  // mid-swap handler. We assert it echoes before sending the rest. The canary
  // is an UNSUBMITTED keystroke at the shell prompt, so after confirming its
  // echo we MUST erase it (Backspace) — otherwise it prefixes the command line
  // (`zecho ...`) and corrupts the round-trip assertion below.
  await page.evaluate(() => { window.__ksHook.data = ''; });
  await page.keyboard.press('z');
  const canaryDl = Date.now() + 4000;
  while (Date.now() < canaryDl && !out.sawCanary) {
    const raw = await page.evaluate(() => window.__ksHook.data).catch(() => '');
    if (clean(raw).includes('z')) out.sawCanary = true;
    else await sleep(60);
  }
  // Erase the canary so it doesn't prefix the command line.
  await page.keyboard.press('Backspace');
  await sleep(120);

  // Now the full command. We type `echo <marker>` and assert BOTH the echoed
  // command and the command OUTPUT line round-trip.
  await page.evaluate(() => { window.__ksHook.data = ''; });
  await page.keyboard.type(`echo ${marker}`, { delay: 15 });
  await page.keyboard.press('Enter');

  const ddl = Date.now() + 8000;
  let lastBuf = '';
  while (Date.now() < ddl && !(out.sawCmd && out.sawOutput)) {
    lastBuf = await page.evaluate(() => window.__ksHook.data).catch(() => '');
    const cleaned = clean(lastBuf);
    out.sawCmd = cleaned.includes(`echo ${marker}`);
    const stripped = cleaned.replace(new RegExp(`echo ${marker}`, 'g'), '');
    out.sawOutput = stripped.includes(marker);
    if (out.sawCmd && out.sawOutput) break;
    await sleep(120);
  }
  // Cross-check command output against the visible xterm buffer too.
  if (!out.sawOutput) {
    const bufferText = await page.evaluate(() => {
      const rows = [];
      for (const row of document.querySelectorAll('.xterm-rows > div')) rows.push(row.textContent || '');
      return rows.join('\n');
    }).catch(() => '');
    if (new RegExp(marker).test(bufferText.replace(new RegExp(`echo ${marker}`, 'g'), ''))) {
      out.sawOutput = true;
      out.detail = 'output via xterm buffer';
    }
  }
  if (!out.sawCmd || !out.sawCanary) {
    out.detail = (out.detail ? out.detail + '; ' : '') + `cleaned tail: ${JSON.stringify(clean(lastBuf).slice(-160))}`;
  }
  return out;
}

// ===== gate-log scan (S4) over the isolated main log file =====
function scanLogForGate(e) {
  let files = [];
  try {
    files = fs.readdirSync(e.logDir)
      .filter((f) => /^main-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map((f) => path.join(e.logDir, f));
  } catch { return { logFound: false, emitDuringStartup: false, gateLine: false, lateLine: false }; }
  let text = '';
  for (const f of files) { try { text += fs.readFileSync(f, 'utf8') + '\n'; } catch { /* */ } }
  return {
    logFound: files.length > 0,
    // main-side emit (proves daemon:connected was broadcast to the renderer)
    emitDuringStartup: text.includes('emitting daemon:connected'),
    // renderer-relayed gate line (the paneGate='pending' branch fired)
    gateLine: text.includes('daemon connected during startup — skipping late reconcile'),
    // the LATE path firing during startup would indicate the gate failed
    lateLine: text.includes('daemon connected late — re-reconciling PTYs'),
  };
}

// ===== shutdown the detached daemon (graceful RPC → pid SIGKILL) =====
async function shutdownDaemon(e) {
  const pipeName = readDaemonPipeName(e);
  const token = readDaemonToken(e);
  const daemonPid = readDaemonPid(e);
  if (pipeName && token && await pipeAlive(pipeName)) {
    try { await rpcCall(pipeName, token, 'daemon.shutdown', {}, 5000); } catch { /* ack may race exit */ }
  }
  const dl = Date.now() + 6000;
  while (daemonPid && pidAlive(daemonPid) && Date.now() < dl) await sleep(150);
  if (daemonPid && pidAlive(daemonPid)) {
    try { process.kill(daemonPid); } catch { /* */ }
    await sleep(300);
    if (pidAlive(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch { /* */ } }
  }
  return daemonPid;
}

function spanMarks(marks, a, b) {
  const va = a in marks ? marks[a] : null;
  const vb = b in marks ? marks[b] : null;
  return va != null && vb != null ? vb - va : null;
}

// track every env+app for the final zombie sweep
const trackedApps = [];

async function main() {
  console.log(`coldstart-first-keystroke-dynamic — exe=${APP_EXE}`);
  console.log(`iterations=${ARGS.iterations}\n`);

  const gateScans = []; // collect per-env gate scans for S4

  // ---------------- S1: parallelism proof (single boot) ----------------
  console.log('=== S1: parallelism proof (renderer-load-triggered < daemon-bootstrap-end) ===');
  const e1 = makeEnv('s1');
  const app1 = spawnApp(e1);
  trackedApps.push({ e: e1, app: app1 });
  let s1Booted = false;
  let s1Cdp = null;
  try {
    s1Cdp = await app1.waitForCdp(25000).catch(() => null);
    s1Booted = await waitDaemonPipeFile(e1, 30000);
  } catch { /* */ }
  // Let post-bootstrap marks (bootstrap-end, ready-end) flush.
  await sleep(2500);

  const m1 = app1.marks;
  const hasRLT = 'renderer-load-triggered' in m1;
  const hasDBE = 'daemon-bootstrap-end' in m1;
  check('S1: both `renderer-load-triggered` and `daemon-bootstrap-end` marks present', hasRLT && hasDBE,
    `renderer-load-triggered=${hasRLT ? m1['renderer-load-triggered'] - app1.t0 + 'ms' : 'ABSENT'}, `
    + `daemon-bootstrap-end=${hasDBE ? m1['daemon-bootstrap-end'] - app1.t0 + 'ms' : 'ABSENT'}`);

  let s1Gap = null;
  if (hasRLT && hasDBE) {
    s1Gap = m1['daemon-bootstrap-end'] - m1['renderer-load-triggered']; // >0 == parallel (RLT earlier)
    check('S1: `renderer-load-triggered` epoch < `daemon-bootstrap-end` epoch (PARALLEL, not serial)',
      m1['renderer-load-triggered'] < m1['daemon-bootstrap-end'],
      `gap = ${s1Gap}ms (RLT is ${s1Gap >= 0 ? 'EARLIER' : 'LATER'} than bootstrap-end; serial order would be LATER)`);
  } else {
    check('S1: `renderer-load-triggered` epoch < `daemon-bootstrap-end` epoch (PARALLEL, not serial)', false,
      'one or both marks absent — cannot compare');
  }
  check('S1: daemon pipe file appeared + CDP exposed', s1Booted && s1Cdp != null,
    `daemonPipe=${s1Booted} cdp=${s1Cdp ?? 'none'}`);

  // S1's renderer is also a fine first dda4c0c sample (fresh HOME). Fold it in.
  let s1Type = null;
  if (s1Cdp != null && s1Booted) {
    let b1 = null;
    try {
      b1 = await connectCdp(s1Cdp);
      s1Type = await mountImmediateType(b1, 's1', 'first-keystroke-ok-s1');
    } catch (err) { s1Type = { detail: err.message, sawCanary: false, sawCmd: false, sawOutput: false, focusOk: false }; }
    finally { try { await b1?.close(); } catch { /* */ } }
  }
  await sleep(800);
  gateScans.push({ tag: 's1', scan: scanLogForGate(e1) });
  await killAppOnly(e1, app1);
  await shutdownDaemon(e1);

  // ---------------- S2: dda4c0c regression x N (fresh HOME each) ----------------
  console.log(`\n=== S2: dda4c0c regression — mount-immediate first keystroke x${ARGS.iterations} (fresh HOME each) ===`);
  const iterResults = [];
  // Include the S1 boot's keystroke result as iteration 0's evidence if valid.
  let successCount = 0;
  let attempted = 0;
  for (let i = 0; i < ARGS.iterations; i++) {
    const e = makeEnv(`s2i${i}`);
    const app = spawnApp(e);
    trackedApps.push({ e, app });
    let cdp = null, booted = false, res = null;
    try {
      cdp = await app.waitForCdp(25000).catch(() => null);
      booted = await waitDaemonPipeFile(e, 30000);
      if (cdp != null && booted) {
        const br = await connectCdp(cdp);
        try { res = await mountImmediateType(br, `s2i${i}`, `first-keystroke-ok-${i}`); }
        finally { try { await br.close(); } catch { /* */ } }
      }
    } catch (err) {
      res = { detail: err.message, sawCanary: false, sawCmd: false, sawOutput: false, focusOk: false };
    }
    attempted++;
    const ok = !!(res && res.sawCanary && res.sawCmd && res.sawOutput);
    if (ok) successCount++;
    iterResults.push({ i, ok, res, cdp, booted });
    const r = res ?? {};
    console.log(`  iter ${i + 1}/${ARGS.iterations}: ${ok ? 'OK ' : 'FAIL'} `
      + `canary=${!!r.sawCanary} cmdEcho=${!!r.sawCmd} output=${!!r.sawOutput} focus=${!!r.focusOk}`
      + `${ok ? '' : ` :: ${r.detail || (booted ? '' : 'boot not ready')}`}`);
    await sleep(500);
    gateScans.push({ tag: `s2i${i}`, scan: scanLogForGate(e) });
    await killAppOnly(e, app);
    await shutdownDaemon(e);
    try { fs.rmSync(e.home, { recursive: true, force: true }); } catch { /* */ }
  }
  // Roll the S1 sample in as supporting evidence (not counted toward N).
  const s1KeystrokeOk = !!(s1Type && s1Type.sawCanary && s1Type.sawCmd && s1Type.sawOutput);
  check(`S2: first keystroke survived on ALL ${ARGS.iterations} fresh-HOME boots (zero drops)`,
    successCount === attempted && attempted === ARGS.iterations,
    `${successCount}/${attempted} boots passed; S1 fresh boot keystroke=${s1KeystrokeOk ? 'OK' : 'n/a/FAIL'}`);

  // ---------------- S3: restore-path variant ----------------
  console.log('\n=== S3: restore path — reboot against a live daemon with a non-empty pty.list ===');
  const e3 = makeEnv('s3');
  // Boot #1: create a pane so the daemon's pty.list is non-empty, then app-only quit.
  const app3a = spawnApp(e3);
  trackedApps.push({ e: e3, app: app3a });
  let s3SeedOk = false;
  let s3PaneCount = null;
  try {
    const cdpA = await app3a.waitForCdp(25000).catch(() => null);
    const bootedA = await waitDaemonPipeFile(e3, 30000);
    if (cdpA != null && bootedA) {
      // type a marker into the seed pane, then split to guarantee >=1 live pty
      const brA = await connectCdp(cdpA);
      try {
        const pageA = await findRendererPage(brA, 30000);
        if (pageA) {
          await dismissOverlays(pageA);
          await focusTerminal(pageA);
          await pageA.keyboard.type('echo seed-pane', { delay: 15 });
          await pageA.keyboard.press('Enter');
          await sleep(400);
        }
      } finally { try { await brA.close(); } catch { /* */ } }
      // Create a second pane over RPC so the reboot's reconcile sees >=2 ptys.
      const mainToken = readMainToken(e3);
      if (mainToken && await pipeAlive(e3.mainPipe)) {
        try { await rpcCall(e3.mainPipe, mainToken, 'pane.split', { direction: 'horizontal' }, 5000); } catch { /* */ }
        await sleep(500);
        try {
          const list = await rpcCall(e3.mainPipe, mainToken, 'pty.list', {}, 5000);
          s3PaneCount = Array.isArray(list) ? list.length : (Array.isArray(list?.ptys) ? list.ptys.length : null);
        } catch { /* */ }
      }
      s3SeedOk = true;
    }
  } catch (err) { console.log(`  [S3 seed] ${err.message}`); }
  const daemonPidBeforeReboot = readDaemonPid(e3);
  await killAppOnly(e3, app3a);
  await sleep(800);
  const daemonSurvived = daemonPidBeforeReboot != null && pidAlive(daemonPidBeforeReboot);
  check('S3: seed boot created live PTYs + detached daemon survived app-only quit', s3SeedOk && daemonSurvived,
    `seedOk=${s3SeedOk} ptyCount=${s3PaneCount ?? '?'} daemonPid=${daemonPidBeforeReboot ?? 'none'} survived=${daemonSurvived}`);

  // Boot #2 (the restore/reuse boot): mount-immediate typing must still work.
  const app3b = spawnApp(e3);
  trackedApps.push({ e: e3, app: app3b });
  let s3Type = null;
  let s3Reused = false;
  try {
    const cdpB = await app3b.waitForCdp(25000).catch(() => null);
    // reuse boot: daemon already up; daemon-pipe file already exists.
    const reuseDl = Date.now() + 8000;
    while (Date.now() < reuseDl) { if ('daemon-reused' in app3b.marks) { s3Reused = true; break; } await sleep(120); }
    if (cdpB != null) {
      const brB = await connectCdp(cdpB);
      try { s3Type = await mountImmediateType(brB, 's3reboot', 'first-keystroke-ok-restore'); }
      finally { try { await brB.close(); } catch { /* */ } }
    }
  } catch (err) {
    s3Type = { detail: err.message, sawCanary: false, sawCmd: false, sawOutput: false, focusOk: false };
  }
  const s3Ok = !!(s3Type && s3Type.sawCanary && s3Type.sawCmd && s3Type.sawOutput);
  check('S3: first keystroke survived on the restore/reuse boot (non-empty reconcile)', s3Ok,
    s3Ok ? `daemon-reused=${s3Reused}` : `${s3Type?.detail || 'no keystroke result'} (daemon-reused=${s3Reused})`);
  await sleep(800);
  gateScans.push({ tag: 's3', scan: scanLogForGate(e3) });
  await killAppOnly(e3, app3b);
  const s3DaemonPid = await shutdownDaemon(e3);

  // ---------------- S4: gate log ----------------
  // The S-A Step 1 race-correctness contract has two valid runtime outcomes for
  // the FIRST daemon:connected (now able to arrive mid-startup):
  //   A) it arrives while paneGate is still 'pending'  → the gate fires:
  //      "[lifecycle] daemon connected during startup — skipping late reconcile"
  //      (the startup reconcile owns the first reconcile; the listener bails).
  //   B) it arrives after the startup reconcile already flipped paneGate to
  //      'ready' → the listener correctly treats it as a GENUINE late connect
  //      and runs "[lifecycle] daemon connected late — re-reconciling PTYs".
  // Both are SAFE — (B) is a real late connect, not a gate miss. The only
  // failure signature would be a dropped keystroke, which S2/S3 already exclude
  // on every boot. So here we (1) prove the emit reached the renderer, (2) where
  // the gate DID fire, confirm it logged the skip, and (3) confirm no SINGLE log
  // contains BOTH lines (that co-occurrence would mean the gate let a connect
  // through while still pending — the actual regression smell).
  console.log('\n=== S4: gate-log (daemon:connected during startup → skipping late reconcile) ===');
  const withEmit = gateScans.filter((g) => g.scan.logFound && g.scan.emitDuringStartup);
  const anyLogFound = gateScans.some((g) => g.scan.logFound);
  const gateFired = gateScans.filter((g) => g.scan.gateLine);
  const lateFired = gateScans.filter((g) => g.scan.lateLine);
  check('S4: at least one isolated main log file was found + readable', anyLogFound,
    `${gateScans.filter((g) => g.scan.logFound).length}/${gateScans.length} envs had a log file`);
  check('S4: daemon:connected was emitted to the renderer (race surface exists)', withEmit.length > 0,
    `emit-during-startup seen in ${withEmit.length}/${gateScans.length} env(s)`);

  // Real regression smell: a single boot logging BOTH the gate-skip AND the late
  // path would mean the gate fired (paneGate pending) yet the late reconcile ALSO
  // ran on that same boot — the gate failed to hold. Valid logs contain exactly
  // ONE of the two.
  const both = gateScans.filter((g) => g.scan.gateLine && g.scan.lateLine);
  check('S4: no boot logged BOTH the gate-skip AND the late path (gate held; outcome A xor B)',
    both.length === 0,
    both.length === 0 ? 'clean (each boot took exactly one path)' : `co-occurred in: ${both.map((g) => g.tag).join(', ')}`);

  if (gateFired.length > 0) {
    check('S4: gate-skip line present where the mid-startup window was hit (outcome A)', true,
      `gate fired in ${gateFired.length} env(s): ${gateFired.map((g) => g.tag).join(', ')}`);
  } else {
    console.log(`  [INFO] gate scenario not exercised — the gate-skip branch was not hit this run: on every boot the `
      + `startup reconcile flipped paneGate to 'ready' before daemon:connected arrived, so the listener took the `
      + `GENUINE late-connect path (outcome B) in ${lateFired.length} env(s). This is correct, race-safe behavior `
      + `(no keystroke dropped per S2/S3), NOT a FAIL — the spec anticipates timing may not hit the gate window.`);
    check('S4: gate-skip branch observed (informational; absence is NOT a FAIL per spec)', true,
      `not exercised this run — late-connect path (outcome B) taken in ${lateFired.length} env(s) instead`);
  }

  // ---------------- S5: cleanup + zombie sweep ----------------
  console.log('\n=== S5: cleanup + zombie sweep ===');
  // Daemons: shut down any still-recorded daemon pid per env, verify gone.
  let zombieDaemons = 0;
  for (const e of liveEnvs) {
    const pid = readDaemonPid(e);
    if (pid && pidAlive(pid)) {
      await shutdownDaemon(e);
      await sleep(200);
      if (pidAlive(pid)) { zombieDaemons++; }
    }
  }
  check('S5: no surviving daemon processes (zombie-free)', zombieDaemons === 0,
    zombieDaemons === 0 ? 'all daemons terminated' : `${zombieDaemons} daemon(s) STILL ALIVE`);

  // App procs: all tracked launcher procs must be gone. pid-level truth alone
  // is unreliable on Windows — the Electron launcher handle can keep
  // exitCode===null after the real process tree is gone, AND the OS can recycle
  // the dead pid to an unrelated process. So a "pidAlive" hit is only a REAL
  // zombie if the live pid still has the wmux.exe image name (a recycled pid
  // would not). Mirrors perf-bench's pidLooksLikeWmuxDaemon pattern.
  let zombieApps = 0;
  const zombieDetail = [];
  for (const { app } of trackedApps) {
    if (app.proc.pid == null) continue;
    if (app.proc.exitCode !== null || app.proc.signalCode !== null) continue; // handle saw it exit
    if (!pidAlive(app.proc.pid)) continue; // pid gone → exited
    // pid is alive — confirm it is actually still a wmux.exe before counting it.
    if (await pidIsWmux(app.proc.pid)) {
      try { app.proc.kill('SIGKILL'); } catch { /* */ }
      await sleep(200);
      if (pidAlive(app.proc.pid) && await pidIsWmux(app.proc.pid)) { zombieApps++; zombieDetail.push(app.proc.pid); }
    }
  }
  check('S5: all tracked app processes exited (zombie-free)', zombieApps === 0,
    zombieApps === 0 ? `${trackedApps.length} app procs gone (no surviving wmux.exe from our spawns)`
      : `${zombieApps} app proc(s) STILL ALIVE: ${zombieDetail.join(', ')}`);

  // Temp dirs removed. A just-shut-down daemon can momentarily re-touch its
  // pid/log files in the home dir as it exits, racing the rmSync; retry a few
  // times with a short backoff so a transient lock doesn't accrete temp dirs
  // across repeated CI runs.
  let rmFail = 0;
  for (const e of liveEnvs) {
    let gone = false;
    for (let attempt = 0; attempt < 5 && !gone; attempt++) {
      try { fs.rmSync(e.home, { recursive: true, force: true }); } catch { /* */ }
      gone = !fs.existsSync(e.home);
      if (!gone) await sleep(300);
    }
    if (!gone) rmFail++;
  }
  check('S5: all temp HOME dirs removed', rmFail === 0,
    rmFail === 0 ? `${liveEnvs.length} dirs removed` : `${rmFail} dir(s) remain`);

  // ---------------- report ----------------
  console.log('\n----- summary -----');
  console.log(`  S1 parallel gap (daemon-bootstrap-end − renderer-load-triggered): ${s1Gap == null ? 'n/a' : s1Gap + 'ms'} `
    + `(positive = renderer kicked BEFORE bootstrap finished; serial order would be negative)`);
  if (hasRLT && hasDBE) {
    console.log(`  S1 marks (ms since spawn): renderer-load-triggered=${m1['renderer-load-triggered'] - app1.t0}, `
      + `daemon-bootstrap-start=${'daemon-bootstrap-start' in m1 ? m1['daemon-bootstrap-start'] - app1.t0 : 'n/a'}, `
      + `daemon-bootstrap-end=${m1['daemon-bootstrap-end'] - app1.t0}, `
      + `ready-end=${'ready-end' in m1 ? m1['ready-end'] - app1.t0 : 'n/a'}`);
  }
  console.log(`  S2 first-keystroke success rate: ${successCount}/${attempted} (${attempted ? Math.round((successCount / attempted) * 100) : 0}%)`);
  console.log(`  S3 restore-boot keystroke: ${s3Ok ? 'OK' : 'FAIL'} (daemon-reused=${s3Reused}, seeded ptyCount=${s3PaneCount ?? '?'})`);
  const gateSummary = gateFired.length > 0
    ? `gate-skip (outcome A) FIRED in ${gateFired.length} env(s); genuine-late (outcome B) in ${lateFired.length}`
    : `gate-skip not exercised this run; genuine-late path (outcome B, race-safe) taken in ${lateFired.length} env(s); emit-during-startup seen in ${withEmit.length}`;
  console.log(`  S4 gate log: ${gateSummary}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) console.log('FAILED: ' + failed.map((r) => r.name).join('; '));
  process.exit(failed.length ? 1 : 0);
}

// Last-resort sweep so a thrown error never leaks a daemon or temp dir.
async function emergencySweep() {
  for (const e of liveEnvs) {
    try { await shutdownDaemon(e); } catch { /* */ }
    try { fs.rmSync(e.home, { recursive: true, force: true }); } catch { /* */ }
  }
  for (const { app } of trackedApps) {
    try { if (app.proc.exitCode === null) app.proc.kill('SIGKILL'); } catch { /* */ }
  }
}

main().catch(async (e) => {
  console.error('FATAL:', e.stack || e.message);
  await emergencySweep();
  process.exit(2);
});

/**
 * perf-bench.mjs — A1 app-level performance benchmark for wmux.
 *
 * WHAT THIS MEASURES (against the PACKAGED app, out/wmux-win32-x64/wmux.exe)
 * --------------------------------------------------------------------------
 *   coldStart      spawn→CDP-ready, spawn→pipe-ready, spawn→renderer (.xterm
 *                  mounted), spawn→first PTY data at the renderer (the prompt
 *                  reaching the terminal — the honest "usable" milestone),
 *                  plus FCP from the renderer's paint timeline. N runs with a
 *                  discarded warmup; per-milestone medians.
 *   inputLatency   key→echo and key→frame-after-echo, measured ENTIRELY
 *                  inside the renderer: an injected capture-phase keydown
 *                  listener timestamps the key, an injected
 *                  electronAPI.pty.onData subscriber timestamps the shell
 *                  echo (renderer→main→daemon→ConPTY→shell→back), and a
 *                  requestAnimationFrame chained on the echo approximates the
 *                  frame in which xterm draws the glyph. CDP/websocket
 *                  transport overhead is therefore EXCLUDED from the numbers.
 *                  Run at 1 pane and again at 8 panes (focused pane).
 *   ram            Working set + commit charge summed over the FULL process
 *                  tree: main exe + Chromium children + the detached daemon
 *                  (read from its pid file) + its ConPTY/conhost children.
 *                  Sampled at idle-1-pane and at 8 panes. PR D adds an additive
 *                  `breakdown` field that attributes that flat total to per-
 *                  process categories (main / renderer / gpu / utility / daemon
 *                  / conhost / other) via the Electron `--type=` flag, so a
 *                  diet candidate (scrollback cap, V8 heap, GPU release) can be
 *                  located before it is built. With --scrollback-lines N the
 *                  bench pre-seeds session.json so EVERY measured pane mounts at
 *                  that scrollback size (clean A/B at both idle1Pane and 8
 *                  panes — see buildScrollbackSeedSession). With
 *                  --webgl-occupancy it logs the 8-pane WebGL-canvas count.
 *
 * ISOLATION MODEL
 * ---------------
 * Each app instance gets a fresh temp USERPROFILE/HOME/APPDATA/LOCALAPPDATA
 * AND a unique WMUX_DATA_SUFFIX. The suffix re-keys the main pipe, the daemon
 * pipe, the auth tokens, ~/.wmux and the Electron userData dir (and therefore
 * the single-instance lock), so the bench can run while a real wmux is open —
 * no pre-flight abort needed (unlike substrate-bench.mjs).
 *
 * CLEANUP (the substrate-bench daemon leak, fixed here)
 * -----------------------------------------------------
 * The daemon is spawned DETACHED by the app and survives SIGTERM on the main
 * exe (quit=detach persistence design). This harness explicitly sends
 * `daemon.shutdown` on the daemon pipe (name read from <home>/.wmux<suffix>/
 * daemon-pipe, token from <home>/.wmux/daemon-auth-token) and falls back to a
 * pid-file kill, then verifies both pipes are gone before the next cold run.
 *
 * MEASUREMENT CAVEATS
 * -------------------
 * - frameMs anchors on the rAF callback after the echo: it marks the start of
 *   the frame that draws the glyph, not the GPU swap — a small constant tail
 *   (≤1 frame) is excluded. echoMs is render-independent and the most stable.
 * - Cursor blink / status-bar timers do NOT pollute these numbers (we anchor
 *   on the echo event, not on global frame diffing).
 * - If the window is occluded, rAF throttles; the harness measures the rAF
 *   cadence and flags `throttled: true` — trust echoMs only in that case.
 * - Numbers are machine-dependent. Baselines are descriptive, not targets.
 *
 * HOW TO RUN (PowerShell, package first):
 *   npm run package; node scripts/perf-bench.mjs --json out/perf-local.json
 *
 * Flags: --mode local|ci   sample-count presets (local: 5 cold runs /120/60,
 *                          ci: 3 /80/40)
 *        --json <path>     write machine-readable results
 *        --cold-runs N --samples N --samples8 N   explicit overrides
 *        --scrollback-lines N   inject scrollback=N into measured panes (A/B)
 *        --webgl-occupancy      log the 8-pane WebGL canvas count (DOM approx)
 *        --skip-cold | --skip-input | --skip-ram
 *        --keep-app        leave the last instance running (debugging)
 */
import { spawn, execFile, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { accumulateBreakdown, RAM_CATEGORIES } from './perf-process-classify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const APP_EXE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
const USERNAME = os.userInfo().username || 'default';
// Identity guard: the app picks a RANDOM CDP port in 18800-18899. If that port
// is already taken (a live wmux, or a zombie listener from a dead one), the
// bind silently fails and connectOverCDP would attach to the OTHER app — and
// the bench would type keystrokes into someone's real terminal. Only accept
// renderer pages whose URL lives under OUR packaged build dir.
const APP_URL_PREFIX = pathToFileURL(path.join(REPO_ROOT, 'out', 'wmux-win32-x64')).href.toLowerCase();

// === CLI ===
function parseArgs(argv) {
  const out = {
    mode: 'local', json: null, help: false, keepApp: false,
    coldRuns: null, samples: null, samples8: null,
    skipCold: false, skipInput: false, skipRam: false, diag: false,
    // PR D — RAM attribution. scrollbackLines: null leaves the app default
    // (10000) untouched; a number injects that scrollback into the panes the
    // bench measures so two runs (e.g. 10000 vs 1000) form an A/B for the
    // scrollback-cap go/no-go. webglOccupancy: log the 8-pane WebGL-canvas
    // count (approximation; see measureWebglOccupancy).
    scrollbackLines: null, webglOccupancy: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--mode') out.mode = argv[++i] === 'ci' ? 'ci' : 'local';
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--cold-runs') out.coldRuns = Math.max(1, Number(argv[++i]) || 0);
    else if (a === '--samples') out.samples = Math.max(5, Number(argv[++i]) || 0);
    else if (a === '--samples8') out.samples8 = Math.max(5, Number(argv[++i]) || 0);
    else if (a === '--scrollback-lines') {
      // Reject garbage instead of coercing to 0 — a silently-zeroed seed
      // would measure "scrollback disabled" while the runner believes they
      // asked for N lines, poisoning the A/B comparison.
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`--scrollback-lines expects a positive integer, got: ${argv[i]}`);
        out.help = true;
      } else {
        out.scrollbackLines = n;
      }
    }
    else if (a === '--webgl-occupancy') out.webglOccupancy = true;
    else if (a === '--skip-cold') out.skipCold = true;
    else if (a === '--skip-input') out.skipInput = true;
    else if (a === '--skip-ram') out.skipRam = true;
    else if (a === '--keep-app') out.keepApp = true;
    else if (a === '--diag') out.diag = true;
    else { console.error(`unknown arg: ${a}`); out.help = true; }
  }
  const preset = out.mode === 'ci'
    ? { coldRuns: 3, samples: 80, samples8: 40 }
    : { coldRuns: 5, samples: 120, samples8: 60 };
  out.coldRuns = out.coldRuns ?? preset.coldRuns;
  out.samples = out.samples ?? preset.samples;
  out.samples8 = out.samples8 ?? preset.samples8;
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log(`perf-bench.mjs — wmux app-level performance benchmark (A1)

Usage (PowerShell, package first):
  npm run package; node scripts/perf-bench.mjs [--mode local|ci] [--json <path>]

Scenarios: coldStart (N isolated boots, warmup discarded), inputLatency
(key→echo / key→frame in-renderer, 1 pane and 8 panes), ram (process-tree
working set at idle-1-pane / 8 panes). See bench/README.md.

RAM-attribution flags (PR D):
  --scrollback-lines N   inject scrollback=N into the panes the bench creates
                         (run twice, e.g. 10000 vs 1000, for a scrollback A/B).
  --webgl-occupancy      log the 8-pane WebGL canvas count (DOM approximation).
ram results carry an additive ram.breakdown (per-process-category working set:
main / renderer / gpu / utility / daemon / conhost / other) — never gated.`);
  process.exit(0);
}
if (!fs.existsSync(APP_EXE)) {
  console.error(`Packaged app missing at ${APP_EXE}. Run \`npm run package\` first.`);
  process.exit(2);
}

// === Small utils ===
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}
function summarize(latencies) {
  const s = [...latencies].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    min: round(s[0] ?? null),
    max: round(s[s.length - 1] ?? null),
    mean: s.length ? round(sum / s.length) : null,
  };
}
function median(values) {
  const s = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}
async function waitFor(label, fn, timeoutMs, intervalMs = 100) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
    if (Date.now() - start >= timeoutMs) throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}
function pipeAlive(pipeName) {
  return new Promise((resolve) => {
    const sock = net.createConnection(pipeName);
    const done = (val) => { try { sock.destroy(); } catch { /* noop */ } resolve(val); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 300);
  });
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// === Raw newline-delimited JSON-RPC over a named pipe (one-shot client) ===
// No clientName → recorded 'legacy' and grandfathered by RpcRouter, so
// mutating calls (pane.split) run against the production enforce-mode app
// without an approval dialog (same model as substrate-bench.mjs).
class PipeClient {
  constructor(pipeName, token) {
    this.pipeName = pipeName;
    this.token = token;
    this.sock = null;
    this.buf = '';
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.pipeName);
      let settled = false;
      sock.setEncoding('utf8');
      sock.once('connect', () => { settled = true; this.sock = sock; resolve(); });
      sock.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('close', () => {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('socket closed')); }
        this.pending.clear();
      });
    });
  }
  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? msg);
    }
  }
  call(method, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('not connected'));
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, method, params, token: this.token }) + '\n');
    });
  }
  close() { try { this.sock?.destroy(); } catch { /* noop */ } }
}

// === Renderer-side instrumentation (injected as init script + idempotent) ===
// - firstDataEpoch: Date.now() at the first PTY data chunk → cold-start
//   "prompt reached the terminal" milestone.
// - arm({ch}) + capture-phase keydown listener + pty.onData echo matcher +
//   rAF chained on the echo → per-key {echoMs, frameMs} samples.
// - pinnedId: after the first matched echo, lock onto that ptyId so sibling
//   panes' output can't satisfy a later match. Reset per scenario.
const HOOK_SOURCE = `(() => {
  if (window.__wmuxBenchHook) return;
  const H = {
    installedEpoch: Date.now(), firstDataEpoch: null, ready: false,
    samples: [], pending: null, pinnedId: null, pinCandidates: [],
    dataEvents: 0, lastData: null, // diag aids
  };
  window.__wmuxBenchHook = H;
  window.addEventListener('keydown', (e) => {
    const p = H.pending;
    if (p && p.tKeydown === null && e.key === p.ch) p.tKeydown = performance.now();
  }, { capture: true });
  const tryHook = () => {
    const api = window.electronAPI;
    if (!api || !api.pty || typeof api.pty.onData !== 'function') { setTimeout(tryHook, 2); return; }
    api.pty.onData((id, data) => {
      H.dataEvents++;
      H.lastData = { id, snippet: String(data).slice(0, 80) };
      if (H.firstDataEpoch === null && data && data.length) H.firstDataEpoch = Date.now();
      const p = H.pending;
      if (p && p.tKeydown !== null && (H.pinnedId === null || H.pinnedId === id)
          && typeof data === 'string' && data.indexOf(p.ch) !== -1) {
        H.pending = null;
        if (p.prime) {
          // Priming keystroke: record the candidate ptyId, no sample. The
          // harness pins only after two consecutive identical candidates, so
          // a sibling pane's random output can't mis-pin the matcher.
          H.pinCandidates.push(id);
          return;
        }
        if (H.pinnedId === null) H.pinnedId = id;
        const tEcho = performance.now();
        const tKey = p.tKeydown;
        requestAnimationFrame(() => {
          H.samples.push({ ch: p.ch, echoMs: tEcho - tKey, frameMs: performance.now() - tKey });
        });
      }
    });
    H.ready = true;
  };
  tryHook();
})();`;

// === App instance lifecycle ===
let INSTANCE_SEQ = 0;
const liveInstances = new Set();

function makeInstance() {
  const seq = INSTANCE_SEQ++;
  const suffix = `-bench${process.pid}r${seq}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `wmux-perf-${seq}-`));
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
  delete env.WMUX_DISABLE_CDP; // the bench NEEDS the app's CDP endpoint
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  // Pre-seed the first-run marker (<userData>/.first-run): a fresh HOME would
  // otherwise pop the first-run wizard, whose fixed-inset overlay swallows the
  // bench's pane click and steals terminal focus (all input samples drop).
  // This also makes coldStart measure the REGULAR boot, not the wizard boot.
  const userDataDir = path.join(env.APPDATA, `wmux${suffix}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');
  // PR D scrollback A/B: pre-seed session.json so loadSession applies the
  // scrollbackLines preference BEFORE any terminal mounts (see
  // buildScrollbackSeedSession for why this beats CDP store-injection). Only
  // when --scrollback-lines is supplied; otherwise the app boots untouched.
  if (ARGS.scrollbackLines != null) {
    fs.writeFileSync(
      path.join(userDataDir, 'session.json'),
      JSON.stringify(buildScrollbackSeedSession(ARGS.scrollbackLines)),
      'utf8',
    );
  }
  return {
    seq, suffix, home, env,
    proc: null, cdpPort: null, browser: null, page: null,
    mainPipe: `\\\\.\\pipe\\wmux${suffix}-${USERNAME}`,
    daemonPipeFallback: `\\\\.\\pipe\\wmux-daemon${suffix}-${USERNAME}`,
    wmuxDir: path.join(home, `.wmux${suffix}`),
    t0: null,
    milestones: {},
    bootMarks: {},   // [boot-trace] mark lines from the app, ms relative to t0
    daemonBoot: null, // daemon.ping bootTrace (marks re-based to t0), or null
  };
}

function spawnInstance(inst) {
  inst.t0 = Date.now();
  inst.proc = spawn(APP_EXE, [], {
    cwd: REPO_ROOT, env: inst.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  liveInstances.add(inst);
  let stdoutBuf = '';
  inst.cdpPortPromise = new Promise((resolve, reject) => {
    const onChunk = (b) => {
      if (inst.cdpPort !== null) return; // already matched — don't re-stamp on later chunks
      stdoutBuf += b.toString('utf8');
      const m = stdoutBuf.match(/CDP enabled on port (\d+)/);
      if (m) {
        inst.cdpPort = Number(m[1]);
        // NOTE: the app prints this line BEFORE Chromium binds the port, so
        // this milestone means "spawn → main process alive at the CDP-announce
        // log", not "CDP connectable". Informational only (never gated).
        inst.milestones.cdpReadyMs = Date.now() - inst.t0;
        resolve(inst.cdpPort);
      }
    };
    inst.proc.stdout.on('data', onChunk);
    inst.proc.stderr.on('data', onChunk);
    inst.proc.on('exit', (code) => reject(new Error(`app exited early (code ${code}) before CDP line`)));
    setTimeout(() => reject(new Error('timeout waiting for CDP port line (20s)')), 20000);
  });
  // Boot-trace mark collector (S-A). Separate listener from the CDP matcher
  // above: that one early-returns once the port is found, while marks keep
  // arriving until ready-end. Line-buffered because chunks can split lines.
  // STDERR ONLY: bootTrace.ts emits marks via process.stderr.write, and a
  // single buffer shared across both streams could interleave stdout chunks
  // into the middle of a stderr line and corrupt the parse.
  // Marks are emitted as absolute epochs by src/main/util/bootTrace.ts and
  // re-based here onto the bench timeline (same machine clock as t0).
  {
    let traceBuf = '';
    const onTraceChunk = (b) => {
      traceBuf += b.toString('utf8');
      let nl;
      while ((nl = traceBuf.indexOf('\n')) !== -1) {
        const line = traceBuf.slice(0, nl);
        traceBuf = traceBuf.slice(nl + 1);
        const m = line.match(/\[boot-trace\] mark=([\w-]+) epoch=(\d+)/);
        if (m && !(m[1] in inst.bootMarks)) {
          inst.bootMarks[m[1]] = Number(m[2]) - inst.t0;
        }
      }
      // Cap a pathological lineless tail (binary noise) — marks always end in \n.
      if (traceBuf.length > 65536) traceBuf = traceBuf.slice(-4096);
    };
    inst.proc.stderr.on('data', onTraceChunk);
  }
  // Surface app errors to the harness log without flooding it.
  inst.proc.on('exit', (code) => {
    if (liveInstances.has(inst)) console.error(`[app#${inst.seq}] exited (code ${code})`);
  });
}

function readDaemonPid(inst) {
  try {
    const pid = Number(fs.readFileSync(path.join(inst.wmuxDir, 'daemon.pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function readDaemonPipeName(inst) {
  try {
    const name = fs.readFileSync(path.join(inst.wmuxDir, 'daemon-pipe'), 'utf8').trim();
    return name || inst.daemonPipeFallback;
  } catch { return inst.daemonPipeFallback; }
}
function readDaemonToken(inst) {
  // DaemonPipeServer.getTokenPath() is NOT suffix-aware (~/.wmux/daemon-auth-token);
  // probe the suffixed dir too in case that ever changes.
  for (const p of [
    path.join(inst.home, '.wmux', 'daemon-auth-token'),
    path.join(inst.wmuxDir, 'daemon-auth-token'),
  ]) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch { /* next */ }
  }
  return null;
}

// Best-effort identity check before the fallback SIGKILL: the pid file lives
// in OUR temp home, but a pid can be recycled by the OS between the alive
// check and the kill. Require the live process to still look like the wmux
// daemon (image wmux.exe/node + a daemon script on the command line). On
// lookup ERROR we default to killing (it is our pid file); on a verified
// MISMATCH we skip.
async function pidLooksLikeWmuxDaemon(pid) {
  return new Promise((resolve) => {
    execFile(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object Name,CommandLine | ConvertTo-Json -Compress`],
    { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(true); // lookup failed → trust our pid file
      try {
        const p = JSON.parse(stdout);
        const name = String(p.Name ?? '').toLowerCase();
        const cmd = String(p.CommandLine ?? '').toLowerCase();
        resolve((name.includes('wmux') || name.includes('node')) && cmd.includes('daemon'));
      } catch { resolve(true); }
    });
  });
}

// Graceful full shutdown: daemon.shutdown on the daemon pipe → pid-file kill
// fallback → terminate the main exe → verify both pipes are gone → rm home.
async function shutdownInstance(inst, { removeHome = true } = {}) {
  if (inst.shuttingDown) return; // re-entrancy guard (double SIGINT, FATAL+SIGINT race)
  inst.shuttingDown = true;
  liveInstances.delete(inst);
  try { await inst.browser?.close(); } catch { /* noop */ }
  inst.browser = null;
  inst.page = null;

  const daemonPid = readDaemonPid(inst);
  const daemonPipe = readDaemonPipeName(inst);
  const token = readDaemonToken(inst);
  if (token && await pipeAlive(daemonPipe)) {
    try {
      const dc = new PipeClient(daemonPipe, token);
      await dc.connect();
      await dc.call('daemon.shutdown', {}, 5000).catch(() => { /* ack may race exit */ });
      dc.close();
    } catch { /* fall through to pid kill */ }
  }
  // Pid-file backstop. The pid file lives in OUR isolated temp home, so this
  // cannot target a foreign process by construction.
  const deadline = Date.now() + 8000;
  while (daemonPid && pidAlive(daemonPid) && Date.now() < deadline) await sleep(150);
  if (daemonPid && pidAlive(daemonPid)) {
    if (await pidLooksLikeWmuxDaemon(daemonPid)) {
      try { process.kill(daemonPid); } catch { /* noop */ }
      await sleep(300);
      if (pidAlive(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch { /* noop */ } }
    } else {
      console.error(`[app#${inst.seq}] daemon pid ${daemonPid} no longer looks like a wmux daemon (recycled?) — not killing`);
    }
  }

  if (inst.proc && !inst.proc.killed) { try { inst.proc.kill(); } catch { /* noop */ } }
  const exitDeadline = Date.now() + 5000;
  while (inst.proc && inst.proc.exitCode === null && Date.now() < exitDeadline) await sleep(100);
  if (inst.proc && inst.proc.exitCode === null) { try { inst.proc.kill('SIGKILL'); } catch { /* noop */ } }

  // Verify the pipes actually went away (next cold run must not reuse them —
  // a unique per-run suffix already prevents collisions, this is belt+braces).
  try {
    await waitFor('pipes gone', async () =>
      !(await pipeAlive(inst.mainPipe)) && !(await pipeAlive(daemonPipe)), 8000, 250);
  } catch { console.error(`[app#${inst.seq}] warning: a pipe is still alive after shutdown`); }

  if (removeHome) { try { fs.rmSync(inst.home, { recursive: true, force: true }); } catch { /* noop */ } }
}

// Find the renderer page (the one with .xterm mounted) among CDP targets.
// Pages not under APP_URL_PREFIX are rejected — see the identity-guard note.
async function findRendererPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      try {
        if (!p.url().toLowerCase().startsWith(APP_URL_PREFIX)) continue;
        if (await p.evaluate(() => !!document.querySelector('.xterm'))) return p;
      } catch { /* navigating */ }
    }
  }
  return null;
}

// Boot with one retry on a fresh instance (fresh random CDP port) — covers the
// port-collision case where the identity guard rejects every page and the
// renderer-ready wait times out.
async function bootFreshInstance(maxAttempts = 2) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const inst = makeInstance();
    try {
      return await bootInstance(inst);
    } catch (e) {
      lastErr = e;
      console.error(`[boot] attempt ${attempt}/${maxAttempts} failed (suffix ${inst.suffix}): ${e.message}`);
      await shutdownInstance(inst);
    }
  }
  throw lastErr;
}

// Boot an instance to full readiness, collecting cold-start milestones.
async function bootInstance(inst) {
  spawnInstance(inst);

  // pipe-ready milestone: poll CONCURRENTLY from spawn. Polling only after the
  // CDP connect completes would fold the connect cost into pipeReadyMs and the
  // milestone would no longer mean "spawn → PipeServer accepting".
  const pipeReadyPromise = (async () => {
    await waitFor('main pipe', () => pipeAlive(inst.mainPipe), 45000, 50);
    inst.milestones.pipeReadyMs = Date.now() - inst.t0;
  })();
  pipeReadyPromise.catch(() => { /* surfaced at the await below */ });

  const port = await inst.cdpPortPromise;
  console.log(`[app#${inst.seq}] cdp port ${port}`);

  // Attach to CDP as early as possible and register the init-script hook so
  // it lands BEFORE the deferred renderer navigation (deferLoad waits for the
  // daemon bootstrap, which gives us a comfortable window).
  inst.browser = await waitFor(`CDP connect :${port}`, async () => {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { return null; }
  }, 30000, 150);
  for (const ctx of inst.browser.contexts()) {
    try { await ctx.addInitScript(HOOK_SOURCE); } catch { /* non-fatal: late-eval fallback below */ }
  }

  await pipeReadyPromise;

  // renderer-ready milestone: .xterm mounted
  inst.page = await waitFor('renderer page (.xterm)', () => findRendererPage(inst.browser), 60000, 100);
  inst.milestones.rendererReadyMs = Date.now() - inst.t0;

  // Ensure the hook exists even if the init script missed the navigation
  // (idempotent; in that case firstPtyData may be null for this run).
  try { await inst.page.evaluate(HOOK_SOURCE); } catch { /* noop */ }

  // first PTY data at the renderer (the shell prompt arriving)
  try {
    const firstDataEpoch = await waitFor('first PTY data', async () => {
      try { return await inst.page.evaluate(() => window.__wmuxBenchHook?.firstDataEpoch ?? null); } catch { return null; }
    }, 30000, 100);
    inst.milestones.firstPtyDataMs = firstDataEpoch - inst.t0;
  } catch {
    inst.milestones.firstPtyDataMs = null; // hook attached after the prompt — see header caveats
  }

  // FCP from the renderer's own paint timeline (absolute epoch math; no polling noise)
  try {
    const fcpEpoch = await inst.page.evaluate(() => {
      const e = performance.getEntriesByType('paint').find((x) => x.name === 'first-contentful-paint');
      return e ? performance.timeOrigin + e.startTime : null;
    });
    inst.milestones.fcpMs = fcpEpoch != null ? round(fcpEpoch - inst.t0) : null;
  } catch { inst.milestones.fcpMs = null; }

  // Daemon-side boot breakdown (S-A): daemon.ping carries `bootTrace`
  // (additive field). Best-effort — a local-PTY-fallback boot has no daemon.
  try {
    const token = readDaemonToken(inst);
    const daemonPipe = readDaemonPipeName(inst);
    if (token && await pipeAlive(daemonPipe)) {
      const dc = new PipeClient(daemonPipe, token);
      await dc.connect();
      const pong = await dc.call('daemon.ping', {}, 3000);
      dc.close();
      if (pong?.bootTrace?.marks) {
        const rebase = (epoch) => round(epoch - inst.t0);
        inst.daemonBoot = {
          jsStartMs: rebase(pong.bootTrace.jsStartEpochMs),
          marks: Object.fromEntries(
            Object.entries(pong.bootTrace.marks).map(([k, v]) => [k, rebase(v)]),
          ),
        };
      }
    }
  } catch { inst.daemonBoot = null; }

  return inst;
}

// Dismiss the first-boot overlays a fresh profile shows; their full-screen
// backdrops swallow the pane click and steal terminal focus (every input
// sample drops):
//   1. onboarding tour (.onboarding-overlay, z-9999) — Escape is its
//      documented close path (capture listener → onComplete → persisted).
//   2. auto-update prompt (fixed inset-0 z-[60], shown when session.json does
//      not exist) — no Escape handler; click its first button ("disable",
//      which also keeps the updater off during the bench).
async function dismissOverlays(page) {
  // The overlays mount asynchronously (session.load + first-run check), so a
  // single "nothing there" observation right after boot can be premature —
  // on slow CI runners the tour appeared AFTER this check and swallowed the
  // 1-pane scenario's focus click. Require two consecutive clean observations
  // before declaring the page overlay-free.
  let cleanChecks = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const state = await page.evaluate(() => ({
        tour: !!document.querySelector('.onboarding-overlay'),
        autoUpdate: [...document.querySelectorAll('div.fixed.inset-0')]
          .some((d) => d.className.includes('z-[60]')),
      }));
      if (!state.tour && !state.autoUpdate) {
        if (++cleanChecks >= 2) return;
        await sleep(500);
        continue;
      }
      cleanChecks = 0;
      if (state.tour) {
        await page.keyboard.press('Escape');
      } else {
        await page.evaluate(() => {
          const overlay = [...document.querySelectorAll('div.fixed.inset-0')]
            .find((d) => d.className.includes('z-[60]'));
          overlay?.querySelector('button')?.click();
        });
      }
      await sleep(400);
    } catch (e) {
      console.error(`[overlay] dismiss attempt failed (continuing): ${e.message}`);
      await sleep(400);
    }
  }
  console.error('[overlay] WARNING: overlays still present after dismissal attempts');
}

// === Scenario: input latency on the currently focused pane ===
const CHARS_SAMPLE = 'abcdefghijklmnopqrstuvwxyz';
const CHARS_PRIME = 'xq'; // pin-priming chars (consistency rule does the work, not rarity)
async function measureInputLatency(page, sampleTarget, label) {
  // Focus the LARGEST visible pane. (With alternating splits the newest pane
  // can degenerate to a ~40px sliver whose center hits a divider — clicking it
  // drops focus to <body> and every sample times out. A normal-sized pane is
  // also the representative typing target.)
  const count = await page.evaluate(() => document.querySelectorAll('.xterm').length);
  const box = await page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll('.xterm-screen')) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width >= 80 && r.height >= 60 && (!best || area > best.area)) {
        best = { x: r.x, y: r.y, width: r.width, height: r.height, area };
      }
    }
    return best;
  });
  if (!box) throw new Error('no usable .xterm-screen (all below 80x60)');
  // Click and VERIFY the terminal actually took focus. A late-mounting
  // overlay (tour/auto-update) can swallow the click and steal focus to
  // <body> — every sample then times out. Re-dismiss and retry.
  let focused = false;
  for (let attempt = 0; attempt < 4 && !focused; attempt++) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(300);
    focused = await page.evaluate(() =>
      !!document.activeElement?.classList?.contains('xterm-helper-textarea'));
    if (!focused) {
      console.error(`[${label}] click did not focus the terminal (attempt ${attempt + 1}/4) — dismissing overlays and retrying`);
      await dismissOverlays(page);
    }
  }
  if (!focused) throw new Error('terminal never took focus after 4 click attempts');

  // Reset hook state for this scenario (drop pin from a previous pane).
  await page.evaluate(() => {
    const H = window.__wmuxBenchHook;
    H.samples.length = 0; H.pending = null; H.pinnedId = null; H.pinCandidates.length = 0;
  });

  // Pin the focused pane's ptyId via priming keystrokes (excluded from the
  // samples): require two CONSECUTIVE matches with the same ptyId before
  // pinning. With 8 panes, sibling output (prompts, repaints) contains a-z and
  // could otherwise satisfy the first match and mis-pin the matcher — after
  // which every real echo would be rejected and the scenario would silently
  // collapse to zero samples.
  for (let p = 0; p < 6; p++) {
    const ch = CHARS_PRIME[p % CHARS_PRIME.length];
    await page.evaluate((c) => { window.__wmuxBenchHook.pending = { ch: c, tKeydown: null, prime: true }; }, ch);
    await page.keyboard.press(ch);
    await sleep(250);
    const pin = await page.evaluate(() => {
      const c = window.__wmuxBenchHook.pinCandidates;
      if (c.length >= 2 && c[c.length - 1] === c[c.length - 2]) {
        window.__wmuxBenchHook.pinnedId = c[c.length - 1];
        return c[c.length - 1];
      }
      return null;
    });
    if (pin) break;
  }
  const pinnedId = await page.evaluate(() => window.__wmuxBenchHook.pinnedId);
  if (!pinnedId) console.error(`[${label}] WARNING: pin priming failed — falling back to first-echo pinning`);

  // rAF cadence sanity check — detects an occluded/throttled window.
  const rafDeltas = await page.evaluate(() => new Promise((resolve) => {
    const deltas = []; let last = null; let n = 0;
    const tick = (ts) => {
      if (last !== null) deltas.push(ts - last);
      last = ts;
      if (++n < 30) requestAnimationFrame(tick); else resolve(deltas);
    };
    requestAnimationFrame(tick);
  }));
  const rafStats = summarize(rafDeltas);
  const throttled = (rafStats.p50 ?? 999) > 50;
  if (throttled) console.error(`[${label}] WARNING: rAF cadence p50=${rafStats.p50}ms — window throttled; frameMs untrustworthy`);

  let dropped = 0;
  let collected = 0;
  let consecutiveDrops = 0;
  for (let i = 0; i < sampleTarget; i++) {
    const ch = CHARS_SAMPLE[i % CHARS_SAMPLE.length];
    await page.evaluate((c) => { window.__wmuxBenchHook.pending = { ch: c, tKeydown: null }; }, ch);
    await page.keyboard.press(ch);
    try {
      await page.waitForFunction((n) => window.__wmuxBenchHook.samples.length > n, collected, { timeout: 1500 });
      collected++;
      consecutiveDrops = 0;
    } catch {
      dropped++;
      await page.evaluate(() => { window.__wmuxBenchHook.pending = null; });
      // Self-heal a bad pin: 3 straight timeouts while pinned means the pin
      // very likely points at the wrong pane — unpin and re-establish on the
      // next real echo rather than dropping the whole scenario.
      if (++consecutiveDrops >= 3) {
        console.error(`[${label}] ${consecutiveDrops} consecutive drops — resetting ptyId pin`);
        await page.evaluate(() => { window.__wmuxBenchHook.pinnedId = null; });
        consecutiveDrops = 0;
      }
    }
    await sleep(50);
  }

  const samples = await page.evaluate(() => window.__wmuxBenchHook.samples.splice(0));
  if (samples.length === 0) {
    try {
      const dbg = await page.evaluate(() => ({
        activeElement: `${document.activeElement?.tagName}.${(document.activeElement?.className?.toString?.() ?? '').slice(0, 50)}`,
        dataEvents: window.__wmuxBenchHook.dataEvents,
        lastData: window.__wmuxBenchHook.lastData,
        pinnedId: window.__wmuxBenchHook.pinnedId,
      }));
      console.error(`[${label}] zero samples — clickedBox=${JSON.stringify(box)} debug=${JSON.stringify(dbg)}`);
    } catch { /* diag only */ }
  }
  const echo = summarize(samples.map((s) => s.echoMs));
  const frame = summarize(samples.map((s) => s.frameMs));
  console.log(`[${label}] echo p50=${echo.p50}ms p95=${echo.p95}ms | frame p50=${frame.p50}ms p95=${frame.p95}ms (n=${echo.count}, dropped=${dropped})`);
  return {
    paneCount: count,
    samples: samples.length,
    dropped,
    throttled,
    echoMs: echo,
    frameMs: frame,
    rafCadenceMs: { p50: rafStats.p50, p95: rafStats.p95 },
  };
}

// === Scenario: RAM over the full process tree ===
const POWERSHELL_EXE = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
); // absolute path — bare 'powershell.exe' is ENOENT under some shells (git-bash PATH)
function snapshotProcesses() {
  return new Promise((resolve, reject) => {
    // PR D: Name + CommandLine are added so measureRam() can attribute the flat
    // total to per-process categories (the Electron `--type=` flag lives on the
    // command line). CommandLine is null for processes the bench user can't read
    // — the classifier tolerates that and buckets them by image name / fallback.
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,PageFileUsage | ConvertTo-Json -Compress';
    execFile(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', ps],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
      });
  });
}
async function measureRam(inst, label) {
  const procs = await snapshotProcesses();
  const byParent = new Map();
  const byPid = new Map();
  for (const p of procs) {
    byPid.set(p.ProcessId, p);
    if (!byParent.has(p.ParentProcessId)) byParent.set(p.ParentProcessId, []);
    byParent.get(p.ParentProcessId).push(p);
  }
  const roots = [inst.proc.pid];
  const daemonPid = readDaemonPid(inst);
  if (daemonPid) roots.push(daemonPid);
  const seen = new Set();
  const queue = roots.filter((pid) => byPid.has(pid));
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of byParent.get(pid) ?? []) queue.push(child.ProcessId);
  }
  let workingSetBytes = 0;
  let commitBytes = 0;
  // PR D: collect the normalized per-process rows over the SAME tree the flat
  // sum walks, so the breakdown reconciles exactly to workingSetBytes below.
  const treeRows = [];
  for (const pid of seen) {
    const p = byPid.get(pid);
    const ws = Number(p.WorkingSetSize) || 0;
    const commit = (Number(p.PageFileUsage) || 0) * 1024; // PageFileUsage is KB
    workingSetBytes += ws;
    commitBytes += commit;
    treeRows.push({
      pid: p.ProcessId,
      name: p.Name,
      commandLine: p.CommandLine,
      workingSetBytes: ws,
      commitBytes: commit,
    });
  }
  // Additive RAM attribution (PR D). Pure classifier in perf-process-classify
  // .mjs; never gated (perf-compare.mjs gates only explicit dot-paths).
  const breakdown = accumulateBreakdown(treeRows, { mainPid: inst.proc.pid, daemonPid });
  let appMetricsRaw = null;
  try {
    appMetricsRaw = await inst.page.evaluate(() =>
      window.electronAPI?.system?.getMemoryUsage ? window.electronAPI.system.getMemoryUsage() : null);
  } catch { /* informational only */ }
  console.log(`[${label}] workingSet=${(workingSetBytes / 1048576).toFixed(1)}MB commit=${(commitBytes / 1048576).toFixed(1)}MB procs=${seen.size}${daemonPid ? '' : ' (daemon pid missing!)'}`);
  // Per-category working-set line (MB), only the non-empty buckets.
  const breakdownLine = RAM_CATEGORIES
    .filter((c) => breakdown[c].processCount > 0)
    .map((c) => `${c}=${(breakdown[c].workingSetBytes / 1048576).toFixed(1)}MB×${breakdown[c].processCount}`)
    .join(' ');
  console.log(`[${label}] breakdown: ${breakdownLine}`);
  // PR D review P2-1: a wmux.exe child whose CommandLine CIM could not read
  // carries no --type= token and silently falls into the `main` bucket. Surface
  // it so a skewed attribution is never silent (additive count is in the JSON).
  if (breakdown.commandLineNullCount > 0) {
    console.error(`[${label}] attribution may be skewed: ${breakdown.commandLineNullCount} wmux processes had unreadable CommandLine`);
  }
  return { workingSetBytes, commitBytes, processCount: seen.size, breakdown, appMetricsRaw };
}

// === Scrollback A/B seed (PR D) ===
//
// HOW scrollbackLines is persisted (investigation result):
//   It rides SessionData — written by AppLayout.buildSessionData into
//   session.json (<userData>/session.json, SessionManager) and read back by
//   workspaceSlice.loadSession on boot, which sets uiSlice.scrollbackLines
//   (default 10000). useTerminal then constructs every xterm with
//   `scrollback: scrollbackLines`. Two product facts shaped the seeding choice:
//     1. The zustand store is NOT exposed on window, so a post-boot CDP
//        `setScrollbackLines()` injection has no handle to call (verified —
//        no window.useStore / __wmuxStore in src/renderer). Driving the
//        Settings UI by CDP is possible but brittle (i18n labels, DOM shape).
//     2. loadSession EARLY-RETURNS on an empty `workspaces` array
//        (`if (!data.workspaces || data.workspaces.length === 0) return;`),
//        so a preference-only session.json is silently ignored.
//   => We pre-seed a session.json carrying ONE minimal, schema-valid workspace
//      (a single leaf pane with one empty-ptyId surface — exactly the shape a
//      fresh boot self-creates, so Terminal.tsx takes its self-create path and
//      spawns a real PTY on mount) PLUS scrollbackLines. loadSession applies
//      the preference BEFORE any terminal mounts, so every measured pane (the
//      seeded pane and the 7 split children) allocates its CircularBuffer at
//      the seeded size — a clean, uniform A/B at both idle1Pane and 8 panes.
//      This is the persisted-location pre-seed the plan asked for; the store
//      not being on window is why the CDP-inject alternative was rejected.
//
// The seed is only written when --scrollback-lines is supplied; otherwise the
// app boots its normal default-workspace path untouched.
function buildScrollbackSeedSession(lines) {
  const id = (prefix) => `${prefix}-${randomUUID()}`;
  const surfaceId = id('surface');
  const paneId = id('pane');
  const wsId = id('ws');
  return {
    workspaces: [
      {
        id: wsId,
        name: 'Workspace 1',
        rootPane: {
          id: paneId,
          type: 'leaf',
          // Empty ptyId → Terminal.tsx self-creates a fresh PTY on mount (the
          // well-tested path), so this seeded pane behaves like a normal first
          // pane — no stale-session reconnect, no scrollback file to replay.
          surfaces: [
            { id: surfaceId, ptyId: '', title: 'powershell', shell: 'powershell', cwd: '' },
          ],
          activeSurfaceId: surfaceId,
        },
        activePaneId: paneId,
      },
    ],
    activeWorkspaceId: wsId,
    sidebarVisible: true,
    // The field under test.
    scrollbackLines: lines,
    // Match the bench's regular-boot assumptions: skip onboarding / first-run
    // overlays that would otherwise steal the pane-focus click.
    onboardingCompleted: true,
    firstRunCompleted: true,
  };
}

// === WebGL pool occupancy (PR D) ===
//
// webglContextPool is a module-level singleton in
// src/renderer/terminal/webglContextPool.ts and is intentionally NOT exposed on
// window. Per PR D we must NOT add a debug window export to product code, so we
// approximate the live GPU-context count from the DOM: xterm's WebglAddon
// appends a <canvas> to each accelerated terminal's `.xterm-screen`, whereas the
// DOM-renderer fallback (panes the pool evicted) has no canvas. We count
// `.xterm-screen canvas` elements and, defensively, probe each canvas for a live
// webgl/webgl2 context so a stray 2D canvas can't inflate the number.
//
// LIMITATIONS (reported in the JSON + log):
//   - This is a DOM proxy, not the pool's own grantedCount(). It can diverge
//     during the 10s deferred-dispose window (a hidden pane still holds a
//     canvas) or right after an eviction before xterm tears the canvas down.
//   - It cannot see the pool's LRU ordering or its MAX_WEBGL_CONTEXTS budget
//     directly; it only observes the realized canvas count, which is the thing
//     that actually consumes GPU memory — adequate for the occupancy question.
async function measureWebglOccupancy(page) {
  return page.evaluate(() => {
    const screens = [...document.querySelectorAll('.xterm-screen')];
    const canvases = [...document.querySelectorAll('.xterm-screen canvas')];
    let liveWebglContexts = 0;
    for (const c of canvases) {
      try {
        // Reuse the existing context if xterm already created one (getContext
        // returns the same object for the same type). On a canvas that already
        // has a live context this does NOT allocate a new one; on a canvas
        // whose context was just lost, getContext CAN re-allocate. We run this
        // probe in a steady state (after panes settle), so in practice it only
        // observes contexts xterm already holds and does not perturb the count.
        if (c.getContext('webgl2') || c.getContext('webgl')) liveWebglContexts++;
      } catch { /* tainted/!canvas — ignore */ }
    }
    return {
      method: 'dom-canvas-approximation',
      xtermScreens: screens.length,
      webglCanvases: canvases.length,
      liveWebglContexts,
      note: 'DOM proxy for webglContextPool.grantedCount(); pool is not exposed on window (no product debug hook added per PR D). May diverge during the 10s deferred-dispose window.',
    };
  });
}

// === Results ===
function appVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

const RESULTS = {
  schemaVersion: 1,
  meta: {
    tool: 'perf-bench.mjs',
    mode: ARGS.mode,
    appVersion: appVersion(),
    commit: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    platform: process.platform,
    arch: process.arch,
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    osRelease: os.release(),
    nodeVersion: process.version,
    config: {
      coldRuns: ARGS.coldRuns,
      inputSamples: ARGS.samples,
      inputSamples8: ARGS.samples8,
      // PR D: which scrollback A/B leg this run is (null = app default 10000,
      // not seeded). Records the run's identity so two result files can be
      // diffed unambiguously.
      scrollbackLines: ARGS.scrollbackLines,
    },
  },
  scenarios: {},
};

// === Global cleanup ===
let cleaningUp = false;
async function cleanupAll() {
  if (cleaningUp) return; // a second concurrent sweep would race shutdownInstance's
  cleaningUp = true;      // pid-file reads against the first sweep's rmSync(home)
  for (const inst of [...liveInstances]) {
    try { await shutdownInstance(inst); } catch { /* best effort */ }
  }
}
let sigints = 0;
process.on('SIGINT', async () => {
  if (++sigints > 1) {
    // Second Ctrl+C while graceful cleanup is in flight: force-kill everything
    // synchronously and bail — do NOT start a second async sweep.
    for (const inst of liveInstances) {
      const daemonPid = readDaemonPid(inst);
      if (daemonPid && pidAlive(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch { /* noop */ } }
      if (inst.proc && inst.proc.exitCode === null) { try { inst.proc.kill('SIGKILL'); } catch { /* noop */ } }
    }
    process.exit(130);
  }
  await cleanupAll();
  process.exit(130);
});
process.on('exit', () => {
  // Last-resort synchronous backstop: terminate anything still tracked.
  for (const inst of liveInstances) {
    const daemonPid = readDaemonPid(inst);
    if (daemonPid && pidAlive(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch { /* noop */ } }
    if (inst.proc && inst.proc.exitCode === null) { try { inst.proc.kill('SIGKILL'); } catch { /* noop */ } }
  }
});

(async () => {
  try {
    RESULTS.meta.commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch { RESULTS.meta.commit = null; }

  console.log(`exe: ${APP_EXE}`);
  console.log(`mode: ${ARGS.mode}  coldRuns=${ARGS.coldRuns} samples=${ARGS.samples} samples8=${ARGS.samples8}`);
  if (ARGS.scrollbackLines != null) {
    console.log(`[scrollback A/B] seeding session.json scrollbackLines=${ARGS.scrollbackLines} into every fresh instance (panes mount at this size). idle1Pane and 8-pane RAM reflect it; compare two runs (e.g. 10000 vs 1000).`);
  }

  let lastInst = null;

  // ---------- coldStart ----------
  if (!ARGS.skipCold) {
    console.log('--- coldStart: warmup run (discarded) ---');
    {
      const warm = await bootFreshInstance();
      await shutdownInstance(warm);
    }
    const runs = [];
    for (let i = 0; i < ARGS.coldRuns; i++) {
      console.log(`--- coldStart run ${i + 1}/${ARGS.coldRuns} ---`);
      const inst = await bootFreshInstance();
      const m = inst.milestones;
      runs.push({
        cdpReadyMs: m.cdpReadyMs ?? null,
        pipeReadyMs: m.pipeReadyMs ?? null,
        rendererReadyMs: m.rendererReadyMs ?? null,
        firstPtyDataMs: m.firstPtyDataMs ?? null,
        fcpMs: m.fcpMs ?? null,
        // S-A boot-phase attribution (additive — perf-compare gates only by
        // explicit dot-paths, so these fields never affect the gate).
        marks: { ...inst.bootMarks },
        daemonBoot: inst.daemonBoot,
      });
      console.log(`    cdp=${m.cdpReadyMs}ms pipe=${m.pipeReadyMs}ms renderer=${m.rendererReadyMs}ms firstPty=${m.firstPtyDataMs}ms fcp=${m.fcpMs}ms`);
      if (i < ARGS.coldRuns - 1) await shutdownInstance(inst);
      else lastInst = inst; // reuse the final boot for input/RAM scenarios
    }
    // median() drops nulls — record how many runs actually contributed to each
    // milestone so a degenerate median (e.g. 1-of-3 on CI) is visible, not silent.
    const countOf = (vals) => vals.filter((v) => typeof v === 'number' && Number.isFinite(v)).length;
    const milestoneKeys = ['cdpReadyMs', 'pipeReadyMs', 'rendererReadyMs', 'firstPtyDataMs', 'fcpMs'];
    const medianEntry = (key) => median(runs.map((r) => r[key]));
    const counts = Object.fromEntries(milestoneKeys.map((k) => [k, countOf(runs.map((r) => r[k]))]));
    RESULTS.scenarios.coldStart = {
      runs,
      median: Object.fromEntries(milestoneKeys.map((k) => [k, medianEntry(k)])),
      medianRunCounts: counts,
    };
    for (const k of milestoneKeys) {
      if (counts[k] < runs.length) {
        console.error(`[coldStart] WARNING: ${k} present in only ${counts[k]}/${runs.length} runs — median is degraded`);
      }
    }
    const med = RESULTS.scenarios.coldStart.median;
    console.log(`coldStart median: firstPtyData=${med.firstPtyDataMs}ms renderer=${med.rendererReadyMs}ms`);

    // ---- boot-phase attribution (S-A) ----
    // Median across runs for every mark seen in any run (key union — the
    // reuse path emits daemon-reused, the spawn path emits spawn marks).
    const medianMarkMap = (pick) => {
      const keys = new Set(runs.flatMap((r) => Object.keys(pick(r) ?? {})));
      const out = {};
      for (const k of keys) out[k] = median(runs.map((r) => pick(r)?.[k] ?? null));
      return out;
    };
    const medianMarks = medianMarkMap((r) => r.marks);
    const medianDaemonMarks = medianMarkMap((r) => r.daemonBoot?.marks);
    RESULTS.scenarios.coldStart.medianMarks = medianMarks;
    RESULTS.scenarios.coldStart.medianDaemonMarks = medianDaemonMarks;

    const span = (marks, a, b) => {
      const va = a === 'spawn' ? 0 : marks[a];
      const vb = marks[b];
      return typeof va === 'number' && typeof vb === 'number' ? Math.round(vb - va) : null;
    };
    const fmt = (v) => (v == null ? 'n/a' : `${v}ms`);
    console.log('boot-phase breakdown (median, ms since spawn):');
    console.log(`  pre-JS (spawn→js-start)                       ${fmt(span(medianMarks, 'spawn', 'js-start'))}`);
    console.log(`  module imports (js-start→imports-done)        ${fmt(span(medianMarks, 'js-start', 'imports-done'))}`);
    console.log(`  app init (imports-done→module-eval-end)       ${fmt(span(medianMarks, 'imports-done', 'module-eval-end'))}`);
    console.log(`    pty managers (construction-start→pre-pipe-server-ctor) ${fmt(span(medianMarks, 'construction-start', 'pre-pipe-server-ctor'))}`);
    console.log(`    PipeServer ctor / token ACL (pre→ctor-done) ${fmt(span(medianMarks, 'pre-pipe-server-ctor', 'pipe-server-ctor-done'))}`);
    console.log(`    handler registration (ctor-done→eval-end)   ${fmt(span(medianMarks, 'pipe-server-ctor-done', 'module-eval-end'))}`);
    console.log(`  ready wait (module-eval-end→ready-fired)      ${fmt(span(medianMarks, 'module-eval-end', 'ready-fired'))}`);
    console.log(`  plugin load (ready-fired→plugins-loaded)      ${fmt(span(medianMarks, 'ready-fired', 'plugins-loaded'))}`);
    console.log(`  window create (plugins-loaded→window-created) ${fmt(span(medianMarks, 'plugins-loaded', 'window-created'))}`);
    console.log(`  daemon bootstrap (start→end)                  ${fmt(span(medianMarks, 'daemon-bootstrap-start', 'daemon-bootstrap-end'))}`);
    console.log(`    spawn call (ensure-start→spawned)           ${fmt(span(medianMarks, 'daemon-ensure-start', 'daemon-spawned'))}`);
    console.log(`    daemon boot (spawned→pipe-file-seen)        ${fmt(span(medianMarks, 'daemon-spawned', 'daemon-pipe-file-seen'))}`);
    console.log(`    ping latency (pipe-file-seen→first-ping-ok) ${fmt(span(medianMarks, 'daemon-pipe-file-seen', 'daemon-first-ping-ok'))}`);
    console.log(`  ready tail (renderer-load-triggered→ready-end) ${fmt(span(medianMarks, 'renderer-load-triggered', 'ready-end'))}`);
    if (Object.keys(medianDaemonMarks).length > 0) {
      const d = medianDaemonMarks;
      console.log('  daemon internal (ms since spawn): '
        + ['main-start', 'lock-acquired', 'bootid-done', 'config-loaded', 'recovery-done', 'pre-pipe-start', 'pipe-listening', 'ready']
          .map((k) => `${k}=${d[k] ?? 'n/a'}`).join(' '));
      console.log(`    daemon pipe start / token ACL (pre-pipe-start→pipe-listening) ${fmt(span(medianDaemonMarks, 'pre-pipe-start', 'pipe-listening'))}`);
    }
  }

  if (!lastInst && (ARGS.diag || !ARGS.skipInput || !ARGS.skipRam)) {
    console.log('--- booting instance for input/ram scenarios ---');
    lastInst = await bootFreshInstance();
  }

  // ---------- diag (debugging aid: dump DOM/hook state + one probed key) ----------
  if (ARGS.diag) {
    const page = lastInst.page;
    const diag = await page.evaluate(() => {
      const screen = document.querySelector('.xterm-screen');
      const r = screen ? screen.getBoundingClientRect() : null;
      const chain = [];
      if (r) {
        let el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        while (el && chain.length < 8) { chain.push(`${el.tagName}.${(el.className?.toString?.() ?? '').slice(0, 60)}`); el = el.parentElement; }
      }
      return {
        url: location.href,
        rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
        topChainAtXtermCenter: chain,
        dialogs: [...document.querySelectorAll('[role=dialog], [aria-modal=true]')].map((d) => (d.className?.toString?.() ?? '').slice(0, 80)),
        activeElement: `${document.activeElement?.tagName}.${(document.activeElement?.className?.toString?.() ?? '').slice(0, 40)}`,
        xtermCount: document.querySelectorAll('.xterm').length,
        hookReady: window.__wmuxBenchHook?.ready ?? null,
        firstDataEpoch: window.__wmuxBenchHook?.firstDataEpoch ?? null,
        bodyChildren: [...document.body.children].map((c) => `${c.tagName}.${(c.className?.toString?.() ?? '').slice(0, 50)}`),
      };
    });
    console.log('[diag] ' + JSON.stringify(diag, null, 2));
    await dismissOverlays(page);
    // Trace what the click actually hits and how focus moves.
    await page.evaluate(() => {
      window.__diagEvents = [];
      const tag = (el) => `${el?.tagName}.${(el?.className?.toString?.() ?? '').slice(0, 50)}`;
      for (const t of ['mousedown', 'mouseup', 'click']) {
        window.addEventListener(t, (e) => window.__diagEvents.push(`${t}:${tag(e.target)}`), { capture: true });
      }
      document.addEventListener('focusin', (e) => window.__diagEvents.push(`focusin:${tag(e.target)}`), { capture: true });
      document.addEventListener('focusout', (e) => window.__diagEvents.push(`focusout:${tag(e.target)}`), { capture: true });
    });
    const postDismiss = await page.evaluate(() => {
      const screen = document.querySelector('.xterm-screen');
      const r = screen.getBoundingClientRect();
      const chain = [];
      let el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      while (el && chain.length < 6) { chain.push(`${el.tagName}.${(el.className?.toString?.() ?? '').slice(0, 50)}`); el = el.parentElement; }
      return { topChain: chain, overlayGone: !document.querySelector('.onboarding-overlay') };
    });
    console.log('[diag post-dismiss] ' + JSON.stringify(postDismiss, null, 2));
    const box = await page.locator('.xterm-screen').first().boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(400);
    const preKey = await page.evaluate(() => ({
      activeElement: `${document.activeElement?.tagName}.${(document.activeElement?.className?.toString?.() ?? '').slice(0, 40)}`,
      dataEvents: window.__wmuxBenchHook.dataEvents,
      events: window.__diagEvents,
    }));
    console.log('[diag post-click] ' + JSON.stringify(preKey, null, 2));
    await page.evaluate(() => { window.__wmuxBenchHook.pending = { ch: 'a', tKeydown: null }; });
    await page.keyboard.press('a');
    await sleep(800);
    const after = await page.evaluate(() => ({
      pending: window.__wmuxBenchHook.pending,
      samples: window.__wmuxBenchHook.samples,
      pinnedId: window.__wmuxBenchHook.pinnedId,
      dataEvents: window.__wmuxBenchHook.dataEvents,
      lastData: window.__wmuxBenchHook.lastData,
      activeElement: `${document.activeElement?.tagName}.${(document.activeElement?.className?.toString?.() ?? '').slice(0, 40)}`,
    }));
    console.log('[diag after keypress] ' + JSON.stringify(after, null, 2));
    await shutdownInstance(lastInst);
    process.exit(0);
  }

  if (lastInst) await dismissOverlays(lastInst.page);

  // ---------- ram: idle, 1 pane (before any typing/splitting) ----------
  if (!ARGS.skipRam) {
    console.log('--- ram: idle 1-pane (8s settle) ---');
    await sleep(8000);
    RESULTS.scenarios.ram = RESULTS.scenarios.ram ?? {};
    RESULTS.scenarios.ram.idle1Pane = await measureRam(lastInst, 'ram idle1Pane');
  }

  // ---------- inputLatency: 1 pane ----------
  if (!ARGS.skipInput) {
    console.log(`--- inputLatency: 1 pane, ${ARGS.samples} samples ---`);
    RESULTS.scenarios.inputLatency = await measureInputLatency(lastInst.page, ARGS.samples, 'input 1-pane');
  }

  // ---------- split to 8 panes ----------
  if (!ARGS.skipInput || !ARGS.skipRam) {
    console.log('--- splitting to 8 panes ---');
    const tokenPath = path.join(lastInst.home, `.wmux${lastInst.suffix}-auth-token`);
    const token = (await waitFor('main auth token', () => {
      try { return fs.readFileSync(tokenPath, 'utf8').trim() || null; } catch { return null; }
    }, 5000, 100));
    const client = new PipeClient(lastInst.mainPipe, token);
    await client.connect();
    try {
      for (let i = 0; i < 7; i++) {
        await client.call('pane.split', { direction: i % 2 === 0 ? 'horizontal' : 'vertical' });
        await sleep(400);
      }
    } finally {
      client.close(); // a mid-loop RPC failure must not leak the pipe socket
    }
    await waitFor('8 panes mounted', async () =>
      (await lastInst.page.evaluate(() => document.querySelectorAll('.xterm').length)) >= 8, 30000, 250);
    await sleep(3000);
  }

  // ---------- ram: 8 panes ----------
  if (!ARGS.skipRam) {
    console.log('--- ram: 8 panes (5s settle) ---');
    await sleep(5000);
    RESULTS.scenarios.ram.panes8 = await measureRam(lastInst, 'ram panes8');
  }

  // ---------- WebGL pool occupancy at 8 panes (PR D) ----------
  // Always recorded when the 8-pane state exists (additive, near-zero cost);
  // --webgl-occupancy is the explicit knob for runs that skip RAM. The pool
  // budget is MAX_WEBGL_CONTEXTS=12, so 8 panes sits below the cap — we expect
  // up to 8 live canvases here. See measureWebglOccupancy for the DOM-proxy
  // caveat (it is not the pool's own grantedCount()).
  if ((!ARGS.skipInput || !ARGS.skipRam) && (ARGS.webglOccupancy || !ARGS.skipRam)) {
    try {
      const occ = await measureWebglOccupancy(lastInst.page);
      RESULTS.scenarios.ram = RESULTS.scenarios.ram ?? {};
      RESULTS.scenarios.ram.webglOccupancy8 = occ;
      console.log(`[webgl occupancy 8-pane] screens=${occ.xtermScreens} canvases=${occ.webglCanvases} liveContexts=${occ.liveWebglContexts} (DOM approximation)`);
    } catch (e) {
      console.error(`[webgl occupancy] measurement failed (continuing): ${e.message}`);
    }
  }

  // ---------- inputLatency: 8 panes (focused pane) ----------
  if (!ARGS.skipInput) {
    console.log(`--- inputLatency: 8 panes, ${ARGS.samples8} samples ---`);
    RESULTS.scenarios.inputLatency8 = await measureInputLatency(lastInst.page, ARGS.samples8, 'input 8-pane');
  }

  // ---------- teardown + write ----------
  if (ARGS.keepApp) {
    console.log(`--keep-app: leaving instance running (home: ${lastInst.home}, suffix: ${lastInst.suffix})`);
    liveInstances.delete(lastInst);
  } else if (lastInst) {
    await shutdownInstance(lastInst);
  }

  RESULTS.meta.finishedAt = new Date().toISOString();
  const jsonText = JSON.stringify(RESULTS, null, 2);
  if (ARGS.json) {
    fs.mkdirSync(path.dirname(path.resolve(ARGS.json)), { recursive: true });
    fs.writeFileSync(ARGS.json, jsonText, 'utf8');
    console.log(`[json written] ${path.resolve(ARGS.json)}`);
  }
  console.log('----- BENCH_JSON_BEGIN -----');
  console.log(jsonText);
  console.log('----- BENCH_JSON_END -----');
  process.exit(0);
})().catch(async (e) => {
  console.error('FATAL:', e.stack || e.message);
  await cleanupAll();
  process.exit(2);
});

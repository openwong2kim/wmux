/**
 * twenty-pane-stability.mjs: a soak benchmark that keeps 20 terminal panes
 * open for 30 minutes in an ISOLATED wmux instance and records, over time:
 *
 *   - focused-pane keystroke -> echo latency (CDP keyboard events, timed in
 *     the renderer from keydown to the echoed marker in pty.onData, plus the
 *     next animation frame), sampled every --sample-sec while focus moves
 *     between panes (pane.focus) and workspaces (Alt+ArrowDown);
 *   - an echo probe on EVERY pane each sample (a short marker written with
 *     electronAPI.pty.write, matched in pty.onData), so hidden and idle panes
 *     are measured too; markers that never come back are dropped inputs;
 *   - output stalls: a streaming pane whose output stops for --stall-ms;
 *   - memory: daemon RSS/heap/rings (daemon.ping includeMemory), Electron
 *     working sets per process type (perf.status includeMemory), and an OS
 *     process-tree sample every --tree-every samples.
 *
 * Mix: --streaming panes run a synthetic producer (TUI-style status repaint
 * plus colored log lines at --rate-kib KiB/s, backpressure-aware); the rest
 * are idle shells. Panes are spread over workspaces of --per-workspace panes,
 * so most of them are hidden, as in real use.
 *
 * WHY NOT A perf-bench.mjs SCENARIO: perf-bench.mjs runs its bench on import,
 * exits when the packaged Windows exe is missing, and is the CI perf gate.
 * This script reuses its importable helpers (perf-scenarios, perf-frame-sample,
 * perf-process-tree, perf-process-classify, lib/idle-memory) and copies the
 * instance lifecycle (isolated HOME + WMUX_DATA_SUFFIX, seeded plugin trust,
 * overlay dismissal, daemon shutdown), generalized to macOS and Linux.
 *
 * ISOLATION: a fresh temp HOME/USERPROFILE/APPDATA and a unique
 * WMUX_DATA_SUFFIX re-key every pipe, token, data dir and the single-instance
 * lock. The harness drives CDP only after the app itself logs
 * "CDP listening on port N" (ownership verified), only accepts renderer pages
 * under the launched app's directory, and kills only the pids it launched or
 * read from its own sandbox.
 *
 * HOW TO RUN (package first; PowerShell on Windows):
 *   npm run package
 *   node scripts/twenty-pane-stability.mjs
 *   node scripts/twenty-pane-stability.mjs --panes 4 --streaming 1 --per-workspace 2 --minutes 1
 *
 * Output: out/twenty-pane-stability/<stamp>/ (config.json, samples.ndjson
 * appended every sample, summary.json + summary.txt at the end or on Ctrl+C).
 * See docs/performance/twenty-panes.md.
 */
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { sampleRafDeltas } from './perf-frame-sample.mjs';
import { summarizeSamples } from './perf-scenarios.mjs';
import { collectProcessTree, looksLikeDaemonRow, parseCimDate } from './perf-process-tree.mjs';
import { accumulateBreakdown, RAM_CATEGORIES } from './perf-process-classify.mjs';
import { parsePsRows, groupMemory } from './lib/idle-memory.mjs';
import {
  parseArgs, planLayout, assignClasses, markerFor, stripTerminalControls,
  producerCommand, producerSource, shellPrepCommand, summarizeRun, renderSummary, verifyEngine,
  CLAUDE_PROMPT, CLAUDE_README, claudeProjectSettings, claudeHookSource, claudeLaunchCommand,
  newClaudeState, applyClaudeEvents, nextClaudeAction, inTurnAt, gapInTurnMs, answerTrustPrompts, profileDiff,
  daemonPidVerdict, leftoverPids, runTeardown, teardownFlags,
} from './lib/twenty-pane-stability.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PLATFORM = process.platform;
const USERNAME = os.userInfo().username || 'default';
const HARNESS_START_MS = Date.now();
// The user's real profile, before the sandbox replaces it. Only a Claude
// pane's claude process gets it back (see claudeLaunchCommand).
const REAL_PROFILE = { USERPROFILE: process.env.USERPROFILE ?? os.homedir(), HOME: process.env.HOME ?? null };

let ARGS;
try {
  ARGS = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
if (ARGS.help) {
  console.log(`Usage: node scripts/twenty-pane-stability.mjs [flags]
  --minutes N            run length after setup (default 30)
  --panes N              terminal panes (default 20)
  --streaming N          panes running the synthetic producer (default 6)
  --per-workspace N      panes per workspace (default 5)
  --sample-sec N         seconds between samples (default 10)
  --keys N               focused-pane keystroke markers per sample (default 4)
  --workspace-switch-every N  switch workspace every N samples (default 3, 0 = never)
  --tree-every N         OS process-tree sample every N samples (default 3)
  --stall-ms N           output gap that counts as a stall (default 5000)
  --rate-kib N           producer output per streaming pane, KiB/s (default 16)
  --probe-timeout-ms N / --key-timeout-ms N   echo wait (default 3000)
  --app PATH             wmux executable or macOS .app to run (default: packaged build under out/)
  --engine node|rust     terminal engine for the instance; verified after launch, the run aborts on a mismatch
  --claude N             panes running Claude Code on a light prompt loop (default 0)
  --claude-config-dir DIR  another Claude Code config dir (default: your real profile; see the doc)
  --claude-cmd CMD       command typed to start Claude Code (default "claude")
  --claude-max-turns N   prompts per Claude pane (default 20)
  --claude-interval-sec N  seconds between prompts (default 60)
  --claude-turn-timeout-sec N  a longer turn stops that pane's loop (default 120)
  --out DIR              output directory (must not exist)
  --keep-app             leave the instance running at the end (debugging)`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultAppPath() {
  if (PLATFORM === 'win32') return path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
  if (PLATFORM === 'darwin') {
    const built = path.join(REPO_ROOT, 'out', `wmux-darwin-${process.arch}`, 'wmux.app', 'Contents', 'MacOS', 'wmux');
    return fs.existsSync(built) ? built : '/Applications/wmux.app/Contents/MacOS/wmux';
  }
  return path.join(REPO_ROOT, 'out', `wmux-linux-${process.arch}`, 'wmux');
}
// A macOS .app bundle may be passed as is.
const APP_EXE = (() => {
  const p = path.resolve(ARGS.app ?? defaultAppPath());
  return PLATFORM === 'darwin' && p.endsWith('.app') ? path.join(p, 'Contents', 'MacOS', path.basename(p, '.app')) : p;
})();
if (!fs.existsSync(APP_EXE)) {
  console.error(`wmux executable not found at ${APP_EXE}. Run \`npm run package\` or pass --app.`);
  process.exit(2);
}
if (ARGS.claude > 0 && ARGS.claudeConfigDir && !fs.existsSync(path.join(path.resolve(ARGS.claudeConfigDir), '.claude.json')) && !fs.existsSync(path.join(path.resolve(ARGS.claudeConfigDir), '.credentials.json'))) {
  console.error(`--claude-config-dir ${ARGS.claudeConfigDir} does not look like a Claude Code config directory (no .claude.json). Log in once with CLAUDE_CONFIG_DIR set to it, then rerun.`);
  process.exit(2);
}
if (ARGS.claude > 0 && !ARGS.claudeConfigDir) {
  console.warn('[setup] warning: Claude panes use your real Claude Code profile (global CLAUDE.md, MCP servers, hooks, default model); for runs beyond the engine A/B prefer --claude-config-dir <separate logged-in config> --claude-cmd "claude --model haiku"');
}
// Identity guard: only renderer pages served from the launched app's own
// directory (the .app bundle on macOS) are driven.
const APP_ROOT = PLATFORM === 'darwin' && APP_EXE.includes('.app/')
  ? APP_EXE.slice(0, APP_EXE.indexOf('.app/') + 4)
  : path.dirname(APP_EXE);
const APP_URL_PREFIX = pathToFileURL(APP_ROOT).href.toLowerCase();

// ---------------------------------------------------------------------------
// Pipe client (newline-delimited JSON-RPC), as in perf-bench.mjs
// ---------------------------------------------------------------------------

const BENCH_CLIENT_NAME = 'wmux-bench';
// pane.list / pane.focus / perf.status -> pane.read; pane.split -> pane.create;
// input.send -> terminal.send; mcp.claimWorkspace -> workspace.claim;
// workspace.current -> workspace.read. daemon.* goes to the daemon pipe.
const BENCH_CAPABILITIES = ['pane.read', 'pane.create', 'terminal.send', 'workspace.claim', 'workspace.read'];

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
      sock.on('data', (chunk) => this.onData(chunk));
      sock.on('close', () => {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('socket closed')); }
        this.pending.clear();
      });
    });
  }
  onData(chunk) {
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
  call(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('not connected'));
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, method, params, token: this.token, clientName: BENCH_CLIENT_NAME, clientVersion: '0.0.0-bench' }) + '\n');
    });
  }
  close() { try { this.sock?.destroy(); } catch { /* noop */ } }
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
async function waitFor(label, fn, timeoutMs, intervalMs = 150) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
    if (Date.now() - start >= timeoutMs) throw new Error(`timeout waiting for ${label} after ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}
/** Retry a call that the production per-socket rate limit refused. Pacing, not a fix. */
async function callPaced(client, method, params) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await client.call(method, params);
      const err = res && typeof res === 'object' ? res.error : null;
      if (!err) return res;
      throw new Error(String(err));
    } catch (e) {
      if (!/rate limited|RESOURCE_EXHAUSTED/i.test(e.message) || attempt >= 6) throw e;
      await sleep(1200);
    }
  }
}

// ---------------------------------------------------------------------------
// Isolated instance
// ---------------------------------------------------------------------------

function powershellExe() {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
/** Run a PowerShell script via -EncodedCommand (no quoting through argv). */
function runPowerShell(script, timeoutMs = 15000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(powershellExe(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
  });
}
function runPs(args) {
  return new Promise((resolve, reject) => {
    // C locale: lstart dates must parse regardless of the user's language.
    execFile('ps', args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

function makeInstance() {
  // macOS/Linux session sockets live at <home>/.wmux<suffix>/session-<uuid>.sock
  // and must fit sun_path (104 bytes on macOS); macOS's per-user tmpdir is too
  // long for that, so POSIX sandboxes go under /tmp when needed.
  const tmpRoot = PLATFORM === 'win32' || os.tmpdir().length <= 20 ? os.tmpdir() : '/tmp';
  const home = fs.mkdtempSync(path.join(tmpRoot, 'wsk-'));
  const suffix = `-s${process.pid.toString(36)}`;
  const env = { ...process.env };
  // Never inherit the identity of the wmux pane this script may run in.
  for (const key of Object.keys(env)) {
    // Also no Claude Code session identity: a Claude pane gets only the
    // config dir the operator passed.
    if (key.startsWith('WMUX_') || (key.startsWith('CLAUDE') && key !== 'CLAUDE_CODE_GIT_BASH_PATH') || key === 'ZDOTDIR' || key === 'XDG_CONFIG_HOME' || key === 'XDG_DATA_HOME') delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    WMUX_DATA_SUFFIX: suffix,
    WMUX_NO_DIALOG: '1',
    WMUX_TEST_CDP_PORT: '1',
  });
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });

  const wmuxDir = path.join(home, `.wmux${suffix}`);
  fs.mkdirSync(wmuxDir, { recursive: true });
  // Skip the hooks prompt and pin the production permission gate, with a
  // trusted row for this client (see perf-bench.mjs seedBenchTrust).
  fs.writeFileSync(path.join(wmuxDir, 'hooks-prompt.json'), JSON.stringify({ suppressed: true }), 'utf8');
  const now = Date.now();
  fs.writeFileSync(path.join(wmuxDir, 'plugin-trust.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: {
      [BENCH_CLIENT_NAME]: {
        name: BENCH_CLIENT_NAME, version: '0.0.0-bench', status: 'trusted',
        declaredCapabilities: BENCH_CAPABILITIES,
        rationale: 'twenty-pane-stability.mjs sandbox instance',
        firstSeen: now, lastSeen: now,
      },
    },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(wmuxDir, 'config.json'), JSON.stringify({ mcp: { mode: 'enforce' } }, null, 2), 'utf8');
  // Settings > Terminal > Performance > Terminal engine writes this file
  // (src/shared/terminalCoreSettings.ts); the daemon reads it once at start.
  // This instance's daemon has not started yet, so no restart is needed.
  if (ARGS.engine) fs.writeFileSync(path.join(wmuxDir, 'terminal-core.json'), JSON.stringify({ engine: ARGS.engine }), 'utf8');

  // The first-run wizard would swallow focus; seed its marker in userData.
  // Where Electron puts appData depends on the platform (and on macOS it may
  // not follow HOME), so seed every candidate this run creates, verify against
  // the userData path the app logs, and remove the ones we created at the end.
  const candidates = PLATFORM === 'win32'
    ? [path.join(env.APPDATA, `wmux${suffix}`)]
    : PLATFORM === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', `wmux${suffix}`),
        path.join(os.homedir(), 'Library', 'Application Support', `wmux${suffix}`)]
      : [path.join(home, '.config', `wmux${suffix}`)];
  const createdUserData = [];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) createdUserData.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.first-run'), new Date().toISOString(), 'utf8');
  }

  return {
    home, suffix, env, wmuxDir, userDataCandidates: candidates, createdUserData,
    mainPipe: PLATFORM === 'win32' ? `\\\\.\\pipe\\wmux${suffix}-${USERNAME}` : path.join(home, `.wmux${suffix}.sock`),
    mainTokenPath: path.join(home, `.wmux${suffix}-auth-token`),
    proc: null, browser: null, page: null, cdpPort: null, userDataLogged: null, logTail: [],
  };
}

function readDaemonPid(inst) {
  try {
    const pid = Number(fs.readFileSync(path.join(inst.wmuxDir, 'daemon.pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function defaultDaemonPipe(inst) {
  return PLATFORM === 'win32' ? `\\\\.\\pipe\\wmux-daemon${inst.suffix}-${USERNAME}` : path.join(inst.wmuxDir, 'daemon.sock');
}
function readDaemonPipeName(inst) {
  let name = '';
  try { name = fs.readFileSync(path.join(inst.wmuxDir, 'daemon-pipe'), 'utf8').trim(); } catch { /* default below */ }
  if (!name) return defaultDaemonPipe(inst);
  // Never talk to a daemon of another instance.
  if (![`${inst.suffix}-`, `${inst.suffix}/`, `${inst.suffix}\\`].some((s) => name.includes(s))) {
    throw new Error(`the daemon-pipe file names a pipe without this run's suffix ${inst.suffix}`);
  }
  return name;
}
function readDaemonToken(inst) {
  for (const p of [path.join(inst.wmuxDir, 'daemon-auth-token'), path.join(inst.home, '.wmux', 'daemon-auth-token')]) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t; } catch { /* next */ }
  }
  return null;
}

/** Spawn the app and resolve with the CDP port once the app reports it verified. */
function spawnInstance(inst) {
  // macOS: with a sandbox HOME there is no login keychain, and Chromium's
  // Safe Storage key request blocks the main process behind a keychain dialog
  // before `ready`. The mock keychain keeps the run unattended and off the
  // user's real keychain.
  const args = PLATFORM === 'darwin' ? ['--use-mock-keychain'] : [];
  inst.proc = spawn(APP_EXE, args, { cwd: inst.home, env: inst.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let buf = '';
  return new Promise((resolve, reject) => {
    let requested = null;
    const timer = setTimeout(() => reject(new Error(requested
      ? `CDP port ${requested} was requested but never verified ("CDP listening") within 60 s`
      : 'no CDP line from the app within 60 s')), 60000);
    const onChunk = (b) => {
      buf += b.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        inst.logTail.push(line);
        if (inst.logTail.length > 60) inst.logTail.shift();
        const ud = /WMUX_DATA_SUFFIX="[^"]*" → userData="([^"]+)"/.exec(line);
        if (ud) inst.userDataLogged = ud[1];
        const req = /CDP requested on port (\d+)/.exec(line);
        if (req) requested = Number(req[1]);
        // "listening" is logged after the app verified the port is its own
        // (#1331 ownership probe); "enabled" is the pre-#1331 wording.
        const ok = /CDP (?:listening|enabled) on port (\d+)/.exec(line);
        if (ok && inst.cdpPort === null) {
          inst.cdpPort = Number(ok[1]);
          clearTimeout(timer);
          resolve(inst.cdpPort);
        }
      }
    };
    inst.proc.stdout.on('data', onChunk);
    inst.proc.stderr.on('data', onChunk);
    inst.proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`app exited (code ${code}) before CDP was ready`)); });
  });
}

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

// First-boot overlays (onboarding tour, auto-update prompt) swallow clicks
// and focus; same handling as perf-bench.mjs dismissOverlays.
async function dismissOverlays(page) {
  let clean = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const state = await page.evaluate(() => ({
        tour: !!document.querySelector('.onboarding-overlay'),
        autoUpdate: [...document.querySelectorAll('div.fixed.inset-0')].some((d) => d.className.includes('z-[60]')),
      }));
      if (!state.tour && !state.autoUpdate) {
        if (++clean >= 2) return;
        await sleep(500);
        continue;
      }
      clean = 0;
      if (state.tour) await page.keyboard.press('Escape');
      else {
        await page.evaluate(() => {
          [...document.querySelectorAll('div.fixed.inset-0')].find((d) => d.className.includes('z-[60]'))?.querySelector('button')?.click();
        });
      }
      await sleep(400);
    } catch { await sleep(400); }
  }
  console.error('[setup] warning: overlays still present after dismissal attempts');
}

// Renderer instrumentation. One pty.onData subscriber sees every pane, hidden
// workspaces included (the output scheduler queues downstream of it).
//   - per pty: last data time, byte count, and gaps >= stallMs (stalls);
//   - pending markers: matched in the control-stripped tail of the pane's
//     output; keyboard markers are timed from the keydown of their last key,
//     probes from the pty.write call; keyboard results also get the next rAF.
function hookSource(stallMs) {
  return `(() => {
  if (window.__wmuxSoak) return;
  const strip = ${stripTerminalControls.toString()};
  const H = { gapMs: ${Number(stallMs)}, last: {}, bytes: {}, tails: {}, gaps: [], pending: new Map(), results: [], late: [], key: null, ready: false, watch: {} };
  window.__wmuxSoak = H;
  window.addEventListener('keydown', (e) => {
    const k = H.key;
    if (k && k.armed && k.t0 === null && e.key === k.last) {
      k.t0 = performance.now();
      const p = H.pending.get(k.marker);
      if (p) p.t0 = k.t0;
    }
  }, { capture: true });
  const onData = (id, data) => {
    const now = performance.now();
    const prev = H.last[id];
    if (prev !== undefined && now - prev >= H.gapMs) H.gaps.push({ ptyId: id, gapMs: Math.round(now - prev), at: Date.now() });
    H.last[id] = now;
    H.bytes[id] = (H.bytes[id] || 0) + (data ? data.length : 0);
    if (H.watch[id] !== undefined && typeof data === 'string') H.watch[id] = (H.watch[id] + data).slice(-8192);
    if (H.pending.size === 0 || typeof data !== 'string') return;
    let tail = (H.tails[id] || '') + data;
    if (tail.length > 2048) tail = tail.slice(-2048);
    H.tails[id] = tail;
    const text = strip(tail);
    for (const [marker, p] of H.pending) {
      if (p.t0 === null || text.indexOf(marker) === -1) continue;
      H.pending.delete(marker);
      H.tails[id] = '';
      const rec = { marker, kind: p.kind, ptyId: id, expected: p.expected, echoMs: now - p.t0 };
      // An echo after the harness gave up is late, not a sample.
      const sink = p.timedOut ? H.late : H.results;
      if (p.kind === 'key') requestAnimationFrame(() => { rec.frameMs = performance.now() - p.t0; sink.push(rec); });
      else sink.push(rec);
      break;
    }
  };
  const tryHook = () => {
    const api = window.electronAPI;
    if (!api || !api.pty || typeof api.pty.onData !== 'function') { setTimeout(tryHook, 5); return; }
    api.pty.onData(onData);
    H.ready = true;
  };
  tryHook();
})();`;
}

async function bootInstance(inst) {
  // A fresh suffix should have no listeners; if one does, it is not ours.
  for (const pipe of [inst.mainPipe, defaultDaemonPipe(inst)]) {
    if (await pipeAlive(pipe)) throw new Error(`a pipe of this run's suffix ${inst.suffix} is already in use; refusing to start`);
  }
  const port = await spawnInstance(inst);
  console.log(`[setup] app pid ${inst.proc.pid}, CDP port ${port} (verified by the app)`);
  inst.browser = await waitFor(`CDP connect :${port}`, async () => {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { return null; }
  }, 30000);
  const hook = hookSource(ARGS.stallMs);
  for (const ctx of inst.browser.contexts()) {
    try { await ctx.addInitScript(hook); } catch { /* evaluated below */ }
  }
  inst.page = await waitFor('renderer page (.xterm)', () => findRendererPage(inst.browser), 90000);
  await inst.page.evaluate(hook);
  await waitFor('renderer hook', () => inst.page.evaluate(() => window.__wmuxSoak?.ready === true), 15000);
  if (inst.userDataLogged && !inst.userDataCandidates.some((d) => path.resolve(d) === path.resolve(inst.userDataLogged))) {
    // Unseeded, the first-run wizard takes focus and every sample drops.
    // The dir carries this run's suffix, so it is ours to remove.
    if (path.basename(inst.userDataLogged).endsWith(inst.suffix)) inst.createdUserData.push(inst.userDataLogged);
    throw new Error('the app chose a userData dir this harness did not seed (the first-run wizard would take focus)');
  }
  await waitFor('main pipe', () => pipeAlive(inst.mainPipe), 30000);
  const token = await waitFor('main auth token', () => {
    try { return fs.readFileSync(inst.mainTokenPath, 'utf8').trim() || null; } catch { return null; }
  }, 15000);
  inst.main = new PipeClient(inst.mainPipe, token);
  await inst.main.connect();
  await dismissOverlays(inst.page);
}

/**
 * The daemon's own report of its terminal engine. With `requested` set it
 * aborts on a mismatch; with null it only records (the end-of-run check, so
 * a changed engine is reported instead of lost in a throw).
 */
async function checkEngine(inst, requested) {
  const dc = await waitFor('daemon pipe', () => daemonClient(inst).catch(() => null), 30000, 500);
  const ping = await dc.call('daemon.ping', { includeTerminalCore: true }, 5000);
  const runtime = verifyEngine(requested, ping);
  if (Number.isInteger(ping?.pid)) inst.lastDaemonPid = ping.pid;
  return { runtime, daemonPid: ping?.pid ?? null, daemonVersion: ping?.version ?? null };
}

async function daemonClient(inst) {
  if (inst.daemon && inst.daemon.sock && !inst.daemon.sock.destroyed) return inst.daemon;
  const token = readDaemonToken(inst);
  if (!token) return null;
  const c = new PipeClient(readDaemonPipeName(inst), token);
  await c.connect();
  inst.daemon = c;
  return c;
}

/** One process listing: [{ pid, ppid, createdMs, commandLine, name, workingSetBytes, commitBytes, raw }]. */
async function listProcesses() {
  if (PLATFORM === 'win32') {
    const out = await runPowerShell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,WorkingSetSize,PageFileUsage | ConvertTo-Json -Compress', 30000);
    const rows = JSON.parse(out);
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name, commandLine: r.CommandLine ?? null,
      createdMs: parseCimDate(r.CreationDate), workingSetBytes: Number(r.WorkingSetSize) || 0,
      commitBytes: (Number(r.PageFileUsage) || 0) * 1024, raw: r,
    }));
  }
  const out = await runPs(['-axww', '-o', 'pid=,ppid=,lstart=,command=']);
  const rows = [];
  for (const line of out.split('\n')) {
    // lstart is five fields: "Mon Oct 26 16:53:52 2026".
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), createdMs: Date.parse(m[3]), commandLine: m[4] });
  }
  return rows;
}

/** Threads, handles and working set (Windows) or RSS and state (POSIX) of a live pid. */
async function describeProcess(pid) {
  if (PLATFORM === 'win32') {
    const out = await runPowerShell(`$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; [pscustomobject]@{ threads = $p.Threads.Count; handles = $p.HandleCount; workingSetBytes = $p.WorkingSet64 } | ConvertTo-Json -Compress`, 10000);
    return JSON.parse(out);
  }
  const out = (await runPs(['-p', String(pid), '-o', 'rss=,stat='])).trim();
  const m = /^(\d+)\s+(\S+)/.exec(out);
  return m ? { rssBytes: Number(m[1]) * 1024, state: m[2] } : null;
}

/** Kill `pid` only when one lookup proves it is this run's daemon; false on any doubt. */
async function killDaemonIfOurs(pid) {
  if (!pid || !pidAlive(pid)) return false;
  let row = null;
  try { row = (await listProcesses()).find((r) => r.pid === pid) ?? null; } catch { return false; }
  if (!daemonPidVerdict(row, { harnessStartMs: HARNESS_START_MS, appDir: APP_ROOT, platform: PLATFORM })) {
    console.error(`[teardown] pid ${pid} is not provably this run's daemon; not killing it`);
    return false;
  }
  try { process.kill(pid); } catch { /* exited */ }
  await sleep(500);
  if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
  await sleep(300);
  return !pidAlive(pid);
}

/** Order and rationale: runTeardown in scripts/lib/twenty-pane-stability.mjs. */
async function shutdownInstance(inst) {
  if (inst.shuttingDown) return null;
  inst.shuttingDown = true;
  try { await inst.browser?.close(); } catch { /* noop */ }
  inst.main?.close();
  inst.daemon?.close();
  inst.daemon = null;
  // The pid the daemon last reported over its pipe and the pid file, read
  // before shutdown removes it (a respawned daemon writes a new one).
  const daemonPids = [inst.lastDaemonPid, readDaemonPid(inst)];
  let daemonPipe = defaultDaemonPipe(inst);
  try { daemonPipe = readDaemonPipeName(inst); } catch { /* keep the default */ }
  const report = await runTeardown({
    killApp: async () => { if (inst.proc && inst.proc.exitCode === null) { try { inst.proc.kill(); } catch { /* exited */ } } },
    waitAppExit: async () => {
      if (!inst.proc) return true;
      const deadline = Date.now() + 8000;
      while (inst.proc.exitCode === null && inst.proc.signalCode === null && Date.now() < deadline) await sleep(100);
      if (inst.proc.exitCode === null && inst.proc.signalCode === null) { try { inst.proc.kill('SIGKILL'); } catch { /* exited */ } await sleep(500); }
      return inst.proc.exitCode !== null || inst.proc.signalCode !== null;
    },
    shutdownDaemon: async () => {
      const token = readDaemonToken(inst);
      if (!token || !(await pipeAlive(daemonPipe))) return false;
      const c = new PipeClient(daemonPipe, token);
      await c.connect();
      await c.call('daemon.shutdown', {}, 5000).catch(() => { /* the ack may race the exit */ });
      c.close();
      return true;
    },
    daemonPids,
    daemonPipeAlive: () => pipeAlive(daemonPipe),
    pidAlive: async (pid) => pidAlive(pid),
    describeProcess,
    killDaemonIfOurs: (pid) => killDaemonIfOurs(pid),
    findLeftovers: async () => {
      try {
        return leftoverPids(await listProcesses(), {
          needles: [inst.home, ...inst.userDataCandidates, inst.userDataLogged],
          harnessStartMs: HARNESS_START_MS, platform: PLATFORM, excludePids: [process.pid],
        });
      } catch { return []; }
    },
    killPid: async (pid) => { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
    removeSandbox: async () => {
      for (const dir of [inst.home, ...inst.createdUserData]) {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
      }
    },
    sleep,
  });
  if (!report.removed) {
    console.error(`[teardown] the daemon of suffix ${inst.suffix} (pid ${report.daemonLingering?.pid ?? (report.daemonPids.join('/') || 'unknown')}) was not confirmed gone; the sandbox was kept. See "Manual cleanup" in docs/performance/twenty-panes.md (run.json has the paths).`);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Setup: workspaces, panes, shells, producers
// ---------------------------------------------------------------------------

async function listPanes(inst, workspaceId) {
  const res = await inst.main.call('pane.list', { workspaceId });
  const panes = Array.isArray(res?.panes) ? res.panes : Array.isArray(res) ? res : [];
  return panes.map((p) => ({ id: p.id, ptyId: (p.surfacePtyIds ?? [])[0] ?? null, deferred: p.deferred === true, active: p.active === true }));
}

/** Split the largest pane of a workspace until it holds `count` panes (a grid, not a spiral). */
async function fillWorkspace(inst, workspaceId, count) {
  let panes = await listPanes(inst, workspaceId);
  const area = new Map(panes.map((p) => [p.id, { area: 1, depth: 0 }]));
  while (panes.length < count) {
    const target = panes.reduce((a, b) => ((area.get(b.id)?.area ?? 0) > (area.get(a.id)?.area ?? 0) ? b : a));
    const meta = area.get(target.id) ?? { area: 1, depth: 0 };
    await callPaced(inst.main, 'pane.focus', { id: target.id });
    await callPaced(inst.main, 'pane.split', { workspaceId, direction: meta.depth % 2 === 0 ? 'horizontal' : 'vertical' });
    const before = panes.length;
    panes = await waitFor(`pane ${before + 1} in workspace`, async () => {
      const next = await listPanes(inst, workspaceId);
      return next.length > before ? next : null;
    }, 20000, 250);
    for (const p of panes) if (!area.has(p.id)) area.set(p.id, { area: meta.area / 2, depth: meta.depth + 1 });
    area.set(target.id, { area: meta.area / 2, depth: meta.depth + 1 });
    await sleep(300);
  }
}

async function currentWorkspaceId(inst) {
  const cur = await inst.main.call('workspace.current', {});
  return cur?.id ?? null;
}

async function setup(inst) {
  const layout = planLayout(ARGS.panes, ARGS.perWorkspace);
  const workspaceIds = [await currentWorkspaceId(inst)];
  if (!workspaceIds[0]) throw new Error('no active workspace after boot');
  for (let w = 1; w < layout.length; w++) {
    const res = await callPaced(inst.main, 'mcp.claimWorkspace', { name: `soak-${w + 1}` });
    if (typeof res?.workspaceId !== 'string') throw new Error(`mcp.claimWorkspace returned no workspaceId: ${JSON.stringify(res)}`);
    workspaceIds.push(res.workspaceId);
    await sleep(300);
  }
  for (let w = 0; w < layout.length; w++) {
    await fillWorkspace(inst, workspaceIds[w], layout[w]);
    console.log(`[setup] workspace ${w + 1}/${layout.length}: ${layout[w]} panes`);
  }
  // Show every workspace once with the real shortcut, so no pane stays
  // deferred (#2398) and the switch path is proven before the run.
  for (let w = 0; w < layout.length; w++) {
    await inst.page.keyboard.press('Alt+ArrowDown');
    await sleep(1500);
  }
  const panes = [];
  await waitFor('every pane has a started terminal', async () => {
    panes.length = 0;
    for (let w = 0; w < layout.length; w++) {
      const rows = await listPanes(inst, workspaceIds[w]);
      if (rows.length !== layout[w] || rows.some((r) => !r.ptyId || r.deferred)) return false;
      rows.forEach((r, i) => panes.push({ workspaceIndex: w, workspaceId: workspaceIds[w], indexInWorkspace: i, paneId: r.id, ptyId: r.ptyId }));
    }
    return true;
  }, 60000, 1000);
  panes.forEach((p, i) => { p.index = i; });
  const classes = assignClasses(panes, ARGS.streaming, ARGS.claude);
  panes.forEach((p, i) => { p.cls = classes[i]; });

  // Short prompt everywhere so markers never wrap; then start the producers.
  for (const p of panes) {
    await callPaced(inst.main, 'input.send', { ptyId: p.ptyId, text: shellPrepCommand(PLATFORM), submit: true, raw: true });
    await sleep(150);
  }
  await sleep(2000);
  const producerPath = path.join(inst.home, 'soak-producer.cjs');
  fs.writeFileSync(producerPath, producerSource(), 'utf8');
  const seconds = Math.ceil(ARGS.minutes * 60 + 600);
  for (const p of panes.filter((x) => x.cls === 'streaming')) {
    const cmd = producerCommand(PLATFORM, process.execPath, producerPath, [p.index, ARGS.rateKiB, seconds]);
    await callPaced(inst.main, 'input.send', { ptyId: p.ptyId, text: cmd, submit: true, raw: true });
    await sleep(250);
  }
  // Cold node starts under PowerShell on a loaded machine can take a while:
  // wait until every streaming pane shows a producer status row, then check
  // that its output keeps growing.
  const streamingIds = panes.filter((p) => p.cls === 'streaming').map((p) => p.ptyId);
  const flowing = async () => {
    const before = await inst.page.evaluate(() => ({ ...window.__wmuxSoak.bytes }));
    await sleep(1500);
    const after = await inst.page.evaluate(() => ({ ...window.__wmuxSoak.bytes }));
    return streamingIds.filter((id) => !((after[id] ?? 0) > (before[id] ?? 0) + 1024));
  };
  try {
    await waitFor('streaming panes producing output', async () => (await flowing()).length === 0, 45000, 500);
  } catch {
    throw new Error(`${(await flowing()).length} streaming pane(s) produce no output after 45 s; the producer did not start`);
  }
  await startClaude(inst, panes);
  await inst.page.evaluate(() => { window.__wmuxSoak.gaps.length = 0; });
  return { panes, workspaceIds, layout };
}

/** Claude Code's profile locations: the operator's config dir, or the real home. */
function claudeProfilePaths() {
  if (ARGS.claudeConfigDir) {
    const dir = path.resolve(ARGS.claudeConfigDir);
    return { projectsDir: path.join(dir, 'projects'), configFile: path.join(dir, '.claude.json') };
  }
  const home = PLATFORM === 'win32' ? REAL_PROFILE.USERPROFILE : (REAL_PROFILE.HOME ?? os.homedir());
  return { projectsDir: path.join(home, '.claude', 'projects'), configFile: path.join(home, '.claude.json') };
}

/**
 * A Claude pane runs with the real home but this run's WMUX_DATA_SUFFIX, so
 * wmux hooks in the user's own Claude settings may create
 * `<real home>/.wmux<suffix>*` paths. The suffix is unique to this run, so
 * those exact names, created after the harness started, are this run's.
 */
function removeRealHomeSuffixPaths() {
  if (!inst) return [];
  const home = PLATFORM === 'win32' ? REAL_PROFILE.USERPROFILE : (REAL_PROFILE.HOME ?? os.homedir());
  const removed = [];
  for (const name of [`.wmux${inst.suffix}`, `.wmux${inst.suffix}-auth-token`, `.wmux${inst.suffix}.sock`, `.wmux-mcpb${inst.suffix}.sock`]) {
    const target = path.join(home, name);
    try {
      const st = fs.lstatSync(target);
      if ((st.birthtimeMs || st.mtimeMs) < HARNESS_START_MS - 1000) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch { /* absent */ }
  }
  return removed;
}

/** Names only: project entry names and ~/.claude.json keys, never their contents. */
function snapshotClaudeProfile() {
  const { projectsDir, configFile } = claudeProfilePaths();
  let projects = [];
  try { projects = fs.readdirSync(projectsDir); } catch { /* none yet */ }
  let configKeys = [];
  let configProjects = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    configKeys = Object.keys(cfg);
    configProjects = Object.keys(cfg.projects ?? {});
  } catch { /* none yet */ }
  return { projects, configKeys, configProjects };
}

/**
 * Claude Code panes: a tiny fixture repo whose project settings install two
 * hooks (UserPromptSubmit, Stop) that log turn start and end to a per-pane
 * status file, so the harness knows when a turn runs. The operator's config
 * dir is used in place; nothing is copied out of it.
 */
async function startClaude(inst, panes) {
  const claudePanes = panes.filter((p) => p.cls === 'claude');
  if (claudePanes.length === 0) return;
  claudeProfileBefore = snapshotClaudeProfile();
  const repoDir = path.join(inst.home, 'claude-repo');
  claudeRepoPaths = [repoDir];
  fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), CLAUDE_README, 'utf8');
  try { claudeRepoPaths.push(fs.realpathSync.native(repoDir)); } catch { /* as created */ }
  const hookPath = path.join(inst.home, 'claude-turn-hook.cjs');
  fs.writeFileSync(hookPath, claudeHookSource(), 'utf8');
  fs.writeFileSync(path.join(repoDir, '.claude', 'settings.json'), JSON.stringify(claudeProjectSettings(process.execPath, hookPath), null, 2), 'utf8');
  // Keep the recent screen text of these panes, to answer startup prompts.
  const ids = claudePanes.map((p) => p.ptyId);
  await inst.page.evaluate((list) => { for (const id of list) window.__wmuxSoak.watch[id] = ''; }, ids);
  for (const p of claudePanes) {
    p.statusFile = path.join(inst.home, `claude-status-${p.index}.ndjson`);
    p.statusOffset = 0;
    p.claude = newClaudeState();
    const cmd = claudeLaunchCommand(PLATFORM, {
      repoDir, configDir: ARGS.claudeConfigDir ? path.resolve(ARGS.claudeConfigDir) : null,
      statusFile: p.statusFile, cmd: ARGS.claudeCmd, realProfile: REAL_PROFILE,
    });
    await callPaced(inst.main, 'input.send', { ptyId: p.ptyId, text: cmd, submit: true, raw: true });
    await sleep(500);
  }
  // Wait for startup to settle: output quiet for 3 s (at most 45 s).
  const readBytes = () => inst.page.evaluate((list) => list.map((id) => window.__wmuxSoak.bytes[id] ?? 0), ids);
  await sleep(5000);
  let prev = await readBytes();
  for (let waited = 0; waited < 40000; waited += 3000) {
    await sleep(3000);
    const cur = await readBytes();
    if (cur.every((b, i) => b === prev[i])) break;
    prev = cur;
  }
  // A folder Claude Code has not seen asks whether to trust it. Answer "Yes"
  // only where the prompt is on screen; nothing is sent otherwise.
  const screens = await inst.page.evaluate((list) => list.map((id) => window.__wmuxSoak.watch[id] ?? ''), ids);
  const { trusted, refused } = await answerTrustPrompts(claudePanes, screens.map((t) => stripTerminalControls(t)), {
    beforeAnswer: (ptyId) => inst.page.evaluate((id) => { window.__wmuxSoak.watch[id] = ''; }, ptyId),
    write: (ptyId, data) => inst.page.evaluate(({ id, d }) => window.electronAPI.pty.write(id, d), { id: ptyId, d: data }),
    screenAfter: async (ptyId) => stripTerminalControls(await inst.page.evaluate((id) => window.__wmuxSoak.watch[id] ?? '', ptyId)),
    sleep,
  });
  await sleep(4000);
  await inst.page.evaluate((list) => { for (const id of list) delete window.__wmuxSoak.watch[id]; }, ids);
  console.log(`[setup] ${claudePanes.length} Claude Code pane(s) started (${trusted} answered the folder-trust prompt${refused ? `, ${refused} refused: those panes are stopped` : ''})`);
}

/** Read new hook events for each Claude pane, then submit or interrupt as the loop says. */
async function driveClaude(inst, panes, runEnded) {
  for (const p of panes.filter((x) => x.cls === 'claude')) {
    let text = '';
    try {
      const buf = fs.readFileSync(p.statusFile);
      text = buf.subarray(p.statusOffset).toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      text = lastNl === -1 ? '' : text.slice(0, lastNl + 1);
      p.statusOffset += Buffer.byteLength(text);
    } catch { /* no events yet */ }
    const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    applyClaudeEvents(p.claude, events);
    const action = nextClaudeAction(p.claude, Date.now(), {
      maxTurns: ARGS.claudeMaxTurns, intervalSec: ARGS.claudeIntervalSec, turnTimeoutSec: ARGS.claudeTurnTimeoutSec, runEnded,
    });
    try {
      if (action === 'submit') await callPaced(inst.main, 'input.send', { ptyId: p.ptyId, text: CLAUDE_PROMPT, submit: true });
      else if (action === 'interrupt') await callPaced(inst.main, 'input.sendKey', { ptyId: p.ptyId, key: 'escape' });
    } catch (e) {
      p.claude.stopped = `send-failed: ${e.message}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

let markerSeq = 0;

async function collectResults(page) {
  return page.evaluate(() => window.__wmuxSoak.results.splice(0));
}

/** Type one marker into whatever has keyboard focus; time the last key. */
async function keyboardMarker(page, paneIndex, expectedPtyId) {
  const marker = markerFor(paneIndex, ++markerSeq);
  await page.evaluate(({ marker, expected }) => {
    const H = window.__wmuxSoak;
    H.tails = {};
    H.pending.set(marker, { kind: 'key', expected, t0: null });
    H.key = { marker, last: marker[marker.length - 1], armed: false, t0: null };
  }, { marker, expected: expectedPtyId });
  await page.keyboard.type(marker.slice(0, -1), { delay: 15 });
  await page.evaluate(() => { window.__wmuxSoak.key.armed = true; });
  await page.keyboard.press(marker[marker.length - 1]);
  let rec = null;
  const deadline = Date.now() + ARGS.keyTimeoutMs;
  while (!rec && Date.now() < deadline) {
    await sleep(20);
    const got = await collectResults(page);
    rec = got.find((r) => r.marker === marker) ?? null;
  }
  if (!rec) await page.evaluate((m) => { const p = window.__wmuxSoak.pending.get(m); if (p) p.timedOut = true; }, marker);
  for (let i = 0; i < marker.length; i++) await page.keyboard.press('Backspace');
  await sleep(150);
  return { marker, rec };
}

/** Write a marker to every pane, wait for the echoes, then erase them. */
async function probeAll(page, panes) {
  const batch = panes.map((p) => ({ marker: markerFor(p.index, ++markerSeq), ptyId: p.ptyId }));
  await page.evaluate(async (items) => {
    const H = window.__wmuxSoak;
    H.tails = {};
    for (const b of items) {
      H.pending.set(b.marker, { kind: 'probe', expected: b.ptyId, t0: performance.now() });
      window.electronAPI.pty.write(b.ptyId, b.marker);
      await new Promise((r) => setTimeout(r, 20));
    }
  }, batch);
  const got = new Map();
  const deadline = Date.now() + ARGS.probeTimeoutMs;
  while (got.size < batch.length && Date.now() < deadline) {
    await sleep(50);
    for (const r of await collectResults(page)) got.set(r.marker, r);
  }
  const missing = batch.filter((b) => !got.has(b.marker)).map((b) => b.marker);
  await page.evaluate(async ({ items, missing }) => {
    const H = window.__wmuxSoak;
    for (const m of missing) { const p = H.pending.get(m); if (p) p.timedOut = true; }
    for (const b of items) {
      window.electronAPI.pty.write(b.ptyId, '\x7f'.repeat(b.marker.length));
      await new Promise((r) => setTimeout(r, 20));
    }
  }, { items: batch, missing });
  return batch.map((b, i) => ({ ...b, pane: panes[i], rec: got.get(b.marker) ?? null }));
}

const MEM_TYPES = { Browser: 'mainBytes', Tab: 'rendererBytes', GPU: 'gpuBytes' };

async function sampleMemory(inst, withTree, t0) {
  const mem = {};
  try {
    const perf = await inst.main.call('perf.status', { includeMemory: true });
    const procs = perf?.memory?.processes;
    if (Array.isArray(procs)) {
      mem.electronBytes = procs.reduce((a, p) => a + (p.workingSetBytes || 0), 0);
      for (const p of procs) {
        const key = MEM_TYPES[p.type];
        if (key) mem[key] = (mem[key] ?? 0) + (p.workingSetBytes || 0);
      }
      mem.electronProcesses = procs.length;
    }
  } catch (e) { mem.electronError = e.message; }
  // The daemon's own pid from daemon.ping is authoritative; the pid file is a
  // fallback that sampleProcessTree checks before trusting.
  let daemonPid = readDaemonPid(inst);
  let daemonPidVerified = false;
  try {
    const dc = await daemonClient(inst);
    const pong = dc ? await dc.call('daemon.ping', { includeMemory: true }, 5000) : null;
    if (pong && Number.isFinite(pong.eventLoopLagMs)) mem.daemonEventLoopLagMs = pong.eventLoopLagMs;
    const d = pong?.memory;
    if (d) {
      if (Number.isInteger(d.pid)) {
        daemonPid = d.pid;
        daemonPidVerified = true;
        mem.daemonPid = d.pid;
        mem.daemonPingSec = Math.round((Date.now() - t0) / 100) / 10;
        inst.lastDaemonPid = d.pid;
      }
      mem.daemonRssBytes = d.rssBytes;
      mem.daemonHeapUsedBytes = d.heapUsedBytes;
      const sum = (k) => d.sessions.reduce((a, s) => a + (s[k] || 0), 0);
      mem.ringAllocatedBytes = sum('ringAllocatedBytes');
      mem.ringStoredBytes = sum('ringStoredBytes');
      mem.socketQueuedBytes = sum('socketQueuedBytes');
      mem.resyncQueuedBytes = sum('resyncQueuedBytes');
      mem.sessionStates = d.sessions.reduce((a, s) => { a[s.state] = (a[s.state] ?? 0) + 1; return a; }, {});
      if (d.hibernation) mem.hibernatedSessions = d.hibernation.sessions;
    }
  } catch (e) {
    mem.daemonError = e.message;
    inst.daemon?.close();
    inst.daemon = null;
  }
  if (withTree) {
    try { Object.assign(mem, await sampleProcessTree(inst.proc.pid, daemonPid, daemonPidVerified)); } catch (e) { mem.treeError = e.message; }
  }
  return mem;
}

/**
 * OS process-tree working set / RSS of the app and the daemon, incl. shells
 * and producers. On Windows also commit (PageFileUsage), which, unlike the
 * working set, the OS does not trim.
 */
async function sampleProcessTree(appPid, daemonPidIn, daemonPidVerified) {
  let daemonPid = daemonPidIn;
  if (PLATFORM === 'win32') {
    const rows = (await listProcesses()).map((r) => r.raw);
    const byPid = new Map(rows.map((r) => [r.ProcessId, r]));
    // A pid-file pid could be recycled: require it to look like our daemon
    // (perf-bench.mjs measureRam does the same).
    if (daemonPid && !daemonPidVerified && !looksLikeDaemonRow(byPid.get(daemonPid), byPid.get(appPid))) daemonPid = null;
    const { pids, rejectedEdgeCount } = collectProcessTree(rows, daemonPid ? [appPid, daemonPid] : [appPid]);
    const treeRows = [...pids].map((pid) => byPid.get(pid)).filter(Boolean).map((p) => ({
      pid: p.ProcessId, name: p.Name, commandLine: p.CommandLine,
      workingSetBytes: Number(p.WorkingSetSize) || 0, commitBytes: (Number(p.PageFileUsage) || 0) * 1024,
    }));
    const breakdown = accumulateBreakdown(treeRows, { mainPid: appPid, daemonPid });
    const daemonRow = daemonPid ? byPid.get(daemonPid) : null;
    return {
      treeBytes: treeRows.reduce((a, r) => a + r.workingSetBytes, 0),
      treeCommitBytes: treeRows.reduce((a, r) => a + r.commitBytes, 0),
      ...(daemonRow ? { daemonCommitBytes: (Number(daemonRow.PageFileUsage) || 0) * 1024 } : {}),
      treeProcesses: treeRows.length,
      treeRejectedEdges: rejectedEdgeCount,
      treeBreakdown: Object.fromEntries(RAM_CATEGORIES.map((c) => [c, { bytes: breakdown[c].workingSetBytes, processes: breakdown[c].processCount }])),
    };
  }
  if (daemonPid && !daemonPidVerified) {
    const row = (await listProcesses().catch(() => [])).find((r) => r.pid === daemonPid);
    if (!daemonPidVerdict(row, { harnessStartMs: HARNESS_START_MS, appDir: APP_ROOT, platform: PLATFORM })) daemonPid = null;
  }
  const rows = parsePsRows(await runPs(['-axo', 'pid=,ppid=,rss=,comm=']));
  const g = groupMemory(rows, appPid, daemonPid ?? -1, -1);
  return {
    treeBytes: g.app.rssBytes + g.daemon.rssBytes + g.workloads.rssBytes,
    treeProcesses: g.app.processes + g.daemon.processes + g.workloads.processes,
    treeBreakdown: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { bytes: v.rssBytes, processes: v.processes }])),
  };
}

/**
 * Does a terminal hold keyboard focus after pane.focus? One more pane.focus
 * if not; no clicking, since a click could land in a Claude Code pane.
 */
async function focusActiveTerminal(inst, paneId, workspaceId) {
  // The store must name the target as the active pane, and the DOM must have
  // a terminal focused. (The DOM does not say which pane's terminal that is;
  // an echo from another pane is counted as wrongPane and stops the sample.)
  const focused = async () => {
    const domOk = await inst.page.evaluate(() => !!document.activeElement?.classList?.contains('xterm-helper-textarea'));
    if (!domOk) return false;
    const rows = await listPanes(inst, workspaceId).catch(() => []);
    return rows.some((r) => r.id === paneId && r.active);
  };
  if (await focused()) return true;
  await inst.main.call('pane.focus', { id: paneId }).catch(() => { /* counted as a miss */ });
  await sleep(400);
  return focused();
}

async function runSample(inst, ctx, tick, t0) {
  const { page } = inst;
  const tSec = (Date.now() - t0) / 1000;
  const sample = { tick, tSec: Math.round(tSec * 10) / 10, focus: {}, keyboard: [], probes: [] };

  // 1. Move focus: a workspace switch every N samples, a pane switch always.
  const switchWs = ARGS.workspaceSwitchEvery > 0 && tick > 0 && tick % ARGS.workspaceSwitchEvery === 0 && ctx.layout.length > 1;
  let wsBefore = null;
  if (switchWs) {
    wsBefore = await currentWorkspaceId(inst).catch(() => null);
    await page.keyboard.press('Alt+ArrowDown');
    await sleep(500);
  }
  const wsId = await currentWorkspaceId(inst).catch(() => null);
  // Keystrokes and markers never go into Claude Code panes.
  const inWs = ctx.panes.filter((p) => p.workspaceId === wsId && p.cls !== 'claude');
  let target = null;
  if (inWs.length) {
    ctx.rotation[wsId] = ((ctx.rotation[wsId] ?? -1) + 1) % inWs.length;
    target = inWs[ctx.rotation[wsId]];
    await inst.main.call('pane.focus', { id: target.paneId }).catch(() => { /* recorded via focus miss */ });
    await sleep(250);
  }
  sample.focus = {
    workspaceSwitch: switchWs,
    ...(switchWs ? { switched: wsBefore !== null && wsId !== null && wsBefore !== wsId } : {}),
    workspaceIndex: target?.workspaceIndex ?? null, paneIndex: target?.index ?? null,
  };
  if (target) {
    await dismissOverlays(page);
    sample.focus.focused = await focusActiveTerminal(inst, target.paneId, target.workspaceId);
  }

  // 2. Focused keystrokes, only into a focused non-Claude pane. A focus miss
  //    skips them and is counted instead.
  for (let k = 0; target && sample.focus.focused && k < ARGS.keysPerSample; k++) {
    const { rec } = await keyboardMarker(page, target?.index ?? 99, target?.ptyId ?? null);
    sample.keyboard.push({
      phase: k === 0 ? 'afterSwitch' : 'steady',
      echoMs: rec ? Math.round(rec.echoMs * 1000) / 1000 : null,
      frameMs: rec && Number.isFinite(rec.frameMs) ? Math.round(rec.frameMs * 1000) / 1000 : null,
      ptyId: rec?.ptyId ?? null,
      wrongPane: !!(rec && target && rec.ptyId !== target.ptyId),
    });
    // A lost or misrouted key may mean focus sits in another pane (possibly
    // a Claude pane): stop typing for this sample.
    const last = sample.keyboard[sample.keyboard.length - 1];
    if (last.echoMs === null || last.wrongPane) break;
  }

  // 3. Probe every pane.
  for (const r of await probeAll(page, ctx.panes.filter((p) => p.cls !== 'claude'))) {
    sample.probes.push({
      ptyId: r.ptyId, paneIndex: r.pane.index, cls: r.pane.cls,
      echoMs: r.rec && r.rec.ptyId === r.ptyId ? Math.round(r.rec.echoMs * 1000) / 1000 : null,
    });
  }

  // 4. Late echoes of earlier timeouts, stalls, silence, frame cadence.
  const state = await page.evaluate(() => {
    const H = window.__wmuxSoak;
    const now = performance.now();
    const late = H.late.splice(0);
    for (const [m, p] of H.pending) if (p.timedOut && p.t0 !== null && now - p.t0 > 60000) H.pending.delete(m);
    const sinceLast = {};
    for (const id of Object.keys(H.last)) sinceLast[id] = Math.round(now - H.last[id]);
    return { late, gaps: H.gaps.splice(0), sinceLast, bytes: { ...H.bytes } };
  });
  sample.late = state.late.map((r) => ({ kind: r.kind, ptyId: r.ptyId, lateMs: Math.round(r.echoMs) }));
  const clsOf = new Map(ctx.panes.map((p) => [p.ptyId, p.cls]));
  // A Claude pane counts as streaming only while one of its turns runs.
  const byPty = new Map(ctx.panes.map((p) => [p.ptyId, p]));
  const expectsOutput = (ptyId, t) => {
    const p = byPty.get(ptyId);
    return p?.cls === 'streaming' || (p?.cls === 'claude' && inTurnAt(p.claude.intervals, t));
  };
  // A Claude pane's gap counts only for the part inside its turn.
  const stallMs = (g) => {
    const p = byPty.get(g.ptyId);
    if (p?.cls === 'streaming') return g.gapMs;
    if (p?.cls === 'claude') return Math.round(gapInTurnMs(p.claude.intervals, g.at - g.gapMs, g.at));
    return 0;
  };
  sample.stalls = state.gaps.map((g) => ({ g, ms: stallMs(g) })).filter((x) => x.ms >= ARGS.stallMs)
    .map(({ g, ms }) => ({ ptyId: g.ptyId, cls: clsOf.get(g.ptyId), gapMs: ms, atSec: Math.round((g.at - t0) / 100) / 10 }));
  const nowWall = Date.now();
  sample.silent = ctx.panes.filter((p) => (state.sinceLast[p.ptyId] ?? Infinity) > ARGS.stallMs
      && expectsOutput(p.ptyId, nowWall - (state.sinceLast[p.ptyId] ?? 0)) && expectsOutput(p.ptyId, nowWall))
    .map((p) => ({ ptyId: p.ptyId, cls: p.cls, silentMs: state.sinceLast[p.ptyId] ?? null }));
  sample.outputBytes = ctx.panes.reduce((a, p) => a + (state.bytes[p.ptyId] ?? 0), 0);
  const raf = summarizeSamples(await sampleRafDeltas(page, 20));
  sample.raf = { p50: raf.p50, p95: raf.p95, throttled: (raf.p50 ?? 999) > 50 };

  // 5. Memory.
  sample.memory = await sampleMemory(inst, ARGS.treeEvery > 0 && tick % ARGS.treeEvery === 0, t0);

  // 6. Claude Code loop (after the probes, so no marker sits in an input box).
  if (ARGS.claude > 0) {
    await driveClaude(inst, ctx.panes, false);
    sample.claude = ctx.panes.filter((p) => p.cls === 'claude').map((p) => ({ ptyId: p.ptyId, inTurn: p.claude.inTurn, turns: p.claude.turns, completed: p.claude.completed, stopped: p.claude.stopped }));
  }
  return sample;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

let inst = null;
let outDir = null;
let samples = [];
let finished = false;
let runCtx = null;
let claudeProfileBefore = null;
let claudeRepoPaths = [];

/**
 * run.json: everything needed to clean up an interrupted run by hand (local
 * paths, pids, pipes). It stays in the gitignored output dir.
 */
function writeRunInfo(extra = {}) {
  if (!outDir || !inst) return;
  runInfo = {
    ...runInfo,
    suffix: inst.suffix, home: inst.home, wmuxDir: inst.wmuxDir, app: APP_EXE,
    userDataDirs: [...new Set([...inst.userDataCandidates, ...(inst.userDataLogged ? [inst.userDataLogged] : [])])],
    mainPipe: inst.mainPipe, daemonPipe: defaultDaemonPipe(inst),
    harnessPid: process.pid, appPid: inst.proc?.pid ?? null, daemonPid: readDaemonPid(inst),
    ...extra,
  };
  try { fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(runInfo, null, 2)); } catch { /* best effort */ }
}
let runInfo = {};
// What the daemon reported as its terminal engine, at start and at the end.
const engine = { requested: ARGS.engine, start: null, end: null, daemonPidStart: null, daemonPidEnd: null, daemonVersion: null };

function writeSummary(reason, teardown = null) {
  if (!outDir) return null;
  const claude = (runCtx?.panes ?? []).filter((p) => p.cls === 'claude' && p.claude)
    .map((p) => ({ paneIndex: p.index, ptyId: p.ptyId, ...p.claude }));
  const summary = { reason, engine, ...summarizeRun(samples, { stallMs: ARGS.stallMs, claude, startDaemonPid: engine.daemonPidStart }) };
  if (teardown) {
    const { daemonLingering, ...rest } = teardown;
    summary.teardown = rest;
    summary.daemonLingering = daemonLingering;
    summary.flags.push(...teardownFlags(teardown));
  }
  if (engine.start && !engine.end) {
    summary.flags.unshift(`the daemon's terminal engine could not be read at the end${engine.endError ? ` (${engine.endError})` : ''}`);
  }
  if (engine.end && engine.start && engine.end.effective !== engine.start.effective) {
    summary.flags.unshift(`the daemon's terminal engine changed during the run (${engine.start.effective} -> ${engine.end.effective})`);
  }
  if (!summary.daemonRespawned && engine.daemonPidEnd && engine.daemonPidStart && engine.daemonPidEnd !== engine.daemonPidStart) {
    summary.flags.unshift('the daemon was replaced during the run (its pid changed)');
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const text = renderSummary(summary);
  fs.writeFileSync(path.join(outDir, 'summary.txt'), text + '\n');
  return text;
}

async function finish(reason, code) {
  if (finished) return;
  finished = true;
  if (inst && runCtx && ARGS.claude > 0 && inst.proc?.exitCode === null) {
    try { await driveClaude(inst, runCtx.panes, true); } catch { /* reporting only */ }
  }
  if (inst && engine.start && inst.proc?.exitCode === null) {
    try {
      const end = await checkEngine(inst, null);
      engine.end = end.runtime;
      engine.daemonPidEnd = end.daemonPid;
    } catch (e) { engine.endError = e.message; }
  }
  const text = writeSummary(reason);
  if (text) console.log(`\n${text}\n\nresults: ${outDir}`);
  if (inst && !ARGS.keepApp) {
    writeRunInfo();
    const teardown = await shutdownInstance(inst);
    writeRunInfo({ teardown });
    if (teardown) {
      console.log(`[teardown] ${JSON.stringify(teardown)}`);
      // The summary written above predates the teardown; add its outcome.
      writeSummary(reason, teardown);
      for (const f of teardownFlags(teardown)) console.error(`[teardown] ${f}`);
    }
  }
  if (claudeProfileBefore && outDir) {
    const diff = { ...profileDiff(claudeProfileBefore, snapshotClaudeProfile(), claudeRepoPaths, PLATFORM), wmuxPathsRemoved: removeRealHomeSuffixPaths() };
    fs.writeFileSync(path.join(outDir, 'claude-profile-diff.json'), JSON.stringify(diff, null, 2));
    console.log(`[claude] profile entries for the fixture repo: ${diff.projectsAdded.length} project dir(s), ${diff.configProjectsAdded.length} .claude.json project(s) (claude-profile-diff.json)`);
  }
  process.exit(code);
}

process.on('SIGINT', () => {
  // A second Ctrl+C during a slow teardown (a lingering daemon can take 30 s)
  // exits at once; the sandbox may stay behind, run.json says where.
  if (finished) {
    console.error('[teardown] interrupted again: exiting now; see run.json and "Manual cleanup" in docs/performance/twenty-panes.md');
    process.exit(130);
  }
  void finish('interrupted', 130);
});

async function main() {
  outDir = path.resolve(ARGS.out ?? path.join(REPO_ROOT, 'out', 'twenty-pane-stability', stamp()));
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.mkdirSync(outDir); // fails if it exists: results are never overwritten
  const samplesPath = path.join(outDir, 'samples.ndjson');

  inst = makeInstance();
  console.log(`[setup] isolated instance, data suffix ${inst.suffix}`);
  writeRunInfo({ startedAt: new Date().toISOString() });
  await bootInstance(inst);
  writeRunInfo();
  const started = await checkEngine(inst, ARGS.engine);
  engine.start = started.runtime;
  engine.daemonPidStart = started.daemonPid;
  engine.daemonVersion = started.daemonVersion;
  console.log(`[setup] terminal engine: ${ARGS.engine ?? 'app default'} requested; the daemon reports ${started.runtime?.effective ?? 'nothing (older build)'}`);
  const ctx = await setup(inst);
  runCtx = ctx;
  ctx.rotation = {};
  const config = {
    platform: PLATFORM, arch: process.arch, osRelease: os.release(), node: process.version,
    cpus: os.cpus().length, totalMemBytes: os.totalmem(),
    startedAt: new Date().toISOString(),
    // The Claude config dir and command can carry paths or env values: record only whether they were set.
    args: { ...ARGS, app: path.basename(APP_EXE), out: undefined, claudeConfigDir: ARGS.claudeConfigDir ? '(set)' : null, claudeCmd: ARGS.claudeCmd === 'claude' ? 'claude' : '(custom)' },
    layout: ctx.layout,
    panes: ctx.panes.map((p) => ({ index: p.index, workspaceIndex: p.workspaceIndex, ptyId: p.ptyId, cls: p.cls })),
    engine,
  };
  fs.writeFileSync(path.join(outDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`[run] ${ctx.panes.length} panes (${ctx.panes.filter((p) => p.cls === 'streaming').length} streaming, ${ctx.panes.filter((p) => p.cls === 'claude').length} Claude) for ${ARGS.minutes} min, a sample every ${ARGS.sampleSec} s`);

  const t0 = Date.now();
  let lastSeenDaemonPid = engine.daemonPidStart;
  const endAt = t0 + ARGS.minutes * 60000;
  for (let tick = 0; Date.now() < endAt && !finished; tick++) {
    const started = Date.now();
    if (inst.proc.exitCode !== null) throw new Error(`the app exited (code ${inst.proc.exitCode}) during the run`);
    const sample = await runSample(inst, ctx, tick, t0);
    if (Number.isInteger(sample.memory.daemonPid)) {
      if (Number.isInteger(lastSeenDaemonPid) && sample.memory.daemonPid !== lastSeenDaemonPid) {
        console.error(`[t+${Math.round(sample.tSec)}s] the daemon was respawned (pid ${lastSeenDaemonPid} -> ${sample.memory.daemonPid}); stall metrics stop at the last ping of the old one`);
      }
      lastSeenDaemonPid = sample.memory.daemonPid;
    }
    samples.push(sample);
    fs.appendFileSync(samplesPath, JSON.stringify(sample) + '\n');
    const kb = sample.keyboard.filter((k) => k.echoMs !== null).map((k) => k.echoMs);
    const pr = sample.probes.filter((p) => p.echoMs !== null).map((p) => p.echoMs);
    console.log(`[t+${Math.round(sample.tSec)}s] key max ${kb.length ? Math.max(...kb).toFixed(1) : '-'} ms (${sample.keyboard.length - kb.length} lost), ` +
      `probe max ${pr.length ? Math.max(...pr).toFixed(1) : '-'} ms (${sample.probes.length - pr.length} lost), stalls ${sample.stalls.length}, ` +
      `daemon ${((sample.memory.daemonRssBytes ?? NaN) / 1048576).toFixed(0)} MiB, electron ${((sample.memory.electronBytes ?? NaN) / 1048576).toFixed(0)} MiB` +
      `${sample.raf.throttled ? ', window throttled' : ''}`);
    const next = started + ARGS.sampleSec * 1000;
    if (next >= endAt) break;
    await sleep(Math.max(0, next - Date.now()));
  }
  await finish('completed', 0);
}

main().catch(async (e) => {
  // After Ctrl+C the teardown closes the page under a running sample; that
  // error is expected and the interrupted summary is already written.
  if (finished) return;
  console.error(`[fatal] ${e.stack || e.message}`);
  if (inst?.logTail?.length) console.error(`[fatal] last app output lines:\n${inst.logTail.slice(-15).join('\n')}`);
  await finish(`failed: ${e.message}`, 1);
});

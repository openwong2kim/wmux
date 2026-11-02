#!/usr/bin/env node
// First-run end-to-end scenario: a packaged wmux, a brand-new profile, and the
// path a new user takes to a working agent.
//
//   npm run e2e:first-run -- --app <packaged wmux executable> [--keep] [--artifacts <dir>]
//
// Package from a checkout whose path has no dot-directory in it (not one under
// `.claude/`, say): asar's unpack glob does not match dot paths, so such a build
// ships no app.asar.unpacked and its local terminals cannot start.
//
// What it proves, driven through the real UI over CDP (data-testid handles
// only, through scripts/control-wmux.mjs):
//   1. the "Welcome to wmux" wizard opens on a fresh profile;
//   2. the "Agent ready" card shows Claude Code ready, and it is the fake
//      (version 9.9.9), not a real install;
//   3. the wizard reads MCP as registered from the sandbox's ~/.claude.json
//      (seeded: a suffixed instance never writes agent configs) and installs
//      the hook bridge into the sandbox home;
//   4. the wizard is one screen whose one primary is "Open a folder…" (no
//      sample task, no bot task); the folder picker is native, so the run
//      takes the other way out: Skip closes it, and main reports the first
//      run shown but not completed (check() and the `.first-run` marker);
//   5. nothing opens by itself after it: no tour and no keyboard cheat sheet,
//      on the Fleet page (where the tour used to start) or on Workspaces;
//   6. the user's next step, run by hand in the workspace's pane: `claude`
//      with a prompt starts the fake agent there (its own log), the sidebar
//      lists it, and its status leaves `running` for a status at rest.
//
// The pane's claude is checked to be the fake before it is run (step 6), and
// step 2's 9.9.9 proves main resolves the fake too, not a real install.
//
// Isolation: a unique WMUX_DATA_SUFFIX, and a sandbox home (HOME, and on
// Windows USERPROFILE/APPDATA/LOCALAPPDATA) under the temp dir, so nothing is
// shared with the owner's real data. The repo's fake agents
// (scripts/fixtures/fake-agents) come first on PATH: no real account,
// network or token is used.
//
// Teardown runs on every exit path: `control-wmux stop --purge` (only while
// the recorded app is still alive), then a sweep of every process the run's
// app and daemon started, then the sandbox. Both roots are pinned as pid AND
// creation time (the app at spawn, the daemon when first tied to the app), a
// tree is expanded only from a root that still matches, and every kill
// re-checks pid and creation time, so a reused pid is never touched. Suffixed
// data outside the sandbox is deleted only if it appeared during the run (a
// suffix already in use is refused at preflight). A run that leaves a process
// or suffixed data behind fails. On failure the
// evidence is a screenshot, an ARIA snapshot, app.log, the daemon logs and the
// fake agents' log, under e2e/artifacts/first-run/<run>/.
//
// Exit code 0 on pass; 1 with one line `first-run e2e: FAIL at <step>: <why>`.
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SETTLED_AGENT_STATUSES,
  adoptDaemon,
  agentRanInPane,
  appEnvExtras,
  fakeAgentShims,
  INTERRUPT_EXIT_CODES,
  killSurvivors,
  mergeTrees,
  normalizeProcessRows,
  onceAsync,
  paneProbeCommand,
  paneProbeRefusal,
  parseRunArgs,
  removableLeftovers,
  runProcessTree,
  SANDBOX_PREFIX,
  sandboxBase,
  sandboxEnv,
  sandboxShellProfiles,
  seededClaudeJson,
  squirrelInstallRefusal,
  survivors,
  verdictLine,
  writesOutsideSandbox,
} from './lib/e2e-first-run-lib.mjs';
import {
  darwinEnvPart,
  envHasSuffix,
  launchdJobsFor,
  linkInTree,
  packagedCliBundle,
  parseKillResults,
  scrubEnv,
  windowsKillQuery,
} from './lib/control-wmux-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL = path.join(REPO_ROOT, 'scripts', 'control-wmux.mjs');
const FIXTURES = path.join(REPO_ROOT, 'scripts', 'fixtures', 'fake-agents');
const WIN = process.platform === 'win32';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StepError extends Error {}

// ---------------------------------------------------------------- setup
let args;
try {
  args = parseRunArgs(process.argv.slice(2));
} catch (err) {
  console.error(`first-run e2e: ${err.message}`);
  process.exit(2);
}
if (args.help || !args.app) {
  console.log('usage: npm run e2e:first-run -- --app <packaged wmux executable> [--keep] [--artifacts <dir>] [--suffix -e2e-x]');
  process.exit(args.help ? 0 : 2);
}

const t0 = Date.now();
const app = path.resolve(args.app);
const suffix = args.suffix || `-e2e-first-run-${crypto.randomBytes(3).toString('hex')}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const artifactsRoot = path.resolve(args.artifacts || process.env.WMUX_E2E_ARTIFACTS || path.join(REPO_ROOT, 'e2e', 'artifacts', 'first-run'));
const runDir = path.join(artifactsRoot, `${stamp}${suffix}`);
fs.mkdirSync(runDir, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(sandboxBase(), SANDBOX_PREFIX));
const fakeBin = path.join(sandbox, 'fake-bin');
const fakeAgentLog = path.join(runDir, 'fake-agents.jsonl');
/** What the user types into the pane after the wizard: the agent, with a prompt. */
const AGENT_LINE = 'claude "Say hello from the first-run e2e"';
const envFile = path.join(runDir, 'app-env.json');
// Electron's userData goes into the sandbox (wmux appends the suffix to it),
// never to %APPDATA% or ~/Library/Application Support.
const userDataDirArg = path.join(sandbox, 'electron-user-data');
const realHome = os.homedir();
const realAppData = process.env.APPDATA;
const realLocalAppData = process.env.LOCALAPPDATA;
// Suffixed paths outside the sandbox that already exist before anything runs.
// Preflight refuses to start over them; teardown never deletes them.
const preExistingOutside = outsideSandboxPaths().filter((p) => fs.existsSync(p));

const driverEnv = sandboxEnv(process.env, { home: sandbox, fakeBin });
// The driver keeps its state and evidence in this run's folder.
driverEnv.CONTROL_WMUX_DIR = runDir;

const result = {
  suffix,
  app,
  platform: process.platform,
  sandbox,
  runDir,
  steps: [],
  observed: {},
};

function log(msg) {
  process.stderr.write(`[first-run e2e +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);
}

// ---------------------------------------------------------------- driver calls
/** Run one control-wmux command; resolves its JSON. Never hangs past timeoutMs. */
function cw(cmdArgs, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CONTROL, ...cmdArgs], {
      env: driverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => {
      // Our own direct child, by the handle we spawned it with.
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(out); } catch { /* not JSON */ }
      if (!json) json = { ok: false, error: (err || out || `control-wmux ${cmdArgs[0]} exited ${code}`).trim().slice(0, 500) };
      resolve(json);
    });
  });
}

async function must(cmdArgs, opts) {
  const r = await cw(cmdArgs, opts);
  if (!r.ok) throw new StepError(r.error || `control-wmux ${cmdArgs.join(' ')} failed`);
  return r;
}

/** Read-only value from the main window. */
async function read(js) {
  const r = await cw(['eval', '--js', js], { timeoutMs: 30_000 });
  return r.ok ? r.value : undefined;
}

const exists = (testid) => read(`!!document.querySelector('[data-testid="${testid}"]')`);

/** The packaged wmux CLI, against this run's instance only (its suffix, the sandbox home). */
function wmuxCli(cliArgs, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [packagedCliBundle(app), ...cliArgs], {
      env: scrubEnv(driverEnv, suffix),
      timeout: timeoutMs,
      windowsHide: true,
    }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim().slice(0, 500) }));
  });
}

const readFakeAgentLog = () => (fs.existsSync(fakeAgentLog) ? fs.readFileSync(fakeAgentLog, 'utf8') : '');

async function step(name, fn) {
  const started = Date.now();
  log(`${name} …`);
  try {
    const detail = await fn();
    result.steps.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
    log(`${name} ok (${Date.now() - started} ms)`);
  } catch (err) {
    result.steps.push({ name, ok: false, ms: Date.now() - started, reason: err.message });
    err.step = name;
    throw err;
  }
}

// ---------------------------------------------------------------- processes
function listProcesses() {
  return new Promise((resolve) => {
    if (WIN) {
      const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 60_000 }, (err, stdout) => {
          if (err) return resolve(null);
          try { resolve(normalizeProcessRows(JSON.parse(stdout), 'win32')); } catch { resolve(null); }
        });
    } else {
      execFile('ps', ['-A', '-o', 'pid=,ppid=,lstart=,args='], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(normalizeProcessRows(stdout, process.platform));
      });
    }
  });
}

function readPid(file) {
  try {
    const n = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

const daemonPidFile = path.join(sandbox, `.wmux${suffix}`, 'daemon.pid');
let recordedTree = [];
/**
 * The two roots of everything this run started, each pinned once as pid AND
 * creation time ({ ProcessId, CreationDate }): the app as control-wmux
 * recorded it right after spawn, the daemon when it is first tied to the app
 * (adoptDaemon). Only these, while still the same process, are ever expanded.
 */
const identities = { app: null, daemon: null };

/** Pin the app's identity from control-wmux's state (written at spawn). */
function pinApp() {
  if (identities.app) return;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(runDir, '.run', 'state.json'), 'utf8'));
    if (Number.isInteger(state.pid) && state.pid > 0 && state.pidCreatedAt != null) {
      identities.app = { ProcessId: state.pid, CreationDate: state.pidCreatedAt, Name: 'app' };
    }
  } catch { /* not launched yet */ }
}

/** The environment of a same-user process as text, or '' (POSIX only). */
function processEnvText(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'linux') {
      fs.readFile(`/proc/${pid}/environ`, 'utf8', (err, text) => resolve(err ? '' : text));
    } else if (process.platform === 'darwin') {
      // `ps -E` prints the command line, then the environment: keep only the
      // environment, so an argument cannot pass for it.
      execFile('ps', ['-E', '-ww', '-p', String(pid), '-o', 'command='], { timeout: 15_000 }, (err, withEnv) => {
        if (err) return resolve('');
        execFile('ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 15_000 }, (err2, argsOnly) => {
          resolve(err2 ? '' : darwinEnvPart(withEnv, argsOnly));
        });
      });
    } else resolve('');
  });
}

/** Is the recorded app identity still the live process holding its pid? */
function appAliveIn(rows) {
  return !!identities.app && survivors([identities.app], rows).length === 1;
}

/** Add the app's and the daemon's current trees to the record. */
async function recordTree() {
  const rows = await listProcesses();
  if (!rows) return;
  pinApp();
  recordedTree = mergeTrees(recordedTree, runProcessTree(rows, [identities.app, identities.daemon]));
  if (!identities.daemon) {
    const daemonPid = readPid(daemonPidFile);
    const envOwned = !WIN && daemonPid ? envHasSuffix(await processEnvText(daemonPid), suffix) : false;
    const daemon = adoptDaemon({ daemonPid, rows, app: identities.app, recordedTree, envOwned });
    if (daemon) {
      identities.daemon = { ProcessId: daemon.ProcessId, CreationDate: daemon.CreationDate, Name: daemon.Name };
      recordedTree = mergeTrees(recordedTree, runProcessTree(rows, [identities.daemon]));
    }
  }
}

/** Windows: kill { pid, createdAt } targets through handles pinned to their creation time. */
function killWindows(targets) {
  const q = windowsKillQuery(targets);
  if (!q) return Promise.resolve({});
  return new Promise((resolve) => {
    execFile(q.file, q.args, { windowsHide: true, timeout: 60_000 }, (err, stdout) => resolve(err ? {} : parseKillResults(stdout)));
  });
}

function killPosix(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

// ---------------------------------------------------------------- evidence
async function saveFailureEvidence() {
  const saved = {};
  pinApp();
  if (identities.app) {
    const shot = await cw(['screenshot', '--as', 'failure'], { timeoutMs: 30_000 });
    saved.screenshot = shot.ok ? shot.path : `unavailable: ${shot.reason || shot.error}`;
    const snap = await cw(['snapshot', '--as', 'failure'], { timeoutMs: 30_000 });
    saved.ariaSnapshot = snap.ok ? snap.path : `unavailable: ${snap.error}`;
    const doctor = await cw(['doctor'], { timeoutMs: 60_000 });
    saved.doctor = doctor.evidenceDir ? path.join(doctor.evidenceDir, 'doctor.json') : `unavailable: ${doctor.error}`;
  }
  // The daemon's own logs live in the sandbox, which teardown deletes.
  const dataDir = path.join(sandbox, `.wmux${suffix}`);
  const keep = path.join(runDir, 'daemon-logs');
  try {
    for (const name of fs.readdirSync(dataDir)) {
      if (!/\.log(\.\d+)?$/.test(name)) continue;
      fs.mkdirSync(keep, { recursive: true });
      fs.copyFileSync(path.join(dataDir, name), path.join(keep, name));
      saved.daemonLogs = keep;
    }
  } catch { /* no data dir yet */ }
  return saved;
}

// ---------------------------------------------------------------- teardown
/** Suffixed paths outside the sandbox that this run must not leave behind. */
function outsideSandboxPaths() {
  const list = [
    path.join(realHome, `.wmux${suffix}`),
    path.join(realHome, `.wmux${suffix}-auth-token`),
    path.join(realHome, `.wmux${suffix}-tcp-port`),
    path.join(realHome, `.wmux${suffix}.sock`),
  ];
  if (WIN) {
    if (realAppData) list.push(path.join(realAppData, `wmux${suffix}`));
    if (realLocalAppData) list.push(path.join(realLocalAppData, `wmux${suffix}`));
  } else if (process.platform === 'darwin') {
    list.push(path.join(realHome, 'Library', 'Application Support', `wmux${suffix}`));
  } else {
    list.push(path.join(realHome, '.config', `wmux${suffix}`));
  }
  return list;
}

function suffixedPipes() {
  if (!WIN) return [];
  try {
    return fs.readdirSync('\\\\.\\pipe\\').filter((n) => n.includes(suffix));
  } catch {
    return [];
  }
}

async function teardown() {
  const report = { problems: [] };
  await recordTree();
  report.identities = { app: identities.app, daemon: identities.daemon };
  report.recordedProcesses = recordedTree.length;
  if (fs.existsSync(path.join(runDir, '.run', 'state.json'))) {
    // `stop` signals the app by pid. Only while the recorded app is still
    // that pid's process; otherwise straight to the identity-checked sweep.
    const rows = await listProcesses();
    if (rows && appAliveIn(rows)) {
      const stop = await cw(['stop', '--purge'], { timeoutMs: 90_000 });
      report.stop = { ok: stop.ok, steps: stop.steps, leftover: stop.leftover, error: stop.error };
    } else {
      report.stop = { skipped: rows ? 'the recorded app is no longer running (pid gone or reused)' : 'could not list processes' };
    }
  }
  if (!identities.app && fs.existsSync(path.join(runDir, '.run', 'state.json'))) {
    report.problems.push('the launched app has no recorded identity (pid + creation time); its processes could not be tracked');
  }
  if (identities.app && !identities.daemon) {
    report.problems.push(`the daemon was never tied to this run (pid file ${readPid(daemonPidFile) ?? 'missing'}); its processes could not be tracked`);
  }
  // Anything of ours still alive after the driver's stop: wait a moment for
  // ordinary exits, then kill by pid + creation time, and count it as a leak.
  let alive = [];
  for (let i = 0; i < 10; i++) {
    const rows = await listProcesses();
    if (!rows) {
      report.problems.push('could not list processes to check for leftovers');
      break;
    }
    alive = survivors(recordedTree, rows);
    if (alive.length === 0) break;
    await sleep(1000);
  }
  if (alive.length > 0) {
    report.leakedProcesses = alive.map((r) => ({ pid: r.ProcessId, name: r.Name, cmd: (r.CommandLine || '').slice(0, 200) }));
    report.problems.push(`teardown left ${alive.length} process(es): ${alive.map((r) => `${r.Name}#${r.ProcessId}`).join(', ')}`);
    // Same pid AND creation time, checked right before each kill (on Windows
    // through a handle that pins the process it checked).
    report.killResults = await killSurvivors(alive, { listRows: listProcesses, killPosix, killWindows });
    const rows = await listProcesses();
    const still = rows ? survivors(alive, rows) : alive;
    report.killedAfterStop = alive.length - still.length;
    report.killed = alive.filter((r) => !still.includes(r)).map((r) => ({ pid: r.ProcessId, createdAt: r.CreationDate, name: r.Name }));
    if (still.length) report.problems.push(`could not kill ${still.map((r) => `${r.Name}#${r.ProcessId}`).join(', ')}`);
  }
  // macOS: a launchd job labelled for this run's suffix that outlived the
  // sweep. A finished one is booted out; a running one is a leak.
  if (process.platform === 'darwin') {
    const list = await new Promise((resolve) => {
      execFile('launchctl', ['list'], { timeout: 15_000 }, (err, stdout) => resolve(err ? '' : stdout));
    });
    for (const job of launchdJobsFor(list, suffix)) {
      if (job.pid !== null) {
        report.problems.push(`launchd job ${job.label} still running (pid ${job.pid}), left in place`);
        continue;
      }
      await new Promise((resolve) => {
        execFile('launchctl', ['bootout', `gui/${process.getuid()}/${job.label}`], { timeout: 15_000 }, () => resolve());
      });
      (report.launchdBootedOut ??= []).push(job.label);
    }
  }
  report.processesLeft = 0;
  {
    const rows = await listProcesses();
    report.processesLeft = rows ? survivors(recordedTree, rows).length : null;
  }

  // Data: the sandbox goes entirely; nothing suffixed may exist outside it.
  // Only what appeared during this run is deleted: a path that existed at
  // preflight is someone else's, whatever its name.
  const outside = removableLeftovers(outsideSandboxPaths().filter((p) => fs.existsSync(p)), preExistingOutside);
  if (outside.length) {
    report.problems.push(`suffixed data outside the sandbox: ${outside.join(', ')}`);
    for (const p of outside) {
      // A symlink or junction is never followed: its target is not ours.
      const link = linkInTree(p);
      if (link) {
        report.problems.push(`left in place, holds a symlink or junction: ${link}`);
        continue;
      }
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* reported above */ }
    }
  }
  const pipes = suffixedPipes();
  if (pipes.length) report.problems.push(`named pipes still open: ${pipes.join(', ')}`);
  if (args.keep) {
    report.sandboxKept = sandbox;
  } else {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      report.problems.push(`sandbox not removed: ${err.message}`);
    }
    report.sandboxRemoved = !fs.existsSync(sandbox);
  }
  report.suffixedDataLeft = removableLeftovers(outsideSandboxPaths().filter((p) => fs.existsSync(p)), preExistingOutside);
  // Agent configs and the MCP bundle are not per-suffix: a write to them
  // outside the sandbox would have touched the owner's real setup.
  if (result.evidenceDir) {
    let appLog = '';
    try { appLog = fs.readFileSync(path.join(result.evidenceDir, 'app.log'), 'utf8'); } catch { /* no log */ }
    const escaped = writesOutsideSandbox(appLog, sandbox);
    if (escaped.length) report.problems.push(`wrote outside the sandbox: ${escaped.join(' | ')}`);
  }
  return report;
}

// ---------------------------------------------------------------- scenario
async function scenario() {
  await step('preflight', async () => {
    if (!fs.existsSync(app)) throw new StepError(`app executable not found: ${app}`);
    // Through junctions too: the real location decides.
    const installed = squirrelInstallRefusal(app, realLocalAppData) || squirrelInstallRefusal(fs.realpathSync.native(app), realLocalAppData);
    if (installed) throw new StepError(installed);
    // The suffix must be new: data under it outside the sandbox, or a pipe
    // (which no file check sees), belongs to something this run did not start.
    const pipes = suffixedPipes();
    if (preExistingOutside.length || pipes.length) {
      throw new StepError(`suffix ${suffix} is already in use (${[...preExistingOutside, ...pipes.map((n) => `pipe ${n}`)].join(', ')}); pick another --suffix or none`);
    }
    fs.mkdirSync(fakeBin, { recursive: true });
    for (const f of fakeAgentShims({ node: process.execPath, fixturesDir: FIXTURES })) {
      fs.writeFileSync(path.join(fakeBin, f.name), f.content, f.mode ? { mode: f.mode } : undefined);
    }
    // MCP registration is the one first-run step a suffixed instance cannot
    // do (agent configs are not per-suffix), so the profile starts with it.
    fs.writeFileSync(path.join(sandbox, '.claude.json'), JSON.stringify(seededClaudeJson(sandbox), null, 2));
    for (const f of sandboxShellProfiles(fakeBin)) fs.writeFileSync(path.join(sandbox, f.name), f.content);
    // The wizard installs Claude's hooks into the sandbox's ~/.claude, and
    // the fake Claude fires them from there.
    fs.writeFileSync(envFile, JSON.stringify(appEnvExtras({
      fakeAgentLog,
      claudeHooksFile: path.join(sandbox, '.claude', 'settings.json'),
    }), null, 2));
    if (WIN) {
      fs.mkdirSync(driverEnv.APPDATA, { recursive: true });
      fs.mkdirSync(driverEnv.LOCALAPPDATA, { recursive: true });
    }
    return { fakeBin, sandbox };
  });

  await step('launch', async () => {
    const r = await must(['launch', '--app', app, '--suffix', suffix, '--env-file', envFile, '--user-data-dir', userDataDirArg, '--timeout', '120000'], { timeoutMs: 150_000 });
    result.observed.cdpPort = r.cdpPort;
    // The userData the app logged at boot; launch labels a fallback to its
    // prediction 'predicted'.
    result.observed.userData = { path: r.userData, source: r.userDataSource };
    result.evidenceDir = r.evidenceDir;
    await recordTree();
    return { pid: r.pid, cdpPort: r.cdpPort };
  });

  await step('wizard opens', async () => {
    await must(['wait-settle', '--testid', 'first-run-wizard', '--quiet', '0', '--timeout', '60000'], { timeoutMs: 90_000 });
    // By now the app has started its daemon: tie it to the run while the app
    // is alive, so a daemon that outlives an early app exit is still ours.
    await recordTree();
  });

  await step('Claude card ready', async () => {
    const sel = '[data-testid="first-run-agent-claude"][data-status="ok"]';
    const r = await cw(['wait-settle', '--selector', sel, '--quiet', '0', '--timeout', '90000'], { timeoutMs: 120_000 });
    const card = await read(`(() => { const el = document.querySelector('[data-testid="first-run-agent-claude"]'); return el ? { status: el.dataset.status, text: el.textContent } : null; })()`);
    result.observed.claudeCard = card;
    const codex = await read(`(() => { const el = document.querySelector('[data-testid="first-run-agent-codex"]'); return el ? { status: el.dataset.status, text: el.textContent } : null; })()`);
    result.observed.codexCard = codex;
    if (!r.ok) throw new StepError(`the Claude Code card never showed ready (card: ${card ? `${card.status} "${card.text}"` : 'missing'})`);
    // The fakes report 9.9.9; any other version is a real install on PATH.
    if (!/9\.9\.9/.test(card?.text ?? '')) throw new StepError(`the ready Claude Code is not the fake (card says "${card?.text}")`);
    return { claude: card, codex };
  });

  await step('MCP registered', async () => {
    // Never click Register: under a suffix it writes nothing by design. The
    // row must read the sandbox's seeded ~/.claude.json as registered.
    if (await exists('first-run-wizard-register')) {
      throw new StepError('the wizard shows MCP as not registered although the sandbox ~/.claude.json has the wmux entry (did it read another home?)');
    }
  });

  await step('hooks installed', async () => {
    if (await exists('first-run-wizard-hooks-install')) {
      await must(['click', '--testid', 'first-run-wizard-hooks-install']);
      const r = await cw(['wait-settle', '--testid', 'first-run-wizard-hooks-installed', '--quiet', '0', '--timeout', '30000'], { timeoutMs: 60_000 });
      if (!r.ok) {
        const err = await read(`document.querySelector('[data-testid="first-run-wizard-hooks-error"]')?.textContent ?? null`);
        throw new StepError(`hook install did not finish${err ? `: ${err}` : ''}`);
      }
      return { clicked: true };
    }
    return { clicked: false, installed: await exists('first-run-wizard-hooks-installed') };
  });

  await step('wizard offers Open a folder', async () => {
    const r = await cw(['wait-settle', '--testid', 'first-run-wizard-open-folder', '--quiet', '0', '--timeout', '30000'], { timeoutMs: 60_000 });
    const seen = await read(`(() => {
      const dialog = document.querySelector('[data-testid="first-run-wizard"]');
      const q = (id) => document.querySelector('[data-testid="' + id + '"]');
      const open = q('first-run-wizard-open-folder');
      return {
        wizard: !!dialog,
        primaries: dialog ? [...dialog.querySelectorAll('.ui-btn-primary')].map((b) => b.dataset.testid ?? b.textContent) : [],
        openFolder: open ? { text: open.textContent, disabled: open.disabled } : null,
        removed: ['first-run-wizard-try', 'first-run-first-task', 'first-run-folder-row', 'first-run-wizard-statusline-offer'].filter((id) => q(id)),
      };
    })()`);
    result.observed.wizardActions = seen;
    if (!r.ok || !seen?.openFolder) throw new StepError(`no "Open a folder…" button (first-run-wizard-open-folder) in the wizard${seen?.wizard === false ? '; the wizard closed' : ''}`);
    if (seen.openFolder.disabled) throw new StepError('"Open a folder…" is disabled');
    // Agent ready, MCP registered, hooks installed: nothing else unblocks first.
    if (seen.primaries.length !== 1 || seen.primaries[0] !== 'first-run-wizard-open-folder') {
      throw new StepError(`the wizard's one primary should be "Open a folder…", but the primaries are ${JSON.stringify(seen.primaries)}`);
    }
    if (seen.removed.length) throw new StepError(`the one-screen wizard still shows ${seen.removed.join(', ')}`);
    return seen;
  });

  await step('Skip marks the first run shown, not completed', async () => {
    await must(['click', '--testid', 'first-run-wizard-skip']);
    const r = await cw(['wait-settle', '--testid', 'first-run-wizard', '--state', 'hidden', '--quiet', '0', '--timeout', '20000'], { timeoutMs: 45_000 });
    if (!r.ok) throw new StepError('the wizard stayed open after Skip');
    // What main reports now (the same call a reopened wizard and Settings make).
    const check = await read(`window.electronAPI.firstRun.check().then((c) => ({ shown: c.shown, completedAt: c.completedAt ?? null }), (e) => ({ error: String(e) }))`);
    result.observed.afterSkip = check;
    if (!check || check.error) throw new StepError(`firstRun.check() failed after Skip: ${check?.error ?? 'no answer'}`);
    if (check.shown !== true) throw new StepError('after Skip, main does not report the first run as shown: the wizard would open again on the next launch');
    if (check.completedAt !== null) throw new StepError(`after Skip, main reports the first run completed on ${check.completedAt}`);
    // The marker itself, where the app logged its userData.
    const marker = result.observed.userData?.path ? path.join(result.observed.userData.path, '.first-run') : null;
    if (marker && fs.existsSync(marker)) {
      const body = fs.readFileSync(marker, 'utf8').trim();
      if (!body.startsWith('skipped ')) throw new StepError(`the .first-run marker reads "${body.slice(0, 80)}", not a skip`);
      return { check, marker: body };
    }
    return { check, marker: `not found where expected (${marker ?? 'no userData path'}; informational)` };
  });

  await step('nothing opens by itself', async () => {
    // The tour used to start on the first visit to Fleet, and the cheat sheet
    // after it: visit Fleet, then Workspaces, and watch for either.
    const watch = async (page) => {
      await must(['click', '--selector', `[data-sidebar-nav="${page}"]`]);
      const until = Date.now() + 8_000;
      while (Date.now() < until) {
        const open = await read(`['onboarding-overlay', 'keyboard-cheat-sheet', 'first-run-wizard'].filter((id) => document.querySelector('[data-testid="' + id + '"]'))`);
        if (open?.length) throw new StepError(`${open.join(', ')} opened by itself on the ${page} page after the first run`);
        await sleep(500);
      }
    };
    await watch('fleet');
    await watch('home');
    return { watched: ['fleet', 'home'] };
  });

  await agentInPane();

  await step('evidence', async () => {
    const snap = await cw(['snapshot', '--as', 'final'], { timeoutMs: 30_000 });
    const shot = await cw(['screenshot', '--as', 'final'], { timeoutMs: 30_000 });
    return { ariaSnapshot: snap.path ?? snap.error, screenshot: shot.path ?? shot.reason ?? shot.error };
  });
}

/** The user's next step after the wizard: the agent, started by hand in the
 *  workspace's pane, really runs there and the sidebar follows it. */
async function agentInPane() {
  await step('pane runs the fake claude', async () => {
    // Before `claude` is typed into a pane, prove that the pane's shell
    // resolves it to the fake: a login shell's profile can put a real install
    // first, which would spend the owner's account. Asked in the active pane,
    // through the run's own CLI.
    const probe = path.join(sandbox, 'claude-probe.txt');
    const deadline = Date.now() + 30_000;
    let sent = await wmuxCli(['send', '--active', '--submit', paneProbeCommand(probe)]);
    while (!sent.ok && Date.now() < deadline) {
      await sleep(1000);
      sent = await wmuxCli(['send', '--active', '--submit', paneProbeCommand(probe)]);
    }
    if (!sent.ok) throw new StepError(`could not ask a pane which claude it runs: ${sent.out}`);
    while (!fs.existsSync(probe) && Date.now() < deadline) await sleep(250);
    await sleep(250);
    if (!fs.existsSync(probe)) throw new StepError('the pane never answered which claude it runs; refusing to start the agent');
    const raw = fs.readFileSync(probe);
    const refusal = paneProbeRefusal(raw, fakeBin);
    result.observed.paneClaude = raw.toString('utf8').replace(/^﻿/, '').trim();
    if (refusal) throw new StepError(`refusing to start the agent: ${refusal}`);
    return { resolved: result.observed.paneClaude };
  });

  await step('agent ran in the pane', async () => {
    const sent = await wmuxCli(['send', '--active', '--submit', AGENT_LINE]);
    if (!sent.ok) throw new StepError(`could not type the agent's line into the pane: ${sent.out}`);
    const deadline = Date.now() + 30_000;
    let seen = { started: false, prompted: false };
    while (Date.now() < deadline) {
      seen = agentRanInPane(readFakeAgentLog());
      if (seen.started && seen.prompted) return seen;
      await sleep(500);
    }
    throw new StepError(seen.started
      ? 'the fake Claude started in a pane but never received its prompt'
      : 'no fake Claude ever started in a terminal (the pane ran something else)');
  });

  await step('sidebar shows the agent', async () => {
    const sel = '[data-testid="sidebar-agent-row"][data-agent-slug="claude"]';
    const r = await cw(['wait-settle', '--selector', sel, '--quiet', '0', '--timeout', '60000'], { timeoutMs: 90_000 });
    if (!r.ok) {
      const rows = await read(`[...document.querySelectorAll('[data-testid="sidebar-agent-row"]')].map((el) => el.dataset.agentSlug + ':' + el.dataset.agentStatus)`);
      throw new StepError(`no Claude Code row in the sidebar (agent rows: ${JSON.stringify(rows ?? [])})`);
    }
  });

  await step('agent status settles', async () => {
    const seen = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = await read(`document.querySelector('[data-testid="sidebar-agent-row"][data-agent-slug="claude"]')?.dataset.agentStatus ?? null`);
      if (seen[seen.length - 1] !== status) seen.push(status);
      if (SETTLED_AGENT_STATUSES.has(status)) {
        result.observed.sidebarStatuses = seen;
        return { statuses: seen };
      }
      if (status === 'error' || status === 'exited') break;
      await sleep(1000);
    }
    result.observed.sidebarStatuses = seen;
    throw new StepError(`the Claude Code row never reached a status at rest (seen: ${seen.join(' -> ') || 'none'})`);
  });
}

// Ctrl+C or a SIGTERM still tears down: otherwise the app, its daemon, the
// sandbox and the suffixed data stay behind. The main flow and the handlers
// share one teardown; a second Ctrl+C (the handler is `once`) exits at once.
const runTeardown = onceAsync(teardown);
for (const [signal, exitCode] of Object.entries(INTERRUPT_EXIT_CODES)) {
  process.once(signal, () => {
    log(`${signal}: tearing down before exit (press Ctrl+C again to exit without it)`);
    runTeardown()
      .then((report) => report, (err) => ({ problems: [`teardown threw: ${err?.stack || err}`] }))
      .then((report) => {
        result.teardown = report;
        result.ok = false;
        result.failure = { step: 'interrupted', reason: `${signal} during the run; teardown ${report?.problems?.length ? `problems: ${report.problems.join('; ')}` : 'clean'}` };
        result.seconds = (Date.now() - t0) / 1000;
        try { fs.writeFileSync(path.join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`); } catch { /* best effort */ }
        console.log(verdictLine({ ok: false, step: result.failure.step, reason: result.failure.reason, seconds: result.seconds }));
      })
      .finally(() => process.exit(exitCode));
  });
}

let failure = null;
try {
  await scenario();
} catch (err) {
  failure = { step: err.step || 'scenario', reason: err instanceof StepError ? err.message : String(err?.stack || err) };
  try {
    result.evidence = await saveFailureEvidence();
  } catch (e) {
    result.evidence = { error: String(e) };
  }
}

let teardownReport;
try {
  teardownReport = await runTeardown();
} catch (err) {
  teardownReport = { problems: [`teardown threw: ${err?.stack || err}`] };
}
result.teardown = teardownReport;
if (!failure && teardownReport.problems.length) {
  failure = { step: 'teardown', reason: teardownReport.problems.join('; ') };
}
result.ok = !failure;
result.failure = failure;
result.seconds = (Date.now() - t0) / 1000;
fs.writeFileSync(path.join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
log(`result: ${path.join(runDir, 'result.json')}`);
console.log(verdictLine({ ok: !failure, step: failure?.step, reason: failure?.reason, seconds: result.seconds }));
process.exitCode = failure ? 1 : 0;

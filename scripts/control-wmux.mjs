#!/usr/bin/env node
// control-wmux: launch an ISOLATED wmux, drive its UI over CDP, capture
// evidence, and tear down only what it started. Driver for the project skill
// .claude/skills/verify-wmux/SKILL.md (read that first).
//
// Every command prints one JSON object on stdout and exits 0 on success, 1 on
// failure ({ ok:false, error }). Commands are stateless processes; the launched
// instance is recorded in .claude/skills/verify-wmux/.run/state.json and every
// command except `launch` refuses to run without it, so the driver can only
// ever touch the instance it launched itself — never the owner's real wmux.
//
//   node scripts/control-wmux.mjs launch [--app <executable>] [--suffix -verify-x] [--timeout ms] [--env-file vars.json] [--user-data-dir dir] [--fake-audio clip.wav]
//   node scripts/control-wmux.mjs doctor
//   node scripts/control-wmux.mjs snapshot [--testid ID | --selector CSS | --role R --name N] [--as label]
//   node scripts/control-wmux.mjs screenshot [--as label]
//   node scripts/control-wmux.mjs click (--testid ID | --label ARIA | --role R --name N | --text T) [--nth N]
//   node scripts/control-wmux.mjs hover (same targets as click)   (reveals hover-only controls)
//   node scripts/control-wmux.mjs press --key Meta+Comma [--testid ID to focus first]
//   node scripts/control-wmux.mjs type --text "echo hi" [--label "Terminal input" to focus first]
//   node scripts/control-wmux.mjs select --label "Terminal engine" --value rust
//   node scripts/control-wmux.mjs eval --js "<read-only expression>"   (alias: inspect)
//   node scripts/control-wmux.mjs wait-settle [--testid ID|--label ARIA|--selector CSS] [--state visible|hidden] [--quiet ms] [--timeout ms]
//   node scripts/control-wmux.mjs console [--errors] [--tail N]
//   node scripts/control-wmux.mjs stop [--purge]
//   node scripts/control-wmux.mjs restart  (app only; keep its daemon and sessions)
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appIdentityHolds,
  claimOwnedBy,
  daemonIdentityHolds,
  darwinEnvPart,
  electronUserDataDir,
  launchAppArgs,
  launchdJobsFor,
  launchEnv,
  launchUserDataDirArg,
  ownedCdpPort,
  packagedCliBundle,
  parseCdpLog,
  parseConsoleLine,
  parseDaemonStatusPid,
  parseKillResults,
  parseProcessStart,
  parseUserDataLog,
  pathPresent,
  processListQuery,
  processStartQuery,
  purgeSuffixedData,
  releaseRecordedClaim,
  resolveUserDataRecord,
  scrubEnv,
  signalProcess,
  stopRecordedApp,
  suffixRefusal,
  suffixedPaths,
  windowsKillQuery,
} from './lib/control-wmux-lib.mjs';
import { normalizeProcessRows, runProcessTree, survivors } from './lib/e2e-first-run-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(REPO_ROOT, '.claude', 'skills', 'verify-wmux');
// CONTROL_WMUX_DIR moves the run state and evidence out of the skill folder,
// so a harness (scripts/e2e-first-run.mjs) keeps its own instance record and
// artifacts and never collides with a verify-wmux session in the same checkout.
const CONTROL_DIR = process.env.CONTROL_WMUX_DIR ? path.resolve(process.env.CONTROL_WMUX_DIR) : SKILL_DIR;
const RUN_DIR = path.join(CONTROL_DIR, '.run');
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const EVIDENCE_ROOT = path.join(CONTROL_DIR, 'evidence');
const CLAIM_DIR = path.join(os.homedir(), '.cache', 'wmux-cdp');
const DEFAULT_APP = '/Applications/wmux.app/Contents/MacOS/wmux';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return { cmd, opts };
}

function print(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

class DriverError extends Error {}
const fail = (msg) => { throw new DriverError(msg); };

// ---------------------------------------------------------------- state
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** A live process's creation time (epoch ms), or null when it is gone or unreadable. */
function processStartedAt(pid) {
  const q = processStartQuery(pid);
  if (!q) return null;
  const r = spawnSync(q.file, q.args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return r.status === 0 ? parseProcessStart(r.stdout, pid) : null;
}

/** Every process as identity rows ({ ProcessId, ParentProcessId, CreationDate, … }), or null. */
function listProcessRows() {
  const q = processListQuery();
  const r = spawnSync(q.file, q.args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (r.status !== 0) return null;
  try {
    return normalizeProcessRows(process.platform === 'win32' ? JSON.parse(r.stdout) : r.stdout);
  } catch {
    return null;
  }
}

/** The recorded processes still alive after up to `ms`; [] once all are gone. */
async function waitTreeGone(tree, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const rows = listProcessRows();
    const left = rows ? survivors(tree, rows) : tree;
    if (left.length === 0 || Date.now() >= end) return left;
    await sleep(500);
  }
}

/**
 * Is the app this state recorded (pid + creation time, taken right after
 * spawn) still the process holding that pid? The only test that lets `stop`
 * or `restart` signal it: a pid alone may have been reused by anything.
 */
function recordedAppAlive(state) {
  return appIdentityHolds(state, { pidAlive, startedAt: processStartedAt });
}

/**
 * Windows: terminate { pid, createdAt } targets through handles pinned to
 * their recorded creation time (windowsKillQuery). Returns { [pid]: result }.
 */
function killByIdentity(targets) {
  const q = windowsKillQuery(targets);
  if (!q) return {};
  const r = spawnSync(q.file, q.args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return r.status === 0 ? parseKillResults(r.stdout) : {};
}

function readPidFile(file) {
  try {
    const n = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** The recorded instance, or a refusal. Re-checks the suffix every time. */
function requireState({ alive = true } = {}) {
  const state = readState();
  if (!state) fail('no instance launched by control-wmux in this checkout; run `launch` first (the driver never attaches to an instance it did not start)');
  const refusal = suffixRefusal(state.suffix);
  if (refusal) fail(refusal);
  if (alive && !pidAlive(state.pid)) fail(`launched wmux (pid ${state.pid}) is not running; run \`stop\` then \`launch\``);
  return state;
}

function evidenceDir(state) {
  const dir = path.join(EVIDENCE_ROOT, state.runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function nextArtifact(state, name, ext) {
  const dir = evidenceDir(state);
  const n = fs.readdirSync(dir).filter((f) => /^\d{3}-/.test(f)).length + 1;
  const safe = String(name || ext).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);
  return path.join(dir, `${String(n).padStart(3, '0')}-${safe}.${ext}`);
}

function timeline(state, entry) {
  try {
    fs.appendFileSync(path.join(evidenceDir(state), 'timeline.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* evidence log is best-effort */ }
}

// ---------------------------------------------------------------- CDP
function cdpDisabledReason(suffix, env = process.env) {
  if (env.WMUX_DISABLE_CDP === 'true') return 'WMUX_DISABLE_CDP=true in the launching environment';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), `.wmux${suffix}`, 'config.json'), 'utf8'));
    if (cfg?.browser?.cdp?.enabled === false) return `~/.wmux${suffix}/config.json has browser.cdp.enabled=false`;
  } catch { /* no config = default (enabled) */ }
  return null;
}

async function httpJson(url, timeoutMs = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Is `t` the wmux main window? Not a webview, devtools, or the hidden
 * quick-launch window (launcher.html), which is also a `page` target.
 */
function isMainWindowTarget(t) {
  if (t?.type !== 'page' || !/^(file:|https?:\/\/localhost)/.test(t.url || '')) return false;
  let pathname;
  try { pathname = new URL(t.url).pathname; } catch { return false; }
  return pathname.endsWith('/index.html') || pathname === '/';
}

/** Verify the recorded port still belongs to our pid before every attach. */
function assertPortOwned(state) {
  if (!state.cdpPort) fail('no CDP port recorded for this instance (CDP disabled or never came up); see `doctor`');
  if (!claimOwnedBy(CLAIM_DIR, state.cdpPort, state.pid)) {
    fail(`CDP port ${state.cdpPort} is no longer claimed by pid ${state.pid}; refusing to attach (it may belong to another wmux)`);
  }
}

async function loadPlaywright() {
  try {
    return (await import('playwright-core')).chromium;
  } catch {
    fail('playwright-core is not installed; run `npm ci` in this checkout (it is a regular dependency)');
  }
  return null;
}

/** Connect, find the main window page, run fn(page), always disconnect. */
async function withPage(state, fn) {
  assertPortOwned(state);
  const chromium = await loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.cdpPort}`, { timeout: 10_000 });
  try {
    let page = null;
    for (let i = 0; i < 20 && !page; i++) {
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
          if (isMainWindowTarget({ type: 'page', url: p.url() })) { page = p; break; }
        }
        if (page) break;
      }
      if (!page) await sleep(250);
    }
    if (!page) fail('main window page not found over CDP');
    return await fn(page);
  } finally {
    // Disconnect only; for a connectOverCDP browser close() never kills the app.
    await browser.close().catch(() => undefined);
  }
}

function locatorFor(page, opts) {
  let loc;
  if (opts.testid) loc = page.getByTestId(String(opts.testid));
  else if (opts.label) loc = page.getByLabel(String(opts.label), { exact: true }).or(page.locator(`[aria-label=${JSON.stringify(String(opts.label))}]`));
  else if (opts.role) loc = page.getByRole(String(opts.role), opts.name ? { name: String(opts.name), exact: true } : {});
  else if (opts.text) loc = page.getByText(String(opts.text), { exact: true });
  else if (opts.selector) loc = page.locator(String(opts.selector));
  else return null;
  if (opts.nth !== undefined) loc = loc.nth(Number(opts.nth));
  return loc;
}

/** First line of a Playwright error plus the "intercepts pointer events" culprit, ANSI-free. */
function playwrightReason(err) {
  // eslint-disable-next-line no-control-regex
  const lines = String(err?.message || err).replace(/\u001b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim());
  const blocker = lines.find((l) => /intercepts pointer events/.test(l));
  return [lines[0], blocker].filter(Boolean).join(' | ').slice(0, 400);
}

function describeTarget(opts) {
  for (const k of ['testid', 'label', 'role', 'text', 'selector']) if (opts[k]) return `${k}=${opts[k]}${opts.name ? ` name=${opts.name}` : ''}`;
  return '(none)';
}

/** Page.captureScreenshot with a timeout; a locked/occluded window may never paint. */
async function cdpScreenshot(page, timeoutMs = 8000) {
  const session = await page.context().newCDPSession(page);
  try {
    for (const fromSurface of [true, false]) {
      const shot = await Promise.race([
        session.send('Page.captureScreenshot', { format: 'png', fromSurface }),
        sleep(timeoutMs).then(() => null),
      ]).catch(() => null);
      if (shot?.data) return { data: Buffer.from(shot.data, 'base64'), fromSurface };
    }
    return null;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- commands
async function cmdLaunch(opts, reconnectState = null) {
  const existing = readState();
  // A state without a recorded creation time (older driver) stays conservative.
  if (existing && (existing.pidCreatedAt == null ? pidAlive(existing.pid) : recordedAppAlive(existing))) {
    fail(`an instance launched by this driver is still running (pid ${existing.pid}, suffix ${existing.suffix}); run \`stop\` first`);
  }
  const suffix = String(opts.suffix || `-verify-${crypto.randomBytes(3).toString('hex')}`);
  const refusal = suffixRefusal(suffix);
  if (refusal) fail(refusal);
  const app = path.resolve(String(opts.app || DEFAULT_APP));
  if (!fs.existsSync(app)) fail(`app executable not found: ${app} (pass --app <path to the wmux executable>)`);

  const home = os.homedir();
  const sock = path.join(home, `.wmux${suffix}.sock`);
  const daemonPid = readPidFile(path.join(home, `.wmux${suffix}`, 'daemon.pid'));
  const ownedReconnect = reconnectState && reconnectState.suffix === suffix && reconnectState.app === app
    && daemonPid && daemonOwned(daemonPid, app, suffix).ok;
  if ((fs.existsSync(sock) || pidAlive(daemonPid)) && !ownedReconnect) {
    fail(`suffix ${suffix} already has a live socket or daemon (${sock}); pick another --suffix — refusing to share someone else's instance`);
  }
  const preExisting = reconnectState?.preExisting ?? suffixedPaths(home, suffix).filter((p) => fs.existsSync(p));

  // `restart` relaunches with the variables the first launch was given.
  const envFile = opts['env-file'] ? path.resolve(String(opts['env-file'])) : reconnectState?.envFile ?? null;
  let extraEnv = {};
  if (envFile) {
    try {
      extraEnv = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    } catch (err) {
      fail(`--env-file ${envFile} is not readable JSON: ${err.message}`);
    }
  }
  const built = launchEnv(process.env, suffix, extraEnv);
  if (built.refusal) fail(built.refusal);
  const env = built.env;

  // Electron's userData, snapshotted like the paths above so `stop --purge`
  // removes it only if this run created it. A relaunch keeps the first
  // launch's record; a relaunch of a state without one stays unknown.
  const userDataDirArg = launchUserDataDirArg({
    explicit: opts['user-data-dir'] ? path.resolve(String(opts['user-data-dir'])) : null,
    previous: reconnectState ? reconnectState.userDataDirArg ?? null : undefined,
    home,
    suffix,
  });
  const userDataPath = electronUserDataDir({ suffix, env, home, userDataDirArg });
  const userData = reconnectState
    ? reconnectState.userData ?? null
    : { path: userDataPath, existedBeforeLaunch: pathPresent(userDataPath) };

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${suffix}`;
  const state = { runId, suffix, app, pid: null, cdpPort: null, startedAt: new Date().toISOString(), preExisting, userData, userDataDirArg };
  const dir = evidenceDir(state);
  const logPath = path.join(dir, 'app.log');
  const logFd = fs.openSync(logPath, 'a');
  // Renderer console -> stderr -> app.log, so `console` can read history.
  env.ELECTRON_ENABLE_LOGGING = '1';
  const fakeAudio = opts['fake-audio'] ? path.resolve(String(opts['fake-audio'])) : reconnectState?.fakeAudio ?? null;
  if (fakeAudio && !fs.existsSync(fakeAudio)) fail(`--fake-audio ${fakeAudio} does not exist`);
  const child = spawn(app, launchAppArgs({ userDataDirArg, fakeAudio }), { env, detached: true, stdio: ['ignore', logFd, logFd] });
  if (fakeAudio) state.fakeAudio = fakeAudio;
  fs.closeSync(logFd);
  state.pid = child.pid;
  // The app's identity is its pid AND its creation time, read while we still
  // hold the spawn handle: `stop` and `restart` signal state.pid only while
  // both still match. Without it a reused pid would be indistinguishable.
  state.pidCreatedAt = processStartedAt(child.pid);
  if (state.pidCreatedAt == null) {
    // Through our own handle, which cannot point at a reused pid.
    child.kill();
    fail(`could not read the launched app's creation time (pid ${child.pid}); stopped it through its spawn handle. See ${logPath}`);
  }
  child.unref();
  state.logPath = logPath;
  if (envFile) state.envFile = envFile;
  writeState(state);
  timeline(state, { cmd: 'launch', app, suffix, pid: child.pid });

  const disabled = cdpDisabledReason(suffix, env);
  const deadline = Date.now() + Number(opts.timeout || 60_000);
  let ready = false;
  let lastErr = 'waiting for CDP';
  while (Date.now() < deadline) {
    if (!pidAlive(state.pid)) fail(`wmux exited during launch; see ${logPath}`);
    const log = parseCdpLog(fs.readFileSync(logPath, 'utf8'));
    if (log.disabled || disabled) {
      lastErr = `CDP disabled (${disabled || 'app log says so'}); the UI cannot be driven`;
      break;
    }
    // Only the port the app logged; until that line lands, keep polling.
    state.cdpPort = ownedCdpPort(CLAIM_DIR, state.pid, log.requested);
    if (!log.requested) lastErr = 'waiting for the app to log "CDP requested on port N"';
    else if (!state.cdpPort) lastErr = `the claim for logged port ${log.requested} does not name pid ${state.pid} (yet)`;
    if (state.cdpPort) {
      const targets = await httpJson(`http://127.0.0.1:${state.cdpPort}/json/list`);
      if (Array.isArray(targets) && targets.some(isMainWindowTarget)) {
        try {
          const hasRoot = await withPage(state, (page) => page.evaluate(() => !!document.querySelector('#root > *')));
          if (hasRoot) { ready = true; break; }
          lastErr = 'main window has not rendered #root yet';
        } catch (err) {
          lastErr = err.message;
        }
      } else lastErr = `CDP on ${state.cdpPort} has no main window target yet`;
    }
    await sleep(500);
  }
  // The app logs where its userData really is; that path, not the
  // prediction, is what launch and doctor print and stop --purge removes.
  state.userData = resolveUserDataRecord({ recorded: state.userData, logged: parseUserDataLog(fs.readFileSync(logPath, 'utf8')) });
  writeState(state);
  timeline(state, { cmd: 'launch', ready, cdpPort: state.cdpPort, userData: state.userData, note: ready ? 'ready' : lastErr });
  if (!ready) fail(`launch not ready: ${lastErr}. The process is still recorded; run \`doctor\`, then \`stop\`.`);
  return { ok: true, runId, suffix, pid: state.pid, cdpPort: state.cdpPort, app, ...userDataFields(state.userData), evidenceDir: dir, log: logPath };
}

/** `userData` (the path) and `userDataSource` ('logged' or 'predicted') for launch and doctor output. */
function userDataFields(record) {
  return { userData: record?.path ?? null, userDataSource: record ? record.source ?? 'predicted' : null };
}

function appVersion(app) {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(app);
  if (!m || process.platform !== 'darwin') return null;
  const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(m[1], 'Contents', 'Info.plist')], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function cmdDoctor() {
  const state = requireState({ alive: false });
  const checks = {};
  const problems = [];
  checks.suffix = state.suffix;
  checks.app = state.app;
  checks.appVersion = appVersion(state.app);
  checks.repoVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  if (checks.appVersion && checks.appVersion !== checks.repoVersion) {
    problems.push(`version skew: app ${checks.appVersion} vs checkout ${checks.repoVersion} — feature-map handles may not match the running build`);
  }
  checks.outsideApplications = !state.app.startsWith('/Applications/');
  checks.pid = state.pid;
  checks.alive = pidAlive(state.pid);
  if (!checks.alive) problems.push(`wmux pid ${state.pid} is not running`);
  const logText = fs.existsSync(state.logPath) ? fs.readFileSync(state.logPath, 'utf8') : '';
  const log = parseCdpLog(logText);
  checks.cdpLog = log;
  // A launch that gave up before the app logged its userData line recorded
  // the prediction; take the logged path now, and keep it for stop --purge.
  const userData = resolveUserDataRecord({ recorded: state.userData ?? null, logged: parseUserDataLog(logText) });
  if (JSON.stringify(userData) !== JSON.stringify(state.userData ?? null)) {
    state.userData = userData;
    writeState(state);
  }
  if (userData?.source === 'predicted') problems.push('the app has not logged its userData line; `userData` is the predicted path');
  checks.cdpDisabled = cdpDisabledReason(state.suffix) || (log.disabled ? 'app log: CDP disabled' : null);
  if (checks.cdpDisabled) problems.push(`CDP disabled: ${checks.cdpDisabled}`);
  checks.cdpPort = state.cdpPort;
  checks.cdpPortOwnedByPid = state.cdpPort ? claimOwnedBy(CLAIM_DIR, state.cdpPort, state.pid) : false;
  if (state.cdpPort && !checks.cdpPortOwnedByPid) problems.push(`claim for port ${state.cdpPort} no longer names pid ${state.pid}`);
  if (log.requested && state.cdpPort && log.requested !== state.cdpPort) problems.push(`log requested port ${log.requested} != claimed port ${state.cdpPort}`);
  if (!log.listening) problems.push(log.unverified ? 'wmux reports its CDP port as unverified' : 'wmux has not logged "CDP listening" yet');
  const version = state.cdpPort ? await httpJson(`http://127.0.0.1:${state.cdpPort}/json/version`) : null;
  checks.cdpBrowser = version?.Browser ?? null;
  if (state.cdpPort && !version) problems.push(`CDP port ${state.cdpPort} does not answer /json/version`);
  const daemonPid = readPidFile(path.join(os.homedir(), `.wmux${state.suffix}`, 'daemon.pid'));
  checks.daemonPid = daemonPid;
  checks.daemonAlive = pidAlive(daemonPid);
  if (checks.alive && checks.cdpPortOwnedByPid && version) {
    try {
      checks.ui = await withPage(state, (page) => page.evaluate(() => ({
        title: document.title,
        url: location.href.replace(/^file:\/\/.*\/(?=[^/]+$)/, 'file://…/'),
        rootRendered: !!document.querySelector('#root > *'),
        firstRunWizard: !!document.querySelector('[data-testid="first-run-wizard"]'),
        settingsOpen: !!document.querySelector('[data-testid="settings-page-title"]'),
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
      })));
      if (!checks.ui.rootRendered) problems.push('renderer #root is empty');
    } catch (err) {
      problems.push(`UI probe failed: ${err.message}`);
    }
  }
  const consoleErrors = readConsole(state, { errors: true }).length;
  checks.consoleErrors = consoleErrors;
  const result = { ok: problems.length === 0, healthy: problems.length === 0, problems, ...userDataFields(userData), checks, evidenceDir: evidenceDir(state) };
  fs.writeFileSync(path.join(evidenceDir(state), 'doctor.json'), `${JSON.stringify(result, null, 2)}\n`);
  timeline(state, { cmd: 'doctor', healthy: result.healthy, problems });
  return result;
}

async function cmdSnapshot(opts) {
  const state = requireState();
  const text = await withPage(state, async (page) => {
    const root = locatorFor(page, opts) ?? page.locator('body');
    const header = `# wmux ${state.suffix} — ${await page.title()}\n# target: ${locatorFor(page, opts) ? describeTarget(opts) : 'body'}\n`;
    return header + (await root.first().ariaSnapshot({ timeout: 10_000 }));
  });
  const out = nextArtifact(state, opts.as || 'snapshot', 'aria.yml');
  fs.writeFileSync(out, text);
  timeline(state, { cmd: 'snapshot', target: describeTarget(opts), path: out });
  return { ok: true, path: out, lines: text.split('\n').length, text: text.length > 6000 ? `${text.slice(0, 6000)}\n…(truncated; full file at path)` : text };
}

async function cmdScreenshot(opts) {
  const state = requireState();
  const shot = await withPage(state, async (page) => {
    const meta = await page.evaluate(() => ({ visibilityState: document.visibilityState, w: innerWidth, h: innerHeight }));
    return { meta, img: await cdpScreenshot(page) };
  });
  if (!shot.img) {
    timeline(state, { cmd: 'screenshot', ok: false, meta: shot.meta });
    return { ok: false, screenshot: 'unavailable', reason: 'Page.captureScreenshot timed out (window occluded, screen locked, or rAF paused); use `snapshot` as the evidence', meta: shot.meta };
  }
  const out = nextArtifact(state, opts.as || 'screenshot', 'png');
  fs.writeFileSync(out, shot.img.data);
  // A PNG of a blank/black frame compresses to almost nothing.
  const suspectBlank = shot.img.data.length < (shot.meta.w * shot.meta.h) / 400;
  timeline(state, { cmd: 'screenshot', path: out, bytes: shot.img.data.length, suspectBlank });
  return { ok: true, path: out, bytes: shot.img.data.length, fromSurface: shot.img.fromSurface, suspectBlank, meta: shot.meta };
}

async function cmdClick(opts) {
  const state = requireState();
  return withPage(state, async (page) => {
    const loc = locatorFor(page, opts);
    if (!loc) fail('click needs --testid, --label, --role [--name], --text or --selector');
    const timeout = Number(opts.timeout || 5000);
    // The previous action may still be rendering; give the target a moment to appear.
    await loc.first().waitFor({ state: 'attached', timeout }).catch(() => undefined);
    const count = await loc.count();
    if (count === 0) fail(`no element for ${describeTarget(opts)}`);
    if (count > 1 && opts.nth === undefined) fail(`${count} elements match ${describeTarget(opts)}; scope it or pass --nth`);
    try {
      await loc.click({ timeout });
    } catch (err) {
      fail(`click ${describeTarget(opts)} failed: ${playwrightReason(err)}`);
    }
    timeline(state, { cmd: 'click', target: describeTarget(opts) });
    return { ok: true, clicked: describeTarget(opts) };
  });
}

async function cmdHover(opts) {
  const state = requireState();
  return withPage(state, async (page) => {
    const loc = locatorFor(page, opts);
    if (!loc) fail('hover needs --testid, --label, --role [--name], --text or --selector');
    try {
      await loc.first().hover({ timeout: Number(opts.timeout || 5000) });
    } catch (err) {
      fail(`hover ${describeTarget(opts)} failed: ${playwrightReason(err)}`);
    }
    timeline(state, { cmd: 'hover', target: describeTarget(opts) });
    return { ok: true, hovered: describeTarget(opts) };
  });
}

async function cmdPress(opts) {
  const state = requireState();
  if (!opts.key || opts.key === true) fail('press needs --key (Playwright key syntax, e.g. Meta+Comma, Escape, Control+b)');
  return withPage(state, async (page) => {
    const loc = locatorFor(page, opts);
    if (loc) await loc.first().focus({ timeout: 5000 });
    await page.keyboard.press(String(opts.key));
    timeline(state, { cmd: 'press', key: opts.key, focus: loc ? describeTarget(opts) : null });
    return { ok: true, pressed: opts.key };
  });
}

async function cmdType(opts) {
  const state = requireState();
  if (typeof opts.text !== 'string') fail('type needs --text "<characters>" (use `press --key Enter` to submit)');
  return withPage(state, async (page) => {
    // --text is the payload here, so the focus target can only be a handle.
    const loc = locatorFor(page, { ...opts, text: undefined });
    if (loc) await loc.first().focus({ timeout: 5000 });
    await page.keyboard.type(opts.text, { delay: 10 });
    timeline(state, { cmd: 'type', chars: opts.text.length, focus: loc ? describeTarget(opts) : null });
    return { ok: true, typed: opts.text.length };
  });
}

async function cmdSelect(opts) {
  const state = requireState();
  if (typeof opts.value !== 'string') fail('select needs --value "<option value>"');
  return withPage(state, async (page) => {
    const loc = locatorFor(page, opts);
    if (!loc) fail('select needs --testid, --label, --role [--name] or --selector');
    const selected = await loc.selectOption(opts.value, { timeout: Number(opts.timeout || 5000) });
    timeline(state, { cmd: 'select', target: describeTarget(opts), selected });
    return { ok: true, selected };
  });
}

async function cmdEval(opts) {
  const state = requireState();
  if (!opts.js || opts.js === true) fail('eval needs --js "<expression>" (read-only inspection; never use it to put the app into a state)');
  const value = await withPage(state, (page) => page.evaluate((src) => {
    // eslint-disable-next-line no-new-func
    const v = new Function(`return (${src});`)();
    return Promise.resolve(v).then((r) => JSON.parse(JSON.stringify(r ?? null)));
  }, String(opts.js)));
  timeline(state, { cmd: 'eval', js: opts.js });
  return { ok: true, value };
}

async function cmdWaitSettle(opts) {
  const state = requireState();
  const timeout = Number(opts.timeout || 10_000);
  const quiet = opts.quiet === undefined ? 400 : Number(opts.quiet);
  return withPage(state, async (page) => {
    const loc = locatorFor(page, opts);
    const started = Date.now();
    if (loc) await loc.first().waitFor({ state: String(opts.state || 'visible'), timeout });
    // DOM quiet window via MutationObserver: does not depend on rAF, which a
    // locked/occluded window pauses.
    const settled = await page.evaluate(({ quietMs, limit }) => new Promise((resolve) => {
      let last = Date.now();
      const obs = new MutationObserver(() => { last = Date.now(); });
      obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      const t0 = Date.now();
      const tick = () => {
        if (Date.now() - last >= quietMs) { obs.disconnect(); resolve(true); return; }
        if (Date.now() - t0 > limit) { obs.disconnect(); resolve(false); return; }
        setTimeout(tick, 50);
      };
      tick();
    }), { quietMs: quiet, limit: Math.max(0, timeout - (Date.now() - started)) });
    timeline(state, { cmd: 'wait-settle', target: loc ? describeTarget(opts) : null, settled, ms: Date.now() - started });
    return { ok: settled, settled, target: loc ? describeTarget(opts) : null, ms: Date.now() - started, ...(settled ? {} : { error: `DOM did not stay quiet for ${quiet} ms within ${timeout} ms` }) };
  });
}

/** Renderer console lines from app.log (ELECTRON_ENABLE_LOGGING=1). */
function readConsole(state, { errors = false } = {}) {
  let text = '';
  try { text = fs.readFileSync(state.logPath, 'utf8'); } catch { return []; }
  const lines = [];
  for (const line of text.split('\n')) {
    const entry = parseConsoleLine(line);
    if (!entry) continue;
    if (errors && entry.level !== 'error') continue;
    lines.push(entry);
  }
  return lines;
}

async function cmdConsole(opts) {
  const state = requireState({ alive: false });
  const all = readConsole(state, { errors: !!opts.errors });
  const tail = Number(opts.tail || 50);
  return { ok: true, total: all.length, lines: all.slice(-tail), log: state.logPath };
}

function daemonCli(app) {
  const candidates = [
    packagedCliBundle(app),
    path.join(REPO_ROOT, 'dist', 'cli-bundle', 'index.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** process.kill reporting 'gone' / 'denied' instead of throwing (signalProcess). */
const signal = (pid, sig) => signalProcess(pid, sig);

/** The environment of a same-user process as text, or '' when unreadable. */
function processEnvText(pid) {
  if (process.platform === 'linux') {
    try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return ''; }
  }
  if (process.platform === 'darwin') {
    // `ps -E` appends the environment of processes owned by the same user to
    // the command line; keep only what follows the command line.
    const withEnv = spawnSync('ps', ['-E', '-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const argsOnly = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return withEnv.status === 0 && argsOnly.status === 0 ? darwinEnvPart(withEnv.stdout, argsOnly.stdout) : '';
  }
  return '';
}

/**
 * The pid of the daemon answering `daemon status` on this suffix's own pipe,
 * or null (no CLI bundle, or nothing answered). Same CLI and env as the
 * `daemon stop` in cmdStop, so both talk to the same pipe.
 */
function daemonPingPid(app, suffix) {
  const cli = daemonCli(app);
  if (!cli) return null;
  const r = spawnSync(process.execPath, [cli, 'daemon', 'status', '--json'], {
    env: scrubEnv(process.env, suffix),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  return parseDaemonStatusPid(r.stdout);
}

/** daemonIdentityHolds with the real probes: { ok, how, reason }. */
function daemonOwned(pid, app, suffix) {
  const verdict = daemonIdentityHolds({ pid, suffix }, {
    pidAlive,
    pingPid: () => daemonPingPid(app, suffix),
    envText: processEnvText,
  });
  if (!verdict.ok && !daemonCli(app)) {
    return { ...verdict, reason: `${verdict.reason}; no wmux CLI bundle found to ask the daemon (looked next to ${app} and in dist/cli-bundle)` };
  }
  return verdict;
}

async function waitDead(pid, ms) {
  const end = Date.now() + ms;
  while (pidAlive(pid) && Date.now() < end) await sleep(200);
  return !pidAlive(pid);
}

async function cmdRestart(opts) {
  const state = requireState();
  const daemonPid = readPidFile(path.join(os.homedir(), `.wmux${state.suffix}`, 'daemon.pid'));
  if (!daemonPid) fail('restart needs a live daemon owned by the recorded isolated instance (no daemon.pid)');
  const daemon = daemonOwned(daemonPid, state.app, state.suffix);
  if (!daemon.ok) fail(`restart needs a live daemon owned by the recorded isolated instance (${daemon.reason})`);
  if (!recordedAppAlive(state)) fail(`the recorded app (pid ${state.pid}) is gone or its pid now belongs to another process; run stop then launch`);
  // Use the same detach as stop, but deliberately retain the daemon. Windows:
  // through a handle pinned to the recorded creation time, never a bare pid.
  if (process.platform === 'win32') {
    const result = killByIdentity([{ pid: state.pid, createdAt: state.pidCreatedAt }])[state.pid];
    if (result !== 'killed') fail(`app pid ${state.pid} not terminated (${result || 'no result'})`);
  } else if (signal(state.pid, 'SIGTERM') === 'denied') fail(`not permitted to signal pid ${state.pid}`);
  if (!(await waitDead(state.pid, 10_000))) fail('app did not exit; run doctor then stop');
  const claim = releaseRecordedClaim(CLAIM_DIR, { port: state.cdpPort, pid: state.pid }, { pidAlive });
  timeline(state, { cmd: 'restart', previousPid: state.pid, retainedDaemonPid: daemonPid, daemonIdentity: daemon.how, claim });
  const result = await cmdLaunch({ app: state.app, suffix: state.suffix, timeout: opts.timeout }, state);
  return { ...result, previousPid: state.pid, retainedDaemonPid: daemonPid, claim };
}

async function cmdStop(opts) {
  const state = requireState({ alive: false });
  const home = os.homedir();
  const steps = [];
  const env = scrubEnv(process.env, state.suffix);

  // The app's own process tree, expanded only from its pinned identity (pid
  // AND creation time) and taken while the app still runs: its renderer, GPU,
  // network and storage services hold files in userData until they exit,
  // which is after the app itself.
  const appRows = state.pidCreatedAt != null && pidAlive(state.pid) ? listProcessRows() : null;
  const appTree = appRows ? runProcessTree(appRows, [{ ProcessId: state.pid, CreationDate: state.pidCreatedAt }]) : [];

  // 1. The app: only the process we spawned, by pid AND creation time. If the
  // app died, its pid may already belong to someone else: never signal it.
  // Ending it detaches it from its daemon.
  steps.push(await stopRecordedApp(state, { pidAlive, startedAt: processStartedAt, signal, waitDead, killByIdentity }));

  // 2. The daemon our instance spawned (a normal quit only detaches from it).
  // Ask it to shut down over its own suffixed socket; fall back to the pid in
  // OUR suffixed data dir — nobody else's daemon can be recorded there.
  const daemonPidFile = path.join(home, `.wmux${state.suffix}`, 'daemon.pid');
  const daemonPid = readPidFile(daemonPidFile);
  if (pidAlive(daemonPid)) {
    const cli = daemonCli(state.app);
    // Windows: prove the daemon is ours while it still answers, pinned to its
    // creation time read BEFORE the question: a pid reused before the answer
    // fails the answer, one reused after it fails the pinned kill below.
    const pinnedAt = process.platform === 'win32' ? processStartedAt(daemonPid) : null;
    const winProof = process.platform === 'win32' ? daemonOwned(daemonPid, state.app, state.suffix) : null;
    if (cli) {
      const r = spawnSync(process.execPath, [cli, 'daemon', 'stop', '--json'], { env, encoding: 'utf8', timeout: 15_000 });
      steps.push(`daemon stop via ${path.relative(REPO_ROOT, cli).startsWith('..') ? cli : path.relative(REPO_ROOT, cli)}: exit ${r.status}`);
    }
    if (!(await waitDead(daemonPid, 8000))) {
      // A stale pid file can name a reused pid: only end a process proven to
      // be this run's daemon (daemonIdentityHolds).
      if (process.platform === 'win32') {
        if (!winProof.ok || pinnedAt == null) {
          steps.push(`daemon pid ${daemonPid}: still running, identity not verified (${winProof.ok ? 'creation time unreadable' : winProof.reason}), not signalled`);
        } else {
          const result = killByIdentity([{ pid: daemonPid, createdAt: pinnedAt }])[daemonPid];
          steps.push(result === 'killed'
            ? `daemon pid ${daemonPid}: terminated through a handle pinned to its creation time (identity verified by daemon.ping over the ${state.suffix} pipe)`
            : `daemon pid ${daemonPid}: not terminated (${result || 'no result'})`);
          if (result === 'killed') await waitDead(daemonPid, 5000);
        }
      } else {
        const proof = daemonOwned(daemonPid, state.app, state.suffix);
        if (!proof.ok) steps.push(`daemon pid ${daemonPid}: still running, identity not verified (${proof.reason}), not signalled`);
        else if (signal(daemonPid, 'SIGTERM') === 'denied') steps.push(`daemon pid ${daemonPid}: not permitted to signal, skipped`);
        else {
          steps.push(`daemon pid ${daemonPid}: SIGTERM (identity verified by ${proof.how === 'pipe' ? `daemon.ping over the ${state.suffix} pipe` : 'WMUX_DATA_SUFFIX'})`);
          await waitDead(daemonPid, 5000);
        }
      }
    } else steps.push(`daemon pid ${daemonPid}: stopped`);
  } else steps.push('daemon: not running');

  // 3. launchd jobs labelled for our suffix that are no longer running.
  if (process.platform === 'darwin') {
    const list = spawnSync('launchctl', ['list'], { encoding: 'utf8' });
    for (const { label, pid } of launchdJobsFor(list.stdout, state.suffix)) {
      if (pid !== null) continue;
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
      steps.push(`launchd job ${label}: booted out`);
    }
  }

  // 3b. Wait for the app's tree (the daemon and its panes too, on Windows)
  // to be gone: purging while a child still holds a file fails with EPERM.
  let treeLeft = [];
  if (appTree.length) {
    treeLeft = await waitTreeGone(appTree, 15_000);
    steps.push(treeLeft.length
      ? `app process tree: ${treeLeft.length} of ${appTree.length} still running after 15 s (${treeLeft.map((r) => `${r.Name}#${r.ProcessId}`).join(', ')}), not killed`
      : `app process tree: all ${appTree.length} process(es) exited`);
  }

  // 3c. The CDP claim the app left: a hard kill skips its own release.
  steps.push(releaseRecordedClaim(CLAIM_DIR, { port: state.cdpPort, pid: state.pid }, { pidAlive }));

  // 4. Optional: remove the suffixed data this run created (never evidence,
  // never a path that existed before launch).
  let removed = [];
  let purgeSkipped = [];
  if (opts.purge) {
    ({ removed, skipped: purgeSkipped } = purgeSuffixedData({
      suffix: state.suffix,
      paths: suffixedPaths(home, state.suffix),
      preExisting: state.preExisting || [],
      userData: state.userData,
      // Reported only: a state without the record is never purged by guess.
      legacyUserDataPath: electronUserDataDir({ suffix: state.suffix, env: process.env, home }),
    }));
  }
  const userDataLeft = state.userData?.path && pathPresent(state.userData.path) ? [state.userData.path] : [];

  const leftover = [...new Set([
    recordedAppAlive(state) ? state.pid : null,
    ...[readPidFile(daemonPidFile) ?? daemonPid].filter((p) => p && pidAlive(p)),
    ...treeLeft.map((r) => r.ProcessId),
  ].filter(Boolean))];
  timeline(state, { cmd: 'stop', steps, removed, purgeSkipped, leftover });
  const evidence = evidenceDir(state);
  fs.renameSync(STATE_FILE, path.join(RUN_DIR, `stopped-${state.runId}.json`));
  return {
    ok: leftover.length === 0,
    steps,
    removed,
    ...(opts.purge ? { purgeSkipped } : {}),
    leftover,
    evidenceDir: evidence,
    evidence: fs.readdirSync(evidence),
    ...(opts.purge ? {} : {
      dataLeftInPlace: [...new Set([...suffixedPaths(home, state.suffix).filter((p) => fs.existsSync(p)), ...userDataLeft])],
    }),
  };
}

// ---------------------------------------------------------------- main
const COMMANDS = {
  launch: cmdLaunch,
  doctor: cmdDoctor,
  snapshot: cmdSnapshot,
  screenshot: cmdScreenshot,
  click: cmdClick,
  hover: cmdHover,
  press: cmdPress,
  type: cmdType,
  eval: cmdEval,
  // Same command; some agent sandboxes refuse any shell line containing `eval`.
  inspect: cmdEval,
  select: cmdSelect,
  'wait-settle': cmdWaitSettle,
  console: cmdConsole,
  stop: cmdStop,
  restart: cmdRestart,
};

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const run = COMMANDS[cmd];
  if (!run) {
    print({ ok: false, error: `unknown command ${cmd ?? '(none)'}`, commands: Object.keys(COMMANDS) });
    process.exitCode = 1;
    return;
  }
  try {
    const result = await run(opts);
    print(result);
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    print({ ok: false, command: cmd, error: err instanceof DriverError ? err.message : String(err?.stack || err) });
    process.exitCode = 1;
  }
}

await main();

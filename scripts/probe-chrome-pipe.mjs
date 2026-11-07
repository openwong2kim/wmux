#!/usr/bin/env node
/**
 * Probe: can this machine drive an installed Chrome or Edge over
 * --remote-debugging-pipe (fds 3 and 4, NUL-framed JSON) the way wmux spawns
 * it (spawn(binary) directly, no shell)?
 *
 * For each browser found, in headless and headed mode:
 *   - spawn with the pipe and a fresh temporary profile, and time the first
 *     Browser.getVersion answer (the first spawn of each browser is marked
 *     cold: its install may still be on a cold disk). Past the launcher's
 *     start ceiling the run fails, except a preinstalled browser's cold
 *     start under --cold-start-warn, which is a warning (see
 *     probe-chrome-pipe-verdict.mjs);
 *   - open about:blank (Target.createTarget) and a browser session
 *     (Target.attachToBrowserTarget);
 *   - write a persistent cookie, close the pipe, and time the exit;
 *   - check that no process still names the profile: any that does is
 *     recorded (image name, command line) and waited on for up to
 *     LINGER_DEADLINE_MS; one still there then fails the run, with whether the
 *     profile directory can be renamed (a process holding it open on Windows
 *     prevents that);
 *   - list lock files left;
 *   - start again on the same profile and read the cookie back.
 *
 * Usage: node scripts/probe-chrome-pipe.mjs [--browser chrome|edge|chromium|<path>]... [--require <name>]... [--headless-only] [--cold-start-warn] [--json out.json]
 * `chromium` is Playwright's build, installed by `playwright-core install
 * chromium` into PLAYWRIGHT_BROWSERS_PATH.
 * Exits non-zero when a browser that was found fails a step, or a --require'd
 * one is not found. Pages are
 * about:blank only; nothing is fetched from the network.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LAUNCHER_START_CEILING_MS, probeVerdict } from './probe-chrome-pipe-verdict.mjs';

const args = process.argv.slice(2);
const wanted = [];
/** Browsers that must be found: a missing one fails the run. */
const required = new Set();
let jsonOut = null;
let headlessOnly = false;
/** CI only: a preinstalled browser's cold start past the ceiling warns instead of failing. */
let coldStartWarn = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--browser') wanted.push(args[++i]);
  else if (args[i] === '--cold-start-warn') coldStartWarn = true;
  else if (args[i] === '--require') required.add(args[++i]);
  else if (args[i] === '--headless-only') headlessOnly = true;
  else if (args[i] === '--json') jsonOut = args[++i];
}
if (wanted.length === 0) wanted.push('chrome', 'edge', 'chromium');

const STEP_TIMEOUT_MS = 30_000;
/** The first answer is waited on past that ceiling, so a slow start is measured rather than cut off. */
const FIRST_ANSWER_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 5_000;
/** How long a process left after the browser exited is waited on before it counts as left behind. */
const LINGER_DEADLINE_MS = 30_000;

function candidates(name) {
  if (name === 'chromium') {
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!root || !fs.existsSync(root)) return [];
    const rel = process.platform === 'win32'
      ? ['chrome-win64', 'chrome.exe']
      : process.platform === 'darwin'
        ? [`chrome-mac-${process.arch}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']
        : ['chrome-linux64', 'chrome'];
    return fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).map((d) => path.join(root, d, ...rel));
  }
  if (name !== 'chrome' && name !== 'edge') return [name];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const rel = name === 'chrome' ? 'Google\\Chrome\\Application\\chrome.exe' : 'Microsoft\\Edge\\Application\\msedge.exe';
    return roots.map((root) => path.join(root, rel));
  }
  if (process.platform === 'darwin') {
    return name === 'chrome'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  return name === 'chrome'
    ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
    : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'];
}

/**
 * Processes whose command line names `marker` (the temporary profile path), as
 * { pid, ppid, name, commandLine }. The query's own process is left out: its
 * command line holds the marker too. Null when the query itself failed.
 */
function processesNaming(marker) {
  try {
    if (process.platform === 'win32') {
      const escaped = marker.replace(/'/g, "''");
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ForEach-Object { "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.Name)\`t$($_.CommandLine)" }`],
      { encoding: 'utf8' });
      return out.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
        const [pid, ppid, name, ...rest] = line.split('\t');
        return { pid: Number(pid), ppid: Number(ppid), name, commandLine: rest.join('\t').trim() };
      });
    }
    // The image name is read off the command line: on macOS it holds spaces.
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.includes(marker)).map((line) => {
      const [, pid, ppid, commandLine] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
      return { pid: Number(pid), ppid: Number(ppid), name: path.basename((commandLine ?? '').split(' -')[0]), commandLine };
    });
  } catch {
    return null;
  }
}

/**
 * Wait up to LINGER_DEADLINE_MS for every process naming the profile to exit.
 * Returns what was there first, how long it took to go (null if it did not),
 * and what is still there at the deadline.
 */
async function waitForProcessesToLeave(profile) {
  const first = processesNaming(profile);
  if (first === null || first.length === 0) return { atExit: first, goneAfterMs: first === null ? null : 0, left: first };
  const started = Date.now();
  let left = first;
  while (Date.now() - started < LINGER_DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 1_000));
    left = processesNaming(profile);
    if (left !== null && left.length === 0) return { atExit: first, goneAfterMs: Date.now() - started, left };
  }
  return { atExit: first, goneAfterMs: null, left };
}

/** Whether the profile directory can be renamed (and is put back): false when a process holds it open on Windows. */
function profileRenamable(profile) {
  const moved = `${profile}-moved`;
  try {
    fs.renameSync(profile, moved);
  } catch (err) {
    return { renamable: false, error: err.code ?? String(err) };
  }
  fs.renameSync(moved, profile);
  return { renamable: true };
}

function lockFiles(profile) {
  try {
    return fs.readdirSync(profile).filter((f) => /^Singleton|^lockfile$/i.test(f));
  } catch {
    return [];
  }
}

/** A pipe-driven browser: send(method, params, sessionId) → result. */
function launch(binary, profile, headless) {
  const child = spawn(binary, [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let carry = Buffer.alloc(0);
  let exitCode;
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { exitCode = code ?? signal; resolve(); }));
  child.once('error', (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); });
  child.stdio[4].on('data', (chunk) => {
    carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    for (let end = carry.indexOf(0); end !== -1; end = carry.indexOf(0)) {
      const message = JSON.parse(carry.subarray(0, end).toString('utf8'));
      carry = carry.subarray(end + 1);
      const job = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (!job) continue;
      pending.delete(message.id);
      if (message.error) job.reject(new Error(`${job.method}: ${message.error.message}`));
      else job.resolve(message.result);
    }
  });
  child.stdio[3].on('error', () => undefined);
  const send = (method, params = {}, sessionId, timeoutMs = STEP_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no answer in ${timeoutMs} ms`)); }, timeoutMs);
    pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) })}\0`);
  });
  /** Close the pipe; resolves with the ms until the process exited, or null past the timeout. */
  const closePipe = async () => {
    const started = Date.now();
    child.stdio[3].end();
    const done = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_TIMEOUT_MS))]);
    return done ? Date.now() - started : null;
  };
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
  return { child, send, closePipe, kill, exitCode: () => exitCode };
}

const COOKIE = { name: 'wmux_pipe_probe', value: 'kept', domain: 'probe.invalid', path: '/', expires: Math.floor(Date.now() / 1000) + 86_400 };

/** `preinstalled`: a browser the machine came with (chrome, edge), not one the probe installed. */
async function probe(binary, headless, cold, preinstalled) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pipe-probe-'));
  const result = { binary, headless, cold, platform: `${process.platform}-${process.arch}`, ok: false };
  let browser = launch(binary, profile, headless);
  try {
    const started = Date.now();
    const version = await browser.send('Browser.getVersion', {}, undefined, FIRST_ANSWER_TIMEOUT_MS);
    result.firstAnswerMs = Date.now() - started;
    result.withinLauncherCeiling = result.firstAnswerMs < LAUNCHER_START_CEILING_MS;
    result.product = version.product;
    result.target = Boolean((await browser.send('Target.createTarget', { url: 'about:blank' })).targetId);
    result.browserSession = Boolean((await browser.send('Target.attachToBrowserTarget')).sessionId);
    await browser.send('Storage.setCookies', { cookies: [COOKIE] });
    result.eofExitMs = await browser.closePipe();
    result.exitCode = browser.exitCode() ?? null;
    if (result.eofExitMs === null) browser.kill();
    const linger = await waitForProcessesToLeave(profile);
    result.processesAtExit = linger.atExit;
    result.processesGoneAfterMs = linger.goneAfterMs;
    result.processesLeft = linger.left;
    if (linger.left?.length) {
      result.profileHeld = profileRenamable(profile);
      // Recorded; now cleared so the runs after this one start clean.
      for (const p of linger.left) try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    result.lockFilesLeft = lockFiles(profile);
    browser = launch(binary, profile, headless);
    const { cookies } = await browser.send('Storage.getCookies');
    result.cookieKept = cookies.some((c) => c.name === COOKIE.name && c.value === COOKIE.value);
    result.secondExitMs = await browser.closePipe();
    if (result.secondExitMs === null) browser.kill();
    const verdict = probeVerdict(result, { coldStartWarn, preinstalled });
    result.ok = verdict.ok;
    if (verdict.warning) result.warning = verdict.warning;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    browser.kill();
  } finally {
    await new Promise((r) => setTimeout(r, 500));
    // Recorded, not thrown: the results still print.
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      result.profileNotRemoved = err instanceof Error ? err.message : String(err);
    }
  }
  return result;
}

const results = [];
for (const name of wanted) {
  const binary = candidates(name).find((p) => fs.existsSync(p));
  if (!binary) {
    results.push({ browser: name, found: false, ...(required.has(name) && { required: true }) });
    continue;
  }
  let cold = true;
  for (const headless of headlessOnly ? [true] : [true, false]) {
    // A headed browser needs a display: skip it on a Linux runner without one.
    if (!headless && process.platform === 'linux' && !process.env.DISPLAY) {
      results.push({ browser: name, binary, headless, skipped: 'no DISPLAY' });
      continue;
    }
    results.push({ browser: name, ...(await probe(binary, headless, cold, name === 'chrome' || name === 'edge')) });
    cold = false;
  }
}

for (const r of results) console.log(JSON.stringify(r));
for (const r of results) if (r.warning) console.log(`::warning title=Pipe probe (${r.browser})::${r.warning}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const names = (list) => (list ? list.map((p) => `${p.pid} ${p.name}`).join(', ') || 'none' : 'query failed');
  const row = (r) => r.found === false
    ? `| ${r.browser} | — | ${r.required ? 'FAIL: required, not installed' : 'not installed'} | | | | | | |`
    : r.skipped
      ? `| ${r.browser} | headed | skipped: ${r.skipped} | | | | | | |`
      : `| ${r.browser} | ${r.headless ? 'headless' : 'headed'}${r.cold ? ' (cold)' : ''} | ${r.ok ? (r.warning ? `ok, warning: ${r.warning}` : 'ok') : `FAIL${r.error ? `: ${r.error}` : ''}`} | ${r.product ?? ''} | ${r.firstAnswerMs ?? ''} | ${r.eofExitMs ?? 'no exit'} | ${names(r.processesAtExit)}${r.processesGoneAfterMs ? ` (gone after ${r.processesGoneAfterMs} ms)` : ''} | ${names(r.processesLeft)} ${JSON.stringify(r.lockFilesLeft ?? [])} | ${r.cookieKept ?? ''} |`;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### Pipe probe (${process.platform}-${process.arch})`,
    '| browser | mode | result | product | first answer ms | EOF exit ms | processes at exit | left after the deadline / lock files | cookie kept |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map(row),
    '',
  ].join('\n'));
}
for (const name of required) if (!wanted.includes(name)) results.push({ browser: name, found: false, required: true });
process.exitCode = results.some((r) => (r.found === false ? r.required : !r.skipped && !r.ok)) ? 1 : 0;

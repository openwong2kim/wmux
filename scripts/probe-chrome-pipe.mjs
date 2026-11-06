#!/usr/bin/env node
/**
 * Probe: can this machine drive an installed Chrome or Edge over
 * --remote-debugging-pipe (fds 3 and 4, NUL-framed JSON) the way wmux spawns
 * it (spawn(binary) directly, no shell)?
 *
 * For each browser found, in headless and headed mode:
 *   - spawn with the pipe and a fresh temporary profile, and time the first
 *     Browser.getVersion answer;
 *   - open about:blank (Target.createTarget) and a browser session
 *     (Target.attachToBrowserTarget);
 *   - write a persistent cookie, close the pipe, and time the exit;
 *   - check that no process still names the profile, and list lock files left;
 *   - start again on the same profile and read the cookie back.
 *
 * Usage: node scripts/probe-chrome-pipe.mjs [--browser chrome|edge|<path>]... [--headless-only] [--json out.json]
 * Exits non-zero when a browser that was found fails a step. Pages are
 * about:blank only; nothing is fetched from the network.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const wanted = [];
let jsonOut = null;
let headlessOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--browser') wanted.push(args[++i]);
  else if (args[i] === '--headless-only') headlessOnly = true;
  else if (args[i] === '--json') jsonOut = args[++i];
}
if (wanted.length === 0) wanted.push('chrome', 'edge');

const STEP_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 5_000;

function candidates(name) {
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
 * "pid name". The query's own process is left out: its command line holds the
 * marker too.
 */
function processesNaming(marker) {
  try {
    if (process.platform === 'win32') {
      const escaped = marker.replace(/'/g, "''");
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`],
      { encoding: 'utf8' });
      return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
    const out = execFileSync('ps', ['-axo', 'pid=,comm=,command='], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.includes(marker)).map((line) => line.trim().split(/\s+/).slice(0, 2).join(' '));
  } catch {
    return null;
  }
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
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: no answer in ${STEP_TIMEOUT_MS} ms`)); }, STEP_TIMEOUT_MS);
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

async function probe(binary, headless) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pipe-probe-'));
  const result = { binary, headless, platform: `${process.platform}-${process.arch}`, ok: false };
  let browser = launch(binary, profile, headless);
  try {
    const started = Date.now();
    const version = await browser.send('Browser.getVersion');
    result.firstAnswerMs = Date.now() - started;
    result.product = version.product;
    result.target = Boolean((await browser.send('Target.createTarget', { url: 'about:blank' })).targetId);
    result.browserSession = Boolean((await browser.send('Target.attachToBrowserTarget')).sessionId);
    await browser.send('Storage.setCookies', { cookies: [COOKIE] });
    result.eofExitMs = await browser.closePipe();
    result.exitCode = browser.exitCode() ?? null;
    if (result.eofExitMs === null) browser.kill();
    // Give helpers a moment to follow the browser process out.
    await new Promise((r) => setTimeout(r, 1_000));
    result.processesLeft = processesNaming(profile);
    result.lockFilesLeft = lockFiles(profile);
    browser = launch(binary, profile, headless);
    const { cookies } = await browser.send('Storage.getCookies');
    result.cookieKept = cookies.some((c) => c.name === COOKIE.name && c.value === COOKIE.value);
    const second = await browser.closePipe();
    if (second === null) browser.kill();
    result.ok = result.target && result.browserSession && result.eofExitMs !== null && result.processesLeft?.length === 0;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    browser.kill();
  } finally {
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  return result;
}

const results = [];
for (const name of wanted) {
  const binary = candidates(name).find((p) => fs.existsSync(p));
  if (!binary) {
    results.push({ browser: name, found: false });
    continue;
  }
  for (const headless of headlessOnly ? [true] : [true, false]) {
    // A headed browser needs a display: skip it on a Linux runner without one.
    if (!headless && process.platform === 'linux' && !process.env.DISPLAY) {
      results.push({ browser: name, binary, headless, skipped: 'no DISPLAY' });
      continue;
    }
    results.push({ browser: name, ...(await probe(binary, headless)) });
  }
}

for (const r of results) console.log(JSON.stringify(r));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const row = (r) => r.found === false
    ? `| ${r.browser} | — | not installed | | | | | |`
    : r.skipped
      ? `| ${r.browser} | headed | skipped: ${r.skipped} | | | | | |`
      : `| ${r.browser} | ${r.headless ? 'headless' : 'headed'} | ${r.ok ? 'ok' : `FAIL${r.error ? `: ${r.error}` : ''}`} | ${r.product ?? ''} | ${r.firstAnswerMs ?? ''} | ${r.eofExitMs ?? 'no exit'} | ${JSON.stringify(r.processesLeft ?? null)} ${JSON.stringify(r.lockFilesLeft ?? [])} | ${r.cookieKept ?? ''} |`;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### Pipe probe (${process.platform}-${process.arch})`,
    '| browser | mode | result | product | first answer ms | EOF exit ms | processes / lock files left | cookie kept |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map(row),
    '',
  ].join('\n'));
}
process.exitCode = results.some((r) => r.found !== false && !r.skipped && !r.ok) ? 1 : 0;

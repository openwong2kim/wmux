#!/usr/bin/env node
// Smoke run of a built helper on a real Windows desktop (CI's windows job):
// spawns it the way main does, measures time to `hello`, and drives
// capabilities, listApps, resolveTarget, getAppState (ax and vision) and
// releaseInput against a Notepad it starts itself, then checks the helper
// exits on stdin EOF.
//
//   node smoke.mjs <exe>                                   # as the current user
//   node smoke.mjs <exe> --limited <RunLimited.exe> --require-full
//
// Hosted CI runners run jobs as an elevated administrator, and the helper
// refuses to run elevated (exit 72 before hello). Without --limited, that
// refusal counts as a passed check (the full run is skipped unless
// --require-full). With --limited, Notepad and the helper are both started
// through tools/RunLimited at Medium integrity (Notepad must be Medium too, or
// UIPI keeps UIA out and it reads as elevated); first-hello latency then
// includes the launcher's start-up.
//
// With --hang <HangWindow.exe> (tools/HangWindow), it also starts a window
// that stops responding, and checks that getAppState vision on it answers
// within 5 s with a failed screenshot and that the helper still answers the
// next request.
//
// Prints one JSON line of timings, and a markdown table to $GITHUB_STEP_SUMMARY.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
let exe = null;
let launcher = null;
let requireFull = false;
let hangExe = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--limited') launcher = argv[++i] && resolve(argv[i]);
  else if (argv[i] === '--require-full') requireFull = true;
  else if (argv[i] === '--hang') hangExe = argv[++i] && resolve(argv[i]);
  else if (!exe) exe = resolve(argv[i]);
  else { console.error(`unknown argument ${argv[i]}`); process.exit(2); }
}
if (!exe || (argv.includes('--limited') && !launcher)) {
  console.error('usage: node smoke.mjs <wmux-computer-use.exe> [--limited <RunLimited.exe>] [--require-full] [--hang <HangWindow.exe>]');
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.log('computer-use-windows smoke: Windows only; skipped');
  process.exit(0);
}

// The whole run is bounded: a hung helper, launcher or Notepad fails the job
// with the step it was on instead of holding a runner until the job timeout.
const WATCHDOG_MS = 120_000;
const STEP_MS = 30_000;

const timings = {};
let step = 'start';

function log(next) {
  step = next;
  console.error(`[smoke] ${next}`);
}
let stderrTail = '';
let notepadPid = null;
let hangPid = null;
let helper = null;

function fail(message) {
  console.error(`computer-use-windows smoke: FAILED at "${step}": ${message}`);
  if (stderrTail) console.error(`helper stderr (tail):\n${stderrTail}`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  try { helper?.kill(); } catch { /* gone */ }
  // Only the Notepad this script started.
  try { if (notepadPid) process.kill(notepadPid); } catch { /* gone */ }
  try { if (hangPid) process.kill(hangPid); } catch { /* gone */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchdog = setTimeout(() => fail(`watchdog: no finish within ${WATCHDOG_MS / 1000} s`), WATCHDOG_MS);
watchdog.unref?.();

/** Runs a short-lived command with a hard timeout and echoes its stderr. */
function runBounded(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: STEP_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  return r;
}

/** A .dll launcher (framework-dependent build output) runs through `dotnet`. */
function launcherCommand(args) {
  return /\.dll$/i.test(launcher) ? ['dotnet', [launcher, ...args]] : [launcher, args];
}

// --- helper plumbing -------------------------------------------------------

const lines = [];
let lineWaiter = null;
let buffer = '';
let exited = null;

// Resolves null when the helper exits first.
function nextLine(timeoutMs) {
  if (lines.length) return Promise.resolve(lines.shift());
  return new Promise((resolveLine, rejectLine) => {
    const timer = setTimeout(() => { lineWaiter = null; rejectLine(new Error(`no line within ${timeoutMs} ms`)); }, timeoutMs);
    lineWaiter = (line) => { clearTimeout(timer); lineWaiter = null; resolveLine(line); };
  });
}

let nextId = 1;
async function call(method, params = {}, timeoutMs = 15000) {
  log(`request ${method}`);
  const id = nextId++;
  const started = performance.now();
  helper.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  const line = await nextLine(timeoutMs).catch((e) => fail(`${method}: ${e.message}`));
  const ms = Math.round(performance.now() - started);
  if (line === null) fail(`${method}: the helper exited (code ${exited?.code}) before answering`);
  let msg;
  try { msg = JSON.parse(line); } catch { fail(`${method}: reply is not JSON: ${line.slice(0, 200)}`); }
  if (msg.id !== id) fail(`${method}: reply id ${msg.id}, expected ${id}`);
  return { msg, ms };
}

// --- run -------------------------------------------------------------------

function writeSummary() {
  console.log(JSON.stringify(timings));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(timings).filter(([, v]) => v !== undefined).map(([k, v]) => `| ${k} | ${v} |`);
    const title = launcher ? 'computer-use-windows smoke (through RunLimited, Medium integrity)' : 'computer-use-windows smoke';
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### ${title}`, '', '| metric | value |', '| --- | --- |', ...rows, ''].join('\n'));
  }
}

timings.mode = launcher ? 'limited (Medium integrity via RunLimited; hello latency includes the launcher)' : 'as invoked';
if (launcher) {
  log('start Notepad through RunLimited --no-wait');
  const [cmd, args] = launcherCommand(['--no-wait', 'notepad.exe']);
  const r = runBounded(cmd, args);
  log('read the Notepad pid');
  notepadPid = Number.parseInt(String(r.stdout).trim(), 10);
  if (r.status !== 0 || !Number.isInteger(notepadPid)) fail(`RunLimited could not start Notepad: ${r.stderr || r.error?.message}`);
} else {
  log('start Notepad');
  const notepad = spawn('notepad.exe', [], { stdio: 'ignore', detached: false });
  notepad.on('error', (e) => fail(`could not start Notepad: ${e.message}`));
  notepadPid = notepad.pid;
}

log(launcher ? 'spawn the helper through RunLimited' : 'spawn the helper');
const spawnedAt = performance.now();
const [helperCmd, helperArgs] = launcher ? launcherCommand([exe]) : [exe, []];
helper = spawn(helperCmd, helperArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
helper.on('error', (e) => fail(`could not start the helper: ${e.message}`));
helper.on('exit', (code, signal) => {
  exited = { code, signal };
  if (lineWaiter) lineWaiter(null);
});
helper.stderr.setEncoding('utf8');
helper.stderr.on('data', (d) => {
  stderrTail = (stderrTail + d).slice(-4096);
  // The helper's and the launcher's diagnostics, live.
  process.stderr.write(d);
});
helper.stdout.setEncoding('utf8');
helper.stdout.on('data', (d) => {
  buffer += d;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (lineWaiter) lineWaiter(line); else lines.push(line);
  }
});

log('wait for hello');
const helloLine = await nextLine(10000).catch((e) => fail(`hello: ${e.message}`));
if (helloLine === null) {
  // Let stderr drain before judging it.
  await sleep(200);
  if (exited?.code === 72 && /refusing to run elevated/.test(stderrTail)) {
    timings.elevatedRefusal = 'pass (exit 72, "refusing to run elevated")';
    if (requireFull) fail('the helper refused to run elevated; run with --limited for the full smoke');
    writeSummary();
    cleanup();
    process.exit(0);
  }
  fail(`no hello (exited with ${exited?.code})`);
}
timings.firstHelloMs = Math.round(performance.now() - spawnedAt);
const hello = JSON.parse(helloLine);
if (hello.type !== 'hello' || hello.protocolVersion !== 2 || hello.os !== 'win32') fail(`unexpected hello: ${helloLine}`);

const caps = await call('capabilities');
if (!caps.msg.ok || !Array.isArray(caps.msg.result.actions)) fail(`capabilities: ${JSON.stringify(caps.msg)}`);
timings.capabilitiesMs = caps.ms;

// Notepad may take a moment to show its window.
let app = null;
const deadline = performance.now() + 5000;
while (!app && performance.now() < deadline) {
  const r = await call('listApps');
  if (!r.msg.ok) fail(`listApps: ${JSON.stringify(r.msg.error)}`);
  timings.listAppsMs = r.ms;
  app = r.msg.result.apps.find((a) => a.pid === notepadPid) ??
    r.msg.result.apps.find((a) => /\\notepad\.exe$/i.test(a.path));
  if (!app) await sleep(250);
}
if (!app) {
  fail('listApps never reported Notepad. If this runner has no interactive desktop (the session that runs the job ' +
    'cannot see top-level windows), the helper cannot be smoke-tested here; run the dogfood checklist instead.');
}

const resolved = await call('resolveTarget', { app: `pid:${app.pid}` });
if (!resolved.msg.ok) fail(`resolveTarget: ${JSON.stringify(resolved.msg.error)}`);
timings.resolveTargetMs = resolved.ms;
const windowId = resolved.msg.result.window.id;

const ax = await call('getAppState', { app: `pid:${app.pid}`, window: windowId, mode: 'ax', maxNodes: 800, maxDepth: 40 });
if (!ax.msg.ok) fail(`getAppState ax: ${JSON.stringify(ax.msg.error)}`);
if (typeof ax.msg.result.tree !== 'string' || !ax.msg.result.tree.startsWith('App:')) fail(`getAppState ax tree: ${String(ax.msg.result.tree).slice(0, 200)}`);
timings.getAppStateAxMs = ax.ms;
timings.elementCount = ax.msg.result.elementCount;

const vision = await call('getAppState', { app: `pid:${app.pid}`, window: windowId, mode: 'vision', maxNodes: 800, maxDepth: 40 });
if (!vision.msg.ok) fail(`getAppState vision: ${JSON.stringify(vision.msg.error)}`);
timings.getAppStateVisionMs = vision.ms;
timings.screenshotStatus = vision.msg.result.screenshotStatus?.status;
if (vision.msg.result.screenshot) {
  const s = vision.msg.result.screenshot;
  timings.screenshot = `${s.width}x${s.height} ${s.mime} scale ${Number(s.scale).toFixed(3)}`;
} else if (vision.msg.result.screenshotStatus?.error) {
  timings.screenshotError = vision.msg.result.screenshotStatus.error.message;
}

if (hangExe) {
  // A window that stops answering three seconds after it appears.
  log(launcher ? 'start the hang target through RunLimited --no-wait' : 'start the hang target');
  if (launcher) {
    const [cmd, args] = launcherCommand(['--no-wait', hangExe]);
    const r = runBounded(cmd, args);
    hangPid = Number.parseInt(String(r.stdout).trim(), 10);
    if (r.status !== 0 || !Number.isInteger(hangPid)) fail(`RunLimited could not start the hang target: ${r.stderr || r.error?.message}`);
  } else {
    const hang = spawn(hangExe, [], { stdio: 'ignore' });
    hang.on('error', (e) => fail(`could not start the hang target: ${e.message}`));
    hangPid = hang.pid;
  }
  log('wait for the hang target window');
  const seenBy = performance.now() + 15000;
  let seen = false;
  while (!seen && performance.now() < seenBy) {
    const r = await call('listApps');
    seen = r.msg.ok && r.msg.result.apps.some((a) => a.pid === hangPid);
    if (!seen) await sleep(250);
  }
  if (!seen) fail('the hang target never showed a window');
  // It hangs 3 s after it is shown; give it a margin.
  await sleep(4500);
  const hung = await call('getAppState', { app: `pid:${hangPid}`, mode: 'vision', maxNodes: 800, maxDepth: 40 }, 5000);
  timings.hungCaptureMs = hung.ms;
  if (!hung.msg.ok) fail(`getAppState on the hung window: ${JSON.stringify(hung.msg.error)}`);
  const status = hung.msg.result.screenshotStatus;
  if (status?.status !== 'failed' || status.error?.code !== 'screenshot_failed') {
    fail(`getAppState on the hung window should fail its screenshot, got ${JSON.stringify(status)}`);
  }
  timings.hungCapture = `failed: ${status.error.message}`;
  const after = await call('capabilities', {}, 5000);
  if (!after.msg.ok) fail(`capabilities after the hung capture: ${JSON.stringify(after.msg)}`);
  timings.afterHungMs = after.ms;
}

const release = await call('releaseInput', {});
if (!release.msg.ok || release.msg.result.released !== true) fail(`releaseInput: ${JSON.stringify(release.msg)}`);
timings.releaseInputMs = release.ms;

// stdin EOF: the helper must exit on its own.
log('close stdin and wait for exit');
helper.stdin.end();
const exitDeadline = performance.now() + 5000;
while (!exited && performance.now() < exitDeadline) await sleep(50);
if (!exited) fail('the helper did not exit within 5 s of stdin EOF');
timings.exitCode = exited.code;

log('done');
writeSummary();
cleanup();
process.exit(exited.code === 0 ? 0 : 1);

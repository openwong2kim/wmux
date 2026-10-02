#!/usr/bin/env node
// Smoke run of a built helper on a real Windows desktop (CI's windows job):
// spawns it the way main does, measures time to `hello`, and drives
// capabilities, listApps, resolveTarget, getAppState (ax and vision) and
// releaseInput against a Notepad it starts itself, then checks the helper
// exits on stdin EOF.
//
//   node native/computer-use-windows/smoke.mjs native/computer-use-windows/dist/wmux-computer-use.exe
//
// Prints one JSON line of timings, and a markdown table to $GITHUB_STEP_SUMMARY.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const exe = process.argv[2] && resolve(process.argv[2]);
if (!exe) {
  console.error('usage: node smoke.mjs <path to wmux-computer-use.exe>');
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.log('computer-use-windows smoke: Windows only; skipped');
  process.exit(0);
}

const timings = {};
let stderrTail = '';
let notepad = null;
let helper = null;

function fail(message) {
  console.error(`computer-use-windows smoke: FAILED: ${message}`);
  if (stderrTail) console.error(`helper stderr (tail):\n${stderrTail}`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  try { helper?.kill(); } catch { /* gone */ }
  // Only the Notepad this script started.
  try { if (notepad?.pid) process.kill(notepad.pid); } catch { /* gone */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- helper plumbing -------------------------------------------------------

const lines = [];
let lineWaiter = null;
let buffer = '';
let exited = null;

function nextLine(timeoutMs) {
  if (lines.length) return Promise.resolve(lines.shift());
  return new Promise((resolveLine, rejectLine) => {
    const timer = setTimeout(() => { lineWaiter = null; rejectLine(new Error(`no line within ${timeoutMs} ms`)); }, timeoutMs);
    lineWaiter = (line) => { clearTimeout(timer); lineWaiter = null; resolveLine(line); };
  });
}

let nextId = 1;
async function call(method, params = {}, timeoutMs = 15000) {
  const id = nextId++;
  const started = performance.now();
  helper.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  const line = await nextLine(timeoutMs).catch((e) => fail(`${method}: ${e.message}`));
  const ms = Math.round(performance.now() - started);
  let msg;
  try { msg = JSON.parse(line); } catch { fail(`${method}: reply is not JSON: ${line.slice(0, 200)}`); }
  if (msg.id !== id) fail(`${method}: reply id ${msg.id}, expected ${id}`);
  return { msg, ms };
}

// --- run -------------------------------------------------------------------

notepad = spawn('notepad.exe', [], { stdio: 'ignore', detached: false });
notepad.on('error', (e) => fail(`could not start Notepad: ${e.message}`));

const spawnedAt = performance.now();
helper = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
helper.on('error', (e) => fail(`could not start the helper: ${e.message}`));
helper.on('exit', (code, signal) => { exited = { code, signal }; });
helper.stderr.setEncoding('utf8');
helper.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4096); });
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

const helloLine = await nextLine(10000).catch((e) => fail(`hello: ${e.message}${exited ? ` (exited with ${exited.code})` : ''}`));
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
  app = r.msg.result.apps.find((a) => a.pid === notepad.pid) ??
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

const release = await call('releaseInput', {});
if (!release.msg.ok || release.msg.result.released !== true) fail(`releaseInput: ${JSON.stringify(release.msg)}`);
timings.releaseInputMs = release.ms;

// stdin EOF: the helper must exit on its own.
helper.stdin.end();
const exitDeadline = performance.now() + 5000;
while (!exited && performance.now() < exitDeadline) await sleep(50);
if (!exited) fail('the helper did not exit within 5 s of stdin EOF');
timings.exitCode = exited.code;

console.log(JSON.stringify(timings));
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = Object.entries(timings).filter(([, v]) => v !== undefined).map(([k, v]) => `| ${k} | ${v} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### computer-use-windows smoke', '', '| metric | value |', '| --- | --- |', ...rows, ''].join('\n'));
}
cleanup();
process.exit(exited.code === 0 ? 0 : 1);

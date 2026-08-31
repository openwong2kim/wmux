#!/usr/bin/env node
/**
 * A2A EventBus Inbox (S-C2 ②) — dynamic dogfood, Phase 1: DUAL-PARTY SCOPING.
 *
 * WHAT THIS VERIFIES (against the PACKAGED exe, out/wmux-win32-x64/wmux.exe)
 * ------------------------------------------------------------------------
 * The make-or-break invariant of the feature (plan §"The make-or-break"):
 * an A2A task involves exactly TWO workspaces (from, to). The receiver must
 * poll the `created` event; the sender must poll the `updated`/`cancelled`
 * receipt; a THIRD workspace must NEVER see another pair's task, and an
 * UNSCOPED poll (no workspaceId — the plugin-host forwarding path) must see
 * ZERO a2a.task events.
 *
 * The feature tees the renderer-only a2a task store onto the shared 1024-slot
 * EventBus ring via `emitA2aTaskEvent` (useRpcBridge.ts), and re-imposes
 * scoping at the events.poll RPC trust boundary (events.rpc.ts post-filter):
 *   - non-a2a types: strict  `e.workspaceId === caller`        (UNCHANGED)
 *   - a2a.task:      dual    `!!caller && (from===caller || to===caller)`
 *
 * The 22/22 unit suite proves the filter in isolation. This dogfood proves the
 * WHOLE chain in a live packaged build: renderer RPC handler → store mutation →
 * emitA2aTaskEvent → publishA2aTask → preload EVENTS_PUBLISH → main trust
 * boundary (registerHandlers, workspaceId=from) → EventBus ring → events.poll
 * post-filter → the right parties see it and no one else.
 *
 * HOW (no MCP, no CDP keystrokes — pure main-pipe RPC)
 * ---------------------------------------------------
 * The main-pipe RPC router applies workspaceId scoping from `params.workspaceId`
 * VERBATIM (events.rpc.ts:60-95) — the server-side pin lives only in the MCP
 * layer (requireWorkspaceId), NOT in the raw router. And a clientName-less RPC
 * is grandfathered through enforce-mode (RpcRouter.dispatch:206/239 → enforcer
 * legacy/first-party allow). So a single packaged instance + main-pipe RPC can
 * impersonate the sender poll, the receiver poll, a third-party poll, and the
 * unscoped poll — the exact four vantage points the invariant is about.
 *   - a2a.task.send (a2a.rpc.ts:106) passes params straight to the renderer,
 *     so we set from=params.workspaceId and to=params.to freely.
 *   - silent:true keeps the PTY untouched (no paste) while STILL emitting the
 *     `created` pointer (useRpcBridge.ts:1283 is outside the `if(!silent)`).
 *
 * ISOLATION (pra-poll-dogfood model): fresh temp USERPROFILE/HOME/APPDATA/
 * LOCALAPPDATA + a unique WMUX_DATA_SUFFIX re-keys the main pipe
 * (`\\.\pipe\wmux<suffix>-<user>`), the auth token (`<home>/.wmux<suffix>-auth-token`),
 * the daemon pipe, ~/.wmux and the Electron userData dir — BOTH the pipe and the
 * token are suffix-aware (constants.ts:179/209), so this runs beside a live wmux
 * without touching it. CLEANUP: app kill + detached-daemon shutdown RPC →
 * pid SIGKILL fallback → temp HOME removed → zombie count = 0.
 *
 * Run (PowerShell, package first):  npm run package; node scripts/a2a-eventbus-dogfood.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const APP_EXE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
const USERNAME = os.userInfo().username || 'default';

const results = [];
let app = null;
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'win32') {
  console.log('a2a-eventbus-dogfood: SKIP (win32-only)');
  process.exit(0);
}
if (!fs.existsSync(APP_EXE)) {
  console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`);
  process.exit(2);
}

// --- isolated instance environment (pra-poll-dogfood pattern) ---
const suffix = `-a2adog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2adog-'));
const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  WMUX_DATA_SUFFIX: suffix,
  WMUX_NO_DIALOG: '1',
};
// Delete (don't assign undefined) so the keys are actually absent from the
// child env — `spawn` coerces an `undefined` value to the string "undefined",
// which would corrupt Windows %HOMEDRIVE%/%HOMEPATH% path resolution.
delete env.HOMEDRIVE;
delete env.HOMEPATH;
delete env.WMUX_DISABLE_CDP;
fs.mkdirSync(env.APPDATA, { recursive: true });
fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
const userDataDir = path.join(env.APPDATA, `wmux${suffix}`);
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');

const wmuxDir = path.join(home, `.wmux${suffix}`);
const mainPipe = `\\\\.\\pipe\\wmux${suffix}-${USERNAME}`;
// getAuthTokenPath() === `${home}/.wmux${suffix}-auth-token` (constants.ts:209)
const authTokenPath = path.join(home, `.wmux${suffix}-auth-token`);

function readMainToken() {
  try { const t = fs.readFileSync(authTokenPath, 'utf8').trim(); return t || null; }
  catch { return null; }
}
function readDaemonPid() {
  try {
    const pid = Number(fs.readFileSync(path.join(wmuxDir, 'daemon.pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function readDaemonPipeName() {
  try { return fs.readFileSync(path.join(wmuxDir, 'daemon-pipe'), 'utf8').trim() || null; }
  catch { return null; }
}
function readDaemonToken() {
  for (const p of [path.join(home, '.wmux', 'daemon-auth-token'), path.join(wmuxDir, 'daemon-auth-token')]) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t; } catch { /* next */ }
  }
  return null;
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function pipeAlive(pipeName) {
  return new Promise((resolve) => {
    const sock = net.createConnection(pipeName);
    const done = (v) => { try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 800);
  });
}

// One-shot newline-delimited JSON-RPC client (pra PipeClient).
// #1111: these calls used to omit clientName and ride the `legacy`
// grandfather. That lane closes in the first release on or after
// 2026-09-30, so the driver now identifies as 'wmux-cli' (the curated
// internal-CLI lane, src/main/mcp/internalCli.ts) which needs no approval
// dialog.
const DOGFOOD_CLIENT_NAME = 'wmux-cli';
function rpcCall(pipeName, token, method, params = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(pipeName);
    let buf = '';
    let settled = false;
    const id = randomUUID();
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`rpc timeout: ${method}`))), timeoutMs);
    sock.setEncoding('utf8');
    sock.once('connect', () => sock.write(JSON.stringify({ id, method, params, token, clientName: DOGFOOD_CLIENT_NAME, clientVersion: '0.0.0-dogfood' }) + '\n'));
    sock.once('error', (e) => finish(() => reject(e)));
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

function spawnApp() {
  const t0 = Date.now();
  const proc = spawn(APP_EXE, [], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  let cdpPort = null;
  const cdpWaiters = [];
  const stderrLines = [];
  let stdoutBuf = '';
  proc.stdout.on('data', (b) => {
    stdoutBuf += b.toString('utf8');
    const m = stdoutBuf.match(/CDP enabled on port (\d+)/);
    if (m && cdpPort === null) { cdpPort = Number(m[1]); for (const w of cdpWaiters.splice(0)) w(cdpPort); }
    if (stdoutBuf.length > 65536) stdoutBuf = stdoutBuf.slice(-4096);
  });
  let stderrBuf = '';
  proc.stderr.on('data', (b) => {
    stderrBuf += b.toString('utf8');
    let nl;
    while ((nl = stderrBuf.indexOf('\n')) !== -1) { stderrLines.push(stderrBuf.slice(0, nl)); stderrBuf = stderrBuf.slice(nl + 1); }
    if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-4096);
  });
  const waitForCdp = (timeoutMs) => new Promise((resolve, reject) => {
    if (cdpPort !== null) return resolve(cdpPort);
    cdpWaiters.push(resolve);
    setTimeout(() => reject(new Error('timeout waiting for CDP port line')), timeoutMs);
  });
  return { proc, t0, stderrLines, get cdpPort() { return cdpPort; }, waitForCdp };
}

async function waitDaemonPipeFile(timeoutMs) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) { if (fs.existsSync(path.join(wmuxDir, 'daemon-pipe'))) return true; await sleep(80); }
  return false;
}
async function waitMainToken(timeoutMs) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) { const t = readMainToken(); if (t) return t; await sleep(80); }
  return null;
}
// Renderer is ready once workspace.list (a sendToRenderer round-trip) succeeds.
async function waitRendererReady(token, timeoutMs) {
  const dl = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < dl) {
    try { const r = await rpcCall(mainPipe, token, 'workspace.list', {}, 4000); if (Array.isArray(r)) return r; }
    catch (e) { lastErr = e.message; }
    await sleep(200);
  }
  throw new Error(`renderer never became ready (last: ${lastErr})`);
}

async function killAppOnly(app) {
  try { app.proc.kill(); } catch { /* */ }
  const dl = Date.now() + 6000;
  while (app.proc.exitCode === null && Date.now() < dl) await sleep(100);
  if (app.proc.exitCode === null) { try { app.proc.kill('SIGKILL'); } catch { /* */ } }
  const pdl = Date.now() + 5000;
  while (Date.now() < pdl && await pipeAlive(mainPipe)) await sleep(150);
}
async function shutdownDaemon() {
  const pipeName = readDaemonPipeName();
  const token = readDaemonToken();
  const daemonPid = readDaemonPid();
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

// ── A2A helpers over the main pipe ──
let TOKEN = null;
const a2aPoll = async (workspaceId) => {
  const params = { cursor: 0, types: ['a2a.task'] };
  if (workspaceId !== undefined) params.workspaceId = workspaceId;
  const r = await rpcCall(mainPipe, TOKEN, 'events.poll', params);
  const events = Array.isArray(r?.events) ? r.events.filter((e) => e.type === 'a2a.task') : [];
  return events;
};
const kinds = (events, taskId) => events.filter((e) => e.taskId === taskId).map((e) => e.kind);

async function main() {
  console.log(`a2a-eventbus-dogfood — exe=${APP_EXE}`);
  console.log(`home=${home} suffix=${suffix}\n`);

  app = spawnApp();
  try {
    // ---- boot ----
    console.log('=== boot (isolated packaged instance) ===');
    const cdp = await app.waitForCdp(30000).catch(() => null);
    check('boot: app exposed a CDP port (main process alive)', cdp != null, cdp != null ? `port ${cdp}` : 'no CDP line');
    const daemonUp = await waitDaemonPipeFile(30000);
    check('boot: daemon pipe file appeared', daemonUp);
    TOKEN = await waitMainToken(15000);
    check('boot: main-pipe auth token present (suffix-aware path)', !!TOKEN,
      TOKEN ? `…/.wmux${suffix}-auth-token` : `MISSING at ${authTokenPath}`);
    if (!TOKEN) throw new Error('no main-pipe token — cannot drive RPC');

    const initialWs = await waitRendererReady(TOKEN, 30000);
    check('boot: renderer ready (workspace.list round-trip)', Array.isArray(initialWs),
      `${initialWs.length} initial workspace(s)`);

    // ---- ensure 3 distinct workspaces: A(sender) B(receiver) C(third party) ----
    console.log('\n=== setup: 3 workspaces (A=sender, B=receiver, C=third-party) ===');
    let wsList = await rpcCall(mainPipe, TOKEN, 'workspace.list', {});
    while (wsList.length < 3) {
      await rpcCall(mainPipe, TOKEN, 'workspace.new', { name: `a2a-dog-${wsList.length + 1}` });
      await sleep(150);
      wsList = await rpcCall(mainPipe, TOKEN, 'workspace.list', {});
    }
    const idOf = (w) => (typeof w?.id === 'string' ? w.id : w?.workspaceId);
    const [A, B, C] = wsList.map(idOf);
    const allDistinct = A && B && C && new Set([A, B, C]).size === 3;
    check('setup: 3 distinct workspace ids resolved', allDistinct, `A=${A} B=${B} C=${C}`);
    if (!allDistinct) throw new Error('could not resolve 3 distinct workspaces');

    // ---- send A→B (silent:true → no PTY paste, but `created` still emitted) ----
    console.log('\n=== a2a.task.send  A → B  (silent: pointer-only) ===');
    const sendRes = await rpcCall(mainPipe, TOKEN, 'a2a.task.send', {
      workspaceId: A, to: B, title: 'dogfood scoping task',
      message: 'scoping probe body — must NOT leak to a third workspace',
      silent: true,
    });
    const taskId = sendRes?.taskId;
    check('send: a2a.task.send returned a taskId', typeof taskId === 'string' && taskId.length > 0, `taskId=${taskId}`);
    if (!taskId) throw new Error('send did not return a taskId');
    await sleep(400); // let emit land on the ring

    // ---- the four vantage points on `created` ----
    console.log('\n=== poll: dual-party scoping on the `created` event ===');
    const bCreated = await a2aPoll(B);
    check('receiver B sees the created a2a.task (dual-party `to` key)',
      kinds(bCreated, taskId).includes('created'),
      `B a2a events: ${JSON.stringify(bCreated.map((e) => e.kind))}`);

    const aCreated = await a2aPoll(A);
    check('sender A sees the created a2a.task (base workspaceId === from)',
      kinds(aCreated, taskId).includes('created'),
      `A a2a events: ${JSON.stringify(aCreated.map((e) => e.kind))}`);

    const cCreated = await a2aPoll(C);
    check('★ MAKE-OR-BREAK: third workspace C sees ZERO a2a.task',
      cCreated.length === 0,
      cCreated.length === 0 ? 'C sees nothing' : `LEAK! C saw ${JSON.stringify(cCreated)}`);

    const unscoped = await a2aPoll(undefined);
    check('★ unscoped poll (no workspaceId) sees ZERO a2a.task (plugin-host leak guard)',
      unscoped.length === 0,
      unscoped.length === 0 ? 'unscoped sees nothing' : `LEAK! unscoped saw ${JSON.stringify(unscoped)}`);

    // ---- update (B → working): sender A must get the receipt ----
    console.log('\n=== a2a.task.update  B sets working  → sender receipt ===');
    await rpcCall(mainPipe, TOKEN, 'a2a.task.update', { taskId, workspaceId: B, status: 'working' });
    await sleep(400);
    const aAfterUpd = await a2aPoll(A);
    check('sender A sees the `updated` receipt (working transition)',
      kinds(aAfterUpd, taskId).includes('updated'),
      `A a2a kinds: ${JSON.stringify(kinds(aAfterUpd, taskId))}`);
    const cAfterUpd = await a2aPoll(C);
    check('third workspace C STILL sees ZERO after update',
      cAfterUpd.length === 0,
      cAfterUpd.length === 0 ? 'C still blind' : `LEAK! ${JSON.stringify(cAfterUpd)}`);

    // ---- cancel (B): both parties see cancelled, C never ----
    console.log('\n=== a2a.task.cancel  B cancels  → both parties, never C ===');
    await rpcCall(mainPipe, TOKEN, 'a2a.task.cancel', { taskId, workspaceId: B });
    await sleep(400);
    const aFinal = await a2aPoll(A);
    const bFinal = await a2aPoll(B);
    const cFinal = await a2aPoll(C);
    check('sender A sees the full lifecycle created→updated→cancelled',
      ['created', 'updated', 'cancelled'].every((k) => kinds(aFinal, taskId).includes(k)),
      `A kinds: ${JSON.stringify(kinds(aFinal, taskId))}`);
    check('receiver B sees created + cancelled',
      kinds(bFinal, taskId).includes('created') && kinds(bFinal, taskId).includes('cancelled'),
      `B kinds: ${JSON.stringify(kinds(bFinal, taskId))}`);
    check('★ third workspace C saw ZERO across the ENTIRE lifecycle',
      cFinal.length === 0,
      cFinal.length === 0 ? 'C blind start→finish' : `LEAK! ${JSON.stringify(cFinal)}`);

    // ---- strict-path control: a non-a2a poll for C still works normally ----
    // (a2a scoping must not have perturbed the generic strict gate)
    const cAllRaw = await rpcCall(mainPipe, TOKEN, 'events.poll', { cursor: 0, workspaceId: C });
    const cLeakAny = (cAllRaw?.events || []).some((e) => e.type === 'a2a.task');
    check('control: C\'s UNFILTERED poll still contains no a2a.task (strict path intact)',
      !cLeakAny, cLeakAny ? 'a2a leaked into unfiltered C poll' : `C unfiltered events: ${(cAllRaw?.events || []).length}`);
  } catch (err) {
    check('FATAL during scenario', false, err.stack || err.message);
  }

  // ---- cleanup ----
  console.log('\n=== cleanup ===');
  await killAppOnly(app);
  const killedDaemonPid = await shutdownDaemon();
  await sleep(500);
  const daemonGone = killedDaemonPid == null || !pidAlive(killedDaemonPid);
  const appExited = app.proc.exitCode !== null || app.proc.signalCode !== null
    || app.proc.pid == null || !pidAlive(app.proc.pid);
  check('cleanup: daemon terminated (zombie-free)', daemonGone,
    killedDaemonPid ? `pid ${killedDaemonPid} ${daemonGone ? 'gone' : 'STILL ALIVE'}` : 'no daemon pid');
  check('cleanup: app process exited', appExited,
    `exit=${app.proc.exitCode}/sig=${app.proc.signalCode}/alive=${app.proc.pid != null && pidAlive(app.proc.pid)}`);
  let rmOk = false;
  for (let i = 0; i < 5 && !rmOk; i++) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ } rmOk = !fs.existsSync(home); if (!rmOk) await sleep(300); }
  check('cleanup: temp HOME removed', rmOk);

  // ---- report ----
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) console.log('FAILED: ' + failed.map((r) => r.name).join('; '));
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL:', e.stack || e.message);
  try { await killAppOnly(app); } catch { /* */ }
  try { await shutdownDaemon(); } catch { /* */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  process.exit(2);
});

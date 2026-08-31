#!/usr/bin/env node
/**
 * A2A EventBus Inbox (S-C2 ②) — dynamic dogfood, Phase 2: SILENT-DEFAULT.
 *
 * WHAT THIS VERIFIES (against the PACKAGED exe, out/wmux-win32-x64/wmux.exe)
 * ------------------------------------------------------------------------
 * The per-receiver delivery default (plan §"Silent-default for TUI"):
 *   - receiver running a LIVE TUI agent  → a one-line NUDGE pasted to its PTY
 *     (`[wmux] new A2A task <id8> from <sender> — a2a_task_query`), NO message
 *     body, so a live agent's prompt/readline is not corrupted.
 *   - receiver with NO live agent          → today's LOUD full-body paste
 *     (never regress a peer that never polls).
 * Decision: useRpcBridge.ts isLiveTuiAgent(meta) — agentName present AND
 * agentStatus ∈ {running, waiting, awaiting_input}.
 *
 * HOW we make a receiver "live" without a real agent
 * --------------------------------------------------
 * agentName/agentStatus are set by the daemon AgentDetector (a REGEX detector,
 * src/main/pty/AgentDetector.ts) + the session:active burst signal
 * (DaemonNotificationRouter.ts:439 → agentStatus='running', agentName=<gate>).
 * The Claude Code gate is /Claude\s*Code|claude-code|╭.*Claude/. So we
 * `input.send` an `echo Claude Code` into the receiver's PTY: the detector's
 * gate matches (agentName='Claude Code') and the output burst flips
 * agentStatus='running'. We then POLL workspace.list until the live signal is
 * up and send IMMEDIATELY (onIdle re-clears 'running' ~2s after output stops —
 * DaemonNotificationRouter.ts:459 — so the live window is short).
 *
 * The no-agent receiver gets NO such echo: its metadata has no agentName, so
 * isLiveTuiAgent is false and it takes the loud-paste branch.
 *
 * Pure main-pipe RPC (no CDP): mcp.claimWorkspace spawns ws+PTY and returns the
 * ptyId; input.send writes; input.readScreen (ptyId only → ownership check
 * skipped, input.rpc.ts:198) captures the viewport; a2a.task.send with silent
 * UNSET exercises the per-receiver default. clientName 'wmux-cli' → the
 * curated internal-CLI lane (#1111 closes the envelope-less grandfather in the
 * first release on or after 2026-09-30).
 *
 * ISOLATION + CLEANUP identical to a2a-eventbus-dogfood.mjs (suffix-keyed temp
 * env, runs beside a live wmux untouched; app kill + daemon shutdown + rm).
 *
 * Run (PowerShell, package first):  npm run package; node scripts/a2a-silent-default-dogfood.mjs
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

if (process.platform !== 'win32') { console.log('a2a-silent-default-dogfood: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }

const suffix = `-a2asd${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2asd-'));
const env = {
  ...process.env,
  USERPROFILE: home, HOME: home, HOMEDRIVE: undefined, HOMEPATH: undefined,
  APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  WMUX_DATA_SUFFIX: suffix, WMUX_NO_DIALOG: '1',
};
delete env.WMUX_DISABLE_CDP;
fs.mkdirSync(env.APPDATA, { recursive: true });
fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
const userDataDir = path.join(env.APPDATA, `wmux${suffix}`);
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');

const wmuxDir = path.join(home, `.wmux${suffix}`);
const mainPipe = `\\\\.\\pipe\\wmux${suffix}-${USERNAME}`;
const authTokenPath = path.join(home, `.wmux${suffix}-auth-token`);

const readMainToken = () => { try { return fs.readFileSync(authTokenPath, 'utf8').trim() || null; } catch { return null; } };
const readDaemonPid = () => { try { const p = Number(fs.readFileSync(path.join(wmuxDir, 'daemon.pid'), 'utf8').trim()); return Number.isInteger(p) && p > 0 ? p : null; } catch { return null; } };
const readDaemonPipeName = () => { try { return fs.readFileSync(path.join(wmuxDir, 'daemon-pipe'), 'utf8').trim() || null; } catch { return null; } };
const readDaemonToken = () => { for (const p of [path.join(home, '.wmux', 'daemon-auth-token'), path.join(wmuxDir, 'daemon-auth-token')]) { try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t; } catch { /* */ } } return null; };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pipeAlive = (pipeName) => new Promise((resolve) => {
  const sock = net.createConnection(pipeName);
  const done = (v) => { try { sock.destroy(); } catch { /* */ } resolve(v); };
  sock.once('connect', () => done(true)); sock.once('error', () => done(false));
  setTimeout(() => done(false), 800);
});

// #1111: these calls used to omit clientName and ride the `legacy`
// grandfather. That lane closes in the first release on or after
// 2026-09-30, so the driver now identifies as 'wmux-cli' (the curated
// internal-CLI lane, src/main/mcp/internalCli.ts) which needs no approval
// dialog.
const DOGFOOD_CLIENT_NAME = 'wmux-cli';
function rpcCall(pipeName, token, method, params = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(pipeName);
    let buf = ''; let settled = false; const id = randomUUID();
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`rpc timeout: ${method}`))), timeoutMs);
    sock.setEncoding('utf8');
    sock.once('connect', () => sock.write(JSON.stringify({ id, method, params, token, clientName: DOGFOOD_CLIENT_NAME, clientVersion: '0.0.0-dogfood' }) + '\n'));
    sock.once('error', (e) => finish(() => reject(e)));
    sock.on('data', (chunk) => {
      buf += chunk; let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
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
  let cdpPort = null; const cdpWaiters = [];
  let stdoutBuf = '';
  proc.stdout.on('data', (b) => {
    stdoutBuf += b.toString('utf8');
    const m = stdoutBuf.match(/CDP enabled on port (\d+)/);
    if (m && cdpPort === null) { cdpPort = Number(m[1]); for (const w of cdpWaiters.splice(0)) w(cdpPort); }
    if (stdoutBuf.length > 65536) stdoutBuf = stdoutBuf.slice(-4096);
  });
  proc.stderr.on('data', () => { /* drain */ });
  const waitForCdp = (timeoutMs) => new Promise((resolve, reject) => {
    if (cdpPort !== null) return resolve(cdpPort);
    cdpWaiters.push(resolve);
    setTimeout(() => reject(new Error('timeout waiting for CDP port line')), timeoutMs);
  });
  return { proc, t0, get cdpPort() { return cdpPort; }, waitForCdp };
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
async function waitRendererReady(token, timeoutMs) {
  const dl = Date.now() + timeoutMs; let lastErr = '';
  while (Date.now() < dl) {
    try { const r = await rpcCall(mainPipe, token, 'workspace.list', {}, 4000); if (Array.isArray(r)) return r; }
    catch (e) { lastErr = e.message; }
    await sleep(200);
  }
  throw new Error(`renderer never became ready (last: ${lastErr})`);
}
async function killAppOnly(a) {
  if (!a) return;
  try { a.proc.kill(); } catch { /* */ }
  const dl = Date.now() + 6000;
  while (a.proc.exitCode === null && Date.now() < dl) await sleep(100);
  if (a.proc.exitCode === null) { try { a.proc.kill('SIGKILL'); } catch { /* */ } }
  const pdl = Date.now() + 5000;
  while (Date.now() < pdl && await pipeAlive(mainPipe)) await sleep(150);
}
async function shutdownDaemon() {
  const pipeName = readDaemonPipeName(); const token = readDaemonToken(); const daemonPid = readDaemonPid();
  if (pipeName && token && await pipeAlive(pipeName)) { try { await rpcCall(pipeName, token, 'daemon.shutdown', {}, 5000); } catch { /* */ } }
  const dl = Date.now() + 6000;
  while (daemonPid && pidAlive(daemonPid) && Date.now() < dl) await sleep(150);
  if (daemonPid && pidAlive(daemonPid)) { try { process.kill(daemonPid); } catch { /* */ } await sleep(300); if (pidAlive(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch { /* */ } } }
  return daemonPid;
}

let TOKEN = null;
const idOf = (w) => (typeof w?.id === 'string' ? w.id : w?.workspaceId);
const claim = (name) => rpcCall(mainPipe, TOKEN, 'mcp.claimWorkspace', { name });
const wsMeta = async (wsId) => {
  const list = await rpcCall(mainPipe, TOKEN, 'workspace.list', {});
  const w = list.find((x) => idOf(x) === wsId);
  return w?.metadata ?? {};
};
const readScreen = async (ptyId) => {
  const r = await rpcCall(mainPipe, TOKEN, 'input.readScreen', { ptyId });
  return typeof r?.text === 'string' ? r.text : '';
};
const isLive = (m) => !!m?.agentName && ['running', 'waiting', 'awaiting_input'].includes(m?.agentStatus);

// Drive the receiver into a live-Claude state via the AgentDetector gate, then
// confirm via workspace.list. Returns the live metadata (or null if it never lit).
async function makeLive(ptyId, wsId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await rpcCall(mainPipe, TOKEN, 'input.send', { ptyId, text: 'echo Claude Code\r' });
    const dl = Date.now() + 4000;
    while (Date.now() < dl) {
      const m = await wsMeta(wsId);
      if (isLive(m)) return m;
      await sleep(120);
    }
  }
  return null;
}

async function main() {
  console.log(`a2a-silent-default-dogfood — exe=${APP_EXE}`);
  console.log(`home=${home} suffix=${suffix}\n`);

  const LIVE_BODY = 'ZZNUDGEBODYZZ_must_not_paste';
  const PASTE_BODY = 'ZZPASTEBODYZZ_must_paste';
  const UPDATE_BODY = 'ZZUPDATEBODYZZ_must_not_paste';

  app = spawnApp();
  try {
    console.log('=== boot (isolated packaged instance) ===');
    const cdp = await app.waitForCdp(30000).catch(() => null);
    check('boot: app exposed a CDP port (main alive)', cdp != null, cdp != null ? `port ${cdp}` : 'no CDP');
    check('boot: daemon pipe file appeared', await waitDaemonPipeFile(30000));
    TOKEN = await waitMainToken(15000);
    check('boot: main-pipe auth token present', !!TOKEN);
    if (!TOKEN) throw new Error('no main-pipe token');
    await waitRendererReady(TOKEN, 30000);
    check('boot: renderer ready (workspace.list round-trip)', true);

    // ---- claim 3 workspaces, each with a real PTY ----
    console.log('\n=== setup: claim A(sender) / B(live receiver) / D(no-agent receiver), each + PTY ===');
    const a = await claim('a2a-sender');
    const b = await claim('a2a-recv-live');
    const d = await claim('a2a-recv-noagent');
    const A = a?.workspaceId, B = b?.workspaceId, D = d?.workspaceId;
    const ptyB = b?.ptyId, ptyD = d?.ptyId;
    const ok3 = A && B && D && ptyB && ptyD && new Set([A, B, D]).size === 3;
    check('setup: 3 claimed workspaces with PTYs', ok3, `A=${A} B=${B}(${ptyB}) D=${D}(${ptyD})`);
    if (!ok3) throw new Error('claim setup failed');
    await sleep(800); // let claimed PTYs settle (initial prompt burst → idle) before we drive B live

    // ---- drive B into a live-Claude state ----
    console.log('\n=== make B a live TUI agent (AgentDetector gate: "Claude Code") ===');
    const liveMeta = await makeLive(ptyB, B);
    check('setup: receiver B detected as a LIVE agent (agentName + running)',
      isLive(liveMeta),
      liveMeta ? `agentName=${JSON.stringify(liveMeta.agentName)} agentStatus=${JSON.stringify(liveMeta.agentStatus)}` : 'never went live');

    // ---- LIVE receiver: send (silent UNSET) → expect a one-line NUDGE, no body ----
    console.log('\n=== send A → B (live): expect NUDGE (pointer), NOT the body ===');
    const sendB = await rpcCall(mainPipe, TOKEN, 'a2a.task.send', {
      workspaceId: A, to: B, title: 'live-receiver delivery', message: LIVE_BODY,
    });
    check('send→B returned a taskId', typeof sendB?.taskId === 'string', `taskId=${sendB?.taskId}`);
    await sleep(1500);
    const screenB = await readScreen(ptyB);
    const sawNudge = screenB.includes('a2a_task_query');
    const sawBodyB = screenB.includes(LIVE_BODY);
    check('★ LIVE receiver B got the one-line NUDGE (contains "a2a_task_query")', sawNudge,
      sawNudge ? 'nudge present' : `nudge marker absent. tail=${JSON.stringify(screenB.replace(/\s+/g, ' ').slice(-180))}`);
    check('★ LIVE receiver B did NOT get the message body (prompt not flooded)', !sawBodyB,
      sawBodyB ? `BODY LEAKED into live prompt: ${LIVE_BODY}` : 'body correctly withheld');

    // ---- NO-AGENT receiver: send (silent UNSET) → expect LOUD full-body paste ----
    console.log('\n=== send A → D (no agent): expect LOUD body paste (no silent-drop regression) ===');
    const metaD = await wsMeta(D);
    check('control: receiver D is NOT a live agent (no agentName)', !isLive(metaD),
      `agentName=${JSON.stringify(metaD.agentName)} agentStatus=${JSON.stringify(metaD.agentStatus)}`);
    const sendD = await rpcCall(mainPipe, TOKEN, 'a2a.task.send', {
      workspaceId: A, to: D, title: 'no-agent delivery', message: PASTE_BODY,
    });
    check('send→D returned a taskId', typeof sendD?.taskId === 'string', `taskId=${sendD?.taskId}`);
    await sleep(1500);
    const screenD = await readScreen(ptyD);
    const sawBodyD = screenD.includes(PASTE_BODY);
    check('★ NO-AGENT receiver D got the LOUD full-body paste', sawBodyD,
      sawBodyD ? 'body delivered' : `body absent. tail=${JSON.stringify(screenD.replace(/\s+/g, ' ').slice(-180))}`);

    // ---- a2a.task.update (message) to the LIVE receiver B → expect NUDGE ----
    // Regression lock for PR #232 review (CodeRabbit): the update delivery path
    // must honor the SAME live-agent silent-default as send — not always paste
    // the full body. A (sender) appends a message to the existing task; it
    // delivers to B (live), which must get the one-line nudge, not the body.
    console.log('\n=== update A → B (live): expect NUDGE on update path too (not body) ===');
    const updTaskId = sendB?.taskId;
    if (typeof updTaskId === 'string') {
      const updRes = await rpcCall(mainPipe, TOKEN, 'a2a.task.update', {
        workspaceId: A, taskId: updTaskId, message: UPDATE_BODY,
      });
      check('update→B returned ok', updRes?.ok === true, `ok=${JSON.stringify(updRes?.ok)}`);
      await sleep(1500);
      const screenB2 = await readScreen(ptyB);
      // Core invariant: the update body must NOT be pasted into the live prompt.
      // (Nudge presence isn't asserted here — the prior send already left an
      // 'a2a_task_query' nudge on B's screen, so it can't distinguish this
      // delivery. The body marker is unique to the update, so its ABSENCE is the
      // honest signal that update honored silent-default instead of loud paste.)
      const sawUpdateBody = screenB2.includes(UPDATE_BODY);
      check('★ LIVE receiver B did NOT get the update body pasted (update path honors silent-default)', !sawUpdateBody,
        sawUpdateBody ? `UPDATE BODY LEAKED into live prompt: ${UPDATE_BODY}` : 'update body correctly withheld from live prompt');
    } else {
      check('update→B precondition (prior send taskId present)', false, 'no taskId from send→B');
    }
  } catch (err) {
    check('FATAL during scenario', false, err.stack || err.message);
  }

  // ---- cleanup ----
  console.log('\n=== cleanup ===');
  await killAppOnly(app);
  const killedDaemonPid = await shutdownDaemon();
  await sleep(500);
  const daemonGone = killedDaemonPid == null || !pidAlive(killedDaemonPid);
  const appExited = app.proc.exitCode !== null || app.proc.signalCode !== null || app.proc.pid == null || !pidAlive(app.proc.pid);
  check('cleanup: daemon terminated (zombie-free)', daemonGone, killedDaemonPid ? `pid ${killedDaemonPid} ${daemonGone ? 'gone' : 'ALIVE'}` : 'no daemon pid');
  check('cleanup: app process exited', appExited);
  let rmOk = false;
  for (let i = 0; i < 5 && !rmOk; i++) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ } rmOk = !fs.existsSync(home); if (!rmOk) await sleep(300); }
  check('cleanup: temp HOME removed', rmOk);

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

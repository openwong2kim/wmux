/*
 * Live dogfood — A2A symmetric from.ptyId reply + role-per-pane + pane-authz (S-C2).
 *
 * Builds on same-ws-a2a-dogfood. Proves the S-C2 deltas over the pure main-pipe
 * RPC, passing senderPtyId verbatim the way the MCP server would after a verified
 * PID-map hit:
 *   P0    — a new task stores the SENDER pane anchor in metadata.from (symmetric
 *           with `to`), captured from the validated senderPtyId.
 *   P1    — a reply computes its history role PER PANE: the receiver pane's reply
 *           is 'agent', the sender pane's reply is 'user' (was always 'user' for
 *           a same-ws task — the role-collapse this work fixes).
 *   P0/A5 — a status update with NO senderPtyId (the headless worker path) still
 *           passes ws-authz even on a pane-addressed task (never locked out).
 *   P2    — a status update from a SIBLING pane (right ws, wrong pane) is
 *           REJECTED; from the ADDRESSED pane it is allowed.
 *   xws   — from-pane capture + reply role are preserved across workspaces.
 *
 * Single ISOLATED packaged instance (out/wmux-win32-x64/wmux.exe + a unique
 * WMUX_DATA_SUFFIX so it never touches the user's real wmux). Drives the pure
 * main-pipe RPC (clientName omitted → grandfather).
 *
 * Run (PowerShell): npm run package; node scripts/a2a-symmetric-reply-dogfood.mjs
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
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'win32') { console.log('a2a-symmetric-reply-dogfood: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }

const suffix = `-symreplydog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-symreplydog-'));
const env = {
  ...process.env,
  USERPROFILE: home, HOME: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  WMUX_DATA_SUFFIX: suffix, WMUX_NO_DIALOG: '1',
};
delete env.HOMEDRIVE; delete env.HOMEPATH;
fs.mkdirSync(env.APPDATA, { recursive: true });
fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
const userDataDir = path.join(env.APPDATA, `wmux${suffix}`);
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');

const mainPipe = `\\\\.\\pipe\\wmux${suffix}-${USERNAME}`;
const authTokenPath = path.join(home, `.wmux${suffix}-auth-token`);

function readMainToken() { try { return fs.readFileSync(authTokenPath, 'utf8').trim() || null; } catch { return null; } }

function rpcCall(method, params = {}, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(mainPipe);
    let buf = ''; let settled = false; const id = randomUUID();
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`rpc timeout: ${method}`))), timeoutMs);
    sock.setEncoding('utf8');
    sock.once('connect', () => sock.write(JSON.stringify({ id, method, params, token: TOKEN }) + '\n'));
    sock.once('error', (e) => finish(() => reject(e)));
    sock.on('data', (chunk) => {
      buf += chunk; let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        finish(() => resolve(msg));
        return;
      }
    });
  });
}
const rpcResult = async (m, p, o) => { const r = await rpcCall(m, p, o); if (r && r.ok === false) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error)); return r?.result ?? r; };
// Normalize a send/update response to { ok, taskId, error } from the HANDLER
// payload — NEVER the transport-level envelope `ok` (true whenever the RPC didn't
// throw, even when the handler returned { error }).
const sendResp = (r) => {
  // Use ONLY the handler payload (r.result). A missing/invalid payload is a
  // failure with a diagnostic — never the transport-level envelope `ok` (true on
  // any non-throwing RPC), which would mask a missing handler response as a pass.
  const envelope = (r && typeof r === 'object') ? r : {};
  const p = envelope.result;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    const error = typeof envelope.error === 'string' ? envelope.error : `unexpected response: ${JSON.stringify(r)}`;
    return { ok: false, error };
  }
  const error = typeof p.error === 'string' ? p.error : (p.error ? JSON.stringify(p.error) : undefined);
  const taskId = typeof p.taskId === 'string' ? p.taskId : undefined;
  return { ok: !error && (p.ok === true || !!taskId), taskId, error };
};

function spawnApp() {
  const proc = spawn(APP_EXE, [], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  const drain = () => undefined;
  proc.stdout.on('data', drain); proc.stderr.on('data', drain);
  return proc;
}
async function waitMainToken(timeoutMs) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) { const t = readMainToken(); if (t) return t; await sleep(120); }
  return null;
}
async function waitRendererReady(timeoutMs) {
  const dl = Date.now() + timeoutMs; let last = '';
  while (Date.now() < dl) {
    try { const r = await rpcCall('workspace.list', {}, { timeoutMs: 4000 }); if (r && Array.isArray(r.result) && r.result.length > 0) return r.result; }
    catch (e) { last = e.message; }
    await sleep(250);
  }
  throw new Error(`renderer not ready (${last})`);
}

let TOKEN = null;

async function main() {
  console.log(`a2a-symmetric-reply-dogfood — exe=${APP_EXE}`);
  app = spawnApp();
  TOKEN = await waitMainToken(20000);
  if (!TOKEN) throw new Error('main token never appeared');
  const wss = await waitRendererReady(30000);
  check('renderer ready + default workspace exists', wss.length >= 1, `workspaces=${wss.length}`);
  if (wss.length < 1) throw new Error('no workspace at boot — cannot run the dogfood');
  const ws1 = wss[0].id;

  // Split ws1 into THREE addressable terminal panes up front: A = sender,
  // B = receiver, C = a third non-participant pane (for the codex P2 check).
  // Two splits, each pinned to ws1 (pane.split honors workspaceId, #238).
  await rpcResult('pane.split', { workspaceId: ws1, direction: 'vertical' }).catch((e) => console.log('  (split1 note:', e.message, ')'));
  await rpcResult('pane.split', { workspaceId: ws1, direction: 'horizontal' }).catch((e) => console.log('  (split2 note:', e.message, ')'));
  let surfaces = [];
  for (let i = 0; i < 60; i++) {
    surfaces = (await rpcResult('surface.list', { workspaceId: ws1 })).filter((s) => s.surfaceType !== 'browser' && s.ptyId);
    if (surfaces.length >= 3) break;
    await sleep(250);
  }
  check('ws1 has at least two terminal surfaces after split', surfaces.length >= 2, `surfaces=${surfaces.length}`);
  if (surfaces.length < 2) throw new Error('need two panes to test symmetric reply');
  const surfA = surfaces[0];
  const surfB = surfaces[1];
  const surfC = surfaces[2]; // third pane (non-participant); may be undefined
  console.log(`  paneA pty=${surfA.ptyId} surf=${surfA.id} | paneB pty=${surfB.ptyId} surf=${surfB.id} | paneC surf=${surfC?.id ?? 'none'}`);

  const getTask = async (ws, id) => {
    const q = await rpcResult('a2a.task.query', { workspaceId: ws });
    return (q.tasks || []).find((t) => t.id === id);
  };

  // ── P0: same-ws A→B new task captures the SENDER pane anchor in `from` ──
  const t1 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws1, to: ws1, surfaceId: surfB.id, senderPtyId: surfA.ptyId,
    message: 'A asks B', title: 'roundtrip', silent: true,
  }));
  check('same-ws A→B new task SUCCEEDS', t1.ok && !!t1.taskId, JSON.stringify(t1));
  const task1 = await getTask(ws1, t1.taskId);
  check('★ P0: from.surfaceId captured = sender pane A', task1?.metadata?.from?.surfaceId === surfA.id,
    `from.surfaceId=${task1?.metadata?.from?.surfaceId}`);
  check('P0: to.surfaceId pinned = receiver pane B', task1?.metadata?.to?.surfaceId === surfB.id,
    `to.surfaceId=${task1?.metadata?.to?.surfaceId}`);
  const paneA = task1?.metadata?.from?.paneId;
  const paneB = task1?.metadata?.to?.paneId;
  check('P0: from/to paneIds both resolved and distinct', !!paneA && !!paneB && paneA !== paneB, `from=${paneA} to=${paneB}`);

  // ── P1: receiver (B) reply → role 'agent'; sender (A) reply → 'user' ──
  const r1 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws1, taskId: t1.taskId, senderPtyId: surfB.ptyId, message: 'B answers A', silent: true,
  }));
  check('receiver pane B replies SUCCEEDS', r1.ok, JSON.stringify(r1));
  const r2 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws1, taskId: t1.taskId, senderPtyId: surfA.ptyId, message: 'A follows up', silent: true,
  }));
  check('sender pane A replies SUCCEEDS', r2.ok, JSON.stringify(r2));

  const task1b = await getTask(ws1, t1.taskId);
  const hist = task1b?.history || [];
  const roleAt = (i) => hist[i]?.role;
  check('P1: initial sender (A) message role = user', roleAt(0) === 'user', `role0=${roleAt(0)}`);
  check('★ P1: receiver (B) reply role = agent (per-pane; was always user same-ws)', roleAt(1) === 'agent', `role1=${roleAt(1)}`);
  check('★ P1: sender (A) follow-up role = user', roleAt(2) === 'user', `role2=${roleAt(2)}`);

  // ── P0/A5: a status update with NO senderPtyId (worker path) passes ws-authz ──
  // The task is pane-addressed (to.paneId=B); gating on to.paneId would lock out
  // the headless ClaudeWorker (which sends no senderPtyId). Absent callerAddr ⇒
  // ws-authz, so the receiver ws can still drive the task forward.
  const u1 = sendResp(await rpcCall('a2a.task.update', {
    workspaceId: ws1, taskId: t1.taskId, status: 'working',
  }));
  check('★ P0/A5: update WITHOUT senderPtyId passes (worker not locked out)', u1.ok, JSON.stringify(u1));
  const task1c = await getTask(ws1, t1.taskId);
  check('P0/A5: task transitioned to working', task1c?.status?.state === 'working', `state=${task1c?.status?.state}`);

  // ── P2: a status update from a SIBLING pane (A, not the addressed B) is rejected ──
  const u2 = sendResp(await rpcCall('a2a.task.update', {
    workspaceId: ws1, taskId: t1.taskId, status: 'completed', senderPtyId: surfA.ptyId,
  }));
  check('★ P2: update from sibling pane A (not addressed B) is REJECTED',
    !u2.ok && /addressed receiver pane/.test(u2.error || ''), `err=${u2.error}`);
  const task1c2 = await getTask(ws1, t1.taskId);
  check('P2: task still working after the rejected sibling update', task1c2?.status?.state === 'working', `state=${task1c2?.status?.state}`);

  // ── P2: a status update from the ADDRESSED pane (B) is allowed ──
  const u3 = sendResp(await rpcCall('a2a.task.update', {
    workspaceId: ws1, taskId: t1.taskId, status: 'completed', senderPtyId: surfB.ptyId,
  }));
  check('★ P2: update from addressed pane B is ALLOWED', u3.ok, JSON.stringify(u3));
  const task1d = await getTask(ws1, t1.taskId);
  check('P2: task completed by the addressed pane', task1d?.status?.state === 'completed', `state=${task1d?.status?.state}`);

  // ── codex P2: a VERIFIED third pane C (neither from nor to) is a
  // non-participant of the fully-anchored A→B task — its reply/update is rejected
  // rather than defaulting to the ws-level 'user' role (which would store C's
  // message as the sender's and nudge B). Best-effort: skip (not fail) if a third
  // pane didn't materialize — the guard is also covered by a structural test. ──
  if (surfC) {
    const cReply = sendResp(await rpcCall('a2a.task.send', {
      workspaceId: ws1, taskId: t1.taskId, senderPtyId: surfC.ptyId, message: 'C butts in', silent: true,
    }));
    check('★ codex P2: verified non-participant pane C reply is REJECTED',
      !cReply.ok && /not a participant/.test(cReply.error || ''), `err=${cReply.error}`);
    const cUpdate = sendResp(await rpcCall('a2a.task.update', {
      workspaceId: ws1, taskId: t1.taskId, message: 'C status note', senderPtyId: surfC.ptyId,
    }));
    check('★ codex P2: verified non-participant pane C update is REJECTED',
      !cUpdate.ok && /not a participant/.test(cUpdate.error || ''), `err=${cUpdate.error}`);
  } else {
    console.log('  (note: third pane did not materialize — codex P2 behavioral check skipped; covered by the structural test)');
  }

  // ── cross-ws no-regression: from-pane capture + reply role across workspaces ──
  const ws2 = (await rpcResult('workspace.new', { name: 'sender-ws' })).id;
  await sleep(500);
  let ws2Surfaces = [];
  for (let i = 0; i < 20; i++) {
    ws2Surfaces = (await rpcResult('surface.list', { workspaceId: ws2 })).filter((s) => s.surfaceType !== 'browser' && s.ptyId);
    if (ws2Surfaces.length >= 1) break;
    await sleep(250);
  }
  const ws2Surf = ws2Surfaces[0];
  check('ws2 has a terminal surface', !!ws2Surf, `surfaces=${ws2Surfaces.length}`);

  const t2 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws2, to: ws1, surfaceId: surfB.id, senderPtyId: ws2Surf?.ptyId,
    message: 'cross-ws task', title: 'xws', silent: true,
  }));
  check('cross-ws ws2→ws1 new task SUCCEEDS (back-compat)', t2.ok && !!t2.taskId, JSON.stringify(t2));
  const xtask = await getTask(ws1, t2.taskId);
  check('cross-ws P0: from.surfaceId captured = ws2 sender pane', xtask?.metadata?.from?.surfaceId === ws2Surf?.id,
    `from.surfaceId=${xtask?.metadata?.from?.surfaceId}`);

  // ws1 (receiver, pane B) replies → role 'agent'
  const xr1 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws1, taskId: t2.taskId, senderPtyId: surfB.ptyId, message: 'ws1 answers', silent: true,
  }));
  check('cross-ws receiver reply SUCCEEDS', xr1.ok, JSON.stringify(xr1));
  const xtaskb = await getTask(ws1, t2.taskId);
  check('★ cross-ws: receiver (ws1/B) reply role = agent', (xtaskb?.history || [])[1]?.role === 'agent',
    `role1=${(xtaskb?.history || [])[1]?.role}`);

  // ws2 (sender) replies → role 'user'
  const xr2 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws2, taskId: t2.taskId, senderPtyId: ws2Surf?.ptyId, message: 'ws2 follows up', silent: true,
  }));
  check('cross-ws sender reply SUCCEEDS', xr2.ok, JSON.stringify(xr2));
  const xtaskc = await getTask(ws1, t2.taskId);
  check('★ cross-ws: sender (ws2) reply role = user', (xtaskc?.history || [])[2]?.role === 'user',
    `role2=${(xtaskc?.history || [])[2]?.role}`);
}

main()
  .catch((e) => { console.error('FATAL', e); check('harness completed without fatal error', false, e.message); })
  .finally(async () => {
    try { await rpcResult('daemon.shutdown', {}).catch(() => undefined); } catch { /* */ }
    try { if (app) app.kill(); } catch { /* */ }
    await sleep(800);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\na2a-symmetric-reply-dogfood: ${passed}/${results.length} passed`);
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

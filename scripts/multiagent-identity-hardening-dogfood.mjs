/*
 * Live dogfood — multi-agent identity & addressing hardening.
 *
 * Reproduces the three demo repros over a single ISOLATED packaged instance
 * (out/wmux-win32-x64/wmux.exe + a unique WMUX_DATA_SUFFIX). Drives the pure
 * main-pipe RPC, passing senderPtyId verbatim the way the MCP server would after
 * a verified PID-map hit:
 *   P0  terminal omit-ptyId self-loop guard (input.send / input.sendKey)
 *   P1b a2a_whoami pane-level identity (two siblings differ; forged degrades)
 *   P1a duplicate-name workspace refusal (ambiguous → both IDs; ID-direct works)
 *
 * P2a (surface_list scoping) and P2b (suffix isolation) are covered by unit +
 * source-invariant tests (MCP-server identity path / boot launch), not reachable
 * over the raw main-pipe RPC, so they are out of this harness by design.
 *
 * Run (PowerShell): npm run package; node scripts/multiagent-identity-hardening-dogfood.mjs
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

if (process.platform !== 'win32') { console.log('mai-hardening-dogfood: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }

const suffix = `-maihard${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-maihard-'));
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

let TOKEN = null;
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
// Derive ok from the HANDLER payload (ok / error / taskId), never the transport
// envelope ok (true whenever the RPC didn't throw, even on a handler { error }).
const sendResp = (r) => {
  const p = (r && typeof r === 'object' && r.result && typeof r.result === 'object') ? r.result : (r ?? {});
  const error = typeof p.error === 'string' ? p.error : (typeof r?.error === 'string' ? r.error : undefined);
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
    try { const r = await rpcCall('workspace.list', {}, { timeoutMs: 4000 }); if (r && Array.isArray(r.result)) return r.result; }
    catch (e) { last = e.message; }
    await sleep(250);
  }
  throw new Error(`renderer not ready (${last})`);
}

async function main() {
  console.log(`multiagent-identity-hardening-dogfood — exe=${APP_EXE}`);
  app = spawnApp();
  TOKEN = await waitMainToken(20000);
  if (!TOKEN) throw new Error('main token never appeared');
  const wss = await waitRendererReady(30000);
  check('renderer ready + default workspace exists', wss.length >= 1, `workspaces=${wss.length}`);
  const ws1 = wss[0].id;

  // Split ws1 into two addressable terminal panes (A = caller, B = sibling).
  await rpcResult('pane.split', { direction: 'vertical' }).catch((e) => console.log('  (split note:', e.message, ')'));
  let surfaces = [];
  for (let i = 0; i < 40; i++) {
    surfaces = (await rpcResult('surface.list', { workspaceId: ws1 })).filter((s) => s.surfaceType !== 'browser' && s.ptyId);
    if (surfaces.length >= 2) break;
    await sleep(250);
  }
  check('ws1 has two terminal surfaces after split', surfaces.length >= 2, `surfaces=${surfaces.length}`);
  if (surfaces.length < 2) throw new Error('need two panes');
  const surfA = surfaces[0];
  const surfB = surfaces[1];
  console.log(`  paneA pty=${surfA.ptyId} surf=${surfA.id} | paneB pty=${surfB.ptyId} surf=${surfB.id}`);

  // ── P0 — terminal omit-ptyId self-loop guard ──
  const p0reject = await rpcCall('input.send', { workspaceId: ws1, senderPtyId: surfA.ptyId, text: 'P0 guard probe' });
  check('★ P0 omit-ptyId send from a first-party caller is REJECTED (explicit ptyId required)',
    p0reject.ok === false && /explicit ptyId/.test(p0reject.error || ''), p0reject.error);

  const p0key = await rpcCall('input.sendKey', { workspaceId: ws1, senderPtyId: surfA.ptyId, key: 'enter' });
  check('★ P0 input.sendKey parity — omit-ptyId first-party key send REJECTED',
    p0key.ok === false && /explicit ptyId/.test(p0key.error || ''), p0key.error);

  const p0ok = await rpcCall('input.send', { workspaceId: ws1, ptyId: surfB.ptyId, senderPtyId: surfA.ptyId, text: '' });
  check('★ P0 explicit-ptyId send NOT blocked even when senderPtyId is present',
    p0ok.ok === true, JSON.stringify(p0ok.result ?? p0ok.error));

  const p0ext = await rpcCall('input.send', { workspaceId: ws1, text: '' });
  check('P0 external caller (no senderPtyId) is NOT guarded — resolves active pane',
    p0ext.ok === true, JSON.stringify(p0ext.result ?? p0ext.error));

  // ── P1b — a2a_whoami pane-level identity ──
  const w1 = await rpcResult('a2a.whoami', { workspaceId: ws1, senderPtyId: surfA.ptyId });
  const w2 = await rpcResult('a2a.whoami', { workspaceId: ws1, senderPtyId: surfB.ptyId });
  check('★ P1b whoami(senderPtyId=surfA) resolves to surfA pane',
    w1.ptyId === surfA.ptyId && w1.surfaceId === surfA.id, `ptyId=${w1.ptyId} surf=${w1.surfaceId} pane=${w1.paneId}`);
  check('★ P1b two siblings get DIFFERENT pane identities (no ws-level collapse)',
    !!w1.ptyId && !!w2.ptyId && w1.ptyId !== w2.ptyId && w1.paneId !== w2.paneId, `A=${w1.ptyId} B=${w2.ptyId}`);
  const w3 = await rpcResult('a2a.whoami', { workspaceId: ws1 });
  check('P1b whoami WITHOUT senderPtyId degrades to ws-level (no ptyId leaked)',
    !w3.ptyId && w3.workspaceId === ws1, JSON.stringify({ ptyId: w3.ptyId, ws: w3.workspaceId }));
  const w4 = await rpcResult('a2a.whoami', { workspaceId: ws1, senderPtyId: 'pty-foreign-xyz' });
  check('★ P1b whoami with a FOREIGN senderPtyId degrades (fail-closed, no echo)',
    !w4.ptyId, `ptyId=${w4.ptyId}`);

  // ── P1a — duplicate-name workspace refusal ──
  const dupA = (await rpcResult('workspace.new', { name: 'dup-probe' })).id;
  const dupB = (await rpcResult('workspace.new', { name: 'dup-probe' })).id;
  await sleep(500);
  const amb = sendResp(await rpcCall('a2a.task.send', { workspaceId: ws1, to: 'dup-probe', message: 'x', silent: true }));
  check('★ P1a duplicate EXACT name is REJECTED (ambiguous, not silent first-wins)',
    !amb.ok && /ambiguous/i.test(amb.error || ''), amb.error);
  check('★ P1a ambiguity error lists BOTH workspace IDs',
    !!amb.error && amb.error.includes(dupA) && amb.error.includes(dupB), `dupA=${dupA} dupB=${dupB}`);
  const direct = sendResp(await rpcCall('a2a.task.send', { workspaceId: ws1, to: dupB, message: 'x', silent: true }));
  check('★ P1a ID-direct addressing under duplicate names SUCCEEDS',
    direct.ok && !!direct.taskId, JSON.stringify(direct));
}

main()
  .catch((e) => { console.error('FATAL', e); check('harness completed without fatal error', false, e.message); })
  .finally(async () => {
    try { await rpcResult('daemon.shutdown', {}).catch(() => undefined); } catch { /* */ }
    try { if (app) app.kill(); } catch { /* */ }
    await sleep(800);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\nmultiagent-identity-hardening-dogfood: ${passed}/${results.length} passed`);
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

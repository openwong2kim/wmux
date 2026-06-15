/*
 * Live dogfood — Part A: pane-level A2A identity + addressing.
 *
 * Spawns an isolated packaged wmux (out/wmux-win32-x64/wmux.exe) with
 * WMUX_DATA_SUFFIX isolation, splits the default workspace into two panes,
 * spoofs a DISTINCT agent identity into each pane's PTY (echo banners that the
 * AgentDetector gate matches), then verifies over the main-pipe RPC:
 *   - surface.list / pane.list / a2a.discover surface per-pane agent labels
 *     (one workspace, two distinguishable agents)
 *   - a2a_task_send with surface_id resolves to the right pane
 *   - a cross-ws surface_id is rejected (fail-closed, #163)
 *   - pane_id + disagreeing surface_id is rejected
 *
 * Run (PowerShell): npm run package; node scripts/a2a-pane-identity-dogfood.mjs
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

if (process.platform !== 'win32') { console.log('a2a-pane-identity-dogfood: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }

const suffix = `-paneiddog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-paneiddog-'));
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

const wmuxDir = path.join(home, `.wmux${suffix}`);
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

function spawnApp() {
  const proc = spawn(APP_EXE, [], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
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

let TOKEN = null;

async function main() {
  console.log(`a2a-pane-identity-dogfood — exe=${APP_EXE}`);
  app = spawnApp();
  TOKEN = await waitMainToken(20000);
  if (!TOKEN) throw new Error('main token never appeared');
  const wss = await waitRendererReady(30000);
  check('renderer ready + default workspace exists', wss.length >= 1, `workspaces=${wss.length}`);
  const ws1 = wss[0].id;

  // ws1 is the only workspace at boot → already active. Split its pane in two.
  await rpcResult('pane.split', { direction: 'vertical' }).catch((e) => console.log('  (split note:', e.message, ')'));
  await sleep(1500); // let the second pane auto-spawn its PTY

  // Discover the two surfaces of ws1.
  let surfaces = await rpcResult('surface.list', { workspaceId: ws1 });
  surfaces = surfaces.filter((s) => s.surfaceType !== 'browser' && s.ptyId);
  check('ws1 has two terminal surfaces after split', surfaces.length >= 2, `surfaces=${surfaces.length}`);
  if (surfaces.length < 2) throw new Error('need two panes to test pane identity');
  const surfA = surfaces[0];
  const surfB = surfaces[1];

  // Spoof distinct agent identities by echoing banners the AgentDetector gates on.
  // pane A → "Claude Code"; pane B → "OpenAI Codex" (Codex CLI gate).
  await rpcResult('input.send', { ptyId: surfA.ptyId, text: 'echo Claude Code\r' }).catch((e) => console.log('  (writeA:', e.message, ')'));
  await rpcResult('input.send', { ptyId: surfB.ptyId, text: 'echo OpenAI Codex\r' }).catch((e) => console.log('  (writeB:', e.message, ')'));

  // Wait for AgentDetector → METADATA_UPDATE → surfaceAgent to land.
  let labeledA = null, labeledB = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const sl = await rpcResult('surface.list', { workspaceId: ws1 });
    labeledA = sl.find((s) => s.id === surfA.id);
    labeledB = sl.find((s) => s.id === surfB.id);
    if (labeledA?.agentName && labeledB?.agentName && labeledA.agentName !== labeledB.agentName) break;
  }
  check('surface.list shows a per-pane agentName for pane A', !!labeledA?.agentName, `A=${labeledA?.agentName ?? 'null'}`);
  check('surface.list shows a per-pane agentName for pane B', !!labeledB?.agentName, `B=${labeledB?.agentName ?? 'null'}`);
  check('★ the two panes carry DISTINCT agent identities (gap 8 fixed)',
    !!labeledA?.agentName && !!labeledB?.agentName && labeledA.agentName !== labeledB.agentName,
    `A=${labeledA?.agentName} B=${labeledB?.agentName}`);

  // a2a.discover exposes per-pane addressable entries.
  const disc = await rpcResult('a2a.discover', {});
  const ws1Agent = (disc.agents || []).find((a) => a.url === ws1 || a.metadata?.workspaceId === ws1);
  const panes = ws1Agent?.panes || [];
  const paneLabels = panes.map((p) => p.agentName).filter(Boolean);
  check('a2a.discover returns per-pane entries for ws1', panes.length >= 2, `panes=${panes.length}`);
  check('★ a2a.discover panes[] distinguishes the two agents', new Set(paneLabels).size >= 2, `labels=${JSON.stringify(paneLabels)}`);

  // Second workspace as the SENDER (and the cross-ws reject source).
  const ws2 = (await rpcResult('workspace.new', { name: 'sender-ws' })).id;
  await sleep(500);
  const ws2Surfaces = (await rpcResult('surface.list', { workspaceId: ws2 })).filter((s) => s.surfaceType !== 'browser' && s.ptyId);
  const ws2Surf = ws2Surfaces[0];

  // Valid pane-addressed send: ws2 → ws1 surface B.
  const okSend = await rpcCall('a2a.task.send', { workspaceId: ws2, to: ws1, surfaceId: surfB.id, message: 'pane-routed hello', silent: true });
  const sentTaskId = okSend.result?.taskId ?? okSend.taskId;
  // Require BOTH ok:true AND a real taskId — a bare ok flag could be a false positive.
  check('a2a_task_send with a valid surface_id succeeds', (okSend.result?.ok === true || okSend.ok === true) && typeof sentTaskId === 'string' && sentTaskId.length > 0, JSON.stringify(okSend.result ?? okSend));
  // Confirm the task stored the pane address.
  const q = await rpcResult('a2a.task.query', { workspaceId: ws1 });
  const storedTask = (q.tasks || []).find((t) => t.id === sentTaskId);
  check('★ the task pinned to.surfaceId = pane B', storedTask?.metadata?.to?.surfaceId === surfB.id, `to.surfaceId=${storedTask?.metadata?.to?.surfaceId}`);

  // Cross-ws reject: ws2 → ws1 but addressing ws2's OWN surface (not in ws1).
  const crossWs = await rpcCall('a2a.task.send', { workspaceId: ws2, to: ws1, surfaceId: ws2Surf?.id ?? 'nonexistent', message: 'should fail', silent: true });
  const crossErr = crossWs.result?.error ?? crossWs.error;
  check('★ cross-ws surface_id is REJECTED (fail-closed #163)', typeof crossErr === 'string' && /not found in target workspace/.test(crossErr), `err=${crossErr}`);

  // Disagreement reject: pane A + surface B.
  const disagree = await rpcCall('a2a.task.send', { workspaceId: ws2, to: ws1, paneId: surfA.paneId, surfaceId: surfB.id, message: 'mismatch', silent: true });
  const disErr = disagree.result?.error ?? disagree.error;
  check('★ pane_id + disagreeing surface_id is REJECTED', typeof disErr === 'string' && /does not belong to pane_id/.test(disErr), `err=${disErr}`);
}

main()
  .catch((e) => { console.error('FATAL', e); check('harness completed without fatal error', false, e.message); })
  .finally(async () => {
    try { await rpcResult('daemon.shutdown', {}).catch(() => {}); } catch { /* */ }
    try { if (app) app.kill(); } catch { /* */ }
    await sleep(800);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\na2a-pane-identity-dogfood: ${passed}/${results.length} passed`);
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

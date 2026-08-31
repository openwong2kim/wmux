/*
 * Live dogfood — same-workspace multi-agent A2A (Track 1).
 *
 * Proves the headline fix: two agent panes in the SAME workspace can now address
 * each other via a2a_task_send (previously hard-rejected "cannot send to
 * yourself"), while a true self-send (own pane) and an ambiguous no-address send
 * are still rejected, and the cross-workspace fail-closed boundary is unchanged.
 *
 * Single ISOLATED packaged instance (out/wmux-win32-x64/wmux.exe + a unique
 * WMUX_DATA_SUFFIX so it never touches the user's real wmux). Drives the pure
 * main-pipe RPC (clientName omitted → grandfather), passing senderPtyId verbatim
 * the way the MCP server would after a verified PID-map hit.
 *
 * Verifies over the main-pipe RPC:
 *   - ws1 pane A → ws1 pane B (sibling surface_id + sibling senderPtyId) SUCCEEDS
 *     and pins to.surfaceId; the task is same-ws (from.ws === to.ws).
 *   - addressing your OWN pane (surface_id == sender, senderPtyId == that pty)
 *     is REJECTED ("cannot send to your own pane").
 *   - a same-ws send with NO pane address is REJECTED ("without addressing a
 *     specific pane").
 *   - same-ws sibling send with senderPtyId ABSENT still succeeds (silent
 *     fallback — delivery suppressed, task persisted).
 *   - cross-ws ws2 → ws1 paneB still SUCCEEDS (back-compat) and a cross-ws /
 *     foreign surface_id is REJECTED (fail-closed #163).
 *
 * Run (PowerShell): npm run package; node scripts/same-ws-a2a-dogfood.mjs
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

if (process.platform !== 'win32') { console.log('same-ws-a2a-dogfood: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }

const suffix = `-samewsdog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-samewsdog-'));
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

// #1111: these calls used to omit clientName and ride the `legacy`
// grandfather, which closes in the first release on or after 2026-09-30. The
// driver now identifies as 'wmux-cli' AND the sandbox trust DB is seeded with
// a matching `trusted` row (seedDogfoodTrust) declaring exactly the extra
// capabilities this script needs.
//
// Why the row and that particular name: this script also calls `wmux.internal`
// methods that no declaration can ever contain, so those can only ride the
// curated internal-CLI lane — which forces the name to 'wmux-cli'. The methods
// OUTSIDE that allowlist (a2a.task.send / a2a.task.query)
// fall through to normal enforcement, where the seeded declaration grants them.
// Nothing here widens a production allowlist: the row lives in this script's
// throwaway sandbox HOME and dies with it.
const DOGFOOD_CLIENT_NAME = 'wmux-cli';
const DOGFOOD_CAPABILITIES = ["a2a.send", "a2a.read"];

function seedDogfoodTrust(wmuxDir) {
  fs.mkdirSync(wmuxDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(wmuxDir, 'plugin-trust.json'),
    JSON.stringify({
      schemaVersion: 1,
      plugins: {
        [DOGFOOD_CLIENT_NAME]: {
          name: DOGFOOD_CLIENT_NAME,
          version: '0.0.0-dogfood',
          status: 'trusted',
          declaredCapabilities: DOGFOOD_CAPABILITIES,
          rationale: 'dogfood sandbox instance',
          firstSeen: now,
          lastSeen: now,
        },
      },
    }, null, 2),
    'utf8',
  );
}

// Seed BEFORE the app boots: the first RPC is already gated.
seedDogfoodTrust(path.join(home, `.wmux${suffix}`));
function rpcCall(method, params = {}, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(mainPipe);
    let buf = ''; let settled = false; const id = randomUUID();
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`rpc timeout: ${method}`))), timeoutMs);
    sock.setEncoding('utf8');
    sock.once('connect', () => sock.write(JSON.stringify({ id, method, params, token: TOKEN, clientName: DOGFOOD_CLIENT_NAME, clientVersion: '0.0.0-dogfood' }) + '\n'));
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
// Normalize a send response to { ok, taskId, error } from the HANDLER payload.
// CRUCIAL: derive ok from the handler result (ok / error / taskId), NEVER the
// transport-level envelope `ok` (which is true whenever the RPC didn't throw,
// even when the handler returned { error } — that conflation would mis-read a
// rejection as a success).
const sendResp = (r) => {
  const p = (r && typeof r === 'object' && r.result && typeof r.result === 'object') ? r.result : (r ?? {});
  const error = typeof p.error === 'string' ? p.error : undefined;
  const taskId = typeof p.taskId === 'string' ? p.taskId : undefined;
  return { ok: !error && (p.ok === true || !!taskId), taskId, error };
};

function spawnApp() {
  const proc = spawn(APP_EXE, [], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  const drain = () => undefined; // keep the pipes flowing without buffering
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

let TOKEN = null;

async function main() {
  console.log(`same-ws-a2a-dogfood — exe=${APP_EXE}`);
  app = spawnApp();
  TOKEN = await waitMainToken(20000);
  if (!TOKEN) throw new Error('main token never appeared');
  const wss = await waitRendererReady(30000);
  check('renderer ready + default workspace exists', wss.length >= 1, `workspaces=${wss.length}`);
  const ws1 = wss[0].id;

  // ws1 is the only workspace at boot → active. Split its pane into two so the
  // single workspace hosts two addressable terminal panes (A and B).
  await rpcResult('pane.split', { direction: 'vertical' }).catch((e) => console.log('  (split note:', e.message, ')'));

  // Poll until the second pane has auto-spawned its PTY (bounded), rather than a
  // fixed sleep that flakes on slower hosts.
  let surfaces = [];
  for (let i = 0; i < 40; i++) {
    surfaces = (await rpcResult('surface.list', { workspaceId: ws1 })).filter((s) => s.surfaceType !== 'browser' && s.ptyId);
    if (surfaces.length >= 2) break;
    await sleep(250);
  }
  check('ws1 has two terminal surfaces after split', surfaces.length >= 2, `surfaces=${surfaces.length}`);
  if (surfaces.length < 2) throw new Error('need two panes to test same-ws addressing');
  const surfA = surfaces[0]; // sender pane
  const surfB = surfaces[1]; // target sibling pane
  console.log(`  paneA pty=${surfA.ptyId} surf=${surfA.id} | paneB pty=${surfB.ptyId} surf=${surfB.id}`);

  // ── HEADLINE: same-ws A → B (sibling surface_id + sibling senderPtyId) ──
  // This is the exact call that used to hard-fail "cannot send to yourself".
  const t1 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws1, to: ws1, surfaceId: surfB.id, senderPtyId: surfA.ptyId,
    message: 'same-ws sibling hello', silent: true,
  }));
  check('★ same-ws A→B sibling send SUCCEEDS (was "cannot send to yourself")',
    t1.ok && typeof t1.taskId === 'string' && t1.taskId.length > 0, JSON.stringify(t1));

  // The task is genuinely same-workspace and pinned to pane B.
  const q1 = await rpcResult('a2a.task.query', { workspaceId: ws1 });
  const task1 = (q1.tasks || []).find((t) => t.id === t1.taskId);
  check('★ same-ws task pinned to.surfaceId = pane B', task1?.metadata?.to?.surfaceId === surfB.id, `to.surfaceId=${task1?.metadata?.to?.surfaceId}`);
  check('★ task is same-workspace (from.ws === to.ws === ws1)',
    task1?.metadata?.from?.workspaceId === ws1 && task1?.metadata?.to?.workspaceId === ws1,
    `from=${task1?.metadata?.from?.workspaceId} to=${task1?.metadata?.to?.workspaceId}`);

  // ── true-self reject: addressing your OWN pane (surface == sender pty) ──
  const t2 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws1, to: ws1, surfaceId: surfA.id, senderPtyId: surfA.ptyId,
    message: 'self loop attempt', silent: true,
  }));
  check('★ true self-send (own pane) is REJECTED',
    !t2.ok && typeof t2.error === 'string' && /your own pane/.test(t2.error), `err=${t2.error}`);

  // ── no-address reject: same-ws send without a pane address (ambiguous) ──
  const t3 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws1, to: ws1, senderPtyId: surfA.ptyId, message: 'ambiguous self', silent: true,
  }));
  check('★ same-ws send with NO pane address is REJECTED',
    !t3.ok && typeof t3.error === 'string' && /without addressing a specific pane/.test(t3.error), `err=${t3.error}`);

  // ── silent fallback: same-ws sibling send with senderPtyId ABSENT still ok ──
  // (the MCP env-hint path supplies no senderPtyId → renderer delivers silently
  // rather than rejecting; the task is still persisted + pollable.)
  const t4 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws1, to: ws1, surfaceId: surfB.id, message: 'no-sender-pty sibling', silent: false,
  }));
  check('same-ws sibling send WITHOUT senderPtyId still succeeds (silent fallback)',
    t4.ok && typeof t4.taskId === 'string' && t4.taskId.length > 0, JSON.stringify(t4));

  // ── back-compat + fail-closed: a second workspace as cross-ws sender ──
  const ws2 = (await rpcResult('workspace.new', { name: 'sender-ws' })).id;
  await sleep(500);
  const ws2Surfaces = (await rpcResult('surface.list', { workspaceId: ws2 })).filter((s) => s.surfaceType !== 'browser' && s.ptyId);
  const ws2Surf = ws2Surfaces[0];

  const t5 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws2, to: ws1, surfaceId: surfB.id, message: 'cross-ws hello', silent: true,
  }));
  check('cross-ws ws2 → ws1 paneB still SUCCEEDS (back-compat)',
    t5.ok && typeof t5.taskId === 'string' && t5.taskId.length > 0, JSON.stringify(t5));

  const t6 = sendResp(await rpcCall('a2a.task.send', {
    workspaceId: ws2, to: ws1, surfaceId: ws2Surf?.id ?? 'nonexistent', message: 'should fail', silent: true,
  }));
  check('★ cross-ws / foreign surface_id is REJECTED (fail-closed #163)',
    !t6.ok && typeof t6.error === 'string' && /not found in target workspace/.test(t6.error), `err=${t6.error}`);
}

main()
  .catch((e) => { console.error('FATAL', e); check('harness completed without fatal error', false, e.message); })
  .finally(async () => {
    try { await rpcResult('daemon.shutdown', {}).catch(() => undefined); } catch { /* */ }
    try { if (app) app.kill(); } catch { /* */ }
    await sleep(800);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\nsame-ws-a2a-dogfood: ${passed}/${results.length} passed`);
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

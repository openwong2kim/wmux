/*
 * Live dogfood — PROPER MCP identity fix (server-side process-tree walk).
 *
 * Proves the REAL packaged MCP server resolves its workspace identity from
 * main's SERVER-SIDE walk even when BOTH client-side resolution paths are gone:
 * the env hints are stripped (Codex behaviour) and — conceptually — the
 * client-side per-hop walk is unavailable. main correlates the MCP's own pid
 * (sent as `callerPid`) up the live process tree to the owning shell's pid-map
 * anchor, on its UNSANDBOXED side, and hands identity straight back.
 *
 * Topology trick: we spawn the real mcp-bundle as a CHILD of this script, then
 * anchor THIS SCRIPT's pid (the MCP's parent) in the isolated pid-map to the
 * live pane's ptyId. That mirrors the production shape "MCP is a descendant of
 * the pane's anchored shell" — server-walk: mcp.pid → script.pid(anchor) → pane.
 * The MCP is launched with the env hints SCRUBBED, so a resolved identity can
 * only have come from the server walk, confirmed by the `server-walk HIT` line
 * in the MCP's stderr (the client walk logs a different `walk HIT`).
 *
 *   A. WITH anchor   → a2a_whoami resolves ws + pane ptyId; stderr: server-walk HIT.
 *   B. WITHOUT anchor→ identity unknown (server miss + env stripped) — before/after.
 *   C. CHANNEL       → with anchor, a channel mutation passes the verified-sender
 *                      gate (fails only as CHANNEL_NOT_FOUND, never authz) — the
 *                      Codex channels-work win (inverse of wi-002's weak-env case).
 *
 * NOTE: proves the CODE PATH on the real bundle + a REAL Win32_Process snapshot.
 * Whether a live Codex's MCP is truly a descendant of the pane shell (§4 gate) is
 * confirmed by the user GUI dogfood; the diagnostic logs expose hit/miss/depth.
 *
 * Run (PowerShell): npm run package; node scripts/proper-mcp-identity-dogfood.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const APP_EXE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
const MCP_BUNDLE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'resources', 'mcp-bundle', 'index.js');
const USERNAME = os.userInfo().username || 'default';

const results = [];
let app = null;
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'win32') { console.log('proper-mcp-identity-dogfood: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }
if (!fs.existsSync(MCP_BUNDLE)) { console.error(`mcp bundle not found: ${MCP_BUNDLE} — run \`npm run package\` first`); process.exit(2); }

const suffix = `-propdog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-propdog-'));
const isoEnv = {
  ...process.env,
  USERPROFILE: home, HOME: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  WMUX_DATA_SUFFIX: suffix, WMUX_NO_DIALOG: '1',
};
delete isoEnv.HOMEDRIVE; delete isoEnv.HOMEPATH;
for (const k of Object.keys(isoEnv)) { if (/^WMUX_(WORKSPACE_ID|PTY_ID|SURFACE_ID|SOCKET_PATH)$/i.test(k)) delete isoEnv[k]; }
fs.mkdirSync(isoEnv.APPDATA, { recursive: true });
fs.mkdirSync(isoEnv.LOCALAPPDATA, { recursive: true });
const userDataDir = path.join(isoEnv.APPDATA, `wmux${suffix}`);
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');

// getPidMapDir() == `${USERPROFILE}/.wmux${SUFFIX}/pid-map` (shared/constants.ts).
const pidMapDir = path.join(home, `.wmux${suffix}`, 'pid-map');
const anchorFile = path.join(pidMapDir, String(process.pid)); // script pid = MCP's parent
function writeAnchor(ptyId) { fs.mkdirSync(pidMapDir, { recursive: true }); fs.writeFileSync(anchorFile, ptyId, 'utf8'); }
function removeAnchor() { try { fs.unlinkSync(anchorFile); } catch { /* */ } }

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

function spawnApp() {
  const proc = spawn(APP_EXE, [], { cwd: REPO_ROOT, env: isoEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
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

/**
 * Spawn the REAL packaged MCP server as a CHILD of this script (so its parent is
 * process.pid — the pid we anchor), do the MCP stdio handshake, call one tool,
 * and return { result, stderr }. `identityEnv` is intentionally minimal — the
 * env hints stay scrubbed so only the server-side walk can resolve identity.
 */
function mcpToolCall(toolName, args, identityEnv = {}, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...isoEnv, WMUX_SOCKET_PATH: mainPipe, ...identityEnv };
    const child = spawn(process.execPath, [MCP_BUNDLE], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let outBuf = ''; let errBuf = ''; let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch { /* */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`mcp timeout: ${toolName}\nstderr:\n${errBuf}`))), timeoutMs);
    child.stderr.on('data', (d) => { errBuf += d.toString(); });
    child.on('error', (e) => finish(() => reject(e)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outBuf += chunk; let nl;
      while ((nl = outBuf.indexOf('\n')) !== -1) {
        const line = outBuf.slice(0, nl).trim(); outBuf = outBuf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) { finish(() => resolve({ result: msg.result, error: msg.error, stderr: errBuf })); return; }
      }
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'propdog', version: '1.0.0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } });
  });
}
const toolText = (res) => (typeof res?.result?.content?.[0]?.text === 'string' ? res.result.content[0].text : '');

async function main() {
  console.log(`proper-mcp-identity-dogfood — exe=${APP_EXE}\n  pidMapDir=${pidMapDir}\n  anchor(script.pid)=${process.pid}`);
  app = spawnApp();
  TOKEN = await waitMainToken(20000);
  if (!TOKEN) throw new Error('main token never appeared');
  const wss = await waitRendererReady(30000);
  check('renderer ready + default workspace exists', wss.length >= 1, `workspaces=${wss.length}`);
  const ws1 = wss[0].id;

  await sleep(1200);
  const surfaces = (await rpcResult('surface.list', { workspaceId: ws1 })).filter((s) => s.surfaceType !== 'browser' && s.ptyId);
  check('default workspace has a terminal pane', surfaces.length >= 1, `surfaces=${surfaces.length}`);
  if (surfaces.length < 1) throw new Error('need a pane to anchor identity against');
  const panePtyId = surfaces[0].ptyId;
  console.log(`  pane ptyId = ${panePtyId}, ws = ${ws1}`);

  // ── A. WITH anchor — the server-side walk resolves identity (env scrubbed) ──
  writeAnchor(panePtyId);
  const withA = await mcpToolCall('a2a_whoami', {});
  const withText = toolText(withA);
  console.log(`  [A] whoami(text)=${withText.slice(0, 240)}`);
  check('★ A: a2a_whoami resolves the pane ptyId via the SERVER-SIDE walk (no env)',
    withText.includes(panePtyId), `expected ptyId ${panePtyId} in whoami`);
  check('A: whoami resolves the workspace too', withText.includes(ws1), `expected ws ${ws1}`);
  check('A: stderr proves the SERVER path fired (server-walk HIT, not client walk/env)',
    /server-walk HIT/.test(withA.stderr), withA.stderr.split('\n').filter((l) => /identity:/.test(l)).join(' | ').slice(0, 240));

  // ── B. WITHOUT anchor — server miss + env stripped → identity unknown ──
  removeAnchor();
  const noA = await mcpToolCall('a2a_whoami', {});
  const noText = toolText(noA);
  console.log(`  [B] whoami(text)=${noText.slice(0, 240)}`);
  check('★ B: without the anchor the pane ptyId is NOT recovered (before/after delta)',
    !noText.includes(panePtyId), 'ptyId must be absent when no ancestor is anchored and env is stripped');
  check('B: stderr shows env stripped (WMUX_PTY_ID=absent)', /WMUX_PTY_ID=absent/.test(noA.stderr), '');

  // ── C. CHANNEL — verified server-walk identity unlocks the channel gate ──
  // channel_post fails closed without a VERIFIED senderPtyId. With the anchor,
  // server-walk supplies one (MY_PTY_ID), so the gate PASSES and the only
  // remaining failure is the missing channel — never an authz/sender rejection.
  writeAnchor(panePtyId);
  const chan = await mcpToolCall('channel_post', { channel_id: 'nonexistent', text: 'hi', member_id: 'm1', member_name: 'M1' });
  const chanText = toolText(chan);
  console.log(`  [C] channel_post(text)=${chanText.slice(0, 200)} isError=${chan.result?.isError}`);
  const authzRejected = /NOT_AUTHORIZED|verifiable caller|no resolvable senderPtyId|identity unknown|cannot determine/i.test(chanText);
  const gatePassed = !authzRejected; // not-found / other is fine — the sender gate let us through
  check('★ C: verified server-walk identity passes the channel sender gate (Codex channels work)',
    gatePassed, `must NOT be an authz/sender rejection; got: ${chanText.slice(0, 160)}`);
  check('C: stderr proves identity came from the server walk', /server-walk HIT/.test(chan.stderr), '');
}

main()
  .catch((e) => { console.error('FATAL', e); check('harness completed without fatal error', false, e.message); })
  .finally(async () => {
    try { await rpcResult('daemon.shutdown', {}).catch(() => {}); } catch { /* */ }
    // Windows: app.kill() terminates only the main process — the Electron helper
    // tree + bundled daemon survive and lock the temp home. Tree-kill so repeated
    // dogfood runs don't accumulate zombies (daemon.shutdown above handles the
    // detached daemon; this sweeps main + helpers).
    try { if (app?.pid) spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
    await sleep(800);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    const passed = results.filter((r) => r.ok).length;
    console.log(`\nproper-mcp-identity-dogfood: ${passed}/${results.length} passed`);
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

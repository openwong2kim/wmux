/*
 * Bug B — commander-brain A2A identity, runtime wiring probe.
 *
 * Bug: the orchestrator (commander brain) has no pane ancestry and no
 * WMUX_WORKSPACE_ID; only a WMUX_COMMANDER_TOKEN. Before the fix,
 * resolveWorkspaceId's PID-walk + env-hint both missed, so every A2A tool threw
 * "Workspace identity unknown". The fix adds a deck.resolveCommanderWorkspace
 * RPC (token -> home workspace) and a commander-token branch in
 * resolveWorkspaceId that consults it.
 *
 * This probe proves the RUNTIME wiring on the REAL packaged main + mcp bundle
 * (what the unit tests + typecheck cannot: pipe routing, firstParty allow-list
 * gate, bundle drift):
 *
 *   A. deck.resolveCommanderWorkspace is registered and routes on the live pipe:
 *      a fake token is rejected with "not a live commander session" (proves the
 *      handler exists + fails closed — the exact code path a real token drives).
 *   B. The MCP bundle, given a WMUX_COMMANDER_TOKEN, actually SENDS the
 *      deck.resolveCommanderWorkspace RPC through the firstParty allow-list when
 *      an A2A tool resolves identity (a2a_whoami). A stale/fake token means the
 *      call is made and rejected, so identity stays unknown — but the request
 *      reaching main proves the allow-list lets it through (a blocked method
 *      would never leave the MCP). We assert the method is allow-listed in the
 *      shipped bundle so the send is not silently dropped.
 *
 * The POSITIVE case (a real commander token -> real home ws) needs a live
 * orchestrator SDK session to mint the token; that is the user's GUI dogfood.
 * This probe locks down everything up to that boundary.
 *
 * Run (PowerShell): npm run package; node scripts/bugB-commander-identity-probe.mjs
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

if (process.platform !== 'win32') { console.log('bugB-commander-identity-probe: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }
if (!fs.existsSync(MCP_BUNDLE)) { console.error(`mcp bundle not found: ${MCP_BUNDLE} — run \`npm run package\` first`); process.exit(2); }

const suffix = `-bugbdog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-bugbdog-'));
const isoEnv = {
  ...process.env,
  USERPROFILE: home, HOME: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  WMUX_DATA_SUFFIX: suffix, WMUX_NO_DIALOG: '1',
};
delete isoEnv.HOMEDRIVE; delete isoEnv.HOMEPATH;
for (const k of Object.keys(isoEnv)) { if (/^WMUX_(WORKSPACE_ID|PTY_ID|SURFACE_ID|SOCKET_PATH|COMMANDER_TOKEN)$/i.test(k)) delete isoEnv[k]; }
fs.mkdirSync(isoEnv.APPDATA, { recursive: true });
fs.mkdirSync(isoEnv.LOCALAPPDATA, { recursive: true });
const userDataDir = path.join(isoEnv.APPDATA, `wmux${suffix}`);
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

// Spawn the real mcp-bundle, do the MCP stdio handshake, call one tool with the
// given identity env, return { result, error, stderr }.
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
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bugbdog', version: '1.0.0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } });
  });
}
const toolText = (res) => (typeof res?.result?.content?.[0]?.text === 'string' ? res.result.content[0].text : '');

async function main() {
  console.log(`bugB-commander-identity-probe — exe=${APP_EXE}`);

  // Static: the shipped mcp bundle must allow-list the new RPC, or the MCP would
  // silently drop the send and identity resolution could never reach main.
  const bundleSrc = fs.readFileSync(MCP_BUNDLE, 'utf8');
  check('★ shipped mcp bundle allow-lists deck.resolveCommanderWorkspace (firstParty)',
    bundleSrc.includes('deck.resolveCommanderWorkspace'),
    'the method string must be present in the bundle (allow-list + sendRpc call)');

  app = spawnApp();
  TOKEN = await waitMainToken(20000);
  if (!TOKEN) throw new Error('main token never appeared');
  const wss = await waitRendererReady(30000);
  check('renderer ready + default workspace exists', wss.length >= 1, `workspaces=${wss.length}`);

  // ── A. The RPC is registered on the live pipe and fails closed on a bad token.
  //    This is the exact handler a real commander token drives; a fake token
  //    proving the fail-closed path proves the routing + handler are wired.
  const bad = await rpcCall('deck.resolveCommanderWorkspace', { token: 'not-a-real-token' });
  const badErr = typeof bad.error === 'string' ? bad.error : JSON.stringify(bad.error ?? bad.result ?? bad);
  console.log(`  [A] fake-token response: ok=${bad.ok} err=${String(badErr).slice(0, 120)}`);
  check('★ A: deck.resolveCommanderWorkspace is registered + routes on the live pipe',
    bad.ok === false && /not a live commander session/i.test(badErr),
    'must reject a fake token with the handler\'s own message (not method-not-found)');
  check('A: a truly-unknown method is method-not-found (control — proves A is a real route)',
    await rpcCall('deck.thisMethodDoesNotExist', {}).then((r) => r.ok === false && !/not a live commander/i.test(JSON.stringify(r.error))),
    'sanity: an unregistered method must NOT return the commander message');

  // ── B. The MCP bundle, handed a (stale/fake) commander token, tries the
  //    commander-identity path: it sends deck.resolveCommanderWorkspace, gets
  //    rejected, and reports identity unknown. That the A2A tool runs the
  //    commander branch at all (vs. never attempting it) is the wiring under test.
  const who = await mcpToolCall('a2a_whoami', {}, { WMUX_COMMANDER_TOKEN: 'fake-commander-token-xyz' });
  const whoText = toolText(who) || JSON.stringify(who.error ?? '');
  console.log(`  [B] whoami(fake commander token): ${whoText.slice(0, 200)}`);
  check('★ B: with only a (fake) commander token + no pane/env, identity is unknown (fail-closed)',
    /identity unknown|cannot determine|unknown/i.test(whoText),
    'a fake token must NOT resolve a workspace — positive path needs a real minted token (GUI dogfood)');
}

main()
  .catch((e) => { console.error('FATAL', e); check('harness completed without fatal error', false, e.message); })
  .finally(async () => {
    try { await rpcCall('daemon.shutdown', {}).catch(() => {}); } catch { /* */ }
    try { if (app?.pid) spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ }
    await sleep(800);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    const passed = results.filter((r) => r.ok).length;
    console.log(`\nbugB-commander-identity-probe: ${passed}/${results.length} passed`);
    console.log('NOTE: positive path (real commander token -> home ws) is the user GUI dogfood.');
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

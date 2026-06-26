/*
 * Live dogfood — WI-002 MCP identity quick-fix (WMUX_PTY_ID weak fallback).
 *
 * Proves the REAL packaged MCP server (resources/mcp-bundle/index.js) recovers
 * its own pane ptyId from the WMUX_PTY_ID spawn env when the verified PID-map
 * process-tree walk MISSES — the same-machine multi-agent A2A launch-demo
 * unblock. Unlike a2a-pane-identity-dogfood.mjs (which drives the main pipe
 * directly), this drives the MCP SERVER over its stdio JSON-RPC, because the
 * server's own identity resolution is the unit under test.
 *
 * Setup: an isolated packaged wmux (out/wmux-win32-x64/wmux.exe + a unique
 * WMUX_DATA_SUFFIX + temp USERPROFILE) boots main+daemon and a real pane. We
 * then spawn the real mcp-bundle as a child of THIS script (so its process tree
 * is node→script, NOT in the daemon's pid-map → the walk misses), with the
 * shell env the daemon would have stamped (WMUX_WORKSPACE_ID + WMUX_PTY_ID), and
 * call a2a_whoami over MCP stdio.
 *
 *   A. WITH WMUX_PTY_ID  → whoami returns the pane ptyId (weak fallback fired);
 *                          stderr logs WMUX_PTY_ID=present + walk MISS + env-hint.
 *   B. WITHOUT it (before)→ whoami is ws-level only (no ptyId); stderr logs
 *                          WMUX_PTY_ID=absent — the pre-fix behavior.
 *   C. PROVENANCE         → with WMUX_PTY_ID set, a channel mutation (channel_post)
 *                          still FAILS CLOSED (weak hint never feeds the verified-
 *                          only channel gate; codex/eng-review security split).
 *
 * NOTE: this proves the CODE PATH on the real bundle. It does NOT prove the real
 * Claude Code / Codex launcher propagates WMUX_PTY_ID to its MCP child — that is
 * a launcher property (evidenced by WMUX_WORKSPACE_ID already reaching the
 * server) and is confirmed by the live GUI dogfood + the diagnostic logs.
 *
 * Run (PowerShell): npm run package; node scripts/wi-002-mcp-identity-dogfood.mjs
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

if (process.platform !== 'win32') { console.log('wi-002-mcp-identity-dogfood: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }
if (!fs.existsSync(MCP_BUNDLE)) { console.error(`mcp bundle not found: ${MCP_BUNDLE} — run \`npm run package\` first`); process.exit(2); }

const suffix = `-wi002dog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wi002dog-'));
const isoEnv = {
  ...process.env,
  USERPROFILE: home, HOME: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  WMUX_DATA_SUFFIX: suffix, WMUX_NO_DIALOG: '1',
};
delete isoEnv.HOMEDRIVE; delete isoEnv.HOMEPATH;
// Scrub any inherited wmux identity so the script's own env can't leak a stale
// ptyId/workspace into the spawned MCP server (we inject explicitly per case).
for (const k of Object.keys(isoEnv)) { if (/^WMUX_(WORKSPACE_ID|PTY_ID|SURFACE_ID|SOCKET_PATH)$/i.test(k)) delete isoEnv[k]; }
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
 * Spawn the REAL packaged MCP server as a child of this script (its process tree
 * is node→script, never in the daemon pid-map → the identity walk MISSES), do
 * the MCP stdio handshake, call one tool, and return { result, stderr }.
 */
function mcpToolCall(toolName, args, identityEnv, { timeoutMs = 45000 } = {}) {
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
    // MCP stdio is newline-delimited JSON-RPC. initialize → initialized → tools/call.
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wi002-dogfood', version: '1.0.0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } });
  });
}
function toolText(res) {
  const t = res?.result?.content?.[0]?.text;
  return typeof t === 'string' ? t : '';
}

async function main() {
  console.log(`wi-002-mcp-identity-dogfood — exe=${APP_EXE}`);
  app = spawnApp();
  TOKEN = await waitMainToken(20000);
  if (!TOKEN) throw new Error('main token never appeared');
  const wss = await waitRendererReady(30000);
  check('renderer ready + default workspace exists', wss.length >= 1, `workspaces=${wss.length}`);
  const ws1 = wss[0].id;

  // The default workspace already auto-spawned a pane PTY (daemon mode → the
  // daemon stamped WMUX_PTY_ID = the session id on that shell's env).
  await sleep(1200);
  let surfaces = (await rpcResult('surface.list', { workspaceId: ws1 })).filter((s) => s.surfaceType !== 'browser' && s.ptyId);
  check('default workspace has a terminal pane', surfaces.length >= 1, `surfaces=${surfaces.length}`);
  if (surfaces.length < 1) throw new Error('need a pane to test identity recovery');
  const panePtyId = surfaces[0].ptyId;
  console.log(`  pane ptyId = ${panePtyId}, ws = ${ws1}`);

  // ── A. WITH WMUX_PTY_ID — the weak fallback recovers the pane anchor ──
  const withPty = await mcpToolCall('a2a_whoami', {}, { WMUX_WORKSPACE_ID: ws1, WMUX_PTY_ID: panePtyId });
  const withText = toolText(withPty);
  console.log(`  [A] whoami(text)=${withText.slice(0, 240)}`);
  check('★ A: a2a_whoami recovers the pane ptyId from WMUX_PTY_ID (walk missed)',
    withText.includes(panePtyId), `expected ptyId ${panePtyId} in whoami`);
  check('A: stderr logs WMUX_PTY_ID=present', /WMUX_PTY_ID=present/.test(withPty.stderr), '');
  check('A: stderr shows the walk MISSED (env/file fallback path exercised)', /walk MISS/.test(withPty.stderr), '');
  check('A: stderr confirms senderPty recovered from the weak env hint',
    /senderPty=weak-env/.test(withPty.stderr) || /resolved ws via env-hint/.test(withPty.stderr), '');

  // ── B. WITHOUT WMUX_PTY_ID — pre-fix behavior: ws-level only, no ptyId ──
  const noPty = await mcpToolCall('a2a_whoami', {}, { WMUX_WORKSPACE_ID: ws1 });
  const noText = toolText(noPty);
  console.log(`  [B] whoami(text)=${noText.slice(0, 240)}`);
  check('★ B: without WMUX_PTY_ID the pane ptyId is NOT recovered (before/after delta)',
    !noText.includes(panePtyId), 'ptyId must be absent when the env hint is missing');
  check('B: stderr logs WMUX_PTY_ID=absent', /WMUX_PTY_ID=absent/.test(noPty.stderr), '');
  check('B: whoami still resolves the workspace via WMUX_WORKSPACE_ID hint',
    noText.includes(ws1), `expected ws ${ws1} in whoami`);

  // ── C. PROVENANCE — weak hint must NOT unlock verified-only channel mutation ──
  // channel_post is a mutating a2a.channel.* call; its main-side handler resolves
  // senderPtyId → owning workspace and fails closed without a VERIFIED one. The
  // weak WMUX_PTY_ID env hint is deliberately not forwarded on the channel path,
  // so even with WMUX_PTY_ID set the mutation must be rejected (no downgrade).
  const chan = await mcpToolCall('channel_post',
    { channel_id: 'nonexistent', text: 'hi', member_id: 'm1', member_name: 'M1' },
    { WMUX_WORKSPACE_ID: ws1, WMUX_PTY_ID: panePtyId });
  const chanText = toolText(chan);
  // Codex/coderabbit P2: accepting `isError` or CHANNEL_NOT_FOUND made this green
  // even on a regression that forwarded the weak hint — the nonexistent channel
  // fails at lookup either way, masking the authz downgrade. The gate rejects on
  // an unresolvable senderPtyId BEFORE the channel lookup, so require THAT
  // authz-specific failure; a downgrade that reaches lookup (CHANNEL_NOT_FOUND)
  // now FAILS the check.
  const authzBlocked = /no resolvable senderPtyId|NOT_AUTHORIZED|verifiable caller/i.test(chanText);
  console.log(`  [C] channel_post(text)=${chanText.slice(0, 200)} isError=${chan.result?.isError}`);
  check('★ C: weak WMUX_PTY_ID does NOT unlock a verified-only channel mutation (provenance split holds)',
    authzBlocked, `must fail CLOSED on authz (no resolvable senderPtyId), NOT at channel lookup; got: ${chanText.slice(0, 160)}`);
}

main()
  .catch((e) => { console.error('FATAL', e); check('harness completed without fatal error', false, e.message); })
  .finally(async () => {
    try { await rpcResult('daemon.shutdown', {}).catch(() => {}); } catch { /* */ }
    try { if (app) app.kill(); } catch { /* */ }
    await sleep(800);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\nwi-002-mcp-identity-dogfood: ${passed}/${results.length} passed`);
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

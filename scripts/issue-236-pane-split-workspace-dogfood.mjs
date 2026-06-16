/*
 * Live dogfood — issue #236: pane.split must honor an explicit workspaceId.
 *
 * Spawns an isolated packaged wmux (out/wmux-win32-x64/wmux.exe) with
 * WMUX_DATA_SUFFIX isolation, then over the pure main-pipe RPC (clientName
 * omitted → grandfather path, exactly how an external multi-agent CLI drives
 * the daemon) verifies the root fix:
 *
 *   - With ws B globally active, `pane.split {workspaceId: wsA}` lands the new
 *     pane in the BACKGROUND ws A (not the on-screen ws B) — the core bug.
 *   - The split returns the new paneId, and that background pane gets a LIVE
 *     PTY surface immediately (eager-spawn P0 closed).
 *   - ws B is untouched and global focus does NOT move (no hijack).
 *   - An explicit-but-unknown workspaceId is REJECTED (fail-closed), with no
 *     tree mutation — never a silent active-ws fallback.
 *   - Omitting workspaceId still splits the ACTIVE ws (human-path back-compat).
 *
 * Run (PowerShell): npm run package; node scripts/issue-236-pane-split-workspace-dogfood.mjs
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

if (process.platform !== 'win32') { console.log('issue-236-dogfood: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }

const suffix = `-split236dog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-split236-'));
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
const paneCount = async (wsId) => ((await rpcResult('pane.list', { workspaceId: wsId })).panes ?? []).length;

let TOKEN = null;

async function main() {
  console.log(`issue-236-pane-split-workspace-dogfood — exe=${APP_EXE}`);
  app = spawnApp();
  TOKEN = await waitMainToken(20000);
  if (!TOKEN) throw new Error('main token never appeared');
  const wss = await waitRendererReady(30000);
  check('renderer ready + default workspace exists', wss.length >= 1, `workspaces=${wss.length}`);
  const wsA = wss[0].id; // default ws — the BACKGROUND split target

  // Create ws B and make it the globally-active (on-screen) workspace, so wsA
  // is a background workspace exactly like another agent's session.
  const wsB = (await rpcResult('workspace.new', { name: 'focus-holder-B' })).id;
  await sleep(700);
  await rpcResult('workspace.focus', { id: wsB }).catch(() => {});
  await sleep(400);
  const curBefore = await rpcResult('workspace.current', {});
  check('ws B is the globally-active workspace before the split', curBefore?.id === wsB, `current=${curBefore?.id}`);

  const aBefore = await paneCount(wsA);
  const bBefore = await paneCount(wsB);

  // ── THE TEST: split ws A (background) while ws B is active ──────────────
  const split = await rpcCall('pane.split', { direction: 'vertical', workspaceId: wsA });
  const sres = split.result ?? split;
  check('pane.split returned ok + a new paneId',
    sres?.ok === true && typeof sres.paneId === 'string' && sres.paneId.length > 0,
    JSON.stringify(sres));
  const newPaneId = sres?.paneId;
  await sleep(2000); // allow the eager-spawn PTY create to settle

  const aPanes = (await rpcResult('pane.list', { workspaceId: wsA })).panes ?? [];
  check('★ ws A gained exactly one pane (split landed in the TARGET ws, not the active one)',
    aPanes.length === aBefore + 1, `before=${aBefore} after=${aPanes.length}`);
  check('★ the returned paneId exists in ws A', !!aPanes.find((p) => p.id === newPaneId), `paneId=${newPaneId}`);

  // The background pane has a live PTY surface (3a eager-spawn).
  const aSurfaces = (await rpcResult('surface.list', { workspaceId: wsA }))
    .filter((s) => s.surfaceType !== 'browser' && s.ptyId);
  const newSurface = aSurfaces.find((s) => s.paneId === newPaneId);
  check('★ the new background pane has a spawned PTY surface (eager-spawn closed the P0)',
    !!newSurface?.ptyId, `surface=${JSON.stringify(newSurface ?? null)}`);

  // ws B untouched + global focus did not move.
  const bAfter = await paneCount(wsB);
  check('★ ws B pane count unchanged (no collateral split into the active ws)',
    bAfter === bBefore, `before=${bBefore} after=${bAfter}`);
  const curAfter = await rpcResult('workspace.current', {});
  check('★ global focus still on ws B after the background split (no focus hijack)',
    curAfter?.id === wsB, `current=${curAfter?.id}`);

  // ── Fail-closed: unknown workspaceId is rejected, no tree mutation ──────
  const aPreBad = await paneCount(wsA);
  const bad = await rpcCall('pane.split', { direction: 'vertical', workspaceId: 'ws-does-not-exist' });
  const bres = bad.result ?? bad;
  check('★ an explicit unknown workspaceId is REJECTED (fail-closed, not active-ws fallback)',
    typeof bres?.error === 'string' && /not found/.test(bres.error), JSON.stringify(bres));
  const aPostBad = await paneCount(wsA);
  check('the rejected split did not mutate any workspace tree', aPostBad === aPreBad, `pre=${aPreBad} post=${aPostBad}`);

  // ── Back-compat: no workspaceId → splits the ACTIVE ws (B) ──────────────
  const bPre = await paneCount(wsB);
  const compat = await rpcCall('pane.split', { direction: 'horizontal' }); // omit workspaceId
  const cres = compat.result ?? compat;
  check('no-workspaceId pane.split still succeeds', cres?.ok === true, JSON.stringify(cres));
  await sleep(1500);
  const bPost = await paneCount(wsB);
  check('★ no-workspaceId split targets the ACTIVE ws (B) — back-compat preserved',
    bPost === bPre + 1, `pre=${bPre} post=${bPost}`);
}

main()
  .catch((e) => { console.error('FATAL', e); check('harness completed without fatal error', false, e.message); })
  .finally(async () => {
    try { await rpcResult('daemon.shutdown', {}).catch(() => {}); } catch { /* */ }
    try { if (app) app.kill(); } catch { /* */ }
    await sleep(800);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\nissue-236-pane-split-workspace-dogfood: ${passed}/${results.length} passed`);
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

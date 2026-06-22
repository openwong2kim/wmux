/*
 * Live dogfood — issue #285: pane + surface lifecycle MCP tools under ENFORCE.
 *
 * Spawns an isolated packaged wmux (out/wmux-win32-x64/wmux.exe, fresh `npm run
 * package`) with WMUX_DATA_SUFFIX isolation + mcp.mode=enforce, then over the
 * main-pipe RPC proves the #285 first-party allowlist end to end:
 *
 *   - With clientName='claude-code' (the bundled MCP server's identity), all
 *     five lifecycle methods are ALLOWED under enforce and actually work:
 *     pane.split (bg ws), pane.focus (non-yank), surface.new + surface.close
 *     (reserved wmux.internal — the ALLOWED_RESERVED_FIRST_PARTY widening),
 *     pane.close (reap).
 *   - ADVERSARIAL: a non-first-party clientName ('evil-agent') is REJECTED for
 *     pane.split AND surface.new — proving the allowlist is the gate, not a
 *     blanket bypass, AND (since rejection only happens under enforce) that
 *     enforce mode is genuinely live.
 *   - SCOPED: claude-code calling workspace.new (NOT in FIRST_PARTY_METHODS) is
 *     REJECTED — the first-party grant is curated, not "first-party ⇒ anything".
 *   - FAIL-CLOSED: claude-code pane.split with an unknown workspaceId rejects.
 *
 * Setup/observer calls (workspace.*, *.list reads) omit clientName → legacy
 * grandfather, exactly how the human/CLI drives the daemon; only the methods
 * UNDER TEST carry a clientName so we exercise the first-party enforce path.
 *
 * Run (PowerShell): npm run package; node scripts/issue-285-pane-lifecycle-enforce-dogfood.mjs
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

if (process.platform !== 'win32') { console.log('issue-285-dogfood: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }

const suffix = `-pl285dog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pl285-'));
const env = {
  ...process.env,
  USERPROFILE: home, HOME: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  WMUX_DATA_SUFFIX: suffix, WMUX_NO_DIALOG: '1',
};
delete env.HOMEDRIVE; delete env.HOMEPATH;
delete env.NODE_ENV; // ensure packaged default (isDev=false ⇒ enforce), not a dev shell's 'development'
fs.mkdirSync(env.APPDATA, { recursive: true });
fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
const userDataDir = path.join(env.APPDATA, `wmux${suffix}`);
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');

// Belt-and-suspenders: seed ~/.wmux<suffix>/config.json with mcp.mode=enforce.
// The packaged exe already defaults to enforce; this pins it regardless of env.
const wmuxDir = path.join(home, `.wmux${suffix}`);
fs.mkdirSync(wmuxDir, { recursive: true });
fs.writeFileSync(path.join(wmuxDir, 'config.json'), JSON.stringify({ mcp: { mode: 'enforce' } }, null, 2), 'utf8');

const mainPipe = `\\\\.\\pipe\\wmux${suffix}-${USERNAME}`;
const authTokenPath = path.join(home, `.wmux${suffix}-auth-token`);

function readMainToken() { try { return fs.readFileSync(authTokenPath, 'utf8').trim() || null; } catch { return null; } }

// rpcCall with an optional clientName stamped into the envelope (the whole
// point: clientName drives the enforcer's first-party recognition).
function rpcCall(method, params = {}, { timeoutMs = 8000, clientName } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(mainPipe);
    let buf = ''; let settled = false; const id = randomUUID();
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`rpc timeout: ${method}`))), timeoutMs);
    sock.setEncoding('utf8');
    const envelope = { id, method, params, token: TOKEN };
    if (clientName) { envelope.clientName = clientName; envelope.clientVersion = '0.0.0-dogfood'; }
    sock.once('connect', () => sock.write(JSON.stringify(envelope) + '\n'));
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
const FP = 'claude-code';
const rpcResult = async (m, p, o) => { const r = await rpcCall(m, p, o); if (r && r.ok === false) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error)); return r?.result ?? r; };

function spawnApp() {
  const proc = spawn(APP_EXE, [], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  proc.stdout.resume(); proc.stderr.resume(); // drain so the child's pipes never block
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
const listSurfaces = async (wsId) => (await rpcResult('surface.list', { workspaceId: wsId })).filter((s) => s.ptyId);

let TOKEN = null;

async function main() {
  console.log(`issue-285-pane-lifecycle-enforce-dogfood — exe=${APP_EXE}`);
  app = spawnApp();
  TOKEN = await waitMainToken(20000);
  if (!TOKEN) throw new Error('main token never appeared');
  const wss = await waitRendererReady(30000);
  check('renderer ready + default workspace exists', wss.length >= 1, `workspaces=${wss.length}`);
  const wsA = wss[0].id; // default ws — the BACKGROUND lifecycle target

  // Setup (grandfather / human-path): ws B becomes the on-screen workspace, so
  // wsA is a background workspace exactly like another agent's session.
  const wsB = (await rpcResult('workspace.new', { name: 'focus-holder-B' })).id;
  await sleep(700);
  await rpcResult('workspace.focus', { id: wsB }).catch(() => undefined);
  await sleep(400);
  const curBefore = await rpcResult('workspace.current', {});
  check('ws B is the on-screen workspace before the test', curBefore?.id === wsB, `current=${curBefore?.id}`);

  // ── ADVERSARIAL FIRST: a non-first-party clientName is REJECTED under enforce.
  //    This also proves enforce is genuinely live (under shadow it would run). ──
  const evil = await rpcCall('pane.split', { direction: 'vertical', workspaceId: wsA }, { clientName: 'evil-agent' });
  check('★ ENFORCE LIVE: pane.split REJECTED for a non-first-party clientName (evil-agent)',
    (evil.result ?? evil)?.ok !== true && (evil.ok === false || (evil.result?.ok === false)),
    JSON.stringify(evil.result ?? evil));
  const evilSurf = await rpcCall('surface.new', { workspaceId: wsA }, { clientName: 'evil-agent' });
  check('★ surface.new REJECTED for evil-agent (reserved method, no blanket bypass)',
    evilSurf.ok === false || (evilSurf.result?.ok === false),
    JSON.stringify(evilSurf.result ?? evilSurf));

  // ── SCOPED: claude-code calling a NON-allowlisted method is still rejected. ──
  const fpWsNew = await rpcCall('workspace.new', { name: 'should-fail' }, { clientName: FP });
  check('★ claude-code REJECTED for workspace.new (not in FIRST_PARTY_METHODS — curated, not blanket)',
    fpWsNew.ok === false || (fpWsNew.result?.ok === false),
    JSON.stringify(fpWsNew.result ?? fpWsNew));

  // ── THE TEST: claude-code drives the five lifecycle methods under enforce. ──
  const aBefore = await paneCount(wsA);

  // 1) pane.split (pane.create) — allowed + lands in the background ws A.
  const split = await rpcCall('pane.split', { direction: 'vertical', workspaceId: wsA }, { clientName: FP });
  const sres = split.result ?? split;
  check('★ pane.split ALLOWED for claude-code under enforce + returns a paneId',
    sres?.ok === true && typeof sres.paneId === 'string' && sres.paneId.length > 0, JSON.stringify(sres));
  const newPaneId = sres?.paneId;
  await sleep(2000); // eager-spawn settle
  const aPanes = (await rpcResult('pane.list', { workspaceId: wsA })).panes ?? [];
  check('★ the split landed in ws A (background target, not the on-screen ws B)',
    aPanes.length === aBefore + 1 && !!aPanes.find((p) => p.id === newPaneId),
    `before=${aBefore} after=${aPanes.length} paneId=${newPaneId}`);

  // 2) pane.focus (pane.read) — allowed + NON-YANK (on-screen ws unchanged).
  const focus = await rpcCall('pane.focus', { id: newPaneId }, { clientName: FP });
  check('★ pane.focus ALLOWED for claude-code under enforce', (focus.result ?? focus)?.ok === true, JSON.stringify(focus.result ?? focus));
  const curAfterFocus = await rpcResult('workspace.current', {});
  check('★ pane.focus is NON-YANK: on-screen workspace still B after focusing a bg pane',
    curAfterFocus?.id === wsB, `current=${curAfterFocus?.id}`);

  // 3) surface.new (RESERVED wmux.internal) — allowed via ALLOWED_RESERVED widening.
  const surfBefore = (await listSurfaces(wsA)).length;
  const sNew = await rpcCall('surface.new', { workspaceId: wsA }, { clientName: FP });
  const sNewRes = sNew.result ?? sNew;
  const newPtyId = sNewRes?.ptyId;
  check('★ surface.new ALLOWED for claude-code under enforce (reserved wmux.internal) + returns ptyId',
    !!newPtyId && sNew.ok !== false, JSON.stringify(sNewRes));
  await sleep(1500);
  const surfAfter = await listSurfaces(wsA);
  check('★ surface.new actually opened a surface in ws A',
    surfAfter.length === surfBefore + 1, `before=${surfBefore} after=${surfAfter.length}`);
  const newSurface = surfAfter.find((s) => s.ptyId === newPtyId) || surfAfter[surfAfter.length - 1];
  const newSurfaceId = sNewRes?.id || newSurface?.surfaceId || newSurface?.id;

  // 4) surface.close (RESERVED wmux.internal) — allowed + disposes.
  const sClose = await rpcCall('surface.close', { id: newSurfaceId }, { clientName: FP });
  check('★ surface.close ALLOWED for claude-code under enforce (reserved wmux.internal)',
    (sClose.result ?? sClose)?.ok === true, JSON.stringify(sClose.result ?? sClose));

  // 5) pane.close (pane.create) — allowed + reaps the worker pane (supervisor flow).
  const close = await rpcCall('pane.close', { id: newPaneId }, { clientName: FP });
  check('★ pane.close ALLOWED for claude-code under enforce', (close.result ?? close)?.ok === true, JSON.stringify(close.result ?? close));
  await sleep(800);
  const aFinal = (await rpcResult('pane.list', { workspaceId: wsA })).panes ?? [];
  check('★ pane.close reaped the worker pane (supervisor spawn→reap round-trip)',
    !aFinal.find((p) => p.id === newPaneId), `panes=${aFinal.length}`);

  // ── FAIL-CLOSED: claude-code pane.split with an unknown workspaceId rejects. ──
  const bad = await rpcCall('pane.split', { direction: 'vertical', workspaceId: 'ws-does-not-exist' }, { clientName: FP });
  const bres = bad.result ?? bad;
  check('★ fail-closed: claude-code pane.split with unknown workspaceId is REJECTED',
    typeof bres?.error === 'string' && /not found/.test(bres.error), JSON.stringify(bres));
}

main()
  .catch((e) => { console.error('FATAL', e); check('harness completed without fatal error', false, e.message); })
  .finally(async () => {
    try { await rpcResult('daemon.shutdown', {}).catch(() => undefined); } catch { /* */ }
    try { if (app) app.kill(); } catch { /* */ }
    await sleep(800);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\nissue-285-pane-lifecycle-enforce-dogfood: ${passed}/${results.length} passed`);
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });

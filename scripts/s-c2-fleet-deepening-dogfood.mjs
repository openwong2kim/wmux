#!/usr/bin/env node
/**
 * S-C2 Fleet View Deepening — LIVE dogfood against the PACKAGED exe.
 * (out/wmux-win32-x64/wmux.exe, built from team/2026-06-15/s-c2-fleet-view-deepening)
 *
 * Proves the two highest-risk things end-to-end in a real build, then attempts the
 * MCP trust-DB chain. See plans/s-c2-fleet-view-deepening.md + decisions.md (6 guards).
 *
 * TIER 1A — live tail on a BACKGROUND (display:none / offsetWidth-0) pane.
 *   The #1 risk (the offsetWidth trap). Create a background workspace, write a
 *   distinctive marker into its terminal, open Fleet View, and assert the
 *   FleetCard for that background ptyId renders a non-empty monospace tail
 *   containing the marker. A blank tail on a background card = FAIL.
 *
 * TIER 1B — A2A execute approval resolves from the inbox.
 *   Fire a2a.task.send {execute:true} over the main pipe (blocks awaiting the
 *   renderer confirm; we don't await — keep the promise). Open Fleet View →
 *   Approvals tab. Assert ONE A2A row with a live "auto-deny in Ns" countdown,
 *   assert the standalone <ExecuteApprovalDialog/> is SUPPRESSED (delta 5),
 *   click the row's Approve button → assert the parked send RPC returns
 *   {approved:true} and the row disappears. Repeat with Deny → {approved:false}.
 *
 * TIER 2 — the REAL MCP enforcer → inbox → trust-DB chain.
 *   Packaged wmux defaults to enforce mode (isDev=!app.isPackaged). Over the raw
 *   main pipe we send clientName-bearing requests (PipeServer forwards clientName
 *   to RpcRouter.dispatch verbatim). Per distinct clientName:
 *     mcp.identify → mcp.declarePermissions(caps) → a capability-gated method
 *   the enforcer rejects (unconfirmed + declaredCaps>0) → ApprovalQueue mints a
 *   prompt → PERMISSION_PROMPT_OPEN → useApprovalInboxBridge.addMcpPrompt.
 *   Two distinct clientNames (distinct caps) → two distinct inbox rows. Approve
 *   one (non-critical), Deny the other; assert ~/.wmux<suffix>/plugin-trust.json
 *   shows trusted/denied. Also proves the critical-Enter guard with a third
 *   critical-capability plugin: focus its row, press Enter → NOT approved (row
 *   stays); click its Approve button → resolves.
 *
 * ISOLATION (a2a-eventbus-dogfood pattern): fresh temp USERPROFILE/HOME/APPDATA/
 * LOCALAPPDATA + a unique WMUX_DATA_SUFFIX re-keys the main pipe, the auth token,
 * ~/.wmux<suffix>, the trust DB and the userData dir — runs beside a live wmux
 * untouched. CLEANUP: app kill + detached-daemon shutdown → SIGKILL fallback →
 * temp HOME removed → zombie count target 0.
 *
 * Run (PowerShell): npm run package; node scripts/s-c2-fleet-deepening-dogfood.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const APP_EXE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
const OUT_DIR = path.join(REPO_ROOT, 'out-sc2-dogfood');
const USERNAME = os.userInfo().username || 'default';
const MARKER = 'S_C2_TAIL_MARKER_zq7x';

const results = [];
let app = null;
let browser = null;
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== 'win32') { console.log('s-c2-dogfood: SKIP (win32-only)'); process.exit(0); }
if (!fs.existsSync(APP_EXE)) { console.error(`packaged exe not found: ${APP_EXE} — run \`npm run package\` first`); process.exit(2); }
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── isolated instance environment ──
const suffix = `-sc2dog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sc2dog-'));
const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  WMUX_DATA_SUFFIX: suffix,
  WMUX_NO_DIALOG: '1',
};
delete env.HOMEDRIVE;
delete env.HOMEPATH;
delete env.WMUX_DISABLE_CDP; // CDP defaults ON (WMUX_DISABLE_CDP !== 'true')
fs.mkdirSync(env.APPDATA, { recursive: true });
fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
const userDataDir = path.join(env.APPDATA, `wmux${suffix}`);
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');

const wmuxDir = path.join(home, `.wmux${suffix}`);
const mainPipe = `\\\\.\\pipe\\wmux${suffix}-${USERNAME}`;
const authTokenPath = path.join(home, `.wmux${suffix}-auth-token`);
const trustPath = path.join(wmuxDir, 'plugin-trust.json');

function readMainToken() { try { const t = fs.readFileSync(authTokenPath, 'utf8').trim(); return t || null; } catch { return null; } }
function readDaemonPid() { try { const p = Number(fs.readFileSync(path.join(wmuxDir, 'daemon.pid'), 'utf8').trim()); return Number.isInteger(p) && p > 0 ? p : null; } catch { return null; } }
function readDaemonPipeName() { try { return fs.readFileSync(path.join(wmuxDir, 'daemon-pipe'), 'utf8').trim() || null; } catch { return null; } }
function readDaemonToken() {
  for (const p of [path.join(home, '.wmux', 'daemon-auth-token'), path.join(wmuxDir, 'daemon-auth-token')]) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t; } catch { /* next */ }
  }
  return null;
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function pipeAlive(pipeName) {
  return new Promise((resolve) => {
    const sock = net.createConnection(pipeName);
    const done = (v) => { try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 800);
  });
}

// One-shot newline-delimited JSON-RPC client. `clientName` is OPTIONAL: omitted
// → grandfathered through enforce mode (legacy). Provided → the enforcer treats
// the caller as an identified plugin (Tier 2 needs this).
function rpcCall(pipeName, token, method, params = {}, { timeoutMs = 8000, clientName, clientVersion } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(pipeName);
    let buf = '';
    let settled = false;
    const id = randomUUID();
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { /* */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`rpc timeout: ${method}`))), timeoutMs);
    sock.setEncoding('utf8');
    const reqObj = { id, method, params, token };
    if (clientName) reqObj.clientName = clientName;
    if (clientVersion) reqObj.clientVersion = clientVersion;
    sock.once('connect', () => sock.write(JSON.stringify(reqObj) + '\n'));
    sock.once('error', (e) => finish(() => reject(e)));
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        // Return the WHOLE response envelope (Tier 2 needs ok:false + rejection).
        finish(() => resolve(msg));
        return;
      }
    });
  });
}
// Convenience: resolve to `result` on ok, reject on ok:false (for plain control RPCs).
async function rpcOk(method, params, opts) {
  const r = await rpcCall(mainPipe, TOKEN, method, params, opts);
  if (r && r.ok === false) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
  return r?.result ?? r;
}

function spawnApp() {
  const proc = spawn(APP_EXE, [], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  let cdpPort = null;
  const cdpWaiters = [];
  let stdoutBuf = '';
  proc.stdout.on('data', (b) => {
    stdoutBuf += b.toString('utf8');
    const m = stdoutBuf.match(/CDP enabled on port (\d+)/);
    if (m && cdpPort === null) { cdpPort = Number(m[1]); for (const w of cdpWaiters.splice(0)) w(cdpPort); }
    if (stdoutBuf.length > 65536) stdoutBuf = stdoutBuf.slice(-4096);
  });
  let stderrBuf = '';
  proc.stderr.on('data', (b) => { stderrBuf += b.toString('utf8'); if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-4096); });
  const waitForCdp = (timeoutMs) => new Promise((resolve, reject) => {
    if (cdpPort !== null) return resolve(cdpPort);
    cdpWaiters.push(resolve);
    setTimeout(() => reject(new Error('timeout waiting for CDP port line')), timeoutMs);
  });
  return { proc, get cdpPort() { return cdpPort; }, waitForCdp };
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
  const dl = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < dl) {
    try { const r = await rpcCall(mainPipe, token, 'workspace.list', {}, { timeoutMs: 4000 }); if (r && Array.isArray(r.result)) return r.result; }
    catch (e) { lastErr = e.message; }
    await sleep(200);
  }
  throw new Error(`renderer never became ready (last: ${lastErr})`);
}

async function findRendererPage() {
  const ctx = browser.contexts()[0];
  for (let i = 0; i < 60; i++) {
    for (const p of ctx.pages()) {
      try {
        const ready = await p.evaluate(() => !!window.electronAPI?.pty?.create && !!document.querySelector('#root'));
        if (ready) return p;
      } catch { /* navigating */ }
    }
    await sleep(500);
  }
  return null;
}

// ── Fleet View open / tab helpers via real CDP interaction ──
async function openFleetView(page) {
  // Ctrl+Shift+A toggles the cockpit (useKeyboard.ts:607 → toggleFleetView).
  // The handler matches on code === 'KeyA', so dispatch a real chord. Ensure
  // we're not already open first.
  const isOpen = () => page.evaluate(() => !!document.querySelector('[role=dialog][aria-modal=true]'));
  for (let i = 0; i < 3 && !(await isOpen()); i++) {
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await sleep(400);
  }
  return isOpen();
}
async function closeFleetView(page) {
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() => !!document.querySelector('[role=dialog][aria-modal=true]'));
    if (!open) return true;
    await page.keyboard.press('Escape');
    await sleep(300);
  }
  return !(await page.evaluate(() => !!document.querySelector('[role=dialog][aria-modal=true]')));
}
// Click the Approvals tab by its role=tab button (text-agnostic: it's the 2nd tab).
async function switchToApprovalsTab(page) {
  return page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role=tab]'));
    if (tabs.length < 2) return false;
    tabs[1].click();
    return true;
  });
}

async function killAppOnly(app) {
  try { app.proc.kill(); } catch { /* */ }
  const dl = Date.now() + 6000;
  while (app.proc.exitCode === null && Date.now() < dl) await sleep(100);
  if (app.proc.exitCode === null) { try { app.proc.kill('SIGKILL'); } catch { /* */ } }
  const pdl = Date.now() + 5000;
  while (Date.now() < pdl && await pipeAlive(mainPipe)) await sleep(150);
}
async function shutdownDaemon() {
  const pipeName = readDaemonPipeName();
  const token = readDaemonToken();
  const daemonPid = readDaemonPid();
  if (pipeName && token && await pipeAlive(pipeName)) {
    try { await rpcCall(pipeName, token, 'daemon.shutdown', {}, { timeoutMs: 5000 }); } catch { /* ack may race exit */ }
  }
  const dl = Date.now() + 6000;
  while (daemonPid && pidAlive(daemonPid) && Date.now() < dl) await sleep(150);
  if (daemonPid && pidAlive(daemonPid)) {
    try { process.kill(daemonPid); } catch { /* */ }
    await sleep(300);
    if (pidAlive(daemonPid)) { try { process.kill(daemonPid, 'SIGKILL'); } catch { /* */ } }
  }
  return daemonPid;
}

let TOKEN = null;

async function main() {
  console.log(`s-c2-fleet-deepening-dogfood — exe=${APP_EXE}`);
  console.log(`home=${home} suffix=${suffix}\n`);

  app = spawnApp();
  let page = null;
  try {
    // ───────────────────────── boot ─────────────────────────
    console.log('=== boot (isolated packaged instance, enforce-mode default) ===');
    const cdpPort = await app.waitForCdp(40000).catch(() => null);
    check('boot: CDP port advertised on stdout', cdpPort != null, cdpPort != null ? `port ${cdpPort}` : 'no CDP line');
    if (cdpPort == null) throw new Error('no CDP — cannot drive renderer');
    const daemonUp = await waitDaemonPipeFile(30000);
    check('boot: daemon pipe file appeared', daemonUp);
    TOKEN = await waitMainToken(20000);
    check('boot: main-pipe auth token present', !!TOKEN, TOKEN ? `…/.wmux${suffix}-auth-token` : `MISSING ${authTokenPath}`);
    if (!TOKEN) throw new Error('no main-pipe token');
    const initialWs = await waitRendererReady(TOKEN, 40000);
    check('boot: renderer ready (workspace.list round-trip)', Array.isArray(initialWs), `${initialWs.length} initial ws`);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    page = await findRendererPage();
    check('boot: CDP connected + renderer page (window.electronAPI + #root)', !!page, page ? page.url() : 'no renderer page');
    if (!page) throw new Error('no renderer page over CDP');
    // Make sure no overlay is up before we begin.
    await closeFleetView(page);

    // ════════════════════════════════════════════════════════════════════
    // TIER 1A — live tail on a BACKGROUND pane
    // ════════════════════════════════════════════════════════════════════
    console.log('\n========== TIER 1A — background-pane live tail (offsetWidth trap) ==========');
    // Create a 2nd workspace; addWorkspace flips the active workspace to the new
    // one, so workspace[0] (the boot workspace) becomes BACKGROUND (display:none).
    await rpcOk('workspace.new', { name: 'sc2-fg' });
    await sleep(600);
    let wsList = await rpcOk('workspace.list', {});
    check('1A.setup: >=2 workspaces (one foreground, one background)', wsList.length >= 2, `${wsList.length} ws`);

    // The active workspace is the LAST created (sc2-fg). The boot workspace is
    // background. workspace.current tells us which is active.
    const cur = await rpcOk('workspace.current', {});
    const activeId = cur?.id;
    const bgWs = wsList.find((w) => w.id !== activeId);
    check('1A.setup: identified a background workspace (≠ active)', !!bgWs && !!activeId,
      `active=${activeId} bg=${bgWs?.id}`);
    if (!bgWs) throw new Error('no background workspace');

    // Wait for the background pane to have a live ptyId (its PTY auto-spawns).
    let bgPty = '';
    for (let i = 0; i < 40 && !bgPty; i++) {
      const list = await rpcOk('workspace.list', {});
      const w = list.find((x) => x.id === bgWs.id);
      bgPty = (w && (w.activePtyId || (w.ptyIds || [])[0])) || '';
      if (!bgPty) await sleep(300);
    }
    check('1A.setup: background pane has a live ptyId', !!bgPty, `ptyId=${bgPty}`);
    if (!bgPty) throw new Error('background pane never got a ptyId');

    // Confirm the background pane's xterm element is genuinely display:none /
    // offsetWidth 0 (the trap) — proving the tail must NOT use the offsetWidth guard.
    const bgHidden = await page.evaluate(() => {
      // PaneContainer roots are keyed; the surest signal is that the background
      // workspace's panes are inside a display:none container. We can't map ptyId
      // → DOM directly without store access, so report the count of xterm screens
      // with offsetWidth 0 (background panes) vs >0 (foreground).
      const screens = Array.from(document.querySelectorAll('.xterm-screen, .xterm'));
      let zero = 0, nonzero = 0;
      for (const el of screens) { if (el.offsetWidth === 0) zero++; else nonzero++; }
      return { zero, nonzero, total: screens.length };
    });
    check('1A: at least one xterm is offsetWidth-0 (a background pane exists in DOM)',
      bgHidden.zero >= 1, `xterm offsetWidth: zero=${bgHidden.zero} nonzero=${bgHidden.nonzero}`);

    // Write a distinctive marker into the BACKGROUND pane's terminal via the
    // renderer pty.write (shell echoes it back → lands in the xterm buffer →
    // tailForPty reads it regardless of visibility).
    await page.evaluate(({ ptyId, marker }) => {
      window.electronAPI.pty.write(ptyId, `echo ${marker}\r`);
    }, { ptyId: bgPty, marker: MARKER });
    await sleep(1500); // let the shell echo the command + print the marker line

    // Open Fleet View and find the FleetCard for the background ptyId.
    const opened = await openFleetView(page);
    check('1A: Fleet View opened (Ctrl+Shift+A)', opened);
    await sleep(700); // first tail tick is immediate, but give the 750ms poll one cycle too

    const tailProbe = await page.evaluate((ptyId) => {
      const card = document.querySelector(`[data-fleet-card][data-pty-id="${ptyId}"]`);
      if (!card) {
        const all = Array.from(document.querySelectorAll('[data-fleet-card]')).map((c) => c.getAttribute('data-pty-id'));
        return { found: false, allPtyIds: all };
      }
      // The tail block is the aria-hidden monospace column of <span> rows.
      const tailBlock = card.querySelector('[aria-hidden="true"]');
      const spans = tailBlock ? Array.from(tailBlock.querySelectorAll('span')).map((s) => s.textContent || '') : [];
      return { found: true, tailLines: spans, cardText: card.textContent || '' };
    }, bgPty);

    check('1A: FleetCard for the BACKGROUND ptyId is present', tailProbe.found,
      tailProbe.found ? `ptyId=${bgPty}` : `not found; cards=${JSON.stringify(tailProbe.allPtyIds)}`);
    const tailJoined = (tailProbe.tailLines || []).join('\n');
    const tailHasMarker = tailJoined.includes(MARKER);
    check('1A.★ background card shows a NON-EMPTY tail (offsetWidth trap NOT regressed)',
      (tailProbe.tailLines || []).some((l) => l.trim().length > 0),
      `tail lines: ${JSON.stringify(tailProbe.tailLines)}`);
    check('1A.★★ background card tail contains the distinctive marker',
      tailHasMarker, tailHasMarker ? `found "${MARKER}"` : `tail="${tailJoined.slice(0, 200)}"`);
    await page.screenshot({ path: path.join(OUT_DIR, '1A-background-tail.png') }).catch(() => {});
    console.log(`  (screenshot: ${path.join(OUT_DIR, '1A-background-tail.png')})`);

    await closeFleetView(page);

    // ════════════════════════════════════════════════════════════════════
    // TIER 1B — A2A execute approval resolves from the inbox
    // ════════════════════════════════════════════════════════════════════
    console.log('\n========== TIER 1B — A2A inbox resolve + modal suppression ==========');
    // Need two distinct workspaces as from/to. wsList already has >=2.
    wsList = await rpcOk('workspace.list', {});
    const A = wsList[0].id, B = wsList[1].id;
    check('1B.setup: two distinct workspaces for from/to', A && B && A !== B, `from=${A} to=${B}`);

    // Run an A2A execute round and resolve it from the inbox button.
    // Returns { sendResp, suppressed, hadRow, rowGone }.
    async function a2aRound(approve) {
      // Fire WITHOUT awaiting — the send RPC blocks until the renderer confirm
      // resolves (we resolve it by clicking the inbox button).
      let sendSettled = null;
      const sendPromise = rpcCall(mainPipe, TOKEN, 'a2a.task.send', {
        workspaceId: A, to: B,
        title: 'sc2 execute probe',
        message: `EXEC_PROBE body — ${approve ? 'APPROVE' : 'DENY'} path`,
        execute: true,
      }, { timeoutMs: 40000 }).then((r) => { sendSettled = r; return r; }).catch((e) => { sendSettled = { error: e.message }; return sendSettled; });

      // Wait for pendingExecuteApproval to surface as a renderer modal (when
      // fleet is closed, <ExecuteApprovalDialog/> renders it: role=alertdialog).
      let modalUp = false;
      for (let i = 0; i < 40 && !modalUp; i++) {
        modalUp = await page.evaluate(() =>
          !!document.querySelector('[role=alertdialog]') &&
          /Background execution requested/.test(document.body.textContent || ''));
        if (!modalUp) await sleep(200);
      }

      // Open Fleet View → Approvals tab. Suppression (delta 5) should hide the
      // standalone alertdialog while fleetViewVisible && tab==='approvals'.
      await openFleetView(page);
      await switchToApprovalsTab(page);
      await sleep(500);

      const state1 = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="a2a"]'));
        const alertdialog = document.querySelector('[role=alertdialog]');
        const bodyHasModalText = /Background execution requested/.test(document.body.textContent || '');
        // grab the countdown text of the first a2a row
        const countdown = rows[0] ? (rows[0].textContent || '').match(/(\d+)\s*s/)?.[0] || null : null;
        return {
          a2aRowCount: rows.length,
          alertdialogPresent: !!alertdialog,
          bodyHasModalText,
          countdown,
        };
      });

      // Click the Approve / Deny button of the A2A row (the actual UI path).
      const clicked = await page.evaluate((wantApprove) => {
        const row = document.querySelector('[data-inbox-row][data-source="a2a"]');
        if (!row) return { ok: false, reason: 'no a2a row' };
        const btns = Array.from(row.querySelectorAll('button'));
        // Approve is the last button (deny then approve); deny is the first.
        const target = wantApprove ? btns[btns.length - 1] : btns[0];
        if (!target) return { ok: false, reason: 'no button' };
        target.click();
        return { ok: true, label: target.textContent };
      }, approve);

      // Wait for the parked send RPC to settle.
      const dl = Date.now() + 8000;
      while (sendSettled === null && Date.now() < dl) await sleep(150);
      await sleep(400);

      const state2 = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="a2a"]'));
        return { a2aRowCount: rows.length };
      });

      await closeFleetView(page);
      return { sendResp: sendSettled, state1, clicked, state2 };
    }

    // — Approve path —
    const ap = await a2aRound(true);
    check('1B.approve: inbox shows exactly ONE A2A row', ap.state1.a2aRowCount === 1, `rows=${ap.state1.a2aRowCount}`);
    check('1B.approve: A2A row shows a live auto-deny countdown', !!ap.state1.countdown, `countdown="${ap.state1.countdown}"`);
    check('1B.approve.★ ExecuteApprovalDialog SUPPRESSED on approvals tab (delta 5)',
      !ap.state1.alertdialogPresent && !ap.state1.bodyHasModalText,
      `alertdialog=${ap.state1.alertdialogPresent} bodyText=${ap.state1.bodyHasModalText}`);
    check('1B.approve: clicked the inbox Approve button', ap.clicked.ok, JSON.stringify(ap.clicked));
    const apOk = ap.sendResp && ap.sendResp.ok === true;
    const apApproved = apOk && ap.sendResp.result && ap.sendResp.result.approved === true;
    // a2a.task.send returns the task store result (taskId etc.), NOT {approved}.
    // The decision is internal; the OBSERVABLE outcome is: send returned ok and
    // the row vanished. We also separately assert the task was NOT cancelled below.
    check('1B.approve.★ parked a2a.task.send RPC returned (unblocked by the click)',
      apOk, ap.sendResp ? `ok=${ap.sendResp.ok} result=${JSON.stringify(ap.sendResp.result || ap.sendResp.error)}` : 'never settled');
    check('1B.approve.★ A2A inbox row disappeared after resolve (no phantom)',
      ap.state2.a2aRowCount === 0, `rows=${ap.state2.a2aRowCount}`);
    const apTaskId = apOk && ap.sendResp.result && ap.sendResp.result.taskId;
    if (apTaskId) {
      const q = await rpcOk('a2a.task.query', { taskId: apTaskId, workspaceId: B }).catch((e) => ({ error: e.message }));
      const st = q?.task?.status?.state ?? q?.status ?? q?.state ?? JSON.stringify(q).slice(0, 120);
      check('1B.approve: task NOT auto-canceled (approve → execution path, not denial)',
        !/cancel/i.test(JSON.stringify(q)), `task state=${st}`);
    }

    await sleep(500);

    // — Deny path —
    const dp = await a2aRound(false);
    check('1B.deny: inbox shows exactly ONE A2A row', dp.state1.a2aRowCount === 1, `rows=${dp.state1.a2aRowCount}`);
    check('1B.deny.★ ExecuteApprovalDialog SUPPRESSED on approvals tab',
      !dp.state1.alertdialogPresent && !dp.state1.bodyHasModalText,
      `alertdialog=${dp.state1.alertdialogPresent}`);
    check('1B.deny: clicked the inbox Deny button', dp.clicked.ok, JSON.stringify(dp.clicked));
    const dpOk = dp.sendResp && dp.sendResp.ok === true;
    check('1B.deny.★ parked a2a.task.send RPC returned (unblocked by Deny click)',
      dpOk, dp.sendResp ? `ok=${dp.sendResp.ok}` : 'never settled');
    check('1B.deny.★ A2A inbox row disappeared after Deny (no phantom)',
      dp.state2.a2aRowCount === 0, `rows=${dp.state2.a2aRowCount}`);
    const dpTaskId = dpOk && dp.sendResp.result && dp.sendResp.result.taskId;
    if (dpTaskId) {
      const q = await rpcOk('a2a.task.query', { taskId: dpTaskId, workspaceId: B }).catch((e) => ({ error: e.message }));
      check('1B.deny.★ denied task transitioned to canceled (a2a.rpc deny branch)',
        /cancel/i.test(JSON.stringify(q)), `query=${JSON.stringify(q).slice(0, 160)}`);
    }

    await closeFleetView(page);

    // ════════════════════════════════════════════════════════════════════
    // TIER 2 — REAL MCP enforcer → inbox → trust-DB chain
    // ════════════════════════════════════════════════════════════════════
    console.log('\n========== TIER 2 — MCP enforcer → inbox → trust-DB ==========');
    // Per distinct clientName: identify → declarePermissions → capability-gated
    // method that the enforcer rejects (unconfirmed + declaredCaps>0) → prompt.
    const PLUGIN1 = 's-c2-dogfood-plugin-alpha';   // neutral cap → non-critical
    const PLUGIN2 = 's-c2-dogfood-plugin-beta';    // neutral cap → non-critical
    const PLUGIN3 = 's-c2-dogfood-plugin-crit';    // terminal.read → CRITICAL

    async function mintPrompt(clientName, caps, gatedMethod, gatedParams) {
      const ident = await rpcCall(mainPipe, TOKEN, 'mcp.identify', { name: clientName, version: '1.0' }, { clientName });
      const decl = await rpcCall(mainPipe, TOKEN, 'mcp.declarePermissions', { permissions: caps, rationale: `dogfood ${clientName}` }, { clientName });
      // The gated call: in enforce mode an unconfirmed plugin with declared caps
      // is rejected AND a prompt is minted (RpcRouter.dispatch:284-306).
      const gated = await rpcCall(mainPipe, TOKEN, gatedMethod, gatedParams, { clientName });
      return { ident, decl, gated };
    }

    const m1 = await mintPrompt(PLUGIN1, ['meta.read'], 'pane.getMetadata', { paneId: 'x' });
    const m2 = await mintPrompt(PLUGIN2, ['pane.read'], 'pane.list', {});
    const m3 = await mintPrompt(PLUGIN3, ['terminal.read'], 'input.readScreen', { ptyId: 'x' });

    const declOk = m1.decl?.result?.ok && m2.decl?.result?.ok && m3.decl?.result?.ok;
    check('2.setup: declarePermissions accepted for all three plugins', !!declOk,
      `alpha=${m1.decl?.result?.ok} beta=${m2.decl?.result?.ok} crit=${m3.decl?.result?.ok}`);

    const enforced = (g) => g && g.ok === false && g.rejection && g.rejection.reason === 'identity-status' && g.rejection.status === 'unconfirmed';
    const promptId1 = m1.gated?.rejection?.pendingApproval?.promptId;
    const promptId2 = m2.gated?.rejection?.pendingApproval?.promptId;
    const promptId3 = m3.gated?.rejection?.pendingApproval?.promptId;
    check('2.★ enforce mode rejected the gated calls AND minted prompts (real enforcer path)',
      enforced(m1.gated) && enforced(m2.gated) && enforced(m3.gated) && !!promptId1 && !!promptId2 && !!promptId3,
      `p1=${promptId1} p2=${promptId2} p3=${promptId3}`);

    const enforcerDrivable = !!(promptId1 && promptId2 && promptId3);
    let tier2Mode = enforcerDrivable ? 'REAL-ENFORCER' : 'BLOCKED';

    if (enforcerDrivable) {
      await sleep(500);
      await openFleetView(page);
      await switchToApprovalsTab(page);
      await sleep(600);

      const inboxState = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        return {
          mcpRowCount: rows.length,
          rowTexts: rows.map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)),
        };
      });
      check('2.★ all three MCP prompts appear as DISTINCT inbox rows (keyed by promptId)',
        inboxState.mcpRowCount === 3, `rows=${inboxState.mcpRowCount}: ${JSON.stringify(inboxState.rowTexts)}`);

      // Critical-Enter guard (guard #5): drive the ROVING inbox index (the
      // FleetView keydown reads inbox[inboxIdx] from React state, NOT DOM
      // activeElement) onto the CRITICAL plugin row via ArrowDown keys, confirm
      // it via aria-selected, press Enter → must NOT approve (critical needs an
      // explicit button). We must land the React-selected row on the critical
      // one, else Enter would (correctly) approve whatever non-critical row is
      // selected.
      const critIdx = await page.evaluate((cn) => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        return rows.findIndex((r) => (r.textContent || '').includes(cn));
      }, PLUGIN3);
      check('2.guard5.setup: located the critical plugin row index', critIdx >= 0, `critIdx=${critIdx}`);
      // The roving index starts at 0 (A2A-first, but no A2A now → first MCP row).
      // ArrowDown advances inboxIdx by 1 each (clamped). Press enough to reach crit.
      for (let i = 0; i < critIdx + 2; i++) { await page.keyboard.press('ArrowDown'); await sleep(120); }
      await sleep(200);
      const selState = await page.evaluate((cn) => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        const sel = rows.find((r) => r.getAttribute('aria-selected') === 'true');
        return { selectedIsCrit: !!sel && (sel.textContent || '').includes(cn), selText: sel ? (sel.textContent || '').replace(/\s+/g, ' ').slice(0, 60) : null };
      }, PLUGIN3);
      check('2.guard5.setup: roving selection landed on the critical row', selState.selectedIsCrit, JSON.stringify(selState));

      // Press Enter — the FleetView capture-phase keydown should NO-OP for the
      // selected critical row (guard #5).
      await page.keyboard.press('Enter');
      await sleep(500);
      const afterEnter = await page.evaluate((cn) => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        return { critStillPresent: rows.some((r) => (r.textContent || '').includes(cn)), mcpRowCount: rows.length };
      }, PLUGIN3);
      check('2.★ critical-Enter guard: Enter did NOT approve the critical row (row stays)',
        afterEnter.critStillPresent, `critPresent=${afterEnter.critStillPresent} rows=${afterEnter.mcpRowCount}`);
      // The crit plugin must NOT be trusted yet.
      await sleep(200);
      let trustAfterEnter = {};
      try { trustAfterEnter = JSON.parse(fs.readFileSync(trustPath, 'utf8')); } catch { /* */ }
      const critRecAfterEnter = findTrustRecord(trustAfterEnter, PLUGIN3);
      check('2.★ critical plugin still NOT trusted after Enter (no blind keyboard grant)',
        !critRecAfterEnter || critRecAfterEnter.userDecision !== 'trusted' && critRecAfterEnter.status !== 'trusted',
        `crit record=${JSON.stringify(critRecAfterEnter)}`);

      // Now resolve via the actual buttons:
      //   PLUGIN1 → Approve (button), PLUGIN2 → Deny (button), PLUGIN3 → Approve (button).
      const clickRowButton = (cn, approve) => page.evaluate(({ cn, approve }) => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        const row = rows.find((r) => (r.textContent || '').includes(cn));
        if (!row) return { ok: false, reason: 'no row' };
        const btns = Array.from(row.querySelectorAll('button'));
        const target = approve ? btns[btns.length - 1] : btns[0];
        if (!target) return { ok: false, reason: 'no button' };
        target.click();
        return { ok: true, label: target.textContent };
      }, { cn, approve });

      const c1 = await clickRowButton(PLUGIN1, true);
      await sleep(400);
      const c2 = await clickRowButton(PLUGIN2, false);
      await sleep(400);
      const c3 = await clickRowButton(PLUGIN3, true);
      await sleep(800);

      check('2: clicked Approve(alpha) / Deny(beta) / Approve(crit) inbox buttons',
        c1.ok && c2.ok && c3.ok, `c1=${JSON.stringify(c1)} c2=${JSON.stringify(c2)} c3=${JSON.stringify(c3)}`);

      const afterResolve = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        return { mcpRowCount: rows.length, texts: rows.map((r) => (r.textContent || '').replace(/\s+/g, ' ').slice(0, 80)) };
      });
      check('2.★ all MCP rows removed after resolve (PERMISSION_PROMPT_CLOSED push, no phantoms)',
        afterResolve.mcpRowCount === 0, `rows=${afterResolve.mcpRowCount}: ${JSON.stringify(afterResolve.texts)}`);

      await page.screenshot({ path: path.join(OUT_DIR, '2-mcp-inbox-resolved.png') }).catch(() => {});
      await closeFleetView(page);

      // ── Trust DB assertions (the REAL trust-DB write) ──
      await sleep(500);
      let trust = {};
      try { trust = JSON.parse(fs.readFileSync(trustPath, 'utf8')); } catch (e) { console.log(`  (trust read err: ${e.message})`); }
      const rec1 = findTrustRecord(trust, PLUGIN1);
      const rec2 = findTrustRecord(trust, PLUGIN2);
      const rec3 = findTrustRecord(trust, PLUGIN3);
      const isTrusted = (r) => r && (r.userDecision === 'trusted' || r.status === 'trusted');
      const isDenied = (r) => r && (r.userDecision === 'denied' || r.status === 'denied');
      check('2.★ plugin-trust.json: alpha=trusted (approve → trust-DB write)', isTrusted(rec1), JSON.stringify(rec1));
      check('2.★ plugin-trust.json: beta=denied (deny → trust-DB write)', isDenied(rec2), JSON.stringify(rec2));
      check('2.★ plugin-trust.json: crit=trusted (button approve, NOT Enter)', isTrusted(rec3), JSON.stringify(rec3));
      const caps1 = rec1 && (rec1.grantedCapabilities || rec1.declaredCapabilities || []);
      check('2: approved alpha carries a capability snapshot (anti-widening)',
        Array.isArray(caps1) && caps1.includes('meta.read'), `caps=${JSON.stringify(caps1)}`);
    } else {
      console.log('  [INFO] real enforcer did not mint prompts — see report; fallback not attempted because');
      console.log('         the packaged build is the real-enforcer ground truth and re-injecting via the');
      console.log('         renderer is impossible (window.useStore not exposed in the production bundle).');
    }
    console.log(`  Tier 2 mode: ${tier2Mode}`);

    // ════════════════════════════════════════════════════════════════════
    // TIER 3 — P1 fix: Enter on a focused inbox BUTTON (build #2 / 3cec23a)
    // ════════════════════════════════════════════════════════════════════
    // The Approvals capture-phase keydown now SKIPS the roving Enter/Backspace/
    // Delete shortcut when document.activeElement is a <button> inside the dialog
    // (onDialogButton, FleetView.tsx:234-238). This re-triggers a fresh set of
    // three REAL MCP prompts (distinct clientNames so the trust-DB assertions are
    // unambiguous vs. Tier 2's already-resolved records) and proves:
    //   (P1-a) Enter on a focused DENY button denies the OWNING row (build #1 would
    //          have approved the React-selected row — opposite intent).
    //   (P1-b) Enter on a focused critical APPROVE button approves explicitly
    //          (this path was unreachable by keyboard before the fix).
    //   (guard5) Enter on the focused ROW (role=option, NOT a button) of a critical
    //          row is still a no-op — the row stays.
    console.log('\n========== TIER 3 — P1 fix: Enter on a focused inbox BUTTON ==========');
    if (!enforcerDrivable) {
      check('3: SKIPPED — real enforcer did not mint prompts in Tier 2 (cannot drive inbox)', false);
    } else {
      const P1_NONCRIT = 's-c2-dogfood-p1-noncrit';   // pane.read → non-critical
      const P1_NONCRIT2 = 's-c2-dogfood-p1-spare';    // meta.read → non-critical (spare row; name must NOT be a superstring of P1_NONCRIT)
      const P1_CRIT = 's-c2-dogfood-p1-crit';         // terminal.read → CRITICAL

      // Re-trigger three prompts (mintPrompt is in scope from Tier 2).
      const t3a = await mintPrompt(P1_NONCRIT, ['pane.read'], 'pane.list', {});
      const t3b = await mintPrompt(P1_NONCRIT2, ['meta.read'], 'pane.getMetadata', { paneId: 'x' });
      const t3c = await mintPrompt(P1_CRIT, ['terminal.read'], 'input.readScreen', { ptyId: 'x' });
      const t3PromptsOk =
        !!t3a.gated?.rejection?.pendingApproval?.promptId &&
        !!t3b.gated?.rejection?.pendingApproval?.promptId &&
        !!t3c.gated?.rejection?.pendingApproval?.promptId;
      check('3.setup: three fresh MCP prompts minted (noncrit / noncrit2 / crit)', t3PromptsOk,
        `p=${t3a.gated?.rejection?.pendingApproval?.promptId},${t3b.gated?.rejection?.pendingApproval?.promptId},${t3c.gated?.rejection?.pendingApproval?.promptId}`);

      await sleep(500);
      await openFleetView(page);
      await switchToApprovalsTab(page);
      await sleep(600);

      const rows0 = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        return { count: rows.length, texts: rows.map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90)) };
      });
      check('3.setup: three MCP rows present in the inbox', rows0.count === 3,
        `rows=${rows0.count}: ${JSON.stringify(rows0.texts)}`);

      // ── (guard5) ROW-focused critical-Enter no-op ──────────────────────────
      // Land the roving selection on the critical row, focus the ROW element
      // itself (role=option, NOT a button), confirm activeElement is the row,
      // press Enter → must NOT approve (row stays, plugin still not trusted).
      const critIdx3 = await page.evaluate((cn) => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        return rows.findIndex((r) => (r.textContent || '').includes(cn));
      }, P1_CRIT);
      check('3.guard5.setup: located the critical row index', critIdx3 >= 0, `critIdx=${critIdx3}`);
      // Drive the roving React index onto the critical row via ArrowDown (clamped).
      for (let i = 0; i < critIdx3 + 2; i++) { await page.keyboard.press('ArrowDown'); await sleep(120); }
      await sleep(150);
      // Focus the ROW element (the role=option div), NOT a button inside it.
      const rowFocus = await page.evaluate((cn) => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        const row = rows.find((r) => (r.textContent || '').includes(cn));
        if (!row) return { ok: false, reason: 'no crit row' };
        row.focus();
        const a = document.activeElement;
        return {
          ok: true,
          activeIsRow: a === row,
          activeTag: a ? a.tagName : null,
          activeIsButton: !!a && a.tagName === 'BUTTON',
          ariaSelected: row.getAttribute('aria-selected'),
        };
      }, P1_CRIT);
      check('3.guard5: critical ROW (role=option) is the activeElement (NOT a button)',
        rowFocus.ok && rowFocus.activeIsRow && !rowFocus.activeIsButton,
        JSON.stringify(rowFocus));
      await page.keyboard.press('Enter');
      await sleep(500);
      const afterRowEnter = await page.evaluate((cn) => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        return { critPresent: rows.some((r) => (r.textContent || '').includes(cn)), count: rows.length };
      }, P1_CRIT);
      let trustRowEnter = {};
      try { trustRowEnter = JSON.parse(fs.readFileSync(trustPath, 'utf8')); } catch { /* */ }
      const critRecRowEnter = findTrustRecord(trustRowEnter, P1_CRIT);
      const critNotTrustedYet = !critRecRowEnter || (critRecRowEnter.status !== 'trusted' && critRecRowEnter.userDecision !== 'trusted');
      check('3.★ ROW-focused critical-Enter NO-OP: critical row stays + NOT trusted',
        afterRowEnter.critPresent && critNotTrustedYet,
        `critPresent=${afterRowEnter.critPresent} rows=${afterRowEnter.count} rec=${JSON.stringify(critRecRowEnter)}`);

      // ── (P1-a) Enter on a focused DENY button → DENIES the owning row ───────
      // Pick a NON-critical row (P1_NONCRIT). Focus its FIRST button (Deny),
      // confirm activeElement is that button, press Enter. On build #1 the
      // capture-phase Enter would have approved whatever React-selected row was
      // current (the critical row, still selected from guard5) — opposite intent.
      const denyFocus = await page.evaluate((cn) => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        const row = rows.find((r) => (r.textContent || '').includes(cn));
        if (!row) return { ok: false, reason: 'no noncrit row' };
        const btns = Array.from(row.querySelectorAll('button'));
        const deny = btns[0]; // Deny is rendered first (ApprovalInboxList.tsx:199)
        if (!deny) return { ok: false, reason: 'no deny button' };
        deny.focus();
        const a = document.activeElement;
        return {
          ok: true,
          activeIsDeny: a === deny,
          activeTag: a ? a.tagName : null,
          activeText: a ? (a.textContent || '').trim() : null,
          inDialog: !!a && !!a.closest('[role=dialog][aria-modal=true]'),
        };
      }, P1_NONCRIT);
      check('3.P1-a.setup: NON-critical row Deny button is the activeElement (BUTTON in dialog)',
        denyFocus.ok && denyFocus.activeIsDeny && denyFocus.activeTag === 'BUTTON' && denyFocus.inDialog,
        JSON.stringify(denyFocus));
      await page.keyboard.press('Enter');
      // The trust-DB write is synchronous on resolve, but the row's DOM removal
      // is driven by an async PERMISSION_PROMPT_CLOSED push over the bridge —
      // poll for it rather than racing a single fixed sleep.
      let afterDenyEnter = { denyRowGone: false, critStillPresent: true, count: -1 };
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        afterDenyEnter = await page.evaluate(({ cnDeny, cnCrit }) => {
          const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
          return {
            denyRowGone: !rows.some((r) => (r.textContent || '').includes(cnDeny)),
            critStillPresent: rows.some((r) => (r.textContent || '').includes(cnCrit)),
            count: rows.length,
          };
        }, { cnDeny: P1_NONCRIT, cnCrit: P1_CRIT });
        if (afterDenyEnter.denyRowGone) break;
      }
      let trustAfterDeny = {};
      try { trustAfterDeny = JSON.parse(fs.readFileSync(trustPath, 'utf8')); } catch { /* */ }
      const denyRec = findTrustRecord(trustAfterDeny, P1_NONCRIT);
      const denyIsDenied = denyRec && (denyRec.status === 'denied' || denyRec.userDecision === 'denied');
      const critRecAfterDeny = findTrustRecord(trustAfterDeny, P1_CRIT);
      const critNotTrustedAfterDeny = !critRecAfterDeny || (critRecAfterDeny.status !== 'trusted' && critRecAfterDeny.userDecision !== 'trusted');
      check('3.★ P1-a: Enter on focused DENY button → plugin DENIED in trust DB',
        !!denyIsDenied, `denyRec=${JSON.stringify(denyRec)}`);
      check('3.★ P1-a: the DENY-button row was removed (resolved)', afterDenyEnter.denyRowGone,
        `denyRowGone=${afterDenyEnter.denyRowGone} rows=${afterDenyEnter.count}`);
      check('3.★ P1-a: critical row was NOT wrongly approved (build #1 regression guard)',
        afterDenyEnter.critStillPresent && critNotTrustedAfterDeny,
        `critPresent=${afterDenyEnter.critStillPresent} critRec=${JSON.stringify(critRecAfterDeny)}`);

      // ── (P1-b) Enter on a focused critical APPROVE button → TRUSTS it ───────
      // Focus the critical row's LAST button (Approve), confirm activeElement,
      // press Enter. Pre-fix this was unreachable (the critical-row Enter no-op
      // swallowed it). Now native button activation owns Enter → explicit grant.
      const critApproveFocus = await page.evaluate((cn) => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        const row = rows.find((r) => (r.textContent || '').includes(cn));
        if (!row) return { ok: false, reason: 'no crit row' };
        const btns = Array.from(row.querySelectorAll('button'));
        const approve = btns[btns.length - 1]; // Approve is rendered last
        if (!approve) return { ok: false, reason: 'no approve button' };
        approve.focus();
        const a = document.activeElement;
        return {
          ok: true,
          activeIsApprove: a === approve,
          activeTag: a ? a.tagName : null,
          activeText: a ? (a.textContent || '').trim() : null,
          inDialog: !!a && !!a.closest('[role=dialog][aria-modal=true]'),
        };
      }, P1_CRIT);
      check('3.P1-b.setup: CRITICAL row Approve button is the activeElement (BUTTON in dialog)',
        critApproveFocus.ok && critApproveFocus.activeIsApprove && critApproveFocus.activeTag === 'BUTTON' && critApproveFocus.inDialog,
        JSON.stringify(critApproveFocus));
      await page.keyboard.press('Enter');
      let afterCritApprove = { critRowGone: false, count: -1 };
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        afterCritApprove = await page.evaluate((cn) => {
          const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
          return { critRowGone: !rows.some((r) => (r.textContent || '').includes(cn)), count: rows.length };
        }, P1_CRIT);
        if (afterCritApprove.critRowGone) break;
      }
      let trustAfterCrit = {};
      try { trustAfterCrit = JSON.parse(fs.readFileSync(trustPath, 'utf8')); } catch { /* */ }
      const critApproveRec = findTrustRecord(trustAfterCrit, P1_CRIT);
      const critIsTrusted = critApproveRec && (critApproveRec.status === 'trusted' || critApproveRec.userDecision === 'trusted');
      check('3.★ P1-b: Enter on focused critical APPROVE button → plugin TRUSTED in trust DB',
        !!critIsTrusted, `critRec=${JSON.stringify(critApproveRec)}`);
      check('3.★ P1-b: the critical row was removed after explicit keyboard approve',
        afterCritApprove.critRowGone, `critRowGone=${afterCritApprove.critRowGone} rows=${afterCritApprove.count}`);

      await page.screenshot({ path: path.join(OUT_DIR, '3-p1-button-enter.png') }).catch(() => {});
      // Clean up the leftover spare non-critical row (P1_NONCRIT2) via its Deny
      // button so the inbox ends empty (hygiene; not asserted).
      await page.evaluate((cn) => {
        const rows = Array.from(document.querySelectorAll('[data-inbox-row][data-source="mcp"]'));
        const row = rows.find((r) => (r.textContent || '').includes(cn));
        const btns = row ? Array.from(row.querySelectorAll('button')) : [];
        if (btns[0]) btns[0].click();
      }, P1_NONCRIT2).catch(() => {});
      await sleep(400);
      await closeFleetView(page);
    }

  } catch (err) {
    check('FATAL during scenario', false, err.stack || err.message);
  }

  // ───────────────────────── cleanup ─────────────────────────
  console.log('\n=== cleanup ===');
  try { if (browser) await browser.close(); } catch { /* */ }
  await killAppOnly(app);
  const killedDaemonPid = await shutdownDaemon();
  await sleep(500);
  const daemonGone = killedDaemonPid == null || !pidAlive(killedDaemonPid);
  const appExited = app.proc.exitCode !== null || app.proc.signalCode !== null || app.proc.pid == null || !pidAlive(app.proc.pid);
  check('cleanup: daemon terminated (zombie-free)', daemonGone,
    killedDaemonPid ? `pid ${killedDaemonPid} ${daemonGone ? 'gone' : 'STILL ALIVE'}` : 'no daemon pid');
  check('cleanup: app process exited', appExited,
    `exit=${app.proc.exitCode}/sig=${app.proc.signalCode}/alive=${app.proc.pid != null && pidAlive(app.proc.pid)}`);
  let rmOk = false;
  for (let i = 0; i < 6 && !rmOk; i++) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ } rmOk = !fs.existsSync(home); if (!rmOk) await sleep(400); }
  check('cleanup: temp HOME removed', rmOk);
  const zombies = (daemonGone ? 0 : 1) + (appExited ? 0 : 1);
  console.log(`\nZOMBIE COUNT: ${zombies} (target 0)`);

  // ───────────────────────── report ─────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) console.log('FAILED: ' + failed.map((r) => r.name).join('; '));
  process.exit(failed.length ? 1 : 0);
}

function findTrustRecord(trust, name) {
  if (!trust || typeof trust !== 'object') return null;
  // PluginTrustStore shape: either { plugins: { name: rec } } or { name: rec } or { records: [...] }.
  for (const container of [trust.plugins, trust.records, trust.identities, trust]) {
    if (!container) continue;
    if (Array.isArray(container)) {
      const hit = container.find((r) => r && (r.name === name || r.clientName === name));
      if (hit) return hit;
    } else if (typeof container === 'object') {
      if (container[name]) return container[name];
      for (const v of Object.values(container)) {
        if (v && typeof v === 'object' && (v.name === name || v.clientName === name)) return v;
      }
    }
  }
  return null;
}

main().catch(async (e) => {
  console.error('FATAL:', e.stack || e.message);
  try { if (browser) await browser.close(); } catch { /* */ }
  try { await killAppOnly(app); } catch { /* */ }
  try { await shutdownDaemon(); } catch { /* */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  process.exit(2);
});

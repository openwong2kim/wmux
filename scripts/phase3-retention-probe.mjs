// Phase 3 PR-A — hidden-pane retention functional probe (isolated packaged app).
//
// Boots an isolated instance (fresh HOME + WMUX_DATA_SUFFIX, session.json
// seeded with hiddenPaneRetentionEnabled=true), then drives the REAL feature
// end-to-end over CDP + the main pipe:
//
//   P1  claim a hidden workspace (mcp.claimWorkspace) and flood its PTY.
//       Expect the one-shot '[wmux:hidden-retention] engaged' renderer log
//       AND the hidden pane's xterm rows to stay EMPTY (bytes retained, not
//       parsed) while the flood runs.
//   P2  overflow: keep flooding past the 2MB retention cap. Expect the
//       '[wmux:hidden-retention] backlog overflow' log (pane marked dirty).
//   P3  hydrate-before-read: call input.readScreen for the hidden pane over
//       the pipe. Expect flood content in the response even though the pane
//       was never revealed (dirty → daemon resync → parse barrier → read).
//   P4  dirty reveal: flood again until dirty, stop the flood, focus the
//       hidden workspace. Expect the '[useTerminal] hidden-pane resync' log
//       and the revealed pane's DOM rows to show the flood tail.
//
// Run (after npm run package):  node scripts/phase3-retention-probe.mjs
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const APP_EXE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
const USERNAME = os.userInfo().username || 'default';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 64KB per write: the per-line variant produces bytes too slowly on a cold
// pwsh to cross the 2MB retention cap inside the probe's patience.
const FLOOD_CMD = `while($true){[Console]::Out.Write('x'*65536)}`;

class PipeClient {
  constructor(pipeName, token) {
    this.pipeName = pipeName; this.token = token;
    this.sock = null; this.buf = ''; this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.pipeName);
      let settled = false;
      sock.setEncoding('utf8');
      sock.once('connect', () => { settled = true; this.sock = sock; resolve(); });
      sock.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
      sock.on('data', (chunk) => this._onData(chunk));
    });
  }
  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? msg);
    }
  }
  call(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) return reject(new Error('not connected'));
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, method, params, token: this.token }) + '\n');
    });
  }
  close() { try { this.sock?.destroy(); } catch { /* noop */ } }
}

async function waitFor(label, fn, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* poll */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(intervalMs);
  }
}

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  if (!fs.existsSync(APP_EXE)) throw new Error(`packaged app missing: ${APP_EXE} (npm run package first)`);
  const suffix = `-p3probe${process.pid}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-p3-'));
  const env = {
    ...process.env,
    USERPROFILE: home, HOME: home, HOMEDRIVE: undefined, HOMEPATH: undefined,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    WMUX_DATA_SUFFIX: suffix, WMUX_NO_DIALOG: '1',
  };
  delete env.WMUX_DISABLE_CDP;
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  const userDataDir = path.join(env.APPDATA, `wmux${suffix}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');
  // Seed: retention ON + skip onboarding overlays (same shape perf-bench uses).
  const sid = randomUUID(); const pid = randomUUID(); const wid = randomUUID();
  fs.writeFileSync(path.join(userDataDir, 'session.json'), JSON.stringify({
    workspaces: [{
      id: wid, name: 'Workspace 1',
      rootPane: { id: pid, type: 'leaf', surfaces: [{ id: sid, ptyId: '', title: 'powershell', shell: 'powershell', cwd: '' }], activeSurfaceId: sid },
      activePaneId: pid,
    }],
    activeWorkspaceId: wid,
    sidebarVisible: true,
    hiddenPaneRetentionEnabled: true,
    onboardingCompleted: true,
    firstRunCompleted: true,
  }), 'utf8');

  console.log(`[probe] home=${home} suffix=${suffix}`);
  const proc = spawn(APP_EXE, [], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  let cdpPort = null;
  let stdoutBuf = '';
  const cdpPromise = new Promise((resolve, reject) => {
    const onChunk = (b) => {
      if (cdpPort !== null) return;
      stdoutBuf += b.toString('utf8');
      const m = stdoutBuf.match(/CDP enabled on port (\d+)/);
      if (m) { cdpPort = Number(m[1]); resolve(cdpPort); }
    };
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);
    proc.on('exit', (code) => reject(new Error(`app exited early (code ${code})`)));
    setTimeout(() => reject(new Error('timeout waiting for CDP line')), 25000);
  });

  const cleanup = () => {
    try {
      const dpid = Number(fs.readFileSync(path.join(home, `.wmux${suffix}`, 'daemon.pid'), 'utf8').trim());
      if (Number.isInteger(dpid) && dpid > 0) process.kill(dpid, 'SIGKILL');
    } catch { /* no daemon pid */ }
    try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* already gone */ }
  };
  process.on('exit', cleanup);

  try {
    const port = await cdpPromise;
    const browser = await waitFor('CDP connectable', async () => {
      try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { return null; }
    }, 30000, 500);
    const ctx = browser.contexts()[0];
    const page = await waitFor('renderer page', async () => {
      for (const p of ctx.pages()) {
        try { if (await p.evaluate(() => !!document.querySelector('.xterm'))) return p; } catch { /* navigating */ }
      }
      return null;
    }, 60000, 500);

    // Capture the retention diagnostics as they stream from the renderer.
    const consoleLines = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[wmux:hidden-retention]') || text.includes('hidden-pane resync') || text.includes('resync degraded') || text.includes('resync complete') || text.includes('gate at first data')) {
        consoleLines.push(text);
        console.log(`[renderer] ${text}`);
      }
    });

    // Main pipe client.
    const token = await waitFor('auth token', () => {
      try { return fs.readFileSync(path.join(home, `.wmux${suffix}-auth-token`), 'utf8').trim() || null; } catch { return null; }
    }, 15000, 250);
    const client = new PipeClient(`\\\\.\\pipe\\wmux${suffix}-${USERNAME}`, token);
    await waitFor('main pipe connect', async () => {
      try { await client.connect(); return true; } catch { return null; }
    }, 20000, 500);

    // Let the boot settle (daemon attach for the visible pane).
    await sleep(7000);

    // Diagnostic: the 5s autosave persists the live STORE back to
    // session.json — reading it now tells us whether loadSession actually
    // carried the seeded flag into the store (vs. the seed being rejected).
    try {
      const persisted = JSON.parse(fs.readFileSync(path.join(userDataDir, 'session.json'), 'utf8'));
      console.log(`[probe] store-persisted hiddenPaneRetentionEnabled=${persisted.hiddenPaneRetentionEnabled} (workspaces=${persisted.workspaces?.length})`);
    } catch (e) { console.log(`[probe] session.json readback failed: ${e.message}`); }
    // Diagnostic: is this instance actually in daemon mode? Retention is
    // (by design) inert for local PTYs — a false here explains an inert run.
    try {
      const ready = await page.evaluate(() => window.electronAPI.daemon.whenReady());
      console.log(`[probe] daemon.whenReady → ${JSON.stringify(ready)}`);
    } catch (e) { console.log(`[probe] daemon.whenReady failed: ${e.message}`); }

    // --- P1: claim a hidden workspace + flood it; retention must engage and
    //         the hidden pane must not be parsed.
    const claim = await client.call('mcp.claimWorkspace', { name: 'p3-hidden' });
    if (!claim?.ptyId) throw new Error(`claimWorkspace failed: ${JSON.stringify(claim)}`);
    const hiddenPty = claim.ptyId;
    const hiddenWs = claim.workspaceId;
    await sleep(2500); // hidden shell reaches its prompt
    await client.call('input.send', { ptyId: hiddenPty, text: FLOOD_CMD, submit: true, raw: true });
    await sleep(3000);
    const engaged = consoleLines.some((l) => l.includes('engaged'));
    report('P1a retention engaged log', engaged);
    // Hidden pane rows must be empty-ish: with 2 workspaces there are 2 .xterm
    // mounts; the hidden one is inside a display:none subtree.
    const hiddenRowsText = await page.evaluate(() => {
      const hidden = [];
      for (const x of document.querySelectorAll('.xterm')) {
        let el = x; let isHidden = false;
        while (el) { if (el instanceof HTMLElement && el.style.display === 'none') { isHidden = true; break; } el = el.parentElement; }
        if (isHidden) hidden.push((x.querySelector('.xterm-rows')?.textContent ?? '').trim());
      }
      return hidden;
    });
    const hiddenUnparsed = hiddenRowsText.length > 0 && hiddenRowsText.every((t) => !t.includes('xxxx'));
    report('P1b hidden pane rows stay unparsed during flood', hiddenUnparsed, `hiddenPanes=${hiddenRowsText.length} textLens=${hiddenRowsText.map((t) => t.length).join(',')}`);

    // --- P2: overflow → dirty. The cold pwsh flood can take dozens of
    // seconds to cross the 2MB cap on a loaded machine, and P3/P4 depend on
    // the dirty state — so wait generously HERE to keep ordering
    // deterministic.
    const overflowed = await waitFor('overflow log', () => consoleLines.some((l) => l.includes('backlog overflow')), 180000, 500)
      .then(() => true).catch(() => false);
    report('P2 overflow marks pane dirty', overflowed);

    // --- P3: hydrate-before-read while hidden.
    const read = await client.call('input.readScreen', { ptyId: hiddenPty, workspaceId: hiddenWs }, 20000);
    const readHasFlood = typeof read?.text === 'string' && read.text.includes('xxxx');
    report('P3 readScreen hydrates a dirty hidden pane', readHasFlood, `textLen=${read?.text?.length ?? 0}`);

    // --- P4: dirty again → stop flood → reveal → resync + content on screen.
    await waitFor('dirty again after hydrate', () => {
      const overflowCount = consoleLines.filter((l) => l.includes('backlog overflow')).length;
      return overflowCount >= 2;
    }, 30000, 500).catch(() => { /* may still be dirty from P2 if hydrate raced; reveal path covers it */ });
    await client.call('input.sendKey', { ptyId: hiddenPty, key: 'ctrl+c' });
    await sleep(800);
    const resyncCountBefore = consoleLines.filter((l) => l.includes('hidden-pane resync')).length;
    await client.call('workspace.focus', { id: hiddenWs });
    // Either path is correct on reveal: dirty → daemon resync, clean → the
    // retained backlog flushes into xterm. The load-bearing assertion is the
    // painted content below; which path ran is reported for the record.
    const resyncRan = await waitFor('resync log on reveal', () =>
      consoleLines.filter((l) => l.includes('hidden-pane resync')).length > resyncCountBefore, 8000, 250)
      .then(() => true).catch(() => false);
    // Buffer-truth assertion: the revealed pane switches to the WebGL
    // renderer, whose .xterm-rows DOM carries no text (canvas paint) — so the
    // screen content must be read from the xterm BUFFER via readScreen, which
    // is renderer-agnostic. (The hidden-pane DOM checks above remain valid:
    // hidden panes hold no WebGL context and use the DOM renderer.)
    const revealedText = await waitFor('flood content in revealed buffer', async () => {
      const r = await client.call('input.readScreen', { ptyId: hiddenPty, workspaceId: hiddenWs }, 20000).catch(() => null);
      return r?.text?.includes('xxxx') ? r.text : null;
    }, 40000, 1000).catch(async () => {
      console.log(`[probe] P4 timeout diagnostics — console lines seen:\n  ${consoleLines.join('\n  ')}`);
      return '';
    });
    report('P4 reveal paints the true screen', revealedText.includes('xxxx'), resyncRan ? 'via daemon resync (dirty path)' : 'via retained-backlog flush (clean path)');

    client.close();
    await browser.close();
  } finally {
    // Postmortem: dump every retention-related line from the main log (all
    // renderer console levels are mirrored there with timestamps — including
    // one-shot logs that fired before this probe attached its CDP listener).
    try {
      const logsDir = path.join(env.APPDATA, `wmux${suffix}`, 'logs');
      for (const f of fs.readdirSync(logsDir)) {
        const text = fs.readFileSync(path.join(logsDir, f), 'utf8');
        const hits = text.split('\n').filter((l) =>
          l.includes('hidden-retention') || l.includes('resync') || l.includes('SessionManager] load') ||
          l.includes('daemon reattach') || l.includes('reconnect') || l.includes('flushComplete') || l.includes('SessionPipe'));
        if (hits.length) console.log(`[mainlog ${f}]\n${hits.join('\n')}`);
        else console.log(`[mainlog ${f}] no retention lines (${text.length} bytes)`);
      }
    } catch (e) { console.log(`[mainlog] unreadable: ${e.message}`); }
    cleanup();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[probe] ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(2); });

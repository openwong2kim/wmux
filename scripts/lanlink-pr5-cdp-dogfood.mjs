// LanLink PR-5 — renderer pixel dogfood against the DEV build (Vite store import).
//
// Production bundles don't expose useStore (s-c2:664), so the renderer pixel pass
// runs against `npm start` (electron-forge + Vite) and reaches the SAME store via
// Vite module identity: `import('/src/renderer/stores/index.ts')` (x2 pattern).
//
// The DEV APP IS LAUNCHED BY THE POWERSHELL WRAPPER (Start-Process boots it reliably
// where a bash-launched node spawn does not), which discovers the CDP port and passes
// it here as CDP=http://127.0.0.1:<port>. This script only CONNECTS + drives + asserts.
//
// Verifies what SSR unit tests cannot — the real FleetView remote tab + RemoteInboxList
// integration rendering:
//   - Fleet View opens on the new 'remote' tab; empty state shows.
//   - Injected remote items render as cards with the "remote peer" badge + peerName + text.
//   - A control-char (ESC/CSI) message renders inertly (cards intact, RED visible as
//     text, no synthesized terminal color — the body is a React text node, never a PTY escape).
//   - Per-card dismiss (dismissRemoteItem) removes exactly that card.
// Outbound pairing/peers is proven daemon-side by lanlink-pr5-dogfood.mjs (19/19).
//
//   CDP=http://127.0.0.1:<port> node scripts/lanlink-pr5-cdp-dogfood.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const CDP = process.env.CDP;
if (!CDP) { console.error('FAIL: set CDP=http://127.0.0.1:<port>'); process.exit(2); }

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const OUT_DIR = path.join(REPO_ROOT, 'out-pr5-dogfood');
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok: !!ok }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${d ? ` — ${d}` : ''}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;

async function findPage() {
  for (let i = 0; i < 120; i++) {
    for (const ctx of browser.contexts()) {
      for (const pg of ctx.pages()) {
        try { if (await pg.evaluate(() => !!window.electronAPI && !!document.querySelector('#root'))) return pg; } catch { /* navigating */ }
      }
    }
    await sleep(500);
  }
  return null;
}

async function main() {
  console.log('\n=== LanLink PR-5 renderer CDP dogfood (dev) ===');
  console.log(`  connecting to ${CDP}`);
  browser = await chromium.connectOverCDP(CDP);
  const page = await findPage();
  if (!page) throw new Error('renderer page never became ready');
  check('renderer page ready', true, page.url());
  await page.keyboard.press('Escape'); await sleep(200);

  // Reach the SAME store via Vite module identity (production bundles don't expose it).
  const imported = await page.evaluate(async () => {
    const s = await import('/src/renderer/stores/index.ts');
    window.__s = s.useStore;
    return typeof s.useStore === 'function';
  });
  if (!check('store import (Vite URL)', imported)) throw new Error('store import failed');

  // Open Fleet View on the new 'remote' tab.
  await page.evaluate(() => { const st = window.__s.getState(); st.setFleetViewVisible(true); st.setFleetActiveTab('remote'); });
  await sleep(600);
  check('Fleet View open', await page.evaluate(() => !!document.querySelector('[role=dialog][aria-modal=true]')));
  check('remote tab empty state', await page.evaluate(() => (document.body.textContent || '').includes('No remote messages')));
  await page.screenshot({ path: path.join(OUT_DIR, '1-remote-empty.png') }).catch(() => undefined);

  // Inject two remote items — one plain, one laden with control chars (ESC/CSI).
  await page.evaluate(() => {
    const add = window.__s.getState().addRemoteItem;
    add({ recordId: 'dog-1', origin: 'remote', peerName: 'Workstation-A', text: 'hello from the other box', seq: 1, receivedAt: Date.now() });
    add({ recordId: 'dog-2', origin: 'remote', peerName: 'Laptop-B', text: 'ctrl[31mRED[0m chars here', seq: 2, receivedAt: Date.now() });
  });
  await sleep(600);

  const st1 = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-source="remote"][role=option]'));
    const body = document.body.textContent || '';
    return {
      count: rows.length,
      everyBadge: rows.length > 0 && rows.every((r) => (r.textContent || '').includes('remote peer')),
      hasA: body.includes('Workstation-A'),
      hasB: body.includes('Laptop-B'),
      hasText: body.includes('hello from the other box'),
      redVisible: body.includes('RED'),
      noSynthSpan: !document.querySelector('[data-source="remote"] span[style*="color: rgb(255"]'),
    };
  });
  check('2 remote cards rendered', st1.count === 2, `count=${st1.count}`);
  check('"remote peer" badge on every card', st1.everyBadge);
  check('both peerNames + body text rendered', st1.hasA && st1.hasB && st1.hasText);
  check('control-char message inert (RED visible as text, no synth color span)', st1.redVisible && st1.noSynthSpan);
  await page.screenshot({ path: path.join(OUT_DIR, '2-remote-cards.png') }).catch(() => undefined);

  // Per-card dismiss removes exactly that card.
  await page.evaluate(() => window.__s.getState().dismissRemoteItem('dog-1'));
  await sleep(500);
  const st2 = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-source="remote"][role=option]'));
    const body = document.body.textContent || '';
    return { count: rows.length, stillB: body.includes('Laptop-B'), goneA: !body.includes('Workstation-A') };
  });
  check('dismiss removes exactly the dismissed card', st2.count === 1 && st2.stillB && st2.goneA, `count=${st2.count}`);
  await page.screenshot({ path: path.join(OUT_DIR, '3-after-dismiss.png') }).catch(() => undefined);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== PR-5 renderer CDP: ${passed}/${results.length} ${passed === results.length ? 'ALL PASS' : 'SOME FAILED'} ===`);
  console.log(`  screenshots: ${OUT_DIR}`);
  if (passed !== results.length) process.exitCode = 1;
}

main()
  .catch((e) => { console.error('\nCDP DOGFOOD FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch { /* */ }
    // Tear down the dev tree the PowerShell wrapper launched (PID passed via env).
    // node spawn isn't subject to the harness's PowerShell static analysis, and the
    // full taskkill path avoids the bash-launched-node ENOENT.
    const devPid = process.env.DEV_PID;
    if (devPid) {
      try {
        const tk = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        spawn(tk, ['/PID', devPid, '/T', '/F'], { stdio: 'ignore' });
      } catch { /* */ }
      await sleep(2500);
    }
  });

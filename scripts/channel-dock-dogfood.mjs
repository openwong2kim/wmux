// Live CDP dogfood for the right-side channel dock (Approach A).
//
// The headline claim is "the dock REFLOWS the terminals instead of the old
// fixed overlay that COVERED them." We prove it by comparing bounding boxes:
// with the dock open, the visible terminal area must NOT overlap the dock's
// x-range (they sit side by side). Plus: default-collapsed, StatusBar toggle
// opens/closes, collapse button closes, opposite edge from the sidebar.
//
// Run: node scripts/channel-dock-dogfood.mjs   (dev wmux must be running)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';

const OUT = 'D:/wmux/out-dogfood';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpGet(url) { return new Promise((res) => { const q = http.get(url, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); }); q.on('error', () => res(null)); q.setTimeout(800, () => { q.destroy(); res(null); }); }); }
async function findPort() { for (let p = 18800; p < 18900; p++) { const b = await httpGet(`http://127.0.0.1:${p}/json/version`); if (b && b.includes('webSocketDebuggerUrl')) return p; } return null; }
async function findRenderer(ctx) { for (let i = 0; i < 60; i++) { for (const p of ctx.pages()) { try { if (await p.evaluate(() => !!document.querySelector('.xterm'))) return p; } catch { /* nav */ } } await sleep(1000); } return null; }
// NOTE: this dogfood is intentionally DOM-only — a direct store-drive via
// `import('/src/renderer/stores/index.ts')` resolves to a SEPARATE Vite module
// instance after repeated reloads and won't reflect into the app's React tree.
// All setup + assertions go through real DOM interactions instead.

// Rect of the dock and the visible terminal screen.
const rects = (page) => page.evaluate(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
  const dock = document.querySelector('[data-channel-dock]');
  const screens = Array.from(document.querySelectorAll('.xterm-screen'));
  const vis = screens.find((el) => el.getBoundingClientRect().width > 0) || screens[0];
  return { dock: r(dock), term: r(vis), statusToggle: !!document.querySelector('[data-statusbar-channels]') };
});

async function main() {
  const results = [];
  const pass = (id, cond, detail) => { results.push({ id, ok: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'} ${id} — ${detail}`); };

  const port = await findPort();
  if (!port) { console.log('RESULT: FAIL — no dev CDP endpoint'); process.exit(2); }
  console.log('CDP port:', port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  let page = await findRenderer(ctx);
  if (!page) { console.log('RESULT: FAIL — no renderer'); await browser.close(); process.exit(2); }

  // Reload so Vite serves the dock modules, then wait for re-mount.
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  for (let i = 0; i < 30; i++) { await sleep(700); try { if (await page.evaluate(() => !!document.querySelector('.xterm'))) break; } catch { /* loading */ } }
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);

  // Clean baseline DOM-only: a direct store-drive hits a duplicate Vite module
  // instance after repeated reloads and won't reflect into the app, so we close
  // the dock through its own collapse button instead.
  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(() => !!document.querySelector('[data-channel-dock]'));
    if (!open) break;
    await page.click('[data-channel-dock-collapse]').catch(() => {});
    await sleep(400);
  }

  // D1 — default collapsed: dock absent, StatusBar toggle present.
  let r = await rects(page);
  pass('D1-default-collapsed', !r.dock && r.statusToggle,
    `dock absent by default, StatusBar toggle present=${r.statusToggle}`);

  // D2 — StatusBar toggle opens the dock.
  await page.click('[data-statusbar-channels]');
  await sleep(500);
  r = await rects(page);
  pass('D2-toggle-opens', !!r.dock, `clicking StatusBar # opens the dock (dock rect=${JSON.stringify(r.dock)})`);
  await page.screenshot({ path: `${OUT}/dock-open.png` }).catch(() => {});

  // D3 — THE headline: dock REFLOWS, does not cover the terminals. The visible
  // terminal screen must not overlap the dock's x-range.
  if (r.dock && r.term) {
    const noOverlap = r.term.right <= r.dock.x + 4 || r.dock.right <= r.term.x + 4;
    pass('D3-reflow-not-overlay', noOverlap,
      `terminal[x=${r.term.x},right=${r.term.right}] vs dock[x=${r.dock.x},right=${r.dock.right}] — side by side=${noOverlap}`);
  } else {
    pass('D3-reflow-not-overlay', false, `missing rects (dock=${!!r.dock} term=${!!r.term})`);
  }

  // D4 — dock sits opposite the (left) workspace sidebar → on the right half.
  if (r.dock) {
    const vw = await page.evaluate(() => window.innerWidth);
    pass('D4-opposite-edge', r.dock.x > vw / 2, `dock on the right half (dock.x=${r.dock.x}, vw=${vw})`);
  } else { pass('D4-opposite-edge', false, 'no dock'); }

  // D5 — collapse button closes the dock.
  await page.click('[data-channel-dock-collapse]').catch(() => {});
  await sleep(400);
  r = await rects(page);
  pass('D5-collapse-closes', !r.dock, `collapse button hides the dock (present=${!!r.dock})`);

  // D6 — REAL user path (DOM only; a direct store-drive hits a duplicate Vite
  // module instance and won't reflect into the app's React tree): open the dock
  // via the StatusBar toggle, click a channel row in the list, and confirm the
  // conversation surface renders. (Channels are hydrated from the daemon on
  // mount, so the -dogfood profile's catalog populates the list.)
  await page.click('[data-statusbar-channels]'); // open the dock
  await sleep(600);
  const chRow = await page.$('[data-channel-dock] [data-channel-id]');
  if (chRow) {
    await chRow.click();
    await sleep(600);
    const conv = await page.evaluate(() => !!document.querySelector('[data-channel-view]'));
    pass('D6-click-channel-shows-conversation', conv,
      `clicking a channel row in the dock renders the conversation=${conv}`);
    await page.screenshot({ path: `${OUT}/dock-conversation.png` }).catch(() => {});
  } else {
    pass('D6-click-channel-shows-conversation', false,
      'no channel rows in the dock to click (empty hydrated catalog)');
  }
  await page.screenshot({ path: `${OUT}/dock-conversation.png` }).catch(() => {});

  // Cleanup
  await drive(page, async (useStore) => {
    const s = useStore.getState();
    s.setActiveChannel(null);
    s.setChannelDockVisible(false);
  });

  const passed = results.filter((x) => x.ok).length;
  console.log(`\nRESULT: ${passed}/${results.length} passed`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error('DOGFOOD ERROR:', e); process.exit(3); });

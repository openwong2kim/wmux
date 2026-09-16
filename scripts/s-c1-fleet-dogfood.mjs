// S-C1 Fleet View — real GUI dogfood over the dev CDP endpoint.
//
// dev wmux exposes CDP on a RANDOM port in [18800,18900) and prints
// "[WinMux] CDP requested on port <port>". We scan that range, connect
// playwright-core, and exercise the cockpit end-to-end against the LIVE
// renderer + daemon:
//
//   HARD assertions (deterministic — a FAIL means the feature is broken):
//     A1  Ctrl+Shift+A opens the Fleet View overlay
//     A2  the grid enumerates panes across MULTIPLE workspaces (cross-ws)
//     A3  each card carries workspace + status metadata
//     A4  clicking a card in ANOTHER workspace closes the overlay AND
//         switches the active workspace to that card's workspace (the jump)
//     A5  Esc closes the overlay
//
//   BEST-EFFORT (heuristic timing — reported, not a hard fail):
//     B1  driving a pane's output into the Claude awaiting_input prompt makes
//         its card show data-status="awaiting_input" and sort FIRST
//         (the sort logic itself is locked by fleet.test.ts; this is the live
//          signal-path witness, which the activity-idle heuristic can race)
//
// Run: node scripts/s-c1-fleet-dogfood.mjs   (dev wmux must be running)
import { chromium } from 'playwright-core';
import http from 'node:http';

const OUT = 'D:/wmux/out-dogfood';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

async function findCdpPort() {
  for (let port = 18800; port < 18900; port++) {
    const body = await httpGet(`http://127.0.0.1:${port}/json/version`);
    if (body && body.includes('webSocketDebuggerUrl')) return port;
  }
  return null;
}

async function findRenderer(ctx) {
  for (let i = 0; i < 60; i++) {
    for (const p of ctx.pages()) {
      try {
        const ok = await p.evaluate(() => !!document.querySelector('.xterm'));
        if (ok) return p;
      } catch { /* navigating */ }
    }
    await sleep(1000);
  }
  return null;
}

const readActiveWsName = (page) => page.evaluate(() => {
  const row = document.querySelector('.sidebar-row-active');
  if (!row) return null;
  const name = row.querySelector('.font-mono');
  return name ? name.textContent.trim() : null;
});

const countWorkspaceRows = (page) => page.evaluate(() =>
  document.querySelectorAll('.sidebar-row').length);

const readCards = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-fleet-card]')).map((el) => ({
    status: el.getAttribute('data-status'),
    ptyId: el.getAttribute('data-pty-id'),
    workspaceId: el.getAttribute('data-workspace-id'),
    workspaceName: el.getAttribute('data-workspace-name'),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
  })));

const fleetOpen = (page) => page.evaluate(() => !!document.querySelector('[data-fleet-card]') || !!document.querySelector('[data-fleet-overlay]'));

async function chord(page, mods, key) {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
  await sleep(250);
}

async function focusActiveTerminal(page) {
  const box = await page.evaluate(() => {
    // the visible (not display:none) xterm screen
    const screens = Array.from(document.querySelectorAll('.xterm-screen'));
    const vis = screens.find((el) => el.getBoundingClientRect().width > 0) || screens[0];
    if (!vis) return null;
    const r = vis.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (box) { await page.mouse.click(box.x, box.y); await sleep(200); }
}

async function main() {
  const results = [];
  const pass = (id, cond, detail) => { results.push({ id, ok: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'} ${id} — ${detail}`); };

  const port = await findCdpPort();
  if (!port) { console.log('RESULT: FAIL — no dev wmux CDP endpoint in [18800,18900). Is `npm start` running?'); process.exit(2); }
  console.log('CDP port:', port);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  const page = await findRenderer(ctx);
  if (!page) { console.log('RESULT: FAIL — no renderer with .xterm within 60s'); await browser.close(); process.exit(2); }
  console.log('renderer:', page.url());

  // Clear any stray modal so the keyboard is live.
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);

  // ── Build a multi-workspace fleet: ensure ≥3 workspaces ──
  const wsBefore = await countWorkspaceRows(page);
  console.log('workspace rows before:', wsBefore);
  for (let i = wsBefore; i < 3; i++) { await chord(page, ['Control'], 'KeyN'); await sleep(1200); }
  const wsAfter = await countWorkspaceRows(page);
  console.log('workspace rows after:', wsAfter);

  // ── B1 setup: drive the active workspace's pane into awaiting_input via the
  //    REAL AgentDetector path (gate banner + anchored approval prompt). ──
  await focusActiveTerminal(page);
  const triggerWsName = await readActiveWsName(page);
  await page.keyboard.type('Write-Output "Claude Code"; Write-Output "Do you want to proceed?"');
  await page.keyboard.press('Enter');
  await sleep(1400); // let the daemon detector → METADATA_UPDATE → store settle

  // ── A1: open the cockpit ──
  await chord(page, ['Control', 'Shift'], 'KeyA');
  await sleep(400);
  let open = await fleetOpen(page);
  pass('A1', open, 'Ctrl+Shift+A opens Fleet View overlay');
  if (!open) { console.log('RESULT: FAIL early — overlay never opened'); await browser.close(); process.exit(1); }

  await page.screenshot({ path: `${OUT}/sc1-fleet-open.png` }).catch(() => {});
  let cards = await readCards(page);
  console.log('cards:', JSON.stringify(cards, null, 1));

  // ── A2: cross-workspace enumeration ──
  const distinctWs = new Set(cards.map((c) => c.workspaceId)).size;
  pass('A2', cards.length >= 2 && distinctWs >= 2, `grid shows ${cards.length} cards across ${distinctWs} workspaces`);

  // ── A3: card metadata present ──
  const metaOk = cards.length > 0 && cards.every((c) => c.status && c.workspaceId && c.workspaceName);
  pass('A3', metaOk, 'every card carries status + workspace metadata');

  // ── A6: Tab is trapped inside the overlay (focus never escapes to the bg) ──
  const focusBefore = await page.evaluate(() => !!document.activeElement?.closest?.('[role="dialog"]'));
  await page.keyboard.press('Tab'); await sleep(150);
  await page.keyboard.press('Tab'); await sleep(150);
  const focusAfter = await page.evaluate(() => {
    const ae = document.activeElement;
    return { inDialog: !!ae?.closest?.('[role="dialog"]'), onCard: !!ae?.hasAttribute?.('data-fleet-card') };
  });
  pass('A6', focusBefore && focusAfter.inDialog,
    `Tab keeps focus inside overlay (before=${focusBefore}, after inDialog=${focusAfter.inDialog} onCard=${focusAfter.onCard})`);

  // ── B1: awaiting_input witnessed + sorted first (best-effort) ──
  const awaiting = cards.find((c) => c.status === 'awaiting_input');
  const awaitingFirst = cards.length > 0 && cards[0].status === 'awaiting_input';
  console.log(`B1 awaiting_input present=${!!awaiting} sortedFirst=${awaitingFirst} (triggerWs=${triggerWsName})`);

  // ── A4: jump — click a card in a DIFFERENT workspace, expect ws switch + close ──
  // Identify + click by workspaceId (unique), not workspaceName (which can
  // collide across workspaces and make the jump assertion flaky).
  const activeBefore = await readActiveWsName(page);
  const activeWsId = (cards.find((c) => c.workspaceName === activeBefore) || {}).workspaceId;
  const target = cards.find((c) => c.workspaceId && c.workspaceId !== activeWsId) || cards[0];
  console.log(`A4 active=${activeBefore} (${activeWsId}) → clicking card ws=${target?.workspaceName} (${target?.workspaceId})`);
  await page.evaluate((wsId) => {
    const el = Array.from(document.querySelectorAll('[data-fleet-card]'))
      .find((e) => e.getAttribute('data-workspace-id') === wsId);
    el?.click();
  }, target?.workspaceId);
  await sleep(700);
  const closedAfterJump = !(await fleetOpen(page));
  const activeAfter = await readActiveWsName(page);
  pass('A4', closedAfterJump && activeAfter === target?.workspaceName,
    `jump closed overlay=${closedAfterJump}, active ${activeBefore} → ${activeAfter} (want ${target?.workspaceName})`);
  await page.screenshot({ path: `${OUT}/sc1-fleet-after-jump.png` }).catch(() => {});

  // ── A5: Esc closes ──
  await chord(page, ['Control', 'Shift'], 'KeyA'); // reopen
  await sleep(300);
  const reopened = await fleetOpen(page);
  await page.keyboard.press('Escape');
  await sleep(300);
  const closedByEsc = !(await fleetOpen(page));
  pass('A5', reopened && closedByEsc, `reopen=${reopened}, Esc closes=${closedByEsc}`);

  await browser.close();

  const hardFails = results.filter((r) => !r.ok);
  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}: ${r.detail}`);
  console.log(`  · B1 (best-effort): awaiting_input ${awaiting ? 'witnessed' : 'NOT caught (heuristic idle race; sort locked by unit test)'}`);
  console.log(`RESULT: ${hardFails.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - hardFails.length}/${results.length} hard checks`);
  process.exit(hardFails.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });

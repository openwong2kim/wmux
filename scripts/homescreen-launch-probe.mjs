// Does the installed app work when it opens with no token in the URL?
//
// The manifest's `start_url` is "./", so launching from the home screen loads
// the bare origin — no `?token=`. The page therefore has to authenticate from
// storage or it draws a shell that 401s on every call. Dogfooding hit exactly
// that: the credential lived in sessionStorage, which iOS drops when it evicts
// an installed PWA, so "add to home screen, come back later" was a dead app.
//
// This is a separate script rather than a scenario inside
// m3-csp-device-stream-dynamic.mjs on purpose. Proving it needs a SECOND TAB
// in the SAME browser context — sessionStorage is per-tab, localStorage is
// per-origin, and that asymmetry IS the test. Opening that tab inside the
// ticket-renew scenario perturbs the request counts that scenario asserts on,
// so it would break the thing it was added to.
//
// Usage:  node scripts/homescreen-launch-probe.mjs <origin> <token>
//   e.g.  node scripts/homescreen-launch-probe.mjs http://127.0.0.1:7681 <token>
//
// Exit 0 pass, 1 fail, 2 could not run.
import { chromium } from 'playwright-core';

const ORIGIN = (process.argv[2] || '').replace(/\/+$/, '');
const TOKEN = process.argv[3];
if (!ORIGIN || !TOKEN) {
  console.error('usage: node scripts/homescreen-launch-probe.mjs <origin> <token>');
  process.exit(2);
}

let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
} catch (err) {
  console.error(`could not launch a browser (${err?.message || err}) — skipping`);
  process.exit(2);
}

try {
  const ctx = await browser.newContext();

  // 1. First visit, the way the CLI hands you the URL.
  const first = await ctx.newPage();
  await first.goto(`${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' });
  await first.waitForFunction(
    () => document.querySelectorAll('#sessions option, .sess').length > 0,
    null, { timeout: 20_000 },
  );
  const stored = await first.evaluate(() => ({
    local: !!localStorage.getItem('wmux-web-token'),
    session: !!sessionStorage.getItem('wmux-web-token'),
    urlStillCarriesToken: location.search.includes('token='),
  }));

  // 2. The home-screen launch: a fresh tab in the SAME context (shared
  //    localStorage, fresh sessionStorage) opening the bare origin.
  const home = await ctx.newPage();
  // Recorded, NOT asserted on: the SSE routes carry `?token=` on purpose,
  // because EventSource cannot set a header and the operator token is allowed
  // that one exception. A DEVICE credential in a query string is the thing
  // that must never happen, and the server rejects it with 401 rather than
  // relying on the page to behave — see the M3 harness for that assertion.
  const sseQueryRoutes = [];
  home.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/') && u.search.includes('token=')) sseQueryRoutes.push(u.pathname);
  });
  await home.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });

  let authenticated = false;
  try {
    await home.waitForFunction(
      () => document.querySelectorAll('#sessions option, .sess').length > 0,
      null, { timeout: 20_000 },
    );
    authenticated = true;
  } catch { authenticated = false; }

  const detail = await home.evaluate(() => ({
    credentialFound: !!localStorage.getItem('wmux-web-token'),
    sessionCopy: !!sessionStorage.getItem('wmux-web-token'),
    sessions: document.querySelectorAll('#sessions option, .sess').length,
    conn: (document.querySelector('#conn-label')?.textContent || '').trim(),
  }));

  const evidence = {
    firstVisit: stored,
    homeScreenLaunch: { ...detail, authenticated, sseRoutesUsingQueryToken: sseQueryRoutes },
  };
  console.log(JSON.stringify(evidence, null, 2));

  const pass = authenticated && detail.credentialFound && detail.sessions > 0;
  console.log(pass
    ? '\nPASS — the installed app authenticates itself with no token in the URL'
    : '\nFAIL — a tokenless launch could not authenticate');
  await browser.close();
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.error(`probe error: ${err?.message || err}`);
  await browser.close().catch(() => {});
  process.exit(2);
}

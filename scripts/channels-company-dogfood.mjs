// Live CDP dogfood for two fixes (uncommitted working tree):
//   1) Company-mode UI wiring — Ctrl+K "Company:" commands were "visible but
//      no reaction" because sidebarMode='company' had no renderer consumer and
//      CompanyPanel was orphaned. Fix: Sidebar renders CompanyPanel on
//      sidebarMode==='company' + a header toggle (entry/exit).
//   2) Channels decouple + hydration — channels were gated on in-app Company
//      mode and the renderer never hydrated the daemon catalog.
//
// dev wmux exposes CDP on a random port in [18800,18900). We connect
// playwright-core, drive the LIVE renderer (real click for the toggle; store
// actions for the palette-command effects), and assert the visible result.
//
// Run: node scripts/channels-company-dogfood.mjs   (dev wmux must be running)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';

const OUT = 'D:/wmux/out-dogfood';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve(body));
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
      try { if (await p.evaluate(() => !!document.querySelector('.xterm'))) return p; } catch { /* navigating */ }
    }
    await sleep(1000);
  }
  return null;
}

// All store mutations go through the Vite module URL (dev). Returns plain JSON.
// Extra args after `fn` are forwarded to the evaluated function (after useStore).
const drive = (page, fn, ...args) => page.evaluate(async ({ src, args }) => {
  const { useStore } = await import('/src/renderer/stores/index.ts');
  // eslint-disable-next-line no-eval
  const f = eval('(' + src + ')');
  return await f(useStore, ...args);
}, { src: fn.toString(), args });

const readSidebar = (page) => page.evaluate(() => {
  const panel = document.querySelector('[data-channels-panel]');
  const toggle = document.querySelector('[data-company-toggle]');
  return {
    companyToggle: !!toggle,
    togglePressed: toggle ? toggle.getAttribute('aria-pressed') : null,
    channelsPanel: !!panel,
    companyState: panel ? panel.getAttribute('data-company-state') : null,
    channelCount: panel ? panel.getAttribute('data-channel-count') : null,
    channelIds: Array.from(document.querySelectorAll('[data-channel-id]')).map((e) => e.getAttribute('data-channel-id')),
    workspaceRows: document.querySelectorAll('.sidebar-row').length,
    noCompanyPrompt: document.body.textContent.includes('No company created yet'),
    hasDogfoodCo: document.body.textContent.includes('Dogfood Co'),
    hasDogfoodChan: document.body.textContent.includes('dogfood-chan'),
  };
});

async function main() {
  const results = [];
  const pass = (id, cond, detail, opts = {}) => { results.push({ id, ok: !!cond, besteffort: !!opts.besteffort, detail }); console.log(`${cond ? 'PASS' : (opts.besteffort ? 'WARN' : 'FAIL')} ${id} — ${detail}`); };

  const port = await findCdpPort();
  if (!port) { console.log('RESULT: FAIL — no dev wmux CDP endpoint. Is the dev app running?'); process.exit(2); }
  console.log('CDP port:', port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  const page = await findRenderer(ctx);
  if (!page) { console.log('RESULT: FAIL — no renderer with .xterm in 60s'); await browser.close(); process.exit(2); }
  console.log('renderer:', page.url());
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);

  // Clean known baseline: workspaces mode, no company, no dogfood channel.
  await drive(page, async (useStore) => {
    const s = useStore.getState();
    if (s.company) s.destroyCompany();
    s.setSidebarMode('workspaces');
  });
  await sleep(400);

  // ── Company-mode fix ────────────────────────────────────────────────
  let sb = await readSidebar(page);
  pass('C1-toggle-present', sb.companyToggle && sb.togglePressed === 'false',
    `company toggle present in workspaces mode (pressed=${sb.togglePressed})`);
  pass('C1-channels-decoupled', sb.channelsPanel,
    `channels panel renders without a company (company-state=${sb.companyState})`);

  // C2 — REAL user click on the toggle → CompanyPanel must mount (was orphaned).
  await page.click('[data-company-toggle]');
  await sleep(500);
  sb = await readSidebar(page);
  pass('C2-toggle-enters-company', sb.togglePressed === 'true' && sb.noCompanyPrompt,
    `clicking toggle shows CompanyPanel empty state ("No company created yet"=${sb.noCompanyPrompt})`);
  await page.screenshot({ path: `${OUT}/company-empty.png` }).catch(() => {});

  // C3 — the palette "Company: Create …" command effect: createCompany + mode.
  await drive(page, async (useStore) => {
    const s = useStore.getState();
    s.createCompany('Dogfood Co');
    useStore.getState().setSidebarMode('company');
  });
  await sleep(500);
  sb = await readSidebar(page);
  pass('C3-company-tree-visible', sb.hasDogfoodCo && !sb.noCompanyPrompt,
    `created company renders in the sidebar (hasDogfoodCo=${sb.hasDogfoodCo})`);
  await page.screenshot({ path: `${OUT}/company-tree.png` }).catch(() => {});

  // C4 — toggle back to workspaces.
  await page.click('[data-company-toggle]');
  await sleep(400);
  sb = await readSidebar(page);
  pass('C4-toggle-exits-company', sb.togglePressed === 'false' && sb.workspaceRows > 0,
    `toggle returns to workspaces (rows=${sb.workspaceRows})`);

  // ── Channels decouple + hydration ───────────────────────────────────
  // Unique channel name per run — the daemon persists channels in the -dogfood
  // profile, so a fixed name would collide (INVALID_NAME) on re-run.
  const chan = 'dogfood-' + Date.now().toString(36);
  const bodyHas = (text) => page.evaluate((t) => document.body.textContent.includes(t), text);

  await drive(page, async (useStore) => {
    const s = useStore.getState();
    if (s.company) s.destroyCompany();
    s.setSidebarMode('workspaces');
  });
  await sleep(400);
  sb = await readSidebar(page);
  pass('CH1-panel-no-company', sb.channelsPanel && sb.companyState === 'absent',
    `channels panel present with NO company (not a dead-end), state=${sb.companyState}`);

  // CH2 — create a channel without a company (active-workspace identity).
  const created = await drive(page, async (useStore, name) => {
    const s = useStore.getState();
    const ws = s.activeWorkspaceId;
    const companyId = s.company?.id ?? 'co-default';
    const self = s.company?.ceoWorkspaceId ?? ws;
    const channel = {
      id: `ch-local-${Date.now().toString(36)}`, companyId, name,
      visibility: 'public', status: 'active', createdAt: Date.now(), createdBy: 'local-ui', nextSeq: 1,
    };
    const r = await s.createChannelDaemon({
      name, visibility: 'public',
      createdBy: { workspaceId: self, memberId: 'local-ui', memberName: 'local-ui' }, channel,
    });
    return { ok: r.ok, err: r.ok ? null : r.error, self };
  }, chan);
  await sleep(500);
  const ch2Visible = await bodyHas(chan);
  pass('CH2-create-without-company', created.ok && ch2Visible,
    `channel "${chan}" created w/o company (daemon ok=${created.ok}${created.err ? ' err=' + JSON.stringify(created.err) : ''}) and visible in sidebar=${ch2Visible}`);
  await page.screenshot({ path: `${OUT}/channels-no-company.png` }).catch(() => {});

  // CH3 — hydration: wipe the renderer catalog (simulate fresh start) then run
  // the exact list→getMembers→setChannels path useChannelsHydration uses,
  // including the { id, ok, result } transport-envelope unwrap.
  const hydrated = await drive(page, async (useStore) => {
    const unwrap = (r) => (r && typeof r === 'object' && r.result && typeof r.result === 'object') ? r.result : r;
    const s = useStore.getState();
    useStore.setState((st) => { st.channels = {}; st.channelMembers = {}; });
    const beforeCount = Object.keys(useStore.getState().channels).length;
    const ws = s.activeWorkspaceId;
    const self = s.company?.ceoWorkspaceId ?? ws;
    const bridge = window.__wmuxChannelsRpc;
    if (!bridge) return { beforeCount, error: 'no bridge' };
    const listEnv = unwrap(await bridge.rpc('a2a.channel.list', { workspaceId: self, verifiedWorkspaceId: self }));
    const channels = (listEnv && listEnv.ok && Array.isArray(listEnv.channels)) ? listEnv.channels : [];
    const members = {};
    for (const ch of channels) {
      const mEnv = unwrap(await bridge.rpc('a2a.channel.getMembers', { channelId: ch.id, workspaceId: self, verifiedWorkspaceId: self }));
      if (mEnv && mEnv.ok && Array.isArray(mEnv.members)) members[ch.id] = mEnv.members;
    }
    useStore.getState().setChannels(channels, members);
    return { beforeCount, listedNames: channels.map((c) => c.name), afterCount: Object.keys(useStore.getState().channels).length };
  });
  await sleep(400);
  const ch3Visible = await bodyHas(chan);
  const hydOk = hydrated.beforeCount === 0 && (hydrated.listedNames || []).includes(chan) && ch3Visible;
  pass('CH3-hydration-from-daemon', hydOk,
    `wiped catalog (before=${hydrated.beforeCount}) → hydrated ${(hydrated.listedNames || []).length} channel(s) from daemon → "${chan}" visible=${ch3Visible}`);
  await page.screenshot({ path: `${OUT}/channels-hydrated.png` }).catch(() => {});

  // CH4 — DEPLOYED hook end-to-end: reload the renderer (Vite serves the FIXED
  // modules) and assert useChannelsHydration auto-populates from the daemon on
  // mount, with NO manual bridge calls. This is the real proof the shipped hook
  // (not just the inline pattern) works.
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  // wait for the renderer to re-mount (.xterm) then for hydration to land.
  let remounted = false;
  for (let i = 0; i < 30; i++) { await sleep(700); try { if (await page.evaluate(() => !!document.querySelector('.xterm'))) { remounted = true; break; } } catch { /* loading */ } }
  let ch4Visible = false;
  if (remounted) {
    for (let i = 0; i < 12; i++) { await sleep(700); if (await bodyHas(chan)) { ch4Visible = true; break; } }
  }
  pass('CH4-deployed-hydration-on-reload', ch4Visible,
    `after reload, the shipped useChannelsHydration auto-loaded "${chan}" from the daemon=${ch4Visible} (remounted=${remounted})`);
  await page.screenshot({ path: `${OUT}/channels-reload-hydrated.png` }).catch(() => {});

  // CH5 — DEPLOYED event subscription (best-effort, timing-sensitive): post a
  // message via the raw daemon path (NO optimistic insert) and confirm it
  // arrives through the 1 Hz events.poll. Pre-fix this silently delivered
  // nothing (read one level too shallow). Isolated from optimistic insert by
  // clearing the local message cache before posting.
  const posted = ch4Visible ? await drive(page, async (useStore, name) => {
    const s = useStore.getState();
    const self = s.company?.ceoWorkspaceId ?? s.activeWorkspaceId;
    const ch = Object.values(useStore.getState().channels).find((c) => c.name === name);
    if (!ch) return { ok: false, error: 'channel not hydrated' };
    useStore.getState().setActiveChannel(ch.id);
    useStore.setState((st) => { st.channelMessages[ch.id] = []; });
    const text = 'live-evt-' + Date.now().toString(36);
    const raw = await window.__wmuxChannelsRpc.mutateLocal('a2a.channel.post', {
      channelId: ch.id, text,
      sender: { workspaceId: self, memberId: 'local-ui', memberName: 'local-ui' },
      verifiedWorkspaceId: self, clientMsgId: 'cmid-' + text,
    });
    const ok = !!(raw && (raw.ok === true || (raw.result && raw.result.ok === true)));
    return { ok, text, chId: ch.id };
  }, chan) : { ok: false, error: 'skipped (no hydration)' };
  let ch5 = false;
  if (posted.ok) {
    for (let i = 0; i < 7; i++) {
      await sleep(800);
      const seen = await drive(page, async (useStore, payload) => {
        const msgs = useStore.getState().channelMessages[payload.chId] || [];
        return msgs.some((m) => m.text === payload.text);
      }, posted);
      if (seen) { ch5 = true; break; }
    }
  }
  pass('CH5-live-event-delivery', ch5,
    `posted "${posted.text || '?'}" via daemon (no optimistic) → arrived through events.poll=${ch5}${posted.error ? ' (' + posted.error + ')' : ''}`,
    { besteffort: true });

  // Cleanup the dogfood channel + company so we don't pollute the dev profile.
  await drive(page, async (useStore) => {
    const s = useStore.getState();
    if (s.company) s.destroyCompany();
    s.setSidebarMode('workspaces');
  });

  const hard = results.filter((r) => !r.besteffort);
  const passed = hard.filter((r) => r.ok).length;
  const be = results.filter((r) => r.besteffort);
  const bePassed = be.filter((r) => r.ok).length;
  console.log(`\nRESULT: ${passed}/${hard.length} hard passed` + (be.length ? ` (+ ${bePassed}/${be.length} best-effort)` : ''));
  await browser.close();
  process.exit(passed === hard.length ? 0 : 1);
}
main().catch((e) => { console.error('DOGFOOD ERROR:', e); process.exit(3); });

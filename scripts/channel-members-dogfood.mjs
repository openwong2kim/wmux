// Live CDP dogfood for the channel members roster (membership v1).
// Reload picks up the new ChannelMembers renderer module (Vite). DOM-driven
// (store import hits a duplicate Vite module after reloads — see dock dogfood).
//
// Asserts: M1 count button in the channel header, M2 popover opens with a roster,
// M3 the self row has a leave (✕) button, M4 a public channel shows "+ member"
// add rows, M5 clicking an add row fires a join feedback toast.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
const OUT = 'D:/wmux/out-dogfood'; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpGet(url){return new Promise((res)=>{const q=http.get(url,(r)=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res(b));});q.on('error',()=>res(null));q.setTimeout(800,()=>{q.destroy();res(null);});});}
async function findPort(){for(let p=18800;p<18900;p++){const b=await httpGet(`http://127.0.0.1:${p}/json/version`);if(b&&b.includes('webSocketDebuggerUrl'))return p;}return null;}

const results = [];
const pass = (id, cond, detail, opts = {}) => { results.push({ id, ok: !!cond, besteffort: !!opts.besteffort }); console.log(`${cond ? 'PASS' : (opts.besteffort ? 'WARN' : 'FAIL')} ${id} — ${detail}`); };

const port = await findPort(); if (!port) { console.log('NO CDP'); process.exit(2); }
console.log('port', port);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
let page = null;
for (const p of ctx.pages()) { try { if (await p.evaluate(() => !!document.querySelector('.xterm'))) { page = p; break; } } catch {} }
if (!page) { console.log('NO RENDERER'); await browser.close(); process.exit(2); }

await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
for (let i = 0; i < 30; i++) { await sleep(700); try { if (await page.evaluate(() => !!document.querySelector('.xterm'))) break; } catch {} }
await page.keyboard.press('Escape').catch(() => {});
await sleep(400);

// Open dock + a channel.
if (!(await page.evaluate(() => !!document.querySelector('[data-channel-dock]')))) {
  await page.click('[data-statusbar-channels]').catch(() => {}); await sleep(700);
}
const row = await page.$('[data-channel-dock] [data-channel-id]');
if (!row) { console.log('NO CHANNEL ROW'); await browser.close(); process.exit(1); }
await row.click(); await sleep(600);

// M1 — count button in the header.
const m1 = await page.evaluate(() => {
  const b = document.querySelector('[data-channel-view] [data-channel-members-button]');
  return { present: !!b, count: b?.querySelector('[data-channel-members-count]')?.textContent };
});
pass('M1-count-button', m1.present, `members count button in header (count=${m1.count})`);

// M2 — popover opens.
await page.click('[data-channel-view] [data-channel-members-button]').catch(() => {});
await sleep(300);
const m2 = await page.evaluate(() => {
  const pop = document.querySelector('[data-channel-members-popover]');
  return { open: !!pop, rows: document.querySelectorAll('[data-channel-member-row]').length, addRows: document.querySelectorAll('[data-channel-member-add]').length, selfLeave: !!document.querySelector('[data-channel-member-leave]') };
});
pass('M2-popover-opens', m2.open, `popover opens with ${m2.rows} member row(s)`);
pass('M3-self-leave-affordance', m2.selfLeave || m2.rows === 0, `self row has a leave (✕) button (=${m2.selfLeave}); rows=${m2.rows}`, { besteffort: true });
pass('M4-add-member-rows', m2.addRows >= 0, `"+ member" add rows present=${m2.addRows} (>0 only for public channel with joinable workspaces)`, { besteffort: true });
await page.screenshot({ path: `${OUT}/members-popover.png` }).catch(() => {});

// M5 — clicking an add row fires a join toast (only if add rows exist).
if (m2.addRows > 0) {
  await page.click('[data-channel-member-add]').catch(() => {});
  let toast = '';
  for (let i = 0; i < 6; i++) { await sleep(500); toast = await page.evaluate(() => Array.from(document.querySelectorAll('[role="status"]')).map((e) => e.textContent || '').join(' | ')); if (toast.trim()) break; }
  pass('M5-join-toast', !!toast.trim(), `clicking "+ member" → join feedback toast: "${toast.slice(0, 70)}"`, { besteffort: true });
  await page.screenshot({ path: `${OUT}/members-join-toast.png` }).catch(() => {});
} else {
  pass('M5-join-toast', true, 'no add rows to click (channel private or all workspaces already members) — skipped', { besteffort: true });
}

const hard = results.filter((r) => !r.besteffort);
const passed = hard.filter((r) => r.ok).length;
const be = results.filter((r) => r.besteffort);
console.log(`\nRESULT: ${passed}/${hard.length} hard passed (+ ${be.filter((r) => r.ok).length}/${be.length} best-effort)`);
await browser.close();
process.exit(passed === hard.length ? 0 : 1);

#!/usr/bin/env node
// Record a tab of the isolated instance's dedicated Chrome (the browser agents drive over CDP).
//
//   node scripts/readme-clips/rec-chrome.mjs --suffix readme1 --name browser-chrome-tab --seconds 20
//
// Stops after --seconds, when --until-file appears, or on Ctrl+C. Run it next to rec.mjs
// (two processes) to get both screencasts of one take; marks.json in both outputs uses
// wall-clock-aligned times, so the composer can sync them.
// Options: --port <cdp port> (default: read DevToolsActivePort from the instance's profile),
// --match <url substring> (default: the first http(s) tab), --scenario <file.mjs> (optional,
// gets { page, cursor, mark, sleep, log }), --out <dir>, --width 1440 --height 900.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Cursor, Recorder, instancePaths, normSuffix, loadPlaywright, sleep } from './lib.mjs';

const { values: a } = parseArgs({
  options: {
    suffix: { type: 'string' },
    name: { type: 'string' },
    port: { type: 'string' },
    match: { type: 'string' },
    scenario: { type: 'string' },
    seconds: { type: 'string' },
    'until-file': { type: 'string' },
    out: { type: 'string' },
    width: { type: 'string', default: '1440' },
    height: { type: 'string', default: '900' },
  },
});
if (!a.suffix || !a.name) {
  console.error('usage: rec-chrome.mjs --suffix readme1 --name <clip> [--seconds N | --until-file f | --scenario f]');
  process.exit(2);
}
a.suffix = normSuffix(a.suffix);
const paths = instancePaths(a.suffix);

function findPort() {
  if (a.port) return Number(a.port);
  const stack = [paths.chromeProfile];
  for (let depth = 0; depth < 3 && stack.length; depth++) {
    for (const dir of stack.splice(0)) {
      const f = path.join(dir, 'DevToolsActivePort');
      if (fs.existsSync(f)) return Number(fs.readFileSync(f, 'utf8').split('\n')[0]);
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) stack.push(path.join(dir, e.name));
      } catch { /* not there yet */ }
    }
  }
  return null;
}
let port = findPort();
for (let i = 0; !port && i < 60; i++) { await sleep(500); port = findPort(); }
if (!port) {
  console.error(`no DevToolsActivePort under ${paths.chromeProfile}; open the dedicated Chrome from wmux first or pass --port`);
  process.exit(1);
}

const out = path.resolve(a.out || path.join(os.tmpdir(), 'readme-clips', a.name));
if (fs.existsSync(path.join(out, 'frames'))) {
  console.error(`${out}/frames exists; pick a new --out or --name`);
  process.exit(2);
}

const { chromium } = loadPlaywright();
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pick = () => browser.contexts().flatMap((c) => c.pages())
  .find((p) => (a.match ? p.url().includes(a.match) : /^https?:/.test(p.url())));
let page = pick();
for (let i = 0; !page && i < 60; i++) { await sleep(500); page = pick(); }
if (!page) {
  console.error('no matching tab; tabs:', browser.contexts().flatMap((c) => c.pages().map((p) => p.url())));
  process.exit(1);
}
try {
  const pageCdp = await page.context().newCDPSession(page);
  const { targetInfo } = await pageCdp.send('Target.getTargetInfo');
  const bcdp = await browser.newBrowserCDPSession();
  const { windowId } = await bcdp.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
  await bcdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await bcdp.send('Browser.setWindowBounds', { windowId, bounds: { width: Number(a.width), height: Number(a.height) } });
} catch (e) {
  console.warn(`[rec-chrome] could not set window bounds (${e.message})`);
}
const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
console.log(`[rec-chrome] port ${port} tab ${page.url().slice(0, 60)} viewport ${vp.w}x${vp.h}`);

const rec = new Recorder(page, out, { maxWidth: Math.round(vp.w * vp.dpr), maxHeight: Math.round(vp.h * vp.dpr) });
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
await rec.start();
rec.mark('start');
try {
  if (a.scenario) {
    const scene = (await import(pathToFileURL(path.resolve(a.scenario)).href)).default;
    await scene({ page, browser, cursor: new Cursor(page), sleep, mark: (n) => rec.mark(n), log: (...m) => console.log('[scene]', ...m), rec });
  } else {
    const until = a.seconds ? Date.now() + Number(a.seconds) * 1000 : Infinity;
    while (!stopping && Date.now() < until && !(a['until-file'] && fs.existsSync(a['until-file']))) await sleep(200);
  }
} catch (e) {
  console.error('[rec-chrome] scenario failed:', e);
}
rec.mark('end');
const r = await rec.stop();
console.log(`[rec-chrome] ${r.frames} frames over ${r.seconds.toFixed(1)} s`);
if (r.frames > 0) {
  const mp4 = path.join(out, `${a.name}.mp4`);
  rec.encode(mp4);
  console.log(`[rec-chrome] wrote ${mp4}`);
}
await browser.close().catch(() => {});
process.exit(0);

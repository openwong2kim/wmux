#!/usr/bin/env node
// Record the isolated wmux renderer while a scenario module drives it.
//
//   node scripts/readme-clips/rec.mjs --suffix readme1 --scenario ./my-scene.mjs --name hero
//
// Options: --out <dir> (default $TMPDIR/readme-clips/<name>), --width 1280 --height 800
// (expected window size; launch.sh sets it), --max-fps 30, --no-encode.
// Writes <out>/frames/*.jpg, <out>/marks.json and <out>/<name>.mp4.
//
// A scenario is a plain ES module:
//   export default async function scene({ page, cursor, mark, sleep, rpc, cli, app, setTheme, log }) { ... }
// page = Playwright Page of the wmux renderer, cursor = drawn cursor (moveTo/click/drag/type/press),
// mark(name) = a named moment for export.sh, rpc(method, params) = the isolated daemon,
// cli(args) = the wmux CLI against the isolated instance, app = paths and ports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Cursor, Recorder, daemonRpc, instancePaths, normSuffix, loadPlaywright, readCdpPort, sleep, wmuxCli } from './lib.mjs';

const { values: a } = parseArgs({
  options: {
    suffix: { type: 'string' },
    scenario: { type: 'string' },
    name: { type: 'string' },
    out: { type: 'string' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '800' },
    'max-fps': { type: 'string', default: '30' },
    'no-encode': { type: 'boolean', default: false },
  },
});
if (!a.suffix || !a.scenario || !a.name) {
  console.error('usage: rec.mjs --suffix readme1 --scenario <file.mjs> --name <clip> [--out dir]');
  process.exit(2);
}

a.suffix = normSuffix(a.suffix);
const app = { ...instancePaths(a.suffix), cdpPort: readCdpPort(a.suffix) };
const out = path.resolve(a.out || path.join(os.tmpdir(), 'readme-clips', a.name));
if (fs.existsSync(path.join(out, 'frames'))) {
  console.error(`${out}/frames exists; pick a new --out or --name (the kit never deletes)`);
  process.exit(2);
}
const scene = (await import(pathToFileURL(path.resolve(a.scenario)).href)).default;
if (typeof scene !== 'function') throw new Error(`${a.scenario} has no default export function`);

const { chromium } = loadPlaywright();
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${app.cdpPort}`);

// The wmux window is main_window/index.html (launcher.html is the hidden quick-launch
// window; webview guests and devtools are other targets).
function findRenderer() {
  return browser.contexts().flatMap((c) => c.pages()).find((p) => /main_window\/index\.html/.test(p.url())) ?? null;
}
let page = findRenderer();
for (let i = 0; !page && i < 30; i++) { await sleep(500); page = findRenderer(); }
if (!page) {
  console.error('renderer page not found; pages:', browser.contexts().flatMap((c) => c.pages().map((p) => p.url())));
  process.exit(1);
}

// Electron has no Browser.setWindowBounds; launch.sh seeds window-state.json instead, so
// every clip opens at the same size. Warn if this one does not match.
const width = Number(a.width);
const height = Number(a.height);
const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
console.log(`[rec] viewport ${vp.w}x${vp.h} @${vp.dpr}x`);
if (vp.w !== width || vp.h !== height) console.warn(`[rec] warning: viewport is not ${width}x${height}; relaunch with launch.sh so all clips match`);

const rec = new Recorder(page, out, {
  maxFps: Number(a['max-fps']),
  maxWidth: Math.round(vp.w * vp.dpr),
  maxHeight: Math.round(vp.h * vp.dpr),
});
const cursor = new Cursor(page);
await cursor.install();

// Switch the UI theme by its Settings label (e.g. 'Paper'), through the real Settings page.
async function setTheme(label) {
  const open = () => page.getByTestId('settings-search').isVisible().catch(() => false);
  if (!(await open())) await page.keyboard.press('Meta+Comma');
  await page.getByRole('button', { name: 'Appearance', exact: true }).or(page.getByText('Appearance', { exact: true })).first().click();
  await page.getByRole('radio', { name: label, exact: true }).or(page.getByLabel(label, { exact: true })).first().click({ timeout: 10000 });
  if (await open()) await page.keyboard.press('Meta+Comma');
}

const ctx = {
  page,
  browser,
  cursor,
  sleep,
  app,
  setTheme,
  mark: (n) => rec.mark(n),
  rpc: (method, params) => daemonRpc(a.suffix, method, params),
  cli: (args) => wmuxCli(a.suffix, args),
  log: (...m) => console.log('[scene]', ...m),
  rec,
};

await rec.start();
rec.mark('start');
let failed = null;
try {
  await scene(ctx);
} catch (e) {
  failed = e;
  console.error('[rec] scenario failed:', e);
}
rec.mark('end');
const r = await rec.stop();
console.log(`[rec] ${r.frames} frames over ${r.seconds.toFixed(1)} s`);
if (!a['no-encode'] && r.frames > 0) {
  const mp4 = path.join(out, `${a.name}.mp4`);
  rec.encode(mp4);
  console.log(`[rec] wrote ${mp4} (${(fs.statSync(mp4).size / 1e6).toFixed(2)} MB)`);
}
await browser.close().catch(() => {}); // disconnects only; the app keeps running
process.exit(failed ? 1 : 0);

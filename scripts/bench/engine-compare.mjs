#!/usr/bin/env node
// Terminal engine A/B bench: xterm.js against wongtty (Settings > Labs) on
// the same packaged build, in an isolated instance started by
// `node scripts/control-wmux.mjs launch --app <packaged exe> --suffix -verify-…`.
//
//   node scripts/bench/engine-compare.mjs --cdp-port <port> --case throughput|memory|input
//     [--engine xterm|wongtty|both] [--runs 5] [--file <100 MB text>] [--json out.json]
//     [--claude-cmd '<shell command that starts Claude Code in a sandbox>']
//     [--no-clipboard]   spot case: never copy or read the system clipboard
//                        (also when BENCH_NO_CLIPBOARD=1), for a shared machine
//
// Every number is taken inside the renderer (performance.now), from probes this
// script injects; CDP transport time is not in them. The probes only observe:
// they subscribe to pty data, keydown and long tasks, and chain
// requestAnimationFrame. The app is driven through its own UI: keys into the
// terminal, the Labs switch in Settings.
//
// Cases:
//   throughput  `cat` a large file in one pane; Enter → the sentinel's bytes
//               reach the renderer (data), and → the first of 30 frames in a
//               row under 34 ms after that (idle). Long tasks in between.
//   memory      10 panes with 10k lines each; renderer JS heap and RSS after a
//               forced GC, then again after switching the engine away and back.
//   input       200 keys at a plain prompt (and in Claude Code with
//               --claude-cmd): keydown → echo bytes, keydown → frame after echo.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const port = Number(args['cdp-port']);
const runs = Number(args.runs ?? 5);
const engines = (args.engine ?? 'both') === 'both' ? ['xterm', 'wongtty'] : [args.engine];
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
if (!port || !args.case) {
  console.error('usage: engine-compare.mjs --cdp-port <port> --case throughput|memory|input [--engine both] [--runs 5] [--file f] [--json out]');
  process.exit(2);
}

const { chromium } = await import('playwright-core');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'));
if (!page) throw new Error('main window not found');
const cdp = await page.context().newCDPSession(page);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── renderer probe ─────────────────────────────────────────────────────────
async function installProbe() {
  await page.evaluate(() => {
    if (window.__bench) return;
    const b = { longtasks: [], keyAt: 0, enterAt: 0, sentinel: null, tail: '', dataAt: 0, bytes: 0, echo: null };
    window.__bench = b;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) b.longtasks.push([e.startTime, e.duration]);
    }).observe({ entryTypes: ['longtask'] });
    addEventListener('keydown', (e) => {
      b.keyAt = performance.now();
      if (e.key === 'Enter') b.enterAt = b.keyAt;
      if (b.echo && !b.echo.armed) { b.echo.armed = true; b.echo.key = b.keyAt; }
    }, true);
    window.electronAPI.pty.onData((_id, data, replay) => {
      if (replay) return;
      const now = performance.now();
      b.allBytes = (b.allBytes ?? 0) + data.length;
      b.cap = ((b.cap ?? '') + data).slice(-8192);
      b.lastDataAt = now;
      if (b.sentinel && !b.dataAt) {
        b.bytes += data.length;
        const seen = b.tail + data;
        if (seen.includes(b.sentinel)) b.dataAt = now;
        b.tail = seen.slice(-256);
      }
      const echo = b.echo;
      if (echo && echo.armed && !echo.data) {
        echo.data = now;
        requestAnimationFrame(() => requestAnimationFrame((t) => { echo.frame = t; }));
      }
    });
    // The first frame of `quiet` frames in a row each under `maxGap` ms.
    b.idleAfter = (quiet = 30, maxGap = 34, timeoutMs = 600_000) => new Promise((resolve) => {
      const started = performance.now();
      let last = started; let streak = 0; let streakStart = started;
      const step = (t) => {
        const gap = t - last; last = t;
        if (gap < maxGap) { if (streak === 0) streakStart = t - gap; streak++; } else streak = 0;
        if (streak >= quiet) return resolve(streakStart);
        if (t - started > timeoutMs) return resolve(-1);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  });
}

// ── driving ────────────────────────────────────────────────────────────────
const terminals = () => page.locator('textarea[aria-label="Terminal input"]');

async function focusTerminal(i = 0) {
  await terminals().nth(i).focus();
}

async function run(line) {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

// wongtty (0.0.4 on) marks its terminal element data-engine="wongtty";
// xterm.js sets no such attribute. A swap has landed when the count of
// wongtty terminals matches the engine asked for.
const wongttyTerminals = () => page.locator('[data-engine="wongtty"]').count();

async function paneCount() {
  return page.locator('textarea[aria-label="Terminal input"]').count();
}

async function openLabsSwitch() {
  // Settings opens from the More menu; its keyboard shortcut is a native menu
  // accelerator, which keys sent over CDP do not reach.
  // Settings may still be open from an earlier step; the menu is then covered.
  const title = page.locator('[data-testid="settings-page-title"]');
  for (let attempt = 0; (await title.count()) === 0; attempt++) {
    if (attempt === 3) throw new Error('settings did not open');
    await page.keyboard.press('Escape');
    await page.getByLabel('More', { exact: true }).click();
    const item = page.getByRole('menuitem', { name: /^Settings/ });
    try {
      await item.waitFor({ timeout: 3000 });
      await item.click();
      await title.waitFor({ timeout: 5000 });
    } catch { /* menu or page did not show: retry */ }
  }
  await page.locator('[data-settings-tab="labs"]').click();
  // The row also holds an info button; the toggle is the switch.
  return page.locator('[data-setting-id="labs-wongtty"]').getByRole('switch');
}

async function closeSettings() {
  const title = page.locator('[data-testid="settings-page-title"]');
  for (let i = 0; i < 3 && (await title.count()) > 0; i++) {
    await page.keyboard.press('Escape');
    await sleep(300);
  }
  if ((await title.count()) > 0) throw new Error('settings did not close');
}

async function setEngine(engine) {
  const toggle = await openLabsSwitch();
  const want = engine === 'wongtty';
  if (((await toggle.getAttribute('aria-checked')) === 'true') === want) {
    await closeSettings();
    return;
  }
  const panes = await paneCount();
  await toggle.click();
  await closeSettings();
  const deadline = Date.now() + 30_000;
  const landed = async () => (want ? await wongttyTerminals() : panes - (await wongttyTerminals()));
  while ((await landed()) < panes || (await page.evaluate(() => document.documentElement.dataset.terminalEnginePending ?? '0')) !== '0') {
    if (Date.now() > deadline) throw new Error(`engine did not become ${engine}: ${await landed()}/${panes} panes swapped`);
    await sleep(200);
  }
  await sleep(1000);
}

async function idle() {
  return page.evaluate(() => window.__bench.idleAfter());
}

// ── memory readers ─────────────────────────────────────────────────────────
async function processes() {
  const bcdp = await browser.newBrowserCDPSession();
  const info = await bcdp.send('SystemInfo.getProcessInfo');
  await bcdp.detach();
  // The largest renderer is the main window's (the launcher window is small).
  return info.processInfo;
}

function rssKb(pid) {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' });
    return Math.round(Number(out.trim()) / 1024);
  }
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

async function memorySample() {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  await sleep(500);
  // backingStorageSize holds ArrayBuffers, wongtty's wasm memory among them;
  // usedSize is the V8 heap alone. GPU textures live in the GPU process.
  const heap = await cdp.send('Runtime.getHeapUsage');
  const procs = await processes();
  const kb = (type) => Math.max(0, ...procs.filter((p) => p.type === type).map((p) => { try { return rssKb(p.id); } catch { return 0; } }));
  const mb = (n) => +(n / 2 ** 20).toFixed(1);
  return {
    heapUsedMB: mb(heap.usedSize),
    backingMB: mb(heap.backingStorageSize ?? 0),
    embedderMB: mb(heap.embedderHeapUsedSize ?? 0),
    rendererRssMB: +(kb('renderer') / 1024).toFixed(1),
    gpuRssMB: +(kb('GPU') / 1024).toFixed(1),
  };
}

// ── cases ──────────────────────────────────────────────────────────────────
async function rendererMetrics() {
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function throughput(engine, n) {
  const file = args.file;
  if (!file || !fs.existsSync(file)) throw new Error('--file <large text file> is required for throughput');
  await focusTerminal(0);
  await run("clear; printf '\\033[3J'");
  await sleep(800);
  const tag = `BENCH_DONE_${n + 1000}`;
  await page.evaluate((s) => { const b = window.__bench; b.sentinel = s; b.tail = ''; b.dataAt = 0; b.bytes = 0; b.longtasks.length = 0; }, tag);
  // Renderer main-thread time over the run: when the data rate is set by the
  // pipeline upstream, wall time is equal and the engine's cost shows here.
  const before = await rendererMetrics();
  // The typed command holds `$((n+1000+0))`, so only the output carries the tag.
  await run(`cat '${file}'; echo BENCH_DONE_$((${n + 1000}+0))`);
  const deadline = Date.now() + 1_800_000;
  let lastReport = Date.now();
  while (!(await page.evaluate(() => window.__bench.dataAt))) {
    if (Date.now() > deadline) throw new Error('sentinel never arrived');
    if (Date.now() - lastReport > 60_000) {
      lastReport = Date.now();
      console.error(`  … ${engine} run ${n}: ${(await page.evaluate(() => window.__bench.bytes / 2 ** 20)).toFixed(1)} MiB so far`);
    }
    await sleep(250);
  }
  const idleAt = await idle();
  const after = await rendererMetrics();
  const r = await page.evaluate((idleAt) => {
    const b = window.__bench;
    const lt = b.longtasks.filter(([s]) => s >= b.enterAt && s <= idleAt);
    return {
      dataMs: Math.round(b.dataAt - b.enterAt),
      dataMiBps: +((b.bytes / 2 ** 20) / ((b.dataAt - b.enterAt) / 1000)).toFixed(2),
      idleMs: Math.round(idleAt - b.enterAt),
      longTasks: lt.length,
      longTaskTotalMs: Math.round(lt.reduce((a, [, d]) => a + d, 0)),
      longTaskMaxMs: Math.round(lt.reduce((a, [, d]) => Math.max(a, d), 0)),
    };
  }, idleAt);
  r.taskMs = Math.round((after.TaskDuration - before.TaskDuration) * 1000);
  r.scriptMs = Math.round((after.ScriptDuration - before.ScriptDuration) * 1000);
  r.busyPct = +((r.taskMs / r.idleMs) * 100).toFixed(1);
  console.log(JSON.stringify({ case: 'throughput', engine, run: n, ...r }));
  return r;
}

async function memory(engine, n) {
  // Expects a fresh instance with one pane; builds 10 panes of 10k lines.
  while ((await terminals().count()) < 10) {
    await focusTerminal((await terminals().count()) - 1);
    await page.keyboard.press(`${mod}+d`);
    await sleep(700);
  }
  const gen = "for i in $(seq 1 10000); do printf 'line %05d ASCII 가나다라 漢字かな \\033[3%dmcolour\\033[0m\\n' $i $((i%7+1)); done";
  const startBytes = await page.evaluate(() => window.__bench.allBytes ?? 0);
  for (let i = 0; i < 10; i++) {
    await focusTerminal(i);
    await run(gen);
  }
  // Done when every pane has printed its 10k lines (~40 UTF-16 units each, depending on the prompt;
  // onData hands over strings) and the output has been quiet for 3 s.
  const deadline = Date.now() + 600_000;
  for (;;) {
    const { bytes, quietMs } = await page.evaluate(() => ({ bytes: window.__bench.allBytes ?? 0, quietMs: performance.now() - (window.__bench.lastDataAt ?? 0) }));
    if (bytes - startBytes > 10 * 10_000 * 30 && quietMs > 3000) break;
    if (Date.now() > deadline) throw new Error(`pane output never settled (${bytes - startBytes} bytes)`);
    await sleep(500);
  }
  await idle();
  const loaded = await memorySample();
  const other = engine === 'xterm' ? 'wongtty' : 'xterm';
  await setEngine(other);
  await idle();
  const away = await memorySample();
  await setEngine(engine);
  await idle();
  const back = await memorySample();
  const r = { loaded, away: { engine: other, ...away }, back };
  console.log(JSON.stringify({ case: 'memory', engine, run: n, ...r }));
  return r;
}

async function inputLatency(engine, n) {
  await focusTerminal(0);
  if (args['claude-cmd'] && args.target === 'claude') {
    await run(args['claude-cmd']);
    await sleep(8000);
  } else {
    await run('clear');
    await sleep(500);
  }
  const samples = [];
  for (let k = 0; k < 200; k++) {
    await page.evaluate(() => { window.__bench.echo = { armed: false }; });
    await page.keyboard.press(k % 2 ? 'a' : 'b');
    const deadline = Date.now() + 2000;
    let e;
    while (!(e = await page.evaluate(() => { const x = window.__bench.echo; return x && x.frame ? x : null; }))) {
      if (Date.now() > deadline) break;
      await sleep(5);
    }
    if (e) samples.push({ echo: e.data - e.key, frame: e.frame - e.key });
    await sleep(30);
  }
  await page.keyboard.press('Control+u');
  if (args['claude-cmd'] && args.target === 'claude') {
    // Exit Claude Code and wait for the shell, so the next run's command is
    // not typed into a closing Claude.
    await page.keyboard.press('Control+c'); await sleep(300); await page.keyboard.press('Control+c');
    await page.evaluate(() => { window.__bench.cap = ''; });
    const until = Date.now() + 15_000;
    while (!/\x1b\]133;A/.test(await page.evaluate(() => window.__bench.cap ?? '')) && Date.now() < until) await sleep(200);
    await sleep(500);
  }
  const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
  const r = {
    keys: samples.length,
    echoP50: q(samples.map((s) => s.echo), 0.5), frameP50: q(samples.map((s) => s.frame), 0.5),
    frameP95: q(samples.map((s) => s.frame), 0.95),
  };
  console.log(JSON.stringify({ case: 'input', target: args.target ?? 'shell', engine, run: n, ...r }));
  return r;
}

// ── main ───────────────────────────────────────────────────────────────────
await installProbe();
// Correctness spot-checks: one screenshot per check into --out, plus the
// read-backs a screenshot cannot show (kitty flag answers, copied text, link
// hover). Interactive apps: vim, top (htop where installed), Claude Code.
async function spot(engine) {
  const out = args.out;
  if (!out) throw new Error('--out <dir> is required for spot');
  fs.mkdirSync(out, { recursive: true });
  const shot = async (name) => { await idle(); await page.screenshot({ path: `${out}/${engine}-${name}.png` }); };
  const cap = () => page.evaluate(() => window.__bench.cap ?? '');
  const reset = async () => { await page.evaluate(() => { window.__bench.cap = ''; }); await run("clear; printf '\\033[3J'"); await sleep(600); };
  const screen = page.locator('.xterm-screen').first();
  await focusTerminal(0);
  const r = {};

  await reset();
  await run(`cat '${args.sample}'`);
  await sleep(800);
  await shot('wide-emoji');

  await reset();
  await run(`python3 '${args['kitty-probe']}'`);
  await sleep(2000);
  r.kitty = (/KITTY push=.*/.exec(await cap()) ?? ['(no answer)'])[0];

  // OSC 8 on the top row; hover it (never click: that opens a browser).
  await reset();
  // `clear` in the same command line, so the link lands on the top row.
  await run("clear; printf '\\033]8;;https://example.com/osc8\\033\\\\OSC8-LINK\\033]8;;\\033\\\\ plain\\n'");
  await sleep(800);
  const box = await screen.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 8);
  await sleep(500);
  r.osc8Cursor = await page.evaluate(() => {
    const el = document.querySelector('.xterm-screen');
    return getComputedStyle(el).cursor + ' ' + [...el.classList, ...(el.parentElement?.classList ?? [])].filter((c) => /cursor|link/.test(c)).join(',');
  });
  await shot('osc8-hover');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 5);

  // Select the whole top row by dragging and copy it.
  await reset();
  await run("printf 'COPYME-12345 가나다 漢字\\n'");
  await sleep(800);
  // The copy check writes the system clipboard (the copy key) and reads it
  // back; on a shared machine it is skipped and only the selection is drawn.
  const noClipboard = args['no-clipboard'] === 'true' || process.env.BENCH_NO_CLIPBOARD === '1';
  const saved = noClipboard ? null : clip();
  await page.mouse.move(box.x + 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8, { steps: 8 });
  await page.mouse.move(box.x + box.width - 4, box.y + 8, { steps: 8 });
  await page.mouse.up();
  await shot('selection');
  if (noClipboard) {
    r.copied = 'skipped (--no-clipboard)';
  } else {
    await page.keyboard.press(`${mod}+c`);
    await sleep(500);
    r.copied = clip().trim();
    clip(saved);
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 5);

  await reset();
  await run(`vim -u NONE -N '${args.sample}'`);
  await sleep(1500);
  await shot('vim');
  await page.keyboard.press('Escape');
  await run(':q!');
  await sleep(800);

  await reset();
  await run(process.platform === 'darwin' ? 'top -o cpu' : 'htop || top');
  await sleep(3000);
  await shot('top');
  await page.keyboard.press('q');
  await sleep(800);

  if (args['claude-cmd']) {
    await reset();
    await run(args['claude-cmd']);
    await sleep(9000);
    await shot('claude');
    await page.keyboard.type('/');
    await sleep(1500);
    await shot('claude-slash');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+c');
    await sleep(300);
    await page.keyboard.press('Control+c');
    await sleep(2500);
  }
  console.log(JSON.stringify({ case: 'spot', engine, ...r }));
  return r;
}

// System clipboard read/write (the spot check restores what it found).
function clip(text) {
  if (process.platform === 'darwin') {
    if (text === undefined) return execFileSync('pbpaste', { encoding: 'utf8' });
    execFileSync('pbcopy', { input: text });
    return text;
  }
  if (text === undefined) return execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' });
  execFileSync('powershell.exe', ['-NoProfile', '-Command', '$input | Set-Clipboard'], { input: text });
  return text;
}

const results = [];
for (const engine of engines) {
  await setEngine(engine);
  for (let n = 0; n < runs; n++) {
    const fn = { throughput, memory, input: inputLatency, spot, select: async () => ({}) }[args.case];
    results.push({ engine, run: n, ...(await fn(engine, n)) });
    if (args.case !== 'throughput' && args.case !== 'input') break; // one build-up per instance; relaunch for the next run
  }
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify({ case: args.case, platform: process.platform, results }, null, 2));
await browser.close();

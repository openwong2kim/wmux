// Labs wongtty switch, its core path on any OS: CI runs it on Windows
// (.github/workflows/wongtty-e2e.yml), where e2e/wongtty-switch.e2e.test.mjs,
// built on bash probes and SIGWINCH traps, cannot run. In the real Electron
// app on a dev build: wongtty's .wasm loads from the dev path and draws with
// WebGL2 (on a CI runner, Chromium's software GL), and turning the switch on,
// off and on/off/on rebuilds every pane with the engine and keeps its content.
// A restart builds each pane once with the saved engine (also at a fractional
// device pixel ratio), nothing of wongtty loads with the switch off, and a
// wongtty that cannot load leaves every pane on xterm.js.
//
// Four panes: the default workspace's one, workspace A with two (the one in
// view) and workspace B with one (hidden). Each prints TOP-<n>, ROWS rows and
// BOTTOM-<n> from the pane's own shell (PowerShell on Windows, the user's
// shell elsewhere). IME composition is not driven here.
//
// WMUX_E2E_SANDBOX_BASE moves the sandbox HOME; WMUX_E2E_ARTIFACTS receives
// each launch's logs and a screenshot per step.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { ARTIFACTS, ROOT, killRun, launchApp, makeSandbox, pipeReady, rpc, shot, sleep, waitFor } from './lib.mjs';

const ROWS = 2000;
const SWITCH = 'Rust terminal front end (wongtty)';
const FAILED_TEXT = 'wongtty could not start';
const WONGTTY_WASM_SIZES = ['wongtty.wasm', 'xterm_web_bg.wasm'].map((f) => fs.statSync(path.join(ROOT, 'node_modules', 'wongtty', 'dist', f)).size);

const sb = makeSandbox('wtc');
const panes = []; // { n, ptyId, ws }
const ws = {};
const summary = [];
let run = null;
let launches = 0;

/** The command that fills pane `n`: its markers split so the echoed command
 *  line never matches them. */
function fillCommand(n) {
  if (process.platform === 'win32') return `'TO'+'P-${n}'; 1..${ROWS} | ForEach-Object { "row-${n}-$_" }; 'BOTT'+'OM-${n}'`;
  return `printf 'TO''P-%s\\n' ${n}; seq 1 ${ROWS} | sed 's/^/row-${n}-/'; printf 'BOTT''OM-%s\\n' ${n}`;
}

async function launch(env = {}, extraArgs = []) {
  Object.assign(process.env, env);
  try {
    const launched = await launchApp(sb, { extraArgs });
    const consoleLines = [];
    launched.win.on('console', (m) => consoleLines.push(m.text()));
    await launched.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setPosition(0, 0);
      w.setSize(1600, 1000);
    });
    await launched.win.locator('text=Workspaces').first().waitFor({ timeout: 90_000 });
    // The pipe RPCs go to can come up after the window does.
    await waitFor(() => pipeReady(sb), { timeout: 90_000, what: "the app's pipe" });
    // The first-run wizard ("Skip for now", or "Later" where the sandbox has
    // no agent it can run, as on Windows) opens a moment after the window.
    await launched.win.getByTestId('first-run-wizard-skip').click({ timeout: 15_000 }).catch(() => undefined);
    const dontAsk = launched.win.getByText("Don't ask again", { exact: true });
    if (await dontAsk.count()) await dontAsk.first().click();
    // Count failure toasts as they appear, whatever their lifetime.
    await launched.win.evaluate((text) => {
      window.__wongttyToasts = 0;
      const seen = new WeakSet();
      new MutationObserver((records) => {
        for (const r of records) for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          for (const el of [node, ...node.querySelectorAll('[role="status"]')]) {
            if (el.getAttribute('role') !== 'status' || seen.has(el) || !el.textContent?.includes(text)) continue;
            seen.add(el);
            window.__wongttyToasts++;
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }, FAILED_TEXT);
    return { ...launched, consoleLines };
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

function saveLogs(tag) {
  if (!run) return;
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, `wongtty-core-${tag}.log`), `${run.logs.join('')}\n--- renderer console ---\n${run.consoleLines.join('\n')}\n`);
}

/** Quit the app as a user would; the daemon (and every session) stays up. */
async function quit() {
  saveLogs(`launch${++launches}`);
  const { app } = run;
  const pid = app.process().pid;
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  await app.evaluate(({ app: a }) => a.quit()).catch(() => undefined);
  const done = await Promise.race([exited.then(() => true), sleep(30_000).then(() => false)]);
  if (!done) process.kill(pid, 'SIGKILL');
  run = null;
}

async function setSwitch(clicks, { gapMs = 300 } = {}) {
  const { win } = run;
  const skip = win.getByTestId('first-run-wizard-skip');
  if (await skip.isVisible()) await skip.click();
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
  await win.getByText('Labs', { exact: true }).first().click({ timeout: 15_000 });
  const toggle = win.getByRole('switch', { name: SWITCH });
  for (let i = 0; i < clicks; i++) {
    await toggle.click();
    if (i < clicks - 1) await sleep(gapMs);
  }
  const on = (await toggle.getAttribute('aria-checked')) === 'true';
  return { on, toggle, close: () => win.keyboard.press('Escape') };
}

async function waitEngine(engine) {
  return waitFor(async () => {
    const s = await run.win.evaluate(() => ({
      engine: document.documentElement.dataset.terminalEngine,
      pending: Number(document.documentElement.dataset.terminalEnginePending ?? 0),
      panes: [...document.querySelectorAll('body [data-terminal-engine]')].map((el) => el.dataset.terminalEngine),
    }));
    return s.engine === engine && s.pending === 0 && s.panes.length === panes.length && s.panes.every((p) => p === engine) ? s : null;
  }, { timeout: 90_000, what: `every pane on ${engine}` });
}

const listPanes = async (workspaceId) => {
  const r = await rpc(sb, 'pane.list', { workspaceId });
  return r?.panes ?? r ?? [];
};

async function splitInto(workspaceId, count) {
  let ids = [(await waitFor(async () => (await listPanes(workspaceId))[0], { what: 'the first pane' })).id];
  while (ids.length < count) {
    await rpc(sb, 'pane.focus', { id: ids[ids.length - 1] });
    const split = await rpc(sb, 'pane.split', { workspaceId, direction: 'horizontal' });
    ids = [...ids, split.paneId];
  }
  return waitFor(async () => {
    const list = await listPanes(workspaceId);
    const ptys = list.map((p) => p.surfacePtyIds?.[0]).filter(Boolean);
    return ptys.length === count ? ptys : null;
  }, { timeout: 60_000, what: `${count} panes with a pty` });
}

const screen = async (ptyId) => JSON.stringify(await rpc(sb, 'input.readScreen', { ptyId, lines: 40 }));
const matches = async (query, workspaceId) => (await rpc(sb, 'pane.search', { query, workspaceId })).totalMatches;
const swapLines = () => run.consoleLines.filter((l) => l.includes('[wmux:engine-swap]'));

/** Every pane shows what it showed, once: its markers in scrollback and on screen. */
async function checkContent(label) {
  for (const id of [ws.zero, ws.b, ws.a]) {
    await rpc(sb, 'workspace.focus', { id });
    for (const p of panes.filter((x) => x.ws === id)) {
      await waitFor(async () => (await screen(p.ptyId)).includes(`BOTTOM-${p.n}`)
        && await matches(`TOP-${p.n}`, id) === 1 && await matches(`row-${p.n}-${ROWS / 2}`, id) === 1,
      { timeout: 30_000, interval: 500, what: `${label}: pane ${p.n} content, once` });
    }
  }
}

/** Record the size of every WebAssembly module compiled from now on: wongtty's
 *  two are told apart from xterm.js's own by their size. */
async function countWasm() {
  await run.win.evaluate(() => {
    window.__wasmSizes = [];
    const W = WebAssembly;
    const size = (src) => (src instanceof ArrayBuffer || ArrayBuffer.isView(src) ? src.byteLength : src instanceof W.Module ? 0 : -1);
    for (const name of ['compile', 'instantiate']) {
      const real = W[name];
      W[name] = function (src, ...rest) { window.__wasmSizes.push(size(src)); return real.call(this, src, ...rest); };
    }
    for (const name of ['compileStreaming', 'instantiateStreaming']) {
      const real = W[name];
      if (real) W[name] = function (...args) { window.__wasmSizes.push(-1); return real.apply(this, args); };
    }
    W.Module = new Proxy(W.Module, { construct(target, args) { window.__wasmSizes.push(size(args[0])); return Reflect.construct(target, args); } });
  });
}

async function assertNothingLoaded(label) {
  const chunks = await run.win.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /wongtty-/.test(n)));
  assert.deepEqual(chunks, [], `${label}: no wongtty chunk fetched`);
  assert.equal(run.logs.some((l) => l.includes('[wmux:wongtty] wasm served')), false, `${label}: main served no wasm`);
  const sizes = await run.win.evaluate(() => window.__wasmSizes);
  assert.deepEqual(sizes.filter((n) => n < 0 || WONGTTY_WASM_SIZES.includes(n)), [], `${label}: no wongtty WebAssembly compiled`);
}

/** How many distinct colours a Playwright screenshot (8-bit RGB/RGBA PNG) holds. */
function pngColours(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bpp = png[25] === 6 ? 4 : 3;
  const idat = [];
  for (let off = 8; off < png.length;) {
    const len = png.readUInt32BE(off);
    if (png.toString('ascii', off + 4, off + 8) === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  const colours = new Set();
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      cur[x] = line[x] + [0, a, b, (a + b) >> 1, paeth][filter];
    }
    for (let x = 0; x < stride; x += bpp) colours.add((cur[x] << 16) | (cur[x + 1] << 8) | cur[x + 2]);
    prev = cur;
  }
  return colours.size;
}

/** Record every WebGL2 context asked for from now on, and its renderer.
 *  wongtty draws on an OffscreenCanvas and hands the panes' own canvases the
 *  frames, so the panes' canvases hold no WebGL context to look at. */
async function recordWebgl2() {
  await run.win.evaluate(() => {
    window.__webgl2 = [];
    for (const C of [HTMLCanvasElement, window.OffscreenCanvas].filter(Boolean)) {
      const real = C.prototype.getContext;
      C.prototype.getContext = function (type, ...rest) {
        const ctx = real.call(this, type, ...rest);
        if (type === 'webgl2') {
          let renderer = null;
          try {
            const info = ctx?.getExtension('WEBGL_debug_renderer_info');
            renderer = ctx ? String(ctx.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : ctx.RENDERER)) : null;
          } catch { /* the renderer string is evidence only */ }
          window.__webgl2.push({ ok: !!ctx, renderer });
        }
        return ctx;
      };
    }
  });
}

/** wongtty puts text on screen in the panes in view (and, after
 *  recordWebgl2, got the WebGL2 context it draws with). */
async function assertDrawn(label, { webgl2 = false } = {}) {
  await rpc(sb, 'workspace.focus', { id: ws.a });
  let renderers = [];
  if (webgl2) {
    const asked = await run.win.evaluate(() => window.__webgl2);
    assert.ok(asked.length > 0 && asked.every((c) => c.ok), `${label}: wongtty got WebGL2 (${JSON.stringify(asked)})`);
    renderers = [...new Set(asked.map((c) => c.renderer))];
  }
  const pane = run.win.locator('[data-terminal-engine="wongtty"]').locator('visible=true').first();
  const colours = pngColours(await pane.screenshot());
  assert.ok(colours > 8, `${label}: a wongtty pane in view shows text (${colours} colours)`);
  summary.push(`${label}: ${webgl2 ? `WebGL2 renderer ${renderers.join(' | ')}; ` : ''}a pane in view shows ${colours} colours at DPR ${await run.win.evaluate(() => window.devicePixelRatio)}`);
}

before(async () => {
  run = await launch();
});

after(() => {
  saveLogs(`launch${++launches}`);
  const killed = killRun(sb);
  console.log(`[wongtty-core] killed ${killed} processes of this run`);
  console.log(summary.map((s) => `[wongtty-core] ${s}`).join('\n'));
  // The killed daemon and shells may still be letting go of files for a moment.
  if (process.env.WMUX_E2E_KEEP !== '1') fs.rmSync(sb.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

describe('Labs wongtty switch (core)', { timeout: 20 * 60_000 }, () => {
  it('1. starts off with nothing of wongtty loaded, and fills four panes', async () => {
    await countWasm();
    ws.zero = (await rpc(sb, 'workspace.current', {})).id;
    const zero = await splitInto(ws.zero, 1);
    ws.a = (await rpc(sb, 'workspace.new', { name: 'A' })).id;
    const a = await splitInto(ws.a, 2);
    ws.b = (await rpc(sb, 'workspace.new', { name: 'B' })).id;
    const b = await splitInto(ws.b, 1);
    [[ws.zero, zero], [ws.a, a], [ws.b, b]].forEach(([id, ptys]) => ptys.forEach((ptyId) => panes.push({ n: panes.length + 1, ptyId, ws: id })));
    for (const p of panes) {
      await rpc(sb, 'workspace.focus', { id: p.ws });
      await rpc(sb, 'input.send', { ptyId: p.ptyId, text: fillCommand(p.n), submit: true });
      await waitFor(async () => (await screen(p.ptyId)).includes(`BOTTOM-${p.n}`), { timeout: 90_000, what: `pane ${p.n} filled` });
    }
    await rpc(sb, 'workspace.focus', { id: ws.a });
    await waitEngine('xterm');
    await checkContent('off at start');
    await assertNothingLoaded('off at start');
    await shot(run.win, 'wongtty-core-1-off');
  });

  it('2. switching on loads wongtty from the dev build and rebuilds every pane with it', async () => {
    await recordWebgl2();
    const labs = await setSwitch(1);
    assert.equal(labs.on, true);
    await waitEngine('wongtty');
    await labs.close();
    assert.ok(run.logs.some((l) => l.includes('[wmux:wongtty] wasm served')), 'main served the .wasm');
    const sizes = await run.win.evaluate(() => window.__wasmSizes);
    assert.ok(WONGTTY_WASM_SIZES.every((n) => sizes.includes(n)), `both wongtty modules compiled (compiled: ${sizes.join(',')})`);
    assert.equal(await run.win.getByRole('alert').filter({ hasText: FAILED_TEXT }).count(), 0, 'no Labs error');
    await checkContent('on');
    await assertDrawn('on', { webgl2: true });
    await shot(run.win, 'wongtty-core-2-on');
  });

  it('3. switching off rebuilds every pane with xterm.js and keeps its content', async () => {
    const labs = await setSwitch(1);
    assert.equal(labs.on, false);
    await waitEngine('xterm');
    await labs.close();
    await checkContent('off');
    await shot(run.win, 'wongtty-core-3-off');
  });

  it('4. on/off/on within a second settles on wongtty', async () => {
    const labs = await setSwitch(3);
    assert.equal(labs.on, true);
    await waitEngine('wongtty');
    await labs.close();
    await checkContent('on/off/on');
    assert.equal(await run.win.evaluate(() => window.__wongttyToasts), 0, 'no failure toast');
  });

  it('5. a restart with the switch on, at a device pixel ratio of 1.25, builds every pane with wongtty once', async () => {
    await quit();
    run = await launch({}, ['--force-device-scale-factor=1.25']);
    assert.equal(await run.win.evaluate(() => window.devicePixelRatio), 1.25);
    await waitEngine('wongtty');
    await checkContent('restart on');
    assert.deepEqual(swapLines(), [], 'no pane swapped at startup');
    await assertDrawn('restart on, DPR 1.25');
    await shot(run.win, 'wongtty-core-5-restart-on');
  });

  it('6. a restart with the switch off loads nothing of wongtty', async () => {
    const labs = await setSwitch(1);
    assert.equal(labs.on, false);
    await waitEngine('xterm');
    await labs.close();
    await quit();
    run = await launch();
    await countWasm();
    await waitEngine('xterm');
    await checkContent('restart off');
    await assertNothingLoaded('restart off');
  });

  it('7. a wongtty that cannot load leaves every pane on xterm.js, reported once', async () => {
    await quit();
    run = await launch({ WMUX_E2E_WONGTTY_WASM: 'broken' });
    const labs = await setSwitch(1);
    assert.equal(labs.on, true);
    const alert = run.win.getByRole('alert').filter({ hasText: FAILED_TEXT });
    await alert.waitFor({ timeout: 60_000 });
    await waitEngine('xterm');
    assert.equal(await run.win.evaluate(() => window.__wongttyToasts), 1, 'one toast');
    await labs.toggle.click();
    await waitFor(async () => (await alert.count()) === 0, { what: 'the error line to clear' });
    await labs.close();
    await checkContent('broken wasm');
    await shot(run.win, 'wongtty-core-7-broken');
  });
});

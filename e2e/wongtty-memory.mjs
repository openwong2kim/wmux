// Memory of 17 terminals with a full scrollback, xterm.js against the
// experimental wongtty front end (uiSlice.terminalWongtty). Not a test: a
// measurement run on the e2e build (`npm run -s build:daemon && node e2e/build.mjs`).
//
//   node e2e/wongtty-memory.mjs <xterm|wongtty|cycle> [runs=3] [out.json] [flags]
//
// `cycle` fills the panes with the switch off, then turns it on and off again
// and reads each of the three states: whether turning wongtty off gives its
// memory back.
//
// Flags pick the scenario (the default is 17 filled visible panes):
//   --panes=N       panes in the new workspace (0: no new workspace, and the
//                   first workspace's pane is closed if the app allows it)
//   --empty         do not fill the panes (prompt only)
//   --hide-canvas   then hide every terminal canvas (display:none)
//   --away          then switch back to the first workspace (panes hidden)
//   --minimize      then minimise the window
//   --dpr=N         launch with --force-device-scale-factor=N
//   --args=a;b      more Electron switches (e.g. --args=--disable-gpu)
//   --breakdown     also list each process's largest footprint categories
//   --idle=S        seconds to stay idle before reading (default 5), after 3 s
//                   to settle; the first pane is focused, and WebGL draws during
//                   those S seconds are counted
//   --busy          keep every pane printing while reading (agents at work)
//
// The wongtty mode turns on Settings > Labs "Rust terminal front end (wongtty)"
// (the wongtty dependency, read from node_modules) before any pane is built.
//
// Each run is a fresh e2e sandbox (lib.mjs: own HOME, WMUX_DATA_SUFFIX=-e2e,
// --user-data-dir inside the sandbox), so it never touches a real wmux. The
// run opens a new workspace, splits it into 17 visible panes, prints the same
// file in every pane until the 10,000-line scrollback is full, then reads the
// Electron processes' RSS (ps), the renderer's JS heap (CDP
// Runtime.getHeapUsage), WebAssembly memory, the macOS phys_footprint of each
// Electron process and the daemon's RSS: once as it is, and once more after a
// forced garbage collection (`gc`). WONGTTY_MEM_SHOT=<path prefix> also saves
// a screenshot of the filled panes. WMUX_E2E_SANDBOX_BASE moves the sandbox
// HOME (lib.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, killRun, launchApp, makeSandbox, rpc, sleep, waitFor } from './lib.mjs';

const mode = process.argv[2];
if (mode !== 'xterm' && mode !== 'wongtty' && mode !== 'cycle') {
  console.error('usage: node e2e/wongtty-memory.mjs <xterm|wongtty|cycle> [runs] [out.json]');
  process.exit(2);
}
const positional = process.argv.slice(3).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(3).filter((a) => a.startsWith('--')).map((a) => {
  const at = a.indexOf('=');
  return at < 0 ? [a.slice(2), true] : [a.slice(2, at), a.slice(at + 1)];
}));
const runs = Number(positional[0] ?? 3);
const out = positional[1];
const PANES = flags.panes !== undefined ? Number(flags.panes) : 17;
const FILL_LINES = 12_000;
const MARKER = 'FILL-DONE-MARKER';

// A wmux pane's identity variables must not reach the sandboxed app; the
// harness's own WMUX_E2E_* settings stay.
for (const key of Object.keys(process.env)) if (key.startsWith('WMUX_') && !key.startsWith('WMUX_E2E_')) delete process.env[key];
const WONGTTY_WASM_SIZES = ['wongtty.wasm', 'xterm_web_bg.wasm'].map((f) => fs.statSync(path.join(ROOT, 'node_modules', 'wongtty', 'dist', f)).size);

function fillFile(home) {
  const lines = [];
  for (let i = 0; i < FILL_LINES; i++) {
    lines.push(`\x1b[3${(i % 7) + 1}m${String(i).padStart(5, '0')}\x1b[0m lorem ipsum dolor sit amet, consectetur adipiscing 한글 테스트 ${'x'.repeat(i % 40)}`);
  }
  lines.push(MARKER);
  fs.writeFileSync(path.join(home, 'fill.txt'), `${lines.join('\n')}\n`);
}

const rssKb = (pid) => {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
};

/** macOS phys_footprint (dirty + compressed + swapped), which RSS leaves out under memory pressure; 0 elsewhere. */
const footprintKb = (pid) => {
  if (process.platform !== 'darwin') return 0;
  try {
    const m = /Footprint: ([\d.]+) (KB|MB|GB)/.exec(execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' }));
    return m ? Number(m[1]) * { KB: 1, MB: 1024, GB: 1048576 }[m[2]] : 0;
  } catch {
    return 0;
  }
};

/** The largest categories of `footprint -p` (dirty + swapped, MB), e.g. IOSurface, IOAccelerator, MALLOC_SMALL. */
function footprintCategories(pid, top = 8) {
  if (process.platform !== 'darwin') return {};
  let text;
  try {
    text = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' });
  } catch {
    return {};
  }
  const mb = (v) => {
    const m = /([\d.]+) (B|KB|MB|GB)/.exec(v);
    return m ? Number(m[1]) / { B: 1048576, KB: 1024, MB: 1, GB: 1 / 1024 }[m[2]] : 0;
  };
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s*([\d.]+ (?:B|KB|MB|GB))\s+([\d.]+ (?:B|KB|MB|GB))\s+([\d.]+ (?:B|KB|MB|GB))\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && m[5] !== 'TOTAL') rows.push([m[5], +mb(m[1]).toFixed(1)]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(rows.slice(0, top));
}

/** Daemon processes of this run: node processes whose environment carries the run id. */
function daemonRssKb(sb, appPids) {
  const ps = execFileSync('ps', ['-AEww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let total = 0;
  for (const line of ps.split('\n')) {
    if (!line.includes(`WMUX_E2E_RUN=${sb.runId}`) || !line.includes('daemon-bundle')) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid && !appPids.has(pid)) total += rssKb(pid);
  }
  return total;
}

async function dismissWelcome(win) {
  await win.locator('text=Workspaces').first().waitFor({ timeout: 60_000 });
  await win.getByText('Skip for now', { exact: true }).first().click({ timeout: 15_000 }).catch(() => undefined);
  // eslint-disable-next-line no-restricted-syntax -- the welcome dialog closes with no signal to wait on
  await sleep(500);
  const dontAsk = win.getByText("Don't ask again", { exact: true });
  if (await dontAsk.count()) await dontAsk.first().click();
}

/** Flip Settings > Labs "Rust terminal front end (wongtty)" to `on` and wait
 *  until every terminal runs the engine it asks for (useTerminal's settle
 *  signal on <html>). */
async function setWongtty(win, on) {
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
  await win.getByText('Labs', { exact: true }).first().click({ timeout: 15_000 });
  const toggle = win.getByRole('switch', { name: 'Rust terminal front end (wongtty)' });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await waitFor(async () => (await toggle.getAttribute('aria-checked')) === String(on), { what: 'the wongtty switch' });
  await win.keyboard.press('Escape');
  const engine = on ? 'wongtty' : 'xterm';
  await waitFor(() => win.evaluate((want) => {
    const d = document.documentElement.dataset;
    const panes = [...document.querySelectorAll('body [data-terminal-engine]')];
    return d.terminalEngine === want && Number(d.terminalEnginePending ?? 0) === 0 && panes.every((el) => el.dataset.terminalEngine === want);
  }, engine), { timeout: 60_000, what: `every terminal on ${engine}` });
}

/** From now on, keep a weak reference to every WebAssembly instance's memory,
 *  with the size of the module it came from. Weak, so the record itself keeps
 *  nothing alive: after a collection, what still answers is memory something
 *  else holds. (CDP Runtime.queryObjects would find the memories without this,
 *  but it crashes this Electron's renderer whatever the prototype.) */
async function trackWasm(win) {
  await win.evaluate(() => {
    const W = WebAssembly;
    const sizes = new WeakMap(); // Module -> its byte length
    const refs = [];
    window.__wasmRefs = refs;
    const size = (src) => (src instanceof ArrayBuffer || ArrayBuffer.isView(src) ? src.byteLength : -1);
    const record = (instance, module) => {
      const memory = Object.values(instance.exports).find((v) => v instanceof W.Memory);
      refs.push({ bytes: sizes.get(module) ?? -1, instance: new window.WeakRef(instance), memory: memory ? new window.WeakRef(memory) : null });
    };
    const realInstantiate = W.instantiate;
    W.instantiate = function (src, ...rest) {
      return realInstantiate.call(this, src, ...rest).then((result) => {
        if (result instanceof W.Instance) record(result, src);
        else {
          sizes.set(result.module, size(src));
          record(result.instance, result.module);
        }
        return result;
      });
    };
    const realCompile = W.compile;
    W.compile = function (src, ...rest) {
      return realCompile.call(this, src, ...rest).then((module) => { sizes.set(module, size(src)); return module; });
    };
    W.Module = new Proxy(W.Module, { construct(target, args) { const m = Reflect.construct(target, args); sizes.set(m, size(args[0])); return m; } });
    W.Instance = new Proxy(W.Instance, { construct(target, args) { const i = Reflect.construct(target, args); record(i, args[0]); return i; } });
  });
}

/** WebAssembly instances still alive, and their memories. */
async function wasmLive(win) {
  const live = await win.evaluate(() => (window.__wasmRefs ?? []).map((r) => {
    const memory = r.memory?.deref();
    return { bytes: r.bytes, alive: r.instance.deref() !== undefined, memoryBytes: memory ? memory.buffer.byteLength : 0 };
  }));
  const alive = live.filter((r) => r.alive || r.memoryBytes > 0);
  const wongtty = alive.filter((r) => WONGTTY_WASM_SIZES.includes(r.bytes));
  return {
    instancesCreated: live.length,
    instancesAlive: alive.length,
    memoryMb: +(alive.reduce((n, r) => n + r.memoryBytes, 0) / 1048576).toFixed(1),
    wongttyInstancesAlive: wongtty.length,
    wongttyMemoryMb: +(wongtty.reduce((n, r) => n + r.memoryBytes, 0) / 1048576).toFixed(1),
  };
}

/** Splits the new workspace level by level into PANES panes of similar size. */
async function fanOut(sb, workspaceId) {
  const leaf = await waitFor(async () => {
    const r = await rpc(sb, 'pane.list', { workspaceId });
    const list = r?.panes ?? r;
    return Array.isArray(list) && list.length ? list : null;
  }, { what: 'the first pane' });
  let panes = [leaf[0].id ?? leaf[0].paneId];
  const directions = ['horizontal', 'vertical'];
  for (let level = 0; panes.length < Math.max(PANES, 1); level++) {
    const next = [];
    for (let i = 0; i < panes.length; i++) {
      const id = panes[i];
      next.push(id);
      // Panes after this one stay as they are: stop splitting once the total is reached.
      if (next.length + (panes.length - i - 1) >= Math.max(PANES, 1)) continue;
      await rpc(sb, 'pane.focus', { id });
      const split = await rpc(sb, 'pane.split', { workspaceId, direction: directions[level % 2] });
      next.push(split.paneId);
    }
    panes = next;
  }
  return panes;
}

async function ptyIds(sb, workspaceId) {
  return waitFor(async () => {
    const r = await rpc(sb, 'pane.list', { workspaceId });
    const list = r?.panes ?? r;
    const ids = (Array.isArray(list) ? list : []).map((p) => p.surfacePtyIds?.[0]).filter(Boolean);
    return ids.length === Math.max(PANES, 1) ? ids : null;
  }, { timeout: 60_000, what: `${PANES} panes with a pty` });
}

async function terminalKinds(win) {
  return win.evaluate(() => {
    const all = [...document.querySelectorAll('.xterm')];
    // Only xterm.js builds the decoration container (and the .xterm-viewport beside it).
    const xterm = all.filter((el) => el.querySelector('.xterm-decoration-container')).length;
    return { total: all.length, xterm, wongtty: all.length - xterm };
  });
}

/** The app's memory now: RSS and footprint per Electron process type, the
 *  renderer's JS heap, live WebAssembly memory, the daemon's RSS. */
async function readMemory(app, win, sb, cdp) {
  const heap = await cdp.send('Runtime.getHeapUsage');
  // WebAssembly linear memory (wongtty's engine and front end) is outside the JS heap.
  const wasm = await wasmLive(win);
  const kinds = await terminalKinds(win);
  const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type })));
  const byType = {};
  const footprintByType = {};
  let total = 0;
  let footprintTotal = 0;
  const tabs = [];
  for (const m of metrics) {
    const kb = rssKb(m.pid);
    total += kb;
    byType[m.type] = (byType[m.type] ?? 0) + kb;
    const fp = footprintKb(m.pid);
    footprintTotal += fp;
    footprintByType[m.type] = (footprintByType[m.type] ?? 0) + fp;
    if (m.type === 'Tab') tabs.push({ pid: m.pid, kb });
  }
  const appPids = new Set(metrics.map((m) => m.pid));
  return {
    kinds,
    rendererRssMb: +(Math.max(...tabs.map((t) => t.kb), 0) / 1024).toFixed(1),
    tabsRssMb: +((byType.Tab ?? 0) / 1024).toFixed(1),
    gpuRssMb: +((byType.GPU ?? 0) / 1024).toFixed(1),
    browserRssMb: +((byType.Browser ?? 0) / 1024).toFixed(1),
    totalAppRssMb: +(total / 1024).toFixed(1),
    rendererFootprintMb: +((footprintByType.Tab ?? 0) / 1024).toFixed(1),
    gpuFootprintMb: +((footprintByType.GPU ?? 0) / 1024).toFixed(1),
    totalAppFootprintMb: +(footprintTotal / 1024).toFixed(1),
    jsHeapUsedMb: +(heap.usedSize / 1048576).toFixed(1),
    jsHeapTotalMb: +(heap.totalSize / 1048576).toFixed(1),
    wasm,
    daemonRssMb: +(daemonRssKb(sb, appPids) / 1024).toFixed(1),
    processes: metrics.length,
    footprintByTypeMb: Object.fromEntries(Object.entries(footprintByType).map(([k, v]) => [k, +(v / 1024).toFixed(1)])),
    ...(flags.breakdown ? { breakdown: Object.fromEntries(metrics.map((m) => [`${m.type}:${m.pid}`, footprintCategories(m.pid)])) } : {}),
  };
}

async function oneRun(n) {
  const sb = makeSandbox(`wtm-${mode}`);
  fillFile(sb.home);
  let app;
  const notes = [];
  let glDraws = null;
  const errors = new Set();
  try {
    const extraArgs = [...(flags.dpr ? [`--force-device-scale-factor=${flags.dpr}`] : []), ...(flags.args ? String(flags.args).split(';') : [])];
    const launched = await launchApp(sb, { extraArgs });
    app = launched.app;
    const win = launched.win;
    win.on('pageerror', (e) => errors.add(`pageerror: ${String(e.message).slice(0, 200)}`));
    win.on('console', (m) => {
      if (m.type() === 'error' || /wongtty/.test(m.text())) errors.add(`${m.type()}: ${m.text().slice(0, 200)}`);
    });
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setPosition(0, 0);
      w.setSize(1600, 1000);
    });
    await trackWasm(win);
    await dismissWelcome(win);
    if (mode === 'wongtty') await setWongtty(win, true);

    const first = await rpc(sb, 'workspace.current', {}).catch(() => null);
    if (PANES === 0) {
      // The baseline: try to leave the first workspace without a terminal.
      const list = await rpc(sb, 'pane.list', {});
      const panes = list?.panes ?? list ?? [];
      for (const p of panes) {
        try {
          await rpc(sb, 'pane.close', { id: p.id });
        } catch (err) {
          notes.push(`pane.close refused: ${String(err.message).slice(0, 120)}`);
        }
      }
      // eslint-disable-next-line no-restricted-syntax -- let the layout settle
      await sleep(5_000);
    } else {
      const ws = await rpc(sb, 'workspace.new', { name: 'fan' });
      const paneIds = await fanOut(sb, ws.id);
      const ids = await ptyIds(sb, ws.id);
      if (!flags.empty) {
        for (const ptyId of ids) await rpc(sb, 'input.send', { ptyId, text: 'cat ~/fill.txt', submit: true });
        await waitFor(async () => {
          for (const ptyId of ids) {
            const screen = await rpc(sb, 'input.readScreen', { ptyId, lines: 5 });
            if (!JSON.stringify(screen).includes(MARKER)) return false;
          }
          return true;
        }, { timeout: 180_000, interval: 1_000, what: 'every pane to print the whole file' });
      }
      await rpc(sb, 'pane.focus', { id: paneIds[0] });
      if (flags.busy) {
        for (const ptyId of ids) await rpc(sb, 'input.send', { ptyId, text: 'while :; do head -c 3000 ~/fill.txt; sleep 0.1; done', submit: true });
      }
      // eslint-disable-next-line no-restricted-syntax -- let the focus and the last output render first
      await sleep(3_000);
      // Count WebGL draws while idle: a pane that redraws keeps GPU memory resident.
      await win.evaluate(() => {
        const w = window;
        w.__glDraws = 0;
        w.__glDrawSources = {};
        for (const P of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
          for (const f of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
            const o = P[f];
            if (o) {
              P[f] = function (...a) {
                w.__glDraws++;
                const at = (new Error().stack ?? '').split('\n').slice(2, 5).map((l) => l.trim().replace(/\(.*\//, '(').slice(0, 70)).join(' < ');
                w.__glDrawSources[at] = (w.__glDrawSources[at] ?? 0) + 1;
                return o.apply(this, a);
              };
            }
          }
        }
      });
      // eslint-disable-next-line no-restricted-syntax -- stay idle (or busy) before reading, as the scenario asks
      await sleep(Number(flags.idle ?? 5) * 1000);
      glDraws = await win.evaluate(() => ({ count: window.__glDraws, sources: window.__glDrawSources }));
      if (flags['hide-canvas']) {
        await win.addStyleTag({ content: '.xterm canvas { display: none !important; }' });
      }
      if (flags.away && first?.id) await rpc(sb, 'workspace.focus', { id: first.id });
      if (flags.minimize) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      // eslint-disable-next-line no-restricted-syntax -- let the compositor drop what the change freed
      if (flags['hide-canvas'] || flags.away || flags.minimize) await sleep(5_000);
    }

    if (process.env.WONGTTY_MEM_SHOT) await win.screenshot({ path: `${process.env.WONGTTY_MEM_SHOT}-${mode}-${n}.png` });
    const cdp = await win.context().newCDPSession(win);
    const stages = [];
    /** Read `stage` as it is, then again after a forced garbage collection. */
    const readStage = async (stage) => {
      const asIs = await readMemory(app, win, sb, cdp);
      // A few rounds: memory a collection frees can let a later round free more.
      for (let i = 0; i < 3; i++) {
        await cdp.send('HeapProfiler.collectGarbage');
        // eslint-disable-next-line no-restricted-syntax -- let the freed pages go back to the system
        await sleep(1_000);
      }
      const gc = await readMemory(app, win, sb, cdp);
      stages.push({ stage, asIs, gc });
    };
    if (mode === 'cycle') {
      await readStage('off');
      await setWongtty(win, true);
      // eslint-disable-next-line no-restricted-syntax -- let the swapped panes repaint before reading
      await sleep(Number(flags.idle ?? 5) * 1000);
      await readStage('on');
      await setWongtty(win, false);
      // eslint-disable-next-line no-restricted-syntax -- let the swapped panes repaint before reading
      await sleep(Number(flags.idle ?? 5) * 1000);
      await readStage('off again');
    } else {
      await readStage(mode);
    }
    const layout = await win.evaluate(() => ({
      dpr: window.devicePixelRatio,
      canvases: document.querySelectorAll('canvas').length,
      webviews: document.querySelectorAll('webview, iframe').length,
      focused: document.activeElement?.className ?? '',
    }));
    const gpuFeatures = flags.breakdown ? await app.evaluate(({ app: electronApp }) => electronApp.getGPUFeatureStatus()) : undefined;
    const scenario = Object.entries(flags).map(([k, v]) => (v === true ? k : `${k}=${v}`)).join(',') || 'default';
    const result = {
      mode, scenario, run: n, layout, notes, stages,
      glDrawsWhileWaiting: glDraws,
      ...(gpuFeatures ? { gpuFeatures } : {}),
      errors: [...errors].slice(0, 30),
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    try { await app?.close(); } catch { /* already gone */ }
    killRun(sb);
    fs.rmSync(sb.home, { recursive: true, force: true });
  }
}

const results = [];
for (let n = 1; n <= runs; n++) results.push(await oneRun(n));
if (out) fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);

// Labs wongtty switch, end to end in the real Electron app: turning it on or
// off rebuilds every open terminal with the other engine and keeps what each
// one showed, a restart builds each pane once with the saved engine, nothing
// of wongtty loads while it is off, and a wongtty that cannot load leaves every
// pane on xterm.js.
//
// Seven panes: the default workspace's one, workspace A with four (the one in
// view) and workspace B with two (hidden). Each prints TOP-<n>, 3000 rows and
// BOTTOM-<n>; one then runs a probe that takes the alternate screen with
// bracketed paste, mouse reporting and kitty flags on, and answers what the
// terminal reports for them (DECRQM, CSI ? u, DSR, stty size) on request.
// Every pane traps SIGWINCH and prints it, so a swap that changed a grid shows.
// A further workspace F holds one pane that streams output while the switch
// flips. The last run fails every repaint (WMUX_E2E_RESYNC), and a second
// sandbox runs the app with no daemon at all (local mode).
//
// WMUX_E2E_SANDBOX_BASE moves the sandbox HOME (e.g. off a small system disk).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ROOT, killRun, launchApp, makeSandbox, rpc, sleep, waitFor } from './lib.mjs';

const ROWS = 3000;
const ALT_PANE = 4;
const SWITCH = 'Rust terminal front end (wongtty)';
const FAILED_TEXT = 'wongtty could not start';

/** Processes of the installed wmux (never touched, only counted). */
function packagedWmuxCount() {
  try {
    return execFileSync('pgrep', ['-f', '/Applications/wmux.app'], { encoding: 'utf8' }).split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

let sb = makeSandbox('wts');
let appRoot = ROOT;
const packagedBefore = packagedWmuxCount();
let run = null;
const panes = []; // { n, ptyId, ws }
const ws = {};
// Panes on the page that are not in `panes` (workspace F's streaming pane).
let extraPanes = 0;
const FLOW_LINES = 2_000_000;

// The probe of the alternate-screen pane: on each request file it asks the
// terminal for its modes, kitty flags, cursor and size, and writes the answers.
fs.writeFileSync(path.join(sb.home, 'probe.sh'), [
  'n=$1; out="$HOME/probe-$n"',
  "trap 'echo WINCH >> \"$out.winch\"' WINCH",
  "printf '\\e[?1049h\\e[?2004h\\e[?1000h\\e[?1006h\\e[>1u\\e[2J\\e[HALT-%s\\r\\n' \"$n\"",
  'stty raw -echo',
  'while :; do',
  '  if [ -e "$out.req" ]; then',
  '    rm -f "$out.req"; res=""',
  '    for m in 1049 2004 1000 1006; do printf "\\e[?%s\\$p" "$m"; IFS= read -r -d y -t 3 a; res="$res $m=${a#*;}"; done',
  "    printf '\\e[?u'; IFS= read -r -d u -t 3 a; res=\"$res kitty=${a#*\\?}\"",
  "    printf '\\e[6n'; IFS= read -r -d R -t 3 a; res=\"$res cursor=${a#*[}\"",
  '    res="$res size=$(stty size)"',
  '    printf "%s\\n" "$res" > "$out.tmp"; mv "$out.tmp" "$out"',
  '  fi',
  '  sleep 0.2',
  'done',
  '',
].join('\n'));

// Streams FLOW_LINES numbered rows; the start and end files tell the test
// whether it is still streaming when the switch flips.
fs.writeFileSync(path.join(sb.home, 'flow.sh'), [
  'k=$1; rm -f "$HOME/flow-$k.start" "$HOME/flow-$k.end"',
  'touch "$HOME/flow-$k.start"',
  // -f: BSD seq prints numbers above 999,999 in exponent form.
  `seq -f '%.0f' 1 ${FLOW_LINES} | sed "s/^/FLOW$k-/"`,
  'touch "$HOME/flow-$k.end"',
  "printf 'FLOW''DONE-%s\\n' \"$k\"",
  '',
].join('\n'));

async function launch(env = {}) {
  Object.assign(process.env, env);
  try {
    const launched = await launchApp(sb, { appRoot });
    const consoleLines = [];
    launched.win.on('console', (m) => consoleLines.push(m.text()));
    await launched.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setPosition(0, 0);
      w.setSize(1600, 1000);
    });
    await launched.win.locator('text=Workspaces').first().waitFor({ timeout: 60_000 });
    // The pipe RPCs go to can come up after the window does.
    await waitFor(() => fs.existsSync(path.join(sb.home, '.wmux-e2e.sock')) && fs.existsSync(path.join(sb.home, '.wmux-e2e-auth-token')), { timeout: 60_000, what: "the app's pipe" });
    await launched.win.getByText('Skip for now', { exact: true }).first().click({ timeout: 5_000 }).catch(() => undefined);
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

/** Quit the app as a user would; the daemon (and every session) stays up. */
function saveLogs(tag) {
  const dir = process.env.WMUX_E2E_ARTIFACTS;
  if (!dir || !run) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `wongtty-switch-${tag}.log`), `${run.logs.join('')}\n--- renderer console ---\n${run.consoleLines.join('\n')}\n`);
}

let launches = 0;
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
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
  await win.getByText('Labs', { exact: true }).first().click({ timeout: 15_000 });
  const toggle = win.getByRole('switch', { name: SWITCH });
  for (let i = 0; i < clicks; i++) {
    await toggle.click();
    if (i < clicks - 1) await sleep(gapMs);
  }
  const on = (await toggle.getAttribute('aria-checked')) === 'true';
  return { on, close: () => win.keyboard.press('Escape') };
}

async function engineState() {
  return run.win.evaluate(() => ({
    engine: document.documentElement.dataset.terminalEngine,
    pending: Number(document.documentElement.dataset.terminalEnginePending ?? 0),
    panes: [...document.querySelectorAll('body [data-terminal-engine]')].map((el) => el.dataset.terminalEngine),
  }));
}

async function waitEngine(engine) {
  return waitFor(async () => {
    const s = await engineState();
    return s.engine === engine && s.pending === 0 && s.panes.length === panes.length + extraPanes && s.panes.every((p) => p === engine) ? s : null;
  }, { timeout: 60_000, what: `every pane on ${engine}` });
}

const listPanes = async (workspaceId) => {
  const r = await rpc(sb, 'pane.list', { workspaceId });
  return r?.panes ?? r ?? [];
};

async function splitInto(workspaceId, count) {
  let ids = [(await waitFor(async () => (await listPanes(workspaceId))[0], { what: 'the first pane' })).id];
  while (ids.length < count) {
    await rpc(sb, 'pane.focus', { id: ids[ids.length - 1] });
    const split = await rpc(sb, 'pane.split', { workspaceId, direction: ids.length % 2 ? 'horizontal' : 'vertical' });
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

async function probe() {
  const out = path.join(sb.home, `probe-${ALT_PANE}`);
  fs.rmSync(out, { force: true });
  fs.writeFileSync(`${out}.req`, '');
  return waitFor(() => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : null), { timeout: 20_000, what: 'the probe answer' });
}

let probeBaseline = '';
const winchBaseline = {};

/** Every pane shows what it showed, once: its markers in scrollback and on
 *  screen, no SIGWINCH, and the alternate-screen pane's modes unchanged.
 *  After a restart (`restart`), what a restart changes today whatever the
 *  engine (the session's kitty flags, which the daemon snapshot does not keep,
 *  and a resize from xterm.js's first fit) is recorded as the new baseline. */
async function checkContent(label, { restart = false } = {}) {
  for (const id of [ws.zero, ws.b, ws.a]) {
    await rpc(sb, 'workspace.focus', { id });
    for (const p of panes.filter((x) => x.ws === id)) {
      await waitFor(async () => {
        const text = await screen(p.ptyId);
        if (p.n === ALT_PANE) return text.includes(`ALT-${p.n}`);
        return text.includes(`BOTTOM-${p.n}`) && await matches(`TOP-${p.n}`, id) === 1 && await matches(`row-${p.n}-1500`, id) === 1;
      }, { timeout: 30_000, interval: 500, what: `${label}: pane ${p.n} content, once` });
    }
    const winch = await matches('WINCH-', id);
    if (restart) {
      if (winch !== (winchBaseline[id] ?? 0)) summary.push(`${label}: workspace ${id} resized at startup (${winch - (winchBaseline[id] ?? 0)} SIGWINCH lines; not a swap)`);
      winchBaseline[id] = winch;
    } else {
      assert.equal(winch, winchBaseline[id] ?? 0, `${label}: no pane saw a resize`);
    }
  }
  const probed = await probe();
  if (restart) {
    const strip = (p) => p.replace(/ kitty=\d+/, '');
    assert.equal(strip(probed), strip(probeBaseline), `${label}: alternate screen, modes, cursor and size kept`);
    if (probed !== probeBaseline) summary.push(`${label}: probe ${probed} (kitty flags reset by the restart, as with xterm.js today)`);
    probeBaseline = probed;
    // A resize the restart made is the new baseline too.
    const winchFile = path.join(sb.home, `probe-${ALT_PANE}.winch`);
    if (fs.existsSync(winchFile)) {
      summary.push(`${label}: the probe saw ${fs.readFileSync(winchFile, 'utf8').trim().split('\n').length} resize(s) at startup (not a swap)`);
      fs.rmSync(winchFile);
    }
    return;
  }
  assert.equal(probed, probeBaseline, `${label}: alternate screen, modes, kitty flags, cursor and size kept`);
  assert.equal(fs.existsSync(path.join(sb.home, `probe-${ALT_PANE}.winch`)), false, `${label}: the probe saw no resize`);
}

/** Record the size of every WebAssembly module compiled from now on. (CDP
 *  Runtime.queryObjects, which e2e/wongtty-memory.mjs uses to sum the
 *  memories, crashes this renderer whatever the prototype; and xterm.js's
 *  image addon compiles small modules of its own, so a bare count proves
 *  nothing: wongtty's two modules are told apart by their size.) */
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
const WONGTTY_WASM_SIZES = ['wongtty.wasm', 'xterm_web_bg.wasm'].map((f) => fs.statSync(path.join(ROOT, 'node_modules', 'wongtty', 'dist', f)).size);
/** R14: nothing of wongtty fetched: no chunk, no wasm handed over by main,
 *  no WebAssembly compiled or memory made while panes opened and repainted. */
async function assertNothingLoaded(label) {
  const chunks = await run.win.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /wongtty-/.test(n)));
  assert.deepEqual(chunks, [], `${label}: no wongtty chunk fetched`);
  assert.equal(run.logs.some((l) => l.includes('[wmux:wongtty] wasm served')), false, `${label}: main served no wasm`);
  const sizes = await run.win.evaluate(() => window.__wasmSizes);
  assert.deepEqual(sizes.filter((n) => n < 0 || WONGTTY_WASM_SIZES.includes(n)), [], `${label}: no wongtty WebAssembly compiled (compiled: ${sizes.join(',') || 'none'})`);
  summary.push(`${label}: WebAssembly modules compiled while panes opened: ${sizes.length ? sizes.join(', ') : 'none'} bytes (wongtty's are ${WONGTTY_WASM_SIZES.join(', ')})`);
}

const swapLines = () => run.consoleLines.filter((l) => l.includes('[wmux:engine-swap]'));
const summary = [];

before(async () => {
  run = await launch();
});

after(() => {
  saveLogs(`launch${++launches}`);
  const killed = killRun(sb);
  console.log(`[wongtty-switch] killed ${killed} processes of this run; packaged wmux processes before=${packagedBefore} after=${packagedWmuxCount()}`);
  console.log(summary.map((s) => `[wongtty-switch] ${s}`).join('\n'));
  // The killed daemon and shells may still be letting go of files for a moment.
  if (process.env.WMUX_E2E_KEEP !== '1') fs.rmSync(sb.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  assert.equal(packagedWmuxCount(), packagedBefore, 'the installed wmux was left alone');
});

describe('Labs wongtty switch', { timeout: 30 * 60_000 }, () => {
  it('1. starts off with nothing of wongtty loaded, and fills seven panes', async () => {
    await countWasm();
    ws.zero = (await rpc(sb, 'workspace.current', {})).id;
    const zero = await splitInto(ws.zero, 1);
    ws.a = (await rpc(sb, 'workspace.new', { name: 'A' })).id;
    const a = await splitInto(ws.a, 4);
    ws.b = (await rpc(sb, 'workspace.new', { name: 'B' })).id;
    const b = await splitInto(ws.b, 2);
    [[ws.zero, zero], [ws.a, a], [ws.b, b]].forEach(([id, ptys]) => ptys.forEach((ptyId) => panes.push({ n: panes.length + 1, ptyId, ws: id })));
    for (const p of panes) {
      await rpc(sb, 'workspace.focus', { id: p.ws });
      await rpc(sb, 'input.send', { ptyId: p.ptyId, text: `printf 'TO''P-%s\\n' ${p.n}; seq 1 ${ROWS} | sed 's/^/row-${p.n}-/'; printf 'BOTT''OM-%s\\n' ${p.n}`, submit: true });
      await waitFor(async () => (await screen(p.ptyId)).includes(`BOTTOM-${p.n}`), { timeout: 60_000, what: `pane ${p.n} filled` });
    }
    // Every grid is final now: from here a SIGWINCH is a swap that resized.
    for (const p of panes) {
      await rpc(sb, 'workspace.focus', { id: p.ws });
      await rpc(sb, 'input.send', { ptyId: p.ptyId, text: p.n === ALT_PANE ? `bash ~/probe.sh ${p.n}` : `trap 'echo WIN''CH-${p.n}' WINCH`, submit: true });
    }
    await rpc(sb, 'workspace.focus', { id: ws.a });
    probeBaseline = await probe();
    assert.match(probeBaseline, /1049=1\$ 2004=1\$ 1000=1\$ 1006=1\$ kitty=1 cursor=\d+;\d+ size=\d+ \d+/);
    const s = await waitEngine('xterm');
    assert.equal(s.panes.length, 7);
    await checkContent('off at start');
    await assertNothingLoaded('off at start');
    summary.push(`start off: ${s.panes.length} panes xterm, no wongtty chunk/wasm/memory; probe ${probeBaseline}`);
  });

  it('2. switching on rebuilds every pane with wongtty and keeps its content', async () => {
    const t0 = Date.now();
    const labs = await setSwitch(1);
    assert.equal(labs.on, true);
    await waitEngine('wongtty');
    const settledMs = Date.now() - t0;
    await labs.close();
    await checkContent('on');
    await waitEngine('wongtty');
    summary.push(`on: all ${panes.length} wongtty in ${settledMs} ms; swaps ${swapLines().length} (${[...new Set(swapLines().map((l) => /mechanism=(\S+)/.exec(l)?.[1]))].join(',')})`);
  });

  it('3. switching off rebuilds every pane with xterm.js and keeps its content', async () => {
    const before = swapLines().length;
    const labs = await setSwitch(1);
    assert.equal(labs.on, false);
    await waitEngine('xterm');
    await labs.close();
    await checkContent('off');
    summary.push(`off: all xterm; swaps ${swapLines().length - before}`);
  });

  it('4. on/off/on within a second settles on wongtty', async () => {
    const labs = await setSwitch(3, { gapMs: 300 });
    assert.equal(labs.on, true);
    await waitEngine('wongtty');
    await labs.close();
    await checkContent('on/off/on');
    // Still there after the checks: settled, not passing through.
    await waitEngine('wongtty');
    summary.push('on/off/on: settled on wongtty');
  });

  it('4b. flipped back while its swaps are still repainting, every pane keeps its content', async () => {
    // The second flip lands while panes of the first are still repainting
    // (the settle signal counts them); workspace B is not shown in between.
    await rpc(sb, 'workspace.focus', { id: ws.a });
    const before = swapLines().length;
    const labs = await setSwitch(1); // off
    const caught = await waitFor(async () => {
      const s = await engineState();
      return s.engine === 'xterm' && s.pending > 0 ? s : null;
    }, { timeout: 10_000, interval: 10, what: 'a swap still repainting' });
    await run.win.getByRole('switch', { name: SWITCH }).click(); // on again
    await waitEngine('wongtty');
    await labs.close();
    await checkContent('flipped back before the first repaint');
    const offRepaints = swapLines().slice(before).filter((l) => /from=wongtty to=xterm mechanism=snapshot/.test(l)).length;
    const visible = panes.filter((p) => p.ws === ws.a).length;
    summary.push(`flipped back mid-repaint: second flip with ${caught.pending} panes pending; ${panes.length - visible} hidden panes swapped twice with no repaint between, and ${visible - offRepaints} of ${visible} visible ones before theirs landed`);
  });

  it('5. input sent during a swap lands exactly once', async () => {
    await rpc(sb, 'workspace.focus', { id: ws.a });
    const typed = panes.find((p) => p.ws === ws.a && p.n !== ALT_PANE);
    const labs = await setSwitch(1); // off: every pane swaps back to xterm.js
    for (let k = 1; k <= 4; k++) {
      await rpc(sb, 'input.send', { ptyId: typed.ptyId, text: `printf 'TYP''ED-%s\\n' ${k}`, submit: true });
      await sleep(120);
    }
    await waitEngine('xterm');
    await labs.close();
    for (let k = 1; k <= 4; k++) {
      await waitFor(async () => (await matches(`TYPED-${k}`, ws.a)) === 1, { timeout: 20_000, what: `TYPED-${k} once` });
    }
    await checkContent('typed during a swap');
    // Back on for the restart below.
    const on = await setSwitch(1);
    await waitEngine('wongtty');
    await on.close();
    summary.push('typed during a swap: 4 markers, each once');
  });

  it('5b. a switch flipped while output is streaming loses and doubles nothing', async () => {
    ws.f = (await rpc(sb, 'workspace.new', { name: 'F' })).id;
    const [flow] = await splitInto(ws.f, 1);
    extraPanes = 1;
    await waitEngine('wongtty');
    for (const [k, engine] of [[1, 'xterm'], [2, 'wongtty']]) {
      await rpc(sb, 'workspace.focus', { id: ws.f });
      await rpc(sb, 'input.send', { ptyId: flow, text: `bash ~/flow.sh ${k}`, submit: true });
      await waitFor(() => fs.existsSync(path.join(sb.home, `flow-${k}.start`)), { timeout: 30_000, interval: 50, what: `flow ${k} to start` });
      await sleep(500);
      const labs = await setSwitch(1);
      // The flip is in: the stream must still be running for this step to mean anything.
      assert.equal(fs.existsSync(path.join(sb.home, `flow-${k}.end`)), false, `flow ${k} still streaming when the switch flipped`);
      await waitEngine(engine);
      const streamingAfterSwap = !fs.existsSync(path.join(sb.home, `flow-${k}.end`));
      await labs.close();
      await waitFor(() => fs.existsSync(path.join(sb.home, `flow-${k}.end`)), { timeout: 300_000, interval: 500, what: `flow ${k} to end` });
      await waitFor(async () => (await matches(`FLOWDONE-${k}`, ws.f)) === 1, { timeout: 60_000, interval: 500, what: `FLOWDONE-${k} once` });
      // The last rows, each once (pane.search reaches about 5,000 rows back
      // here, with or without a swap).
      for (const row of [FLOW_LINES - 4000, FLOW_LINES - 2000, FLOW_LINES - 1000, FLOW_LINES - 1, FLOW_LINES]) {
        assert.equal(await matches(`FLOW${k}-${row}`, ws.f), 1, `flow ${k}: row ${row} once`);
      }
      assert.match(await screen(flow), new RegExp(`FLOW${k}-${FLOW_LINES}[^0-9][\\s\\S]*FLOWDONE-${k}`), `flow ${k}: the stream's end on screen, in order`);
      summary.push(`streaming: flow ${k} still streaming when the switch flipped to ${engine}${streamingAfterSwap ? ' and after every pane had swapped' : ''}; its last rows each once`);
    }
    await checkContent('after streaming through swaps');
  });

  it('6. a restart with the switch on builds every pane with wongtty once', async () => {
    await quit();
    run = await launch();
    await waitEngine('wongtty');
    await checkContent('restart on', { restart: true });
    assert.deepEqual(swapLines(), [], 'no pane swapped at startup');
    summary.push('restart on: all wongtty, 0 engine-swap lines');
  });

  it('7. a restart with the switch off loads nothing of wongtty', async () => {
    const labs = await setSwitch(1);
    assert.equal(labs.on, false);
    await waitEngine('xterm');
    await labs.close();
    await quit();
    run = await launch();
    await countWasm();
    await waitEngine('xterm');
    await checkContent('restart off', { restart: true });
    await assertNothingLoaded('restart off');
    assert.deepEqual(swapLines(), [], 'no pane swapped at startup');
    summary.push('restart off: all xterm, no wongtty chunk/wasm/memory, 0 engine-swap lines');
  });

  it('8. a wongtty that cannot load leaves every pane on xterm.js, reported once', async () => {
    await quit();
    run = await launch({ WMUX_E2E_WONGTTY_WASM: 'broken' });
    let labs = await setSwitch(1);
    assert.equal(labs.on, true);
    const alert = run.win.getByRole('alert').filter({ hasText: FAILED_TEXT });
    await alert.waitFor({ timeout: 30_000 });
    await waitEngine('xterm');
    assert.equal(await run.win.evaluate(() => window.__wongttyToasts), 1, 'one toast');
    // The switch still works: off clears the error, on retries and fails the same way.
    await run.win.getByRole('switch', { name: SWITCH }).click();
    await waitFor(async () => (await alert.count()) === 0, { what: 'the error line to clear' });
    await run.win.getByRole('switch', { name: SWITCH }).click();
    await alert.waitFor({ timeout: 30_000 });
    await waitEngine('xterm');
    assert.equal(await run.win.evaluate(() => window.__wongttyToasts), 1, 'still one toast for the same failure');
    await labs.close();
    labs = null;
    await checkContent('broken wasm', { restart: true });
    summary.push('broken wasm: all xterm, 1 toast, error line shown and cleared, switch still toggles');
  });

  it("9. a repaint that fails paints the old terminal's own content, shown or hidden", async () => {
    await quit();
    run = await launch({ WMUX_E2E_RESYNC: 'session-gone' });
    await waitEngine('wongtty');
    await checkContent('repaint fails: start', { restart: true });
    for (const [label, engine] of [['off', 'xterm'], ['on', 'wongtty']]) {
      const before = run.consoleLines.length;
      const labs = await setSwitch(1);
      await waitEngine(engine);
      await labs.close();
      // Shows every workspace, so each hidden pane's repaint is tried (and fails) too.
      await checkContent(`repaint fails: ${label}`);
      const painted = run.consoleLines.slice(before).filter((l) => /\[wmux:engine-swap\].*repaint failed \(resync-failed:session-gone\); painted the old terminal's content/.test(l)).length;
      assert.equal(painted, panes.length, `repaint fails: ${label}: every pane shown painted its old terminal's content`);
      summary.push(`repaint fails, ${label}: ${painted} panes painted their old terminal's content; content and modes kept`);
    }
  });
});

describe('Labs wongtty switch without a daemon (local mode)', { timeout: 15 * 60_000 }, () => {
  const content = async (label, of = panes) => {
    for (const p of of) {
      await waitFor(async () => (await screen(p.ptyId)).includes(`BOTTOM-${p.n}`) && await matches(`TOP-${p.n}`, ws.zero) === 1 && await matches(`row-${p.n}-750`, ws.zero) === 1,
        { timeout: 30_000, interval: 500, what: `${label}: local pane ${p.n} content, once` });
    }
  };

  it('10. switching on and off keeps every local pane\'s content', async () => {
    // Done with the daemon sandbox: none of its processes may serve this one.
    await quit();
    killRun(sb);
    fs.rmSync(sb.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    sb = makeSandbox('wtl');
    // The app from a copy of this checkout's root without the daemon's
    // bundles: main finds no daemon to start and runs every pane itself.
    appRoot = path.join(sb.home, 'app');
    fs.mkdirSync(path.join(appRoot, 'dist'), { recursive: true });
    for (const e of fs.readdirSync(ROOT)) if (e !== 'dist') fs.symlinkSync(path.join(ROOT, e), path.join(appRoot, e));
    for (const e of fs.readdirSync(path.join(ROOT, 'dist'))) if (e !== 'daemon' && e !== 'daemon-bundle') fs.symlinkSync(path.join(ROOT, 'dist', e), path.join(appRoot, 'dist', e));
    panes.length = 0;
    extraPanes = 0;
    run = await launch();
    ws.zero = (await rpc(sb, 'workspace.current', {})).id;
    const ptys = await splitInto(ws.zero, 2);
    ptys.forEach((ptyId) => panes.push({ n: panes.length + 1, ptyId, ws: ws.zero }));
    for (const p of panes) {
      await rpc(sb, 'input.send', { ptyId: p.ptyId, text: `printf 'TO''P-%s\\n' ${p.n}; seq 1 1500 | sed 's/^/row-${p.n}-/'; printf 'BOTT''OM-%s\\n' ${p.n}`, submit: true });
      await waitFor(async () => (await screen(p.ptyId)).includes(`BOTTOM-${p.n}`), { timeout: 60_000, what: `local pane ${p.n} filled` });
    }
    await waitEngine('xterm');
    for (const [label, clicks, engine] of [['on', 1, 'wongtty'], ['off', 1, 'xterm'], ['on/off/on', 3, 'wongtty']]) {
      const before = swapLines().length;
      const labs = await setSwitch(clicks);
      await waitEngine(engine);
      await labs.close();
      await content(`local ${label}`);
      const mechanisms = [...new Set(swapLines().slice(before).map((l) => /mechanism=(\S+)/.exec(l)?.[1]))];
      assert.deepEqual(mechanisms, ['transplant'], `local ${label}: every swap carried the old terminal over (no daemon)`);
    }
    summary.push(`local mode: ${panes.length} panes on, off, on/off/on, each by transplant, content kept once`);
  });

  it('11. switched off while a local capture waits, every pane stays on xterm.js with its content', async () => {
    const labs = await setSwitch(1);
    assert.equal(labs.on, false);
    // Colour-heavy floods in hidden workspaces: their backlogs, handed to
    // xterm.js at the capture, keep the captures waiting on their parse
    // barriers.
    const floods = [];
    for (const name of ['L1', 'L2']) {
      const id = (await rpc(sb, 'workspace.new', { name })).id;
      floods.push({ ws: id, ptyId: (await splitInto(id, 1))[0] });
    }
    extraPanes = floods.length;
    await rpc(sb, 'workspace.focus', { id: ws.zero });
    await waitEngine('xterm');
    const toasts = await run.win.evaluate(() => window.__wongttyToasts);
    const before = swapLines().length;
    const FLOOD_LINES = 600_000;
    for (const [i, f] of floods.entries()) {
      await rpc(sb, 'input.send', { ptyId: f.ptyId, text: `touch ~/flood-${i}.start; seq -f '%.0f' 1 ${FLOOD_LINES} | sed $'s/^/\\e[31mF\\e[32mL\\e[33mO\\e[34mO\\e[35mD\\e[0m-/'; printf 'FLOOD''DONE\\n'`, submit: true });
    }
    await waitFor(() => floods.every((_, i) => fs.existsSync(path.join(sb.home, `flood-${i}.start`))), { timeout: 30_000, interval: 50, what: 'the floods to start' });
    // A slowed renderer CPU stretches the parse each capture waits for, while
    // the controller's quiet window runs on the wall clock.
    const cdp = await run.win.context().newCDPSession(run.win);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
    try {
      const toggle = run.win.getByRole('switch', { name: SWITCH });
      await toggle.click();
      await waitFor(async () => (await engineState()).engine === 'wongtty', { timeout: 60_000, interval: 10, what: 'the switch to reach the panes' });
      await toggle.click();
      await waitEngine('xterm');
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.detach();
    }
    await labs.close();
    for (const f of floods) {
      await waitFor(async () => (await matches('FLOODDONE', f.ws)) === 1, { timeout: 180_000, interval: 500, what: 'FLOODDONE once' });
      for (const row of [FLOOD_LINES - 2000, FLOOD_LINES - 1, FLOOD_LINES]) {
        assert.equal(await matches(`FLOOD-${row}`, f.ws), 1, `flood row ${row} once`);
      }
    }
    await content('switched off while capturing');
    const lines = swapLines().slice(before);
    assert.equal(lines.filter((l) => /could not build/.test(l)).length, 0, 'no pane failed to build');
    assert.equal(await run.win.evaluate(() => window.__wongttyToasts), toasts, 'no failure toast');
    assert.equal(await run.win.getByRole('alert').filter({ hasText: FAILED_TEXT }).count(), 0, 'no Labs error line');
    const dropped = lines.filter((l) => /capture dropped/.test(l)).length;
    assert.ok(dropped > 0, 'the off landed while a capture waited (the step tests nothing otherwise)');
    summary.push(`local mode, switched off while capturing: all xterm, no failure, content kept; ${dropped} capture(s) dropped by the flip back`);
  });
});

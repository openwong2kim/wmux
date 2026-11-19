import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { ChromeLauncher, setPipeRelayForTests, type ChromeProtectionPlan } from '../ChromeLauncher';
import { CdpPipeRelay } from '../CdpPipeRelay';
import type { CdpPipeMux } from '../CdpPipeMux';
import type { CdpConnection } from '../CdpSocket';
import { compileHostPolicy } from '../../../shared/browserHostPolicy';
import { chromeForRuntimeSuite } from '../../../test-utils/runtimeChrome';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { CHROME_TEARDOWN_TIMEOUT_MS, stopChrome, tempChromeProfile, type TempChromeProfile } from '../../../test-utils/chromeProfile';

// ---------------------------------------------------------------------------
// A protected profile on the debugging pipe (WMUX_CHROME_TRANSPORT=auto),
// against a real Chrome started by the production launcher: what an outside
// (relay) client can open, see and drive, and that no debugging port opens.
//
// The control case turns chrome://inspect's "Allow remote debugging for this
// browser instance" on from main's own session and records what follows:
// whether a port opens, whether Chrome writes DevToolsActivePort, and whether
// the launcher's watch then closes the browser. It prints one
// `[pipe-boundary control]` line for the CI log.
// ---------------------------------------------------------------------------

const CHROME = chromeForRuntimeSuite();
const CASE_TIMEOUT_MS = 90_000;
/** How long the cases watch for a port after a toggle attempt. */
const WATCH_MS = 20_000;
const PAYLOAD = 'PAYLOAD-PIPE-BOUNDARY';

let server: http.Server;
let port = 0;
let relayRoot: string | null = null;

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.url?.endsWith('/file.bin')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"' });
    res.end(PAYLOAD);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>page</title><a id="d" href="/file.bin">file</a>${req.url}`);
}

function plan(): ChromeProtectionPlan {
  return {
    matcher: () => compileHostPolicy({ mode: 'allowlist', allow: ['a.test'], block: [] }),
    resolve: (_host, p) => ({ host: '127.0.0.1', port: p }),
  };
}

const run = (cmd: string, args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
  execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(`${cmd} is not available on this runner`));
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

/**
 * TCP ports listening in `rootPid`'s process tree. Throws when the tool that
 * reads them is missing or fails, so "none" is never a reading that did not happen.
 */
async function listeners(rootPid: number): Promise<string[]> {
  if (process.platform === 'win32') {
    const script = [
      `$p = @(${rootPid})`,
      'do { $n = @(Get-CimInstance Win32_Process | Where-Object { $p -contains $_.ParentProcessId -and $p -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }); $p += $n } while ($n.Count)',
      'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $p -contains $_.OwningProcess } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }',
    ].join('; ');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (r.code !== 0) throw new Error(`reading listeners failed: ${r.stderr.trim()}`);
    return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  const ps = await run('ps', ['-A', '-o', 'pid=,ppid=']);
  if (ps.code !== 0) throw new Error(`ps failed: ${ps.stderr.trim()}`);
  const rows = ps.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const pids = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); grew = true; }
  }
  const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', [...pids].join(',')]);
  // lsof exits 1 with nothing on stderr when nothing matched.
  if (lsof.code !== 0 && (lsof.code !== 1 || lsof.stderr.trim())) throw new Error(`lsof failed: ${lsof.stderr.trim()}`);
  return lsof.stdout.split('\n').slice(1).map((l) => l.trim().split(/\s+/).at(-2) ?? '').filter(Boolean);
}

interface Rig { launcher: ChromeLauncher; profile: TempChromeProfile; pid: number }

async function start(opts: { headful?: boolean; profile?: TempChromeProfile } = {}): Promise<Rig> {
  const profile = opts.profile ?? tempChromeProfile('wmux-pipe-boundary-');
  vi.stubEnv('WMUX_CHROME_TRANSPORT', 'auto');
  vi.stubEnv('WMUX_CHROME_PATH', CHROME as string);
  const launcher = new ChromeLauncher(profile.dir, {
    portEnvVar: null,
    profileName: 'pipe-boundary',
    protection: () => plan(),
    extraArgs: [...(opts.headful || process.env.PROTECTED_HEADFUL === '1' ? [] : ['--headless=new']), '--use-mock-keychain', '--password-store=basic'],
  });
  if (!opts.profile) rigs.push({ launcher, profile });
  else launchers.push(launcher);
  await launcher.endpoint();
  const pid = (launcher as unknown as { child: { pid: number } | null }).child?.pid as number;
  return { launcher, profile, pid };
}

/** Main's own connection on the pipe: never filtered. */
function internal(rig: Rig): CdpConnection {
  const mux = (rig.launcher as unknown as { piped: { mux: CdpPipeMux } | null }).piped?.mux;
  if (!mux) throw new Error('not on the pipe');
  return mux.connect({ label: 'test internal' });
}

/** A bare relay client: commands by id; failures come back as the error message. */
async function relayClient(rig: Rig) {
  const grant = await rig.launcher.relayGrant({ workspaceId: 'ws-boundary' });
  const ws = new WebSocket(grant.endpoint, { headers: { ...grant.headers } });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString()) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };
    if (typeof m.id === 'number') waiting.get(m.id)?.(m);
    else if (m.method) events.push({ method: m.method, params: m.params ?? {} });
  });
  let next = 0;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  });
  return { send, events, close: () => ws.close() };
}

const portFile = (rig: Rig) => fs.existsSync(path.join(rig.profile.dir, 'DevToolsActivePort'));

/** A line for the CI log: written straight to stderr, and to the job summary when there is one. */
function report(line: string): void {
  process.stderr.write(`${line}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `\n\`${line}\`\n`);
}

/** Why the launcher closed its protected browser, if it did (read before the next call takes it). */
const closedFor = (rig: Rig) => (rig.launcher as unknown as { protectionLost: string | null }).protectionLost;

/** Over WATCH_MS: any listener in Chrome's tree, and whether DevToolsActivePort appeared. */
async function watchForPort(rig: Rig): Promise<{ listeners: string[]; portFile: boolean }> {
  const seen = new Set<string>();
  let file = false;
  const until = Date.now() + WATCH_MS;
  while (Date.now() < until) {
    if (rig.launcher.isRunning()) for (const l of await listeners(rig.pid)) seen.add(l);
    file ||= portFile(rig);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { listeners: [...seen], portFile: file };
}

const INSPECT = 'chrome://inspect/#remote-debugging';
const TOGGLE_STATE = `(() => { const el = document.getElementById('remote-debugging-enabled'); if (!el) return 'absent'; const r = el.getBoundingClientRect(); return JSON.stringify({ checked: el.checked, x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`;

const rigs: Array<{ launcher: ChromeLauncher; profile: TempChromeProfile }> = [];
/** Launchers on a profile a rig already owns. */
const launchers: ChromeLauncher[] = [];

beforeAll(async () => {
  relayRoot = process.platform === 'win32' ? null : fs.mkdtempSync('/tmp/wmux-pb-');
  if (relayRoot) fs.chmodSync(relayRoot, 0o700);
  await setPipeRelayForTests(new CdpPipeRelay({ roots: relayRoot ? [relayRoot] : [] }));
  server = http.createServer(serve);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const launcher of launchers.splice(0)) await stopChrome(launcher);
  for (const { launcher, profile } of rigs.splice(0)) {
    await stopChrome(launcher);
    await profile.remove();
  }
  vi.unstubAllEnvs();
}, CHROME_TEARDOWN_TIMEOUT_MS);

afterAll(async () => {
  server?.close();
  await setPipeRelayForTests(null);
  if (relayRoot) fs.rmSync(relayRoot, { recursive: true, force: true });
});

describe.skipIf(!CHROME)('a protected profile on the pipe (real Chrome)', () => {
  it('starts on the pipe with no port open and no DevToolsActivePort', { timeout: CASE_TIMEOUT_MS }, async () => {
    const rig = await start();
    expect(rig.launcher.launchedTransport()).toEqual({ kind: 'pipe', weaker: false });
    expect(await listeners(rig.pid)).toEqual([]);
    expect(portFile(rig)).toBe(false);
  });

  it('web content cannot open or navigate to chrome:// pages, so only the CDP methods need the allow-list', { timeout: CASE_TIMEOUT_MS }, async () => {
    const rig = await start();
    const c = await relayClient(rig);
    const created = await c.send('Target.createTarget', { url: `http://a.test:${port}/web` });
    const targetId = created.result?.targetId as string;
    const attached = await c.send('Target.attachToTarget', { targetId, flatten: true });
    const session = attached.result?.sessionId as string;
    const hrefOf = async () => ((await c.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, session)).result?.result as { value?: string } | undefined)?.value;
    await vi.waitFor(async () => expect(await hrefOf()).toBe(`http://a.test:${port}/web`), { timeout: 10_000 });
    for (const expression of [`location = ${JSON.stringify(INSPECT)}; 'set'`, `String(!!window.open(${JSON.stringify(INSPECT)}))`]) {
      await c.send('Runtime.evaluate', { expression, userGesture: true }, session);
      await deliberateSleep(1_000, 'a navigation the page asked for would have committed by now');
      expect(await hrefOf()).toBe(`http://a.test:${port}/web`);
    }
    const own = internal(rig);
    const all = (await own.send('Target.getTargets')) as { targetInfos: Array<{ url: string }> };
    expect(all.targetInfos.filter((t) => t.url.startsWith('chrome://inspect'))).toEqual([]);
    // Back through the client's own history: an entry it was shown goes, an id it wasn't shown does not.
    await c.send('Page.navigate', { url: `http://a.test:${port}/two` }, session);
    await vi.waitFor(async () => expect(await hrefOf()).toBe(`http://a.test:${port}/two`), { timeout: 10_000 });
    const history = (await c.send('Page.getNavigationHistory', {}, session)).result as { entries: Array<{ id: number; url: string }> };
    expect((await c.send('Page.navigateToHistoryEntry', { entryId: history.entries[0].id }, session)).error).toBeUndefined();
    await vi.waitFor(async () => {
      const here = await c.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, session);
      expect((here.result?.result as { value?: string } | undefined)?.value).toBe(`http://a.test:${port}/web`);
    }, { timeout: 10_000 });
    const unshown = Math.max(...history.entries.map((e) => e.id)) + 1000;
    expect((await c.send('Page.navigateToHistoryEntry', { entryId: unshown }, session)).error?.message).toContain('scheme not allowed on a protected profile');
    own.close();
    c.close();
  });

  it('a relay client cannot reach the remote-debugging toggle; turned on from main\'s own session (control), the watch closes the browser if a port opens', { timeout: CASE_TIMEOUT_MS * 2 }, async () => {
    // With windows, as wmux starts Chrome.
    const rig = await start({ headful: true });
    const c = await relayClient(rig);
    // Every way a relay client could open the page is refused.
    for (const url of [INSPECT, 'CHROME://inspect', ' chrome://inspect', 'chrome:inspect', 'view-source:chrome://inspect']) {
      expect((await c.send('Target.createTarget', { url })).error?.message, url).toContain('scheme not allowed on a protected profile');
    }
    const page = await c.send('Target.createTarget', { url: `http://a.test:${port}/p` });
    const pageSession = (await c.send('Target.attachToTarget', { targetId: page.result?.targetId, flatten: true })).result?.sessionId as string;
    expect((await c.send('Page.navigate', { url: INSPECT }, pageSession)).error?.message).toContain('scheme not allowed on a protected profile');

    // Main opens the page: the relay client neither sees it nor can attach.
    const own = internal(rig);
    const inspect = (await own.send('Target.createTarget', { url: INSPECT })) as { targetId: string };
    await vi.waitFor(async () => {
      const mine = (await own.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string; url: string }> };
      expect(mine.targetInfos.find((t) => t.targetId === inspect.targetId)?.url).toMatch(/^chrome:\/\/inspect/);
    }, { timeout: 10_000 });
    const listed = await c.send('Target.getTargets');
    expect((listed.result?.targetInfos as Array<{ targetId: string }>).map((t) => t.targetId)).not.toContain(inspect.targetId);
    expect((await c.send('Target.attachToTarget', { targetId: inspect.targetId, flatten: true })).error).toBeDefined();
    const relayPhase = await watchForPort(rig);
    expect(relayPhase).toEqual({ listeners: [], portFile: false });

    // Control: main's own session turns the toggle on with a trusted click.
    const session = ((await own.send('Target.attachToTarget', { targetId: inspect.targetId, flatten: true })) as { sessionId: string }).sessionId;
    const state = async () => {
      const r = (await own.send('Runtime.evaluate', { expression: TOGGLE_STATE, returnByValue: true }, session).catch(() => null)) as { result?: { value?: string } } | null;
      return r?.result?.value ?? 'gone';
    };
    // The page has drawn its checkbox (or never will: then the line says 'absent').
    await vi.waitFor(async () => expect(await state()).not.toBe('absent'), { timeout: 10_000 }).catch(() => undefined);
    const before = await state();
    // A control that never reached the checkbox proves nothing.
    expect(before, 'the remote-debugging checkbox on chrome://inspect').not.toMatch(/^(absent|gone)$/);
    expect((JSON.parse(before) as { checked: boolean }).checked).toBe(false);
    const { x, y } = JSON.parse(before) as { x: number; y: number };
    for (const type of ['mousePressed', 'mouseReleased']) await own.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, session).catch(() => undefined);
    await vi.waitFor(async () => expect(await state()).not.toBe(before), { timeout: 5_000 }).catch(() => undefined);
    const toggle = await state();
    // On, or the browser is already gone under it.
    if (toggle !== 'gone') expect((JSON.parse(toggle) as { checked: boolean }).checked).toBe(true);
    const control = await watchForPort(rig);
    const cause = closedFor(rig);
    const closedByWatch = cause !== null;
    const nextCall = await rig.launcher.endpoint().then(() => 'started again', (e: unknown) => (e instanceof Error ? e.message : String(e)));
    report(`[pipe-boundary control] ${process.platform} toggle=${toggle} listeners=${control.listeners.join(',') || 'none'} portFileSeenByTest=${control.portFile} closedByWatch=${closedByWatch} nextCall=${nextCall}`);
    // The end state: either no port ever opened, or the watch closed the browser under it and the next call said why.
    expect(control.listeners.length === 0 || closedByWatch, `a port opened (${control.listeners.join(',')}) and the browser was not closed`).toBe(true);
    if (control.portFile) expect(closedByWatch).toBe(true);
    if (closedByWatch) expect(nextCall).toContain('a debugging port opened in the protected browser');
    if (toggle === 'gone') expect(closedByWatch).toBe(true);
    own.close();
    c.close();
  });

  it('a user-opened chrome:// tab stays hidden while Playwright works on normal pages', { timeout: CASE_TIMEOUT_MS }, async () => {
    const rig = await start();
    const own = internal(rig);
    const ntp = (await own.send('Target.createTarget', { url: 'chrome://new-tab-page/' })) as { targetId: string };
    const { chromium } = await import('playwright-core');
    const grant = await rig.launcher.relayGrant({ workspaceId: 'ws-boundary' });
    const browser = await chromium.connectOverCDP(grant.endpoint, { headers: { ...grant.headers } });
    try {
      const p = await browser.contexts()[0].newPage();
      await p.goto(`http://a.test:${port}/normal`);
      expect(await p.content()).toContain('/normal');
      // A host the policy refuses: the fixture never serves it (the proxy answers
      // or the navigation fails), and the page stays attached and usable.
      const blocked = await p.goto(`http://b.test:${port}/blocked`).then((r) => `status ${r?.status() ?? 'none'}`, (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] : String(e)));
      const shown = await p.evaluate(() => location.href).catch((e: unknown) => `evaluate failed: ${e instanceof Error ? e.message : String(e)}`);
      report(`[pipe-boundary blocked-host] goto=${blocked} url=${shown}`);
      expect(await p.content()).not.toContain('/blocked</');
      await p.goto(`http://a.test:${port}/after`);
      expect(await p.content()).toContain('/after');
      const urls = browser.contexts().flatMap((ctx) => ctx.pages().map((pg) => pg.url()));
      expect(urls.some((u) => u.startsWith('chrome://'))).toBe(false);
      const s = await browser.newBrowserCDPSession();
      const { targetInfos } = (await s.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string }> };
      expect(targetInfos.map((t) => t.targetId)).not.toContain(ntp.targetId);
    } finally {
      await browser.close();
      own.close();
    }
  });

  it('a download in a CDP-created context no client made (a stand-in for a user-opened incognito window) is not let through, with windows', { timeout: CASE_TIMEOUT_MS }, async () => {
    // With windows: headless Chrome denies downloads in a new context on its own.
    const rig = await start({ headful: true });
    const own = internal(rig);
    // An off-the-record context made outside any client, so no client rule
    // denied it at creation; the guard's re-assert is what has to cover it.
    const { browserContextId } = (await own.send('Target.createBrowserContext')) as { browserContextId: string };
    const { targetId } = (await own.send('Target.createTarget', { url: `http://a.test:${port}/dl`, browserContextId })) as { targetId: string };
    const { sessionId } = (await own.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    await vi.waitFor(async () => {
      const r = (await own.send('Runtime.evaluate', { expression: "!!document.getElementById('d')", returnByValue: true }, sessionId)) as { result?: { value?: boolean } };
      expect(r.result?.value).toBe(true);
    }, { timeout: 10_000 });
    // What the guard's session saw of it.
    const states: string[] = [];
    const off = rig.launcher.consentDownloadGuard()?.onProgress((p) => { if (typeof p.state === 'string') states.push(p.state); });
    await own.send('Runtime.evaluate', { expression: "document.getElementById('d').click()", userGesture: true }, sessionId);
    await deliberateSleep(3_000, 'a download let through would have landed by now');
    off?.();
    const landed = [rig.profile.downloads, rig.profile.dir].flatMap((dir) => {
      const found: string[] = [];
      const walk = (d: string, depth: number) => {
        for (const n of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, n.name);
          if (n.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
          try { if (fs.statSync(p).size < 4096 && fs.readFileSync(p, 'utf8') === PAYLOAD) found.push(p); } catch { /* unreadable */ }
        }
      };
      walk(dir, 0);
      return found;
    });
    report(`[pipe-boundary cdp-context-download] progress=${states.join('>') || 'none'} files=${landed.map((p) => path.basename(p)).join(',') || 'none'}`);
    expect(states).not.toContain('completed');
    expect(landed.map((p) => path.relative(rig.profile.dir, p))).toEqual([]);
    own.close();
  });

  it('a protection that turns on while an unprotected launch is in flight ends on the pipe with no port file', { timeout: CASE_TIMEOUT_MS }, async () => {
    const profile = tempChromeProfile('wmux-pipe-reconcile-');
    vi.stubEnv('WMUX_CHROME_TRANSPORT', 'auto');
    vi.stubEnv('WMUX_CHROME_PATH', CHROME as string);
    let protectedNow = false;
    const launcher = new ChromeLauncher(profile.dir, {
      portEnvVar: null,
      profileName: 'pipe-reconcile',
      protection: () => (protectedNow ? plan() : null),
      extraArgs: ['--headless=new', '--use-mock-keychain', '--password-store=basic'],
    });
    rigs.push({ launcher, profile });
    const first = launcher.endpoint();
    // The first launch has chosen the port before protection turns on.
    await vi.waitFor(() => expect((launcher as unknown as { transport: { kind: string } | null }).transport?.kind).toBe('port'), { timeout: 10_000, interval: 5 });
    protectedNow = true;
    await launcher.reconcileProtection();
    const ep = await first.catch(() => launcher.endpoint());
    expect(ep.piped).toBe(true);
    expect(launcher.launchedTransport()).toEqual({ kind: 'pipe', weaker: false });
    expect(fs.existsSync(path.join(profile.dir, 'DevToolsActivePort'))).toBe(false);
  });

  it('a profile whose Local State has remote debugging turned on starts protected with it off', { timeout: CASE_TIMEOUT_MS }, async () => {
    const first = await start();
    await stopChrome(first.launcher);
    // As Chrome stores the chrome://inspect setting once it was turned on.
    const file = path.join(first.profile.dir, 'Local State');
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { devtools?: Record<string, unknown> };
    state.devtools = { ...(state.devtools ?? {}), remote_debugging: { 'user-enabled': true } };
    fs.writeFileSync(file, JSON.stringify(state));
    const again = await start({ profile: first.profile });
    const own = internal(again);
    const { targetId } = (await own.send('Target.createTarget', { url: INSPECT })) as { targetId: string };
    const { sessionId } = (await own.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    let toggle = 'absent';
    await vi.waitFor(async () => {
      const r = (await own.send('Runtime.evaluate', { expression: TOGGLE_STATE, returnByValue: true }, sessionId)) as { result?: { value?: string } };
      toggle = r.result?.value ?? 'absent';
      expect(toggle).not.toBe('absent');
    }, { timeout: 10_000 });
    expect((JSON.parse(toggle) as { checked: boolean }).checked).toBe(false);
    expect(await listeners(again.pid)).toEqual([]);
    own.close();
  });
});

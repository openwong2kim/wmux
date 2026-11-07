import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { ChromeLauncher, type ChromeProtectionPlan } from '../ChromeLauncher';
import { openDownloadPass } from '../dangerousActionConsent';
import { compileHostPolicy } from '../../../shared/browserHostPolicy';

// ---------------------------------------------------------------------------
// One protected profile, the same rows on the DevTools port and on the
// debugging pipe, against a real Chrome launched by the production
// ChromeLauncher behind the production proxy, with real Playwright clients.
// A row holds when the protection holds. Every pipe row is asserted, and so
// are the port rows that hold there too (PORT_ROWS); the others run on the
// port only when the table is asked for, and are recorded, not asserted.
//
// SKIPPED unless CHROME_PATH names a Chrome. Every profile is a fresh temp
// dir and every page is served by the local fixture server. To run it:
//
//   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     npx vitest run -c vitest.runtime.config.ts src/main/browser-session/__tests__/ProtectedTransport.chrome.runtime.test.ts
//
// PROTECTED_TABLE_OUT=<file> runs every row on both and writes the table as
// JSON (scripts/probe-protected-transport.mjs runs it and prints the table).
// ---------------------------------------------------------------------------

const CHROME = process.env.CHROME_PATH;
const TABLE_OUT = process.env.PROTECTED_TABLE_OUT;
/** The rows that hold on the port as well; only these are run and asserted there by default. */
const PORT_ROWS = new Set(['a', 'b', 'd']);
/** How many contexts row j creates, each with a download started as soon as it exists. */
const NEW_CONTEXT_ROUNDS = 20;
const CASE_TIMEOUT_MS = 60_000;
const PAYLOAD = 'PAYLOAD-PROTECTED-TABLE';
const hits: string[] = [];
let server: http.Server;
let port = 0;

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  // A request the fixture gets as a proxy (absolute URL) went through a proxy other than main's.
  hits.push(`${req.url?.startsWith('http') ? 'proxied ' : ''}${host} ${req.url}`);
  const html = (b: string) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body>${b}</body></html>`);
  };
  if (req.url?.endsWith('/download')) return html('<a id="d" href="/file.bin">file</a>');
  // Starts its download as it loads.
  if (req.url?.includes('/download-now')) return html('<a id="d" href="/file.bin">file</a><script>document.getElementById("d").click()</script>');
  if (req.url?.endsWith('/slow-download')) return html('<a id="d" href="/slow.bin">file</a>');
  if (req.url?.endsWith('/file.bin')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"' });
    return void res.end(PAYLOAD);
  }
  if (req.url?.endsWith('/slow.bin')) {
    // Streams for ~2 s, so a cancel has time to land.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="slow.bin"' });
    let n = 0;
    const tick = setInterval(() => {
      res.write(`${PAYLOAD}\n`);
      if (++n >= 20) { clearInterval(tick); res.end(); }
    }, 100);
    return;
  }
  return html(`${host}${req.url}`);
}

/** Every file under `dir` (a few levels down) that holds the payload. */
function payloadFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
      try { if (st.size < 4096 && fs.readFileSync(p, 'utf8').includes(PAYLOAD)) found.push(p); } catch { /* unreadable */ }
    }
  };
  walk(dir, 0);
  return found;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Transport = 'port' | 'pipe';
interface Row { id: string; what: string; port?: boolean; pipe?: boolean; note?: Partial<Record<Transport, string>> }
const ROWS: Row[] = [
  { id: 'a', what: "a client's allow does not let a download through" },
  { id: 'b', what: 'a download right after a client that set allow detaches is still stopped' },
  { id: 'c', what: 'a consent-approved download completes, with a second client attaching and leaving' },
  { id: 'd', what: 'the guard still stops a download after a second client attached and left' },
  { id: 'e', what: 'a context created with its own proxy does not reach a blocked host' },
  { id: 'f', what: 'a download in a client-created context is denied' },
  { id: 'g', what: 'Page.setDownloadBehavior allow does not let a download through' },
  { id: 'h', what: "a client's Browser.cancelDownload does not cancel an approved download" },
  { id: 'i', what: "a client's Browser.close does not end the shared Chrome" },
  { id: 'j', what: `a client's new context is denied downloads before the client hears of it (${NEW_CONTEXT_ROUNDS} contexts)` },
];
const row = (id: string) => ROWS.find((r) => r.id === id) as Row;

/** `dir`: the profile; `allowDir`: where a client asks downloads to go; `downloads`: the profile's own download folder (a temp dir). */
interface Rig { transport: Transport; launcher: ChromeLauncher; dir: string; allowDir: string; downloads: string; skip: string | null }

function plan(): ChromeProtectionPlan {
  return {
    matcher: () => compileHostPolicy({ mode: 'allowlist', allow: ['a.test'], block: [] }),
    resolve: (_host, p) => ({ host: '127.0.0.1', port: p }),
  };
}

async function makeRig(transport: Transport): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wmux-protected-${transport}-`));
  // Where a download goes when nothing set a path. Chrome on macOS resolves the
  // default Downloads folder from the account, not HOME, so the profile names a
  // temp one: no row ever writes outside the temp dirs.
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), `wmux-protected-${transport}-downloads-`));
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  vi.stubEnv('WMUX_CHROME_TRANSPORT', transport === 'pipe' ? 'pipe' : '');
  vi.stubEnv('WMUX_CHROME_PATH', CHROME as string);
  const launcher = new ChromeLauncher(dir, {
    portEnvVar: null,
    profileName: `protected-table-${transport}`,
    protection: () => plan(),
    // Headless Chrome denies downloads in a new context by default, which hides
    // what row j checks; PROTECTED_HEADFUL=1 runs with windows, as wmux does.
    extraArgs: [...(process.env.PROTECTED_HEADFUL === '1' ? [] : ['--headless=new']), '--use-mock-keychain', '--password-store=basic'],
  });
  const allowDir = fs.mkdtempSync(path.join(os.tmpdir(), `wmux-protected-${transport}-allow-`));
  const rig: Rig = { transport, launcher, dir, allowDir, downloads, skip: null };
  try {
    await launcher.endpoint();
  } catch (err) {
    rig.skip = `the protected profile did not start: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
  }
  return rig;
}

async function connect(rig: Rig): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  const ep = await rig.launcher.endpoint();
  return chromium.connectOverCDP(ep.wsEndpoint ?? `http://127.0.0.1:${ep.cdpPort}`);
}

/**
 * Click the page's download link. `through` when a download COMPLETED:
 * Playwright saw it finish, or the payload landed on disk.
 */
async function clickDownload(rig: Rig, p: Page): Promise<{ through: boolean; note: string }> {
  // Not the profile dir: its HTTP cache holds the response body too.
  const dirs = [rig.allowDir, rig.downloads];
  const before = new Set(dirs.flatMap(payloadFiles));
  const started = p.waitForEvent('download', { timeout: 4_000 }).catch(() => null);
  await p.click('#d');
  const download = await started;
  const failure = download ? await download.failure() : 'no download event';
  await settle(1_500);
  const landed = dirs.flatMap(payloadFiles).filter((f) => !before.has(f));
  const where = landed.map((f) => (f.startsWith(rig.allowDir) ? 'client download dir' : 'profile download dir')).join(',');
  return { through: failure === null || landed.length > 0, note: `playwright: ${failure ?? 'completed'}; files: ${landed.length}${where ? ` (${where})` : ''}` };
}

async function freshPage(browser: Browser, url: string): Promise<Page> {
  const p = await browser.contexts()[0].newPage();
  await p.goto(url);
  return p;
}

async function targetIdOf(p: Page): Promise<string> {
  const s = await p.context().newCDPSession(p);
  try {
    const { targetInfo } = (await s.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
    return targetInfo.targetId;
  } finally {
    await s.detach().catch(() => undefined);
  }
}

async function consentPass(rig: Rig, p: Page) {
  const guard = rig.launcher.consentDownloadGuard();
  if (!guard) throw new Error('no download guard');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-consent-'));
  const pass = await openDownloadPass(guard, {
    frameId: await targetIdOf(p),
    approvedHost: 'a.test',
    hostOf: (u) => { try { return new URL(u).hostname; } catch { return null; } },
    dir,
    startTimeoutMs: 8_000,
    finishTimeoutMs: 15_000,
    join: (d, n) => path.join(d, n),
  });
  return { pass, dir };
}

beforeAll(async () => {
  server = http.createServer(serve);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server?.close();
  if (TABLE_OUT) fs.writeFileSync(TABLE_OUT, JSON.stringify({ chrome: CHROME, platform: `${process.platform}-${process.arch}`, rows: ROWS }, null, 2));
});

describe.skipIf(!CHROME).each<Transport>(['port', 'pipe'])('a protected profile on the %s', (transport) => {
  let rig: Rig;
  /** Record the row for this transport; asserted on the pipe, and on the port for PORT_ROWS. */
  const record = (id: string, holds: boolean, note?: string) => {
    const r = row(id);
    r[transport] = holds;
    if (note) r.note = { ...r.note, [transport]: note };
    if (transport === 'pipe' || PORT_ROWS.has(id)) expect(holds, `row ${id} on the ${transport}: ${r.what}; ${note ?? ''}`).toBe(true);
  };

  beforeAll(async () => {
    rig = await makeRig(transport);
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rig?.launcher.dispose();
    for (const d of [rig?.dir, rig?.allowDir, rig?.downloads]) if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  const live = (ctx: { skip: (note?: string) => void; task: { name: string } }) => {
    if (transport === 'port' && !TABLE_OUT && !PORT_ROWS.has(ctx.task.name.charAt(0))) ctx.skip('run on the port for the table only');
    if (rig.skip && transport === 'pipe') throw new Error(rig.skip);
    if (rig.skip) ctx.skip(rig.skip);
  };

  it('a: a client\'s allow does not let a download through', { timeout: CASE_TIMEOUT_MS }, async (ctx) => {
    live(ctx);
    const browser = await connect(rig);
    const other = await browser.newBrowserCDPSession();
    await other.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: rig.allowDir, eventsEnabled: true });
    const p = await freshPage(browser, `http://a.test:${port}/download`);
    const r = await clickDownload(rig, p);
    record('a', !r.through, r.note);
    await browser.close();
  });

  it('b: right after a client that set allow detaches, a download is still stopped', { timeout: CASE_TIMEOUT_MS }, async (ctx) => {
    live(ctx);
    const browser = await connect(rig);
    const p = await freshPage(browser, `http://a.test:${port}/download`);
    const setter = await connect(rig);
    const s = await setter.newBrowserCDPSession();
    await s.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: rig.allowDir, eventsEnabled: true });
    await setter.close();
    // At once: no time for the guard's next re-assert.
    const r = await clickDownload(rig, p);
    record('b', !r.through, r.note);
    await browser.close();
  });

  it('c: a consent-approved download completes, with a second client attaching and leaving', { timeout: CASE_TIMEOUT_MS }, async (ctx) => {
    live(ctx);
    const browser = await connect(rig);
    const p = await freshPage(browser, `http://a.test:${port}/download`);
    const { pass, dir } = await consentPass(rig, p);
    const second = await connect(rig);
    await second.close();
    await p.click('#d');
    const done = await pass.done.then((d) => d, (err: Error) => ({ error: err.message }));
    const ok = 'path' in done && fs.existsSync(done.path) && fs.readFileSync(done.path, 'utf8').includes(PAYLOAD);
    record('c', ok, ok ? undefined : JSON.stringify(done));
    fs.rmSync(dir, { recursive: true, force: true });
    await browser.close();
  });

  it('d: the guard still stops a download after a second client attached and left', { timeout: CASE_TIMEOUT_MS }, async (ctx) => {
    live(ctx);
    const browser = await connect(rig);
    const p = await freshPage(browser, `http://a.test:${port}/download`);
    const second = await connect(rig);
    await second.close();
    await settle(600);
    const r = await clickDownload(rig, p);
    record('d', !r.through, r.note);
    await browser.close();
  });

  it('e: a context created with its own proxy does not reach a blocked host', { timeout: CASE_TIMEOUT_MS }, async (ctx) => {
    live(ctx);
    const browser = await connect(rig);
    const before = hits.length;
    let refused = false;
    try {
      const own = await browser.newContext({ proxy: { server: `http://127.0.0.1:${port}` } });
      const p = await own.newPage();
      await p.goto(`http://blocked.test:${port}/own-proxy`).catch(() => undefined);
      await own.close();
    } catch {
      refused = true;
    }
    const reached = hits.slice(before).filter((h) => h.includes('/own-proxy'));
    record('e', reached.length === 0, refused ? 'refused' : `requests seen: ${reached.length}`);
    await browser.close();
  });

  it('f: a download in a client-created context is denied', { timeout: CASE_TIMEOUT_MS }, async (ctx) => {
    live(ctx);
    const browser = await connect(rig);
    const own = await browser.newContext({ acceptDownloads: true });
    const p = await own.newPage();
    await p.goto(`http://a.test:${port}/download`);
    const r = await clickDownload(rig, p);
    record('f', !r.through, r.note);
    await own.close();
    await browser.close();
  });

  it('g: Page.setDownloadBehavior allow does not let a download through', { timeout: CASE_TIMEOUT_MS }, async (ctx) => {
    live(ctx);
    const browser = await connect(rig);
    const p = await freshPage(browser, `http://a.test:${port}/download`);
    const s = await p.context().newCDPSession(p);
    let note: string | undefined;
    await s.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: rig.allowDir }).catch((err: Error) => { note = `refused: ${err.message}`; });
    const r = await clickDownload(rig, p);
    record('g', !r.through, `${note ? `${note}; ` : ''}${r.note}`);
    await browser.close();
  });

  it('h: a client\'s Browser.cancelDownload does not cancel an approved download', { timeout: CASE_TIMEOUT_MS }, async (ctx) => {
    live(ctx);
    const browser = await connect(rig);
    const p = await freshPage(browser, `http://a.test:${port}/slow-download`);
    const { pass, dir } = await consentPass(rig, p);
    // A client that learns the download's guid and tries to cancel it.
    const spy = await browser.newBrowserCDPSession();
    const guids: string[] = [];
    spy.on('Browser.downloadWillBegin', (e: { guid: string }) => { guids.push(e.guid); });
    await spy.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: rig.allowDir, eventsEnabled: true }).catch(() => undefined);
    await p.click('#d');
    await vi.waitFor(() => expect(guids.length).toBeGreaterThan(0), { timeout: 8_000 }).catch(() => undefined);
    for (const guid of guids) await spy.send('Browser.cancelDownload', { guid }).catch(() => undefined);
    const done = await pass.done.then((d) => d, (err: Error) => ({ error: err.message }));
    const ok = 'path' in done && fs.existsSync(done.path);
    record('h', ok, `${guids.length ? 'guid seen' : 'no guid seen'}; ${ok ? 'completed' : JSON.stringify(done)}`);
    fs.rmSync(dir, { recursive: true, force: true });
    await browser.close();
  });

  it('j: a client\'s new context is denied downloads before the client hears of it, every time', { timeout: CASE_TIMEOUT_MS }, async (ctx) => {
    live(ctx);
    // Every deny the download guard's session has had answered, by context.
    // Read from the guard itself: Chrome has no call that reports a context's
    // download behaviour, and a download needs a new renderer, which takes
    // longer than the guard's re-assert tick, so its outcome can't show the order.
    const guard = (rig.launcher as unknown as { downloadGuard: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> } | null }).downloadGuard;
    if (!guard) throw new Error('no download guard');
    const denied = new Set<string>();
    const send = guard.send.bind(guard);
    guard.send = async (method, params = {}) => {
      const result = await send(method, params);
      if (method === 'Browser.setDownloadBehavior' && params.behavior === 'deny' && typeof params.browserContextId === 'string') denied.add(params.browserContextId);
      return result;
    };
    const browser = await connect(rig);
    const s = await browser.newBrowserCDPSession();
    const dirs = [rig.allowDir, rig.downloads];
    const before = new Set(dirs.flatMap(payloadFiles));
    const contexts: string[] = [];
    let deniedFirst = 0;
    try {
      for (let n = 0; n < NEW_CONTEXT_ROUNDS; n++) {
        const { browserContextId } = (await s.send('Target.createBrowserContext')) as { browserContextId: string };
        if (denied.has(browserContextId)) deniedFirst++;
        contexts.push(browserContextId);
        // In the same turn as the reply: the client's allow for its context, then a page that starts a download as it loads.
        void s.send('Browser.setDownloadBehavior', { behavior: 'allow', browserContextId, downloadPath: rig.allowDir }).catch(() => undefined);
        await s.send('Target.createTarget', { url: `http://a.test:${port}/download-now?round=${n}`, browserContextId });
      }
      await settle(2_000);
    } finally {
      guard.send = send;
    }
    const landed = dirs.flatMap(payloadFiles).filter((f) => !before.has(f));
    record('j', deniedFirst === NEW_CONTEXT_ROUNDS && landed.length === 0,
      `denied before the reply: ${deniedFirst}/${NEW_CONTEXT_ROUNDS}; completed: ${landed.length}/${NEW_CONTEXT_ROUNDS}`);
    for (const browserContextId of contexts) await s.send('Target.disposeBrowserContext', { browserContextId }).catch(() => undefined);
    await browser.close();
  });

  // Last: on the port it ends Chrome.
  it('i: a client\'s Browser.close does not end the shared Chrome', { timeout: CASE_TIMEOUT_MS }, async (ctx) => {
    live(ctx);
    const browser = await connect(rig);
    const s = await browser.newBrowserCDPSession();
    let note = 'sent';
    await s.send('Browser.close').catch((err: Error) => { note = `refused: ${err.message}`; });
    await settle(2_000);
    const alive = rig.launcher.isRunning() && (await rig.launcher.listTargets().then(() => true, () => false));
    record('i', alive, note);
    await browser.close().catch(() => undefined);
  });
});

// A real Chrome on a debugging pipe, driven through the multiplexer and its
// loopback endpoint by real Playwright clients.
//
// Chrome: CHROME_PATH, else what wmux's launcher would start
// (chromeForRuntimeSuite). Without one it skips locally, and fails on a CI
// runner that must run the real-Chrome suites. To run it:
//
//   npx vitest run -c vitest.runtime.config.ts src/main/browser-session/__tests__/CdpPipeMux.chrome.runtime.test.ts
//
// A temporary profile, headless, and data: pages only; nothing is fetched.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import WebSocket, { WebSocketServer } from 'ws';
import { CdpPipeMux, type CallerIdentity } from '../CdpPipeMux';
import { CdpPipeRelay, type RelayGrant, type RelayRoute } from '../CdpPipeRelay';
import { ChromeLauncher, setPipeRelayForTests } from '../ChromeLauncher';
import { DownloadRelayPolicy, removeDownloadRelayDir } from '../DownloadRelayPolicy';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { chromeForRuntimeSuite } from '../../../test-utils/runtimeChrome';
import { CHROME_TEARDOWN_TIMEOUT_MS, stopChrome, tempChromeProfile, type TempChromeProfile } from '../../../test-utils/chromeProfile';
import { newRelayProofNonce, RELAY_PROOF_METHOD, relayProofMatches } from '../../../shared/relayProof';

const CHROME = chromeForRuntimeSuite();

interface Started { child: ChildProcess; profile: string; mux: CdpPipeMux; route: RelayRoute; exited: Promise<void> }
const started: Started[] = [];
const browsers: Browser[] = [];
const relays: WebSocketServer[] = [];
/** Every temp profile a test made, removed after its Chrome is gone, launched or not. */
const profiles: TempChromeProfile[] = [];
/**
 * The relay, on a temp root of this file's own (a Unix socket where the OS has
 * them), so nothing here looks in a temp dir another wmux uses.
 */
let relayRoot: string | null = null;
let relay: CdpPipeRelay;

beforeAll(async () => {
  relayRoot = process.platform === 'win32' ? null : fs.mkdtempSync('/tmp/wmux-rr-');
  if (relayRoot) fs.chmodSync(relayRoot, 0o700);
  relay = new CdpPipeRelay({ roots: relayRoot ? [relayRoot] : [] });
  await setPipeRelayForTests(relay);
});

afterAll(async () => {
  await setPipeRelayForTests(null);
  if (relayRoot) fs.rmSync(relayRoot, { recursive: true, force: true });
});

/** Playwright over the relay, with a token minted for `identity`. */
function connectThrough(grant: RelayGrant, timeout?: number): Promise<Browser> {
  return chromium.connectOverCDP(grant.endpoint, { headers: { ...grant.headers }, ...(timeout !== undefined && { timeout }) });
}

/** Whether the relay behind `browser` answers Wmux.relayProof with `grant`'s key. */
async function provenBy(browser: Browser, grant: RelayGrant): Promise<boolean> {
  const session = await browser.newBrowserCDPSession();
  try {
    const nonce = newRelayProofNonce();
    const send = session.send.bind(session) as (method: string, params: object) => Promise<{ proof?: unknown }>;
    const answer = await send(RELAY_PROOF_METHOD, { nonce });
    return relayProofMatches(Buffer.from(grant.proofKey, 'base64url'), Buffer.from(nonce, 'base64url'), answer.proof);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

const connectTo = async (s: Started, identity: CallerIdentity = {}) => connectThrough(await s.route.grant(identity));

/** Grants (C3b): main's registry for one Chrome, filled by the test. */
type Registry = Map<string, { workspaceId?: string }>;

/** With grants: main's download relay for the default context, as the launcher arms it. */
interface Relay { policy: DownloadRelayPolicy; dir: string; userDir: string }
const relaysMade: Relay[] = [];

async function startChrome(registry?: Registry, withRelay?: { relay?: Relay }): Promise<Started> {
  const temp = tempChromeProfile('wmux-pipe-chrome-');
  profiles.push(temp);
  const profile = temp.dir;
  const child = spawn(CHROME as string, [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    // The test HOME is an empty temp dir (isolateDataDir.ts): without this,
    // macOS Chrome waits on a login keychain that is not there, and neither
    // answers cookie calls nor exits.
    '--use-mock-keychain',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let made: CdpPipeMux | null = null;
  let dl: Relay | undefined;
  let dlSession: ReturnType<CdpPipeMux['connect']> | null = null;
  if (withRelay) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-dl-rt-'));
    // The user's download folder, as the launcher has it from Electron: a fresh one per run.
    const userDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-dl-user-')), 'Downloads');
    fs.mkdirSync(userDir);
    const policy = new DownloadRelayPolicy({
      dir,
      userDir: () => userDir,
      contextOf: (client, frameId) => made?.contextOfFrame(client, frameId),
      created: (client, contextId) => made?.createdContext(client, contextId) ?? false,
      contextOfSession: (client, sessionId) => made?.contextOfSession(client, sessionId),
      emit: (client, method, params, sessionId) => made?.emitEvent(client, method, params, sessionId) ?? false,
      cancel: (guid) => dlSession?.send('Browser.cancelDownload', { guid }) ?? Promise.resolve(),
    });
    dl = { policy, dir, userDir };
    relaysMade.push(dl);
    withRelay.relay = dl;
  }
  const mux = new CdpPipeMux(child.stdio[3] as Writable, child.stdio[4] as Readable, {
    ...(registry && { grants: { registry: (id: string) => registry.get(id) ?? null } }),
    ...(dl && { filter: dl.policy.filter, onClientGone: (client: import('../CdpPipeMux').ClientRef) => dl?.policy.forget(client) }),
  });
  made = mux;
  if (dl) {
    const session = mux.connect({ label: 'download relay' });
    dlSession = session;
    session.on('Browser.downloadWillBegin', (p) => dl?.policy.downloadEvent('Browser.downloadWillBegin', p));
    session.on('Browser.downloadProgress', (p) => dl?.policy.downloadEvent('Browser.downloadProgress', p));
    await session.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dl.dir, eventsEnabled: true });
  }
  const s = { child, profile, mux, route: relay.serve(mux), exited };
  started.push(s);
  return s;
}

/**
 * A loopback proxy in front of the relay that records every frame one client
 * receives, so a test can see exactly what reached it. Each connection it
 * passes on uses a token of its own from `grant`.
 */
async function recordingRelay(grant: () => Promise<RelayGrant>): Promise<{ url: string; received: Array<Record<string, unknown>> }> {
  const received: Array<Record<string, unknown>> = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  relays.push(wss);
  wss.on('connection', async (down) => {
    const queued: string[] = [];
    let up: WebSocket | null = null;
    down.on('message', (data) => {
      const text = data.toString();
      if (up?.readyState === WebSocket.OPEN) up.send(text);
      else queued.push(text);
    });
    const g = await grant();
    const upstream = new WebSocket(g.endpoint, { headers: { ...g.headers } });
    up = upstream;
    upstream.on('open', () => { for (const m of queued.splice(0)) upstream.send(m); });
    upstream.on('message', (data) => {
      const text = data.toString();
      received.push(JSON.parse(text) as Record<string, unknown>);
      down.send(text);
    });
    down.on('close', () => upstream.close());
    upstream.on('close', () => down.close());
  });
  await once(wss, 'listening');
  const { port } = wss.address() as { port: number };
  return { url: `ws://127.0.0.1:${port}/devtools/browser/relay`, received };
}

/** The session ids a client was given (attach replies, attachedToTarget), and every session id it received. */
function sessionsOf(frames: Array<Record<string, unknown>>): { given: Set<string>; seen: Set<string> } {
  const given = new Set<string>();
  const seen = new Set<string>();
  for (const f of frames) {
    const result = f.result as { sessionId?: unknown } | undefined;
    if (typeof result?.sessionId === 'string') given.add(result.sessionId);
    const params = f.params as { sessionId?: unknown } | undefined;
    if (f.method === 'Target.attachedToTarget' && typeof params?.sessionId === 'string') given.add(params.sessionId);
    if (typeof f.sessionId === 'string') seen.add(f.sessionId);
  }
  return { given, seen };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const b of browsers.splice(0)) await b.close().catch(() => undefined);
  for (const r of relays.splice(0)) r.close();
  for (const s of started.splice(0)) {
    s.route.close();
    s.mux.close();
    const gone = await Promise.race([s.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5_000))]);
    if (!gone) {
      s.child.kill('SIGKILL');
      await s.exited;
    }
  }
  await Promise.all(profiles.splice(0).map((p) => p.remove()));
}, CHROME_TEARDOWN_TIMEOUT_MS);

describe.skipIf(!CHROME)('a real Chrome on a debugging pipe', () => {
  it('Playwright connects over CDP through the relay, which proves itself, and drives a page', async () => {
    const grant = await (await startChrome()).route.grant({ workspaceId: 'ws-a' });
    const browser = await connectThrough(grant);
    browsers.push(browser);
    expect(await provenBy(browser, grant)).toBe(true);
    const page = await browser.contexts()[0].newPage();
    await page.goto('data:text/html,<title>pipe</title><p id=x>one</p>');
    expect(await page.title()).toBe('pipe');
    expect(await page.evaluate(() => document.getElementById('x')?.textContent)).toBe('one');
  }, 60_000);

  it('two Playwright clients at once, for two workspaces on one profile: targets stay visible to both, sessions stay private to each', async () => {
    const s = await startChrome();
    const relayA = await recordingRelay(() => s.route.grant({ workspaceId: 'ws-a', profile: 'shared' }));
    const relayB = await recordingRelay(() => s.route.grant({ workspaceId: 'ws-b', profile: 'shared' }));
    const a = await chromium.connectOverCDP(relayA.url);
    const b = await chromium.connectOverCDP(relayB.url);
    browsers.push(a, b);
    const [pageA, pageB] = await Promise.all([a.contexts()[0].newPage(), b.contexts()[0].newPage()]);
    await Promise.all([
      pageA.goto('data:text/html,<title>A</title>'),
      pageB.goto('data:text/html,<title>B</title>'),
    ]);
    // Each drives its own page, concurrently.
    const [titleA, titleB] = await Promise.all([pageA.evaluate(() => document.title), pageB.evaluate(() => document.title)]);
    expect([titleA, titleB]).toEqual(['A', 'B']);

    // Targets stay visible: each client lists the other's page, as on the port,
    // whatever workspace each connected for. Nothing narrows this per client yet.
    const cdpA = await a.newBrowserCDPSession();
    const { targetInfos } = (await cdpA.send('Target.getTargets')) as { targetInfos: Array<{ title: string; type: string }> };
    expect(targetInfos.filter((t) => t.type === 'page').map((t) => t.title)).toEqual(expect.arrayContaining(['A', 'B']));

    // Sessions stay private: a client receives frames only for sessions it was given, and no session is given to both.
    const sa = sessionsOf(relayA.received);
    const sb = sessionsOf(relayB.received);
    expect(sa.given.size).toBeGreaterThan(0);
    expect(sb.given.size).toBeGreaterThan(0);
    expect([...sa.seen].filter((s) => !sa.given.has(s))).toEqual([]);
    expect([...sb.seen].filter((s) => !sb.given.has(s))).toEqual([]);
    expect([...sa.given].filter((s) => sb.given.has(s))).toEqual([]);

    // One client leaving leaves the other working.
    await a.close();
    expect(await pageB.evaluate(() => document.title)).toBe('B');
    expect(await b.contexts()[0].pages().length).toBeGreaterThan(0);
  }, 60_000);

  it('the MCP bundle\'s Playwright, as build-mcp.js builds it, drives a page through the relay; a wrong token is refused', async () => {
    const require = createRequire(__filename);
    const { buildPlaywrightChunk } = require('../../../../scripts/lib/playwright-chunk.cjs') as { buildPlaywrightChunk: (dir: string) => Promise<string> };
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pw-chunk-'));
    try {
      const bundled = require(await buildPlaywrightChunk(out)) as typeof import('playwright-core');
      const s = await startChrome();
      const grant = await s.route.grant({ workspaceId: 'ws-a' });
      // A Unix socket wherever the OS has them, a named pipe on Windows: the
      // path the MCP lane takes. The bundle's own ws dials the pipe spelling.
      if (process.platform === 'win32') expect(grant.endpoint.startsWith('ws+unix:\\\\.\\pipe\\')).toBe(true);
      else expect(grant.endpoint.startsWith('ws+unix://')).toBe(true);
      const browser = await bundled.chromium.connectOverCDP(grant.endpoint, { headers: { ...grant.headers } });
      browsers.push(browser as unknown as Browser);
      expect(await provenBy(browser as unknown as Browser, grant)).toBe(true);
      const page = await browser.contexts()[0].newPage();
      await page.goto('data:text/html,<title>bundled</title>');
      expect(await page.title()).toBe('bundled');
      await expect(bundled.chromium.connectOverCDP(grant.endpoint, { headers: { Authorization: 'Bearer forged' }, timeout: 5_000 })).rejects.toThrow(/401/);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('Chrome exits on the pipe closing, with no process or lock file left', async () => {
    const s = await startChrome();
    // A live browser first: the pipe answers.
    const browser = await connectTo(s);
    browsers.push(browser);
    expect(browser.version()).toMatch(/\d+\./);
    const started = Date.now();
    s.mux.close();
    const gone = await Promise.race([s.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5_000))]);
    expect(gone).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Singleton* on macOS and Linux, lockfile on Windows.
    expect(fs.readdirSync(s.profile).filter((f) => /^(Singleton|lockfile$)/.test(f))).toEqual([]);
  }, 60_000);

  // SIGSTOP: the browser process stops reading the pipe, and SIGTERM stays
  // pending; only SIGKILL ends it. No SIGSTOP on Windows.
  it.skipIf(process.platform === 'win32')('a pipe Chrome that stops (SIGSTOP) is let go at the third failed check, killed, and a new one starts on its profile', async () => {
    vi.stubEnv('WMUX_CHROME_TRANSPORT', 'pipe');
    vi.stubEnv('WMUX_CHROME_PATH', CHROME as string);
    const temp = tempChromeProfile('wmux-pipe-stopped-');
    profiles.push(temp);
    const dir = temp.dir;
    const launcher = new ChromeLauncher(dir, { portEnvVar: null, extraArgs: ['--headless=new', '--use-mock-keychain', '--password-store=basic'] });
    try {
      await launcher.endpoint();
      const before = await connectThrough(await launcher.relayGrant({}));
      // Minted for this Chrome; never used.
      const stale = await launcher.relayGrant({});
      await before.contexts()[0].addCookies([{ name: 'kept', value: '1', domain: 'probe.invalid', path: '/', expires: Math.floor(Date.now() / 1000) + 86_400 }]);
      await before.close();
      const pid = (launcher as unknown as { child: ChildProcess }).child.pid as number;
      process.kill(pid, 'SIGSTOP');
      const stoppedAt = Date.now();
      await expect(launcher.endpoint()).rejects.toThrow('ChromeLauncher: Chrome is not answering');
      await expect(launcher.endpoint()).rejects.toThrow('ChromeLauncher: Chrome is not answering');
      await launcher.endpoint();
      const tookMs = Date.now() - stoppedAt;
      expect(() => process.kill(pid, 0)).toThrow();
      // A token minted for the stopped Chrome does not reach the new one.
      await expect(connectThrough(stale, 5_000)).rejects.toThrow(/401/);
      const after = await connectThrough(await launcher.relayGrant({}));
      browsers.push(after);
      const cookieKept = (await after.contexts()[0].cookies('https://probe.invalid/')).some((c) => c.name === 'kept');
      // Measured, not asserted: a SIGKILL loses cookie writes Chrome had not flushed yet.
      console.log(JSON.stringify({ stoppedToNewStartMs: tookMs, cookieKept }));
      expect(tookMs).toBeLessThan(45_000);
    } finally {
      // Graceful: Chrome is gone, and done writing, before its profile is removed.
      for (const b of browsers.splice(0)) await b.close().catch(() => undefined);
      await stopChrome(launcher);
    }
  }, 120_000);
});

describe.skipIf(!CHROME)('a real Chrome on a debugging pipe, with grants (C3b)', () => {
  /** A page main opens and files under `workspaceId`, as the launcher does, then tells the pipe. */
  async function mainOpens(s: Started, registry: Registry, workspaceId: string, url = 'about:blank'): Promise<string> {
    const main = s.mux.connect({ label: 'main' });
    const { targetId } = (await main.send('Target.createTarget', { url })) as { targetId: string };
    registry.set(targetId, { workspaceId });
    s.mux.regrant();
    return targetId;
  }
  const targetIdOf = async (page: Page) => {
    const session = await page.context().newCDPSession(page);
    try {
      return ((await session.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } }).targetInfo.targetId;
    } finally {
      await session.detach().catch(() => undefined);
    }
  };

  it('two workspaces on one profile: each sees and drives only its own pages; the other\'s is "not there"', async () => {
    const registry: Registry = new Map();
    const s = await startChrome(registry);
    const a = await connectThrough(await s.route.grant({ workspaceId: 'ws-a' }));
    const b = await connectThrough(await s.route.grant({ workspaceId: 'ws-b' }));
    browsers.push(a, b);
    // Opened by main after both connected: reaches each through the late grant.
    const pa = await mainOpens(s, registry, 'ws-a', 'data:text/html,<title>A</title>');
    const pb = await mainOpens(s, registry, 'ws-b', 'data:text/html,<title>B</title>');
    await vi.waitFor(() => expect(a.contexts()[0].pages()).toHaveLength(1), { timeout: 15_000 });
    await vi.waitFor(() => expect(b.contexts()[0].pages()).toHaveLength(1), { timeout: 15_000 });
    // Attached while its data: page may still be committing: read once it settles.
    await vi.waitFor(async () => expect(await a.contexts()[0].pages()[0].title().catch(() => '')).toBe('A'), { timeout: 15_000 });
    await vi.waitFor(async () => expect(await b.contexts()[0].pages()[0].title().catch(() => '')).toBe('B'), { timeout: 15_000 });
    const cdpA = await a.newBrowserCDPSession();
    const listed = ((await cdpA.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string; type: string }> }).targetInfos;
    expect(listed.filter((t) => t.type === 'page').map((t) => t.targetId)).toEqual([pa]);
    const failure = (p: Promise<unknown>) => p.then(() => 'answered', (err: unknown) => String(err));
    expect(await failure(cdpA.send('Target.attachToTarget', { targetId: pb, flatten: true }))).toMatch(/No target with given id found/);
    expect(await failure(cdpA.send('Target.activateTarget', { targetId: pb }))).toMatch(/No target with given id found/);
    expect(await failure(cdpA.send('Fetch.enable' as 'Target.getTargets'))).toMatch(/not available to this client/);
  }, 90_000);

  it('20 concurrent new pages across two clients, in the default context and in their own: each gets its own only', async () => {
    const registry: Registry = new Map();
    const s = await startChrome(registry);
    const a = await connectThrough(await s.route.grant({ workspaceId: 'ws-a' }));
    const b = await connectThrough(await s.route.grant({ workspaceId: 'ws-b' }));
    browsers.push(a, b);
    const [ctxA, ctxB] = await Promise.all([a.newContext(), b.newContext()]);
    const made = await Promise.all([
      ...Array.from({ length: 5 }, () => a.contexts()[0].newPage()),
      ...Array.from({ length: 5 }, () => ctxA.newPage()),
      ...Array.from({ length: 5 }, () => b.contexts()[0].newPage()),
      ...Array.from({ length: 5 }, () => ctxB.newPage()),
    ]);
    expect(made).toHaveLength(20);
    const idsA = new Set(await Promise.all([...a.contexts()[0].pages(), ...ctxA.pages()].map((p) => targetIdOf(p))));
    const idsB = new Set(await Promise.all([...b.contexts()[0].pages(), ...ctxB.pages()].map((p) => targetIdOf(p))));
    expect(idsA.size).toBe(10);
    expect(idsB.size).toBe(10);
    expect([...idsA].filter((id) => idsB.has(id))).toEqual([]);
    // Each still drives its own.
    await made[0].goto('data:text/html,<title>mine</title>');
    expect(await made[0].title()).toBe('mine');
  }, 120_000);

  it('storage through Playwright: a default-context page keeps its own storage, its own context keeps storageState and cookies, a foreign origin is refused', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=1; Path=/' });
      res.end('<title>s</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const failure = (p: Promise<unknown>) => p.then(() => 'answered', (err: unknown) => String(err));
    try {
      const s = await startChrome(new Map());
      const a = await connectThrough(await s.route.grant({ workspaceId: 'ws-a' }));
      browsers.push(a);
      const page = await a.contexts()[0].newPage();
      await page.goto(`${origin}/`);
      expect(await page.evaluate(async () => {
        localStorage.setItem('k', 'v');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('d', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('s');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        db.close();
        return `${localStorage.getItem('k')} ${document.cookie}`;
      })).toBe('v sid=1');
      const cdp = await page.context().newCDPSession(page);
      expect(await failure(cdp.send('Storage.trackIndexedDBForOrigin', { origin }))).toBe('answered');
      expect(await failure(cdp.send('Storage.trackIndexedDBForOrigin', { origin: 'https://bank.example' }))).toMatch(/not available to this client/);
      expect(await failure(cdp.send('Storage.getCookies', {}))).toMatch(/not available to this client/);
      await cdp.detach();
      const ctx = await a.newContext();
      const own = await ctx.newPage();
      await own.goto(`${origin}/`);
      await own.evaluate(() => localStorage.setItem('k2', 'v2'));
      const state = await ctx.storageState();
      expect(state.cookies.map((c) => c.name)).toEqual(['sid']);
      expect(state.origins.find((o) => o.origin === origin)?.localStorage).toEqual([{ name: 'k2', value: 'v2' }]);
      await ctx.clearCookies();
      expect(await ctx.cookies()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 90_000);

  it('a popup opened by a click goes to the client that holds its opener, with and without opener access, and the click returns', async () => {
    const registry: Registry = new Map();
    const s = await startChrome(registry);
    const a = await connectThrough(await s.route.grant({ workspaceId: 'ws-a' }));
    const b = await connectThrough(await s.route.grant({ workspaceId: 'ws-b' }));
    browsers.push(a, b);
    const page = await a.contexts()[0].newPage();
    await page.setContent('<button id=open onclick="window.open(\'about:blank\')">o</button><button id=noopener onclick="window.open(\'about:blank\', \'_blank\', \'noopener\')">n</button>');
    for (const id of ['open', 'noopener']) {
      const started = Date.now();
      const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 15_000 }), page.click(`#${id}`)]);
      expect(Date.now() - started, id).toBeLessThan(10_000);
      expect(popup, id).toBeTruthy();
    }
    // An evaluate that opens one returns: with opener access it waits for the
    // paused popup to be let go, so the popup's attach must not wait behind it.
    const cdp = await page.context().newCDPSession(page);
    for (const features of ['', 'noopener']) {
      const started = Date.now();
      const [popup, evaluated] = await Promise.all([
        page.waitForEvent('popup', { timeout: 15_000 }),
        cdp.send('Runtime.evaluate', { expression: `window.open('about:blank', '_blank', '${features}'); 1`, userGesture: true }),
      ]);
      expect(Date.now() - started, features || 'opener').toBeLessThan(10_000);
      expect(popup, features || 'opener').toBeTruthy();
      expect((evaluated as { result: { value: number } }).result.value).toBe(1);
    }
    await cdp.detach();
    await deliberateSleep(500, 'a negative check: no popup reaches the other client');
    expect(b.contexts()[0].pages()).toEqual([]);
    expect(a.contexts()[0].pages()).toHaveLength(5);
  }, 90_000);
});

describe.skipIf(!CHROME)('a real Chrome on a debugging pipe, with grants: downloads through main (C3b)', () => {
  let server: Server | null = null;
  afterAll(async () => {
    for (const r of relaysMade.splice(0)) {
      r.policy.dispose();
      removeDownloadRelayDir(r.dir);
    }
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('two workspaces download at once: each gets only its own file, through Playwright\'s own download.path()', async () => {
    server = createServer((req, res) => {
      const name = (req.url ?? '/').slice(1) || 'x';
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}.bin"` });
      res.end(`content of ${name}`);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registry: Registry = new Map();
    const opts: { relay?: Relay } = {};
    const s = await startChrome(registry, opts);
    const a = await connectThrough(await s.route.grant({ workspaceId: 'ws-a' }));
    const b = await connectThrough(await s.route.grant({ workspaceId: 'ws-b' }));
    browsers.push(a, b);
    const [pa, pb] = await Promise.all([a.contexts()[0].newPage(), b.contexts()[0].newPage()]);
    const seenA: string[] = [];
    const seenB: string[] = [];
    pa.on('download', (d) => seenA.push(d.url()));
    pb.on('download', (d) => seenB.push(d.url()));
    await pa.setContent(`<a id=d href="${origin}/alpha">a</a>`);
    await pb.setContent(`<a id=d href="${origin}/beta">b</a>`);
    const [da, db] = await Promise.all([
      Promise.all([pa.waitForEvent('download', { timeout: 20_000 }), pa.click('#d')]).then(([d]) => d),
      Promise.all([pb.waitForEvent('download', { timeout: 20_000 }), pb.click('#d')]).then(([d]) => d),
    ]);
    expect(fs.readFileSync((await da.path()) as string, 'utf8')).toBe('content of alpha');
    expect(fs.readFileSync((await db.path()) as string, 'utf8')).toBe('content of beta');
    expect(seenA).toEqual([`${origin}/alpha`]);
    expect(seenB).toEqual([`${origin}/beta`]);
    // Nothing left in main's folder.
    await vi.waitFor(() => expect(fs.readdirSync(opts.relay?.dir as string)).toEqual([]), { timeout: 10_000 });
  }, 120_000);

  it('a download in a tab no client holds (the user\'s own) lands in the user\'s folder under its name, a second deduped, no client told', async () => {
    const files = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="report.bin"' });
      res.end('the report');
    });
    await new Promise<void>((resolve) => files.listen(0, '127.0.0.1', () => resolve()));
    try {
      const origin = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
      const opts: { relay?: Relay } = {};
      const s = await startChrome(new Map(), opts);
      const a = await connectThrough(await s.route.grant({ workspaceId: 'ws-a' }));
      browsers.push(a);
      const pa = await a.contexts()[0].newPage();
      const seen: string[] = [];
      pa.on('download', (d) => seen.push(d.url()));
      a.contexts()[0].on('page', (p) => p.on('download', (d) => seen.push(d.url())));
      const userDir = opts.relay?.userDir as string;
      // Main opens the tab and files it under no workspace: a tab the user opened.
      const main = s.mux.connect({ label: 'the user' });
      await main.send('Target.createTarget', { url: `${origin}/report` });
      await vi.waitFor(() => expect(fs.readdirSync(userDir)).toEqual(['report.bin']), { timeout: 20_000 });
      await main.send('Target.createTarget', { url: `${origin}/report` });
      await vi.waitFor(() => expect(fs.readdirSync(userDir).sort()).toEqual(['report (1).bin', 'report.bin']), { timeout: 20_000 });
      expect(fs.readFileSync(path.join(userDir, 'report (1).bin'), 'utf8')).toBe('the report');
      expect(seen).toEqual([]);
      await vi.waitFor(() => expect(fs.readdirSync(opts.relay?.dir as string)).toEqual([]), { timeout: 10_000 });
      for (const name of fs.readdirSync(userDir)) fs.unlinkSync(path.join(userDir, name));
      fs.rmdirSync(userDir);
      fs.rmdirSync(path.dirname(userDir));
    } finally {
      await new Promise<void>((resolve) => files.close(() => resolve()));
    }
  }, 120_000);
});

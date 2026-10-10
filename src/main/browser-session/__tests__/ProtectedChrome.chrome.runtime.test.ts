import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { Browser, Page } from 'playwright-core';
import { ChromeLauncher, type ChromeProtectionPlan } from '../ChromeLauncher';
import { compileHostPolicy, type HostPolicy } from '../../../shared/browserHostPolicy';
import { requiredOnThisRunner } from '../../../test-utils/realBrowserHarness';

// ---------------------------------------------------------------------------
// Protected Chrome profiles against a REAL Chrome, launched by the production
// ChromeLauncher behind the production proxy (headless here; the flags are the
// same). One loopback fixture server answers every hostname; `a.test`,
// `b.test` and `blocked.test` reach it only through the proxy's resolve seam,
// so every request the server sees for `blocked.test` is a policy leak.
//
// Scenarios: redirect, iframe (an OOPIF: cross-site), dedicated worker,
// service worker, WebSocket, popup, Playwright reconnect, revocation, a
// click-triggered download with Playwright attached, and two profiles side by
// side. Playwright click/fill on an allowed host must still work.
// ---------------------------------------------------------------------------

const CASE_TIMEOUT_MS = 60_000;
const hits: string[] = [];
let server: http.Server;
let port = 0;

function hostOf(req: http.IncomingMessage): string {
  return String(req.headers.host ?? '').replace(/:\d+$/, '');
}

function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const host = hostOf(req);
  hits.push(`${host} ${req.url}`);
  const other = `http://blocked.test:${port}`;
  const html = (b: string) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(b));
  };
  switch (req.url) {
    case '/':
      return html('<input id="f"><button id="b" onclick="document.title=\'clicked:\'+f.value">go</button>');
    case '/redirect':
      res.writeHead(302, { location: `${other}/landed` });
      return void res.end();
    case '/iframe':
      return html(`<iframe src="${other}/framed"></iframe>`);
    case '/worker':
      return html(`<script>new Worker('/w.js')</script>`);
    case '/w.js':
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return void res.end(`fetch('${other}/from-worker').catch(() => {})`);
    case '/sw':
      return html(`<script>navigator.serviceWorker.register('/sw.js').then(r => { document.title = 'sw-registered' }, e => { document.title = 'sw-failed:' + e })</script>`);
    case '/sw.js':
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return void res.end(`self.addEventListener('install', e => e.waitUntil(fetch('${other}/from-sw').catch(() => {})))`);
    case '/ws':
      return html(`<script>const s = new WebSocket('ws://blocked.test:${port}/sock'); s.onopen = () => document.title = 'ws-open'; s.onerror = () => document.title = 'ws-error'</script>`);
    case '/ws-ok':
      return html(`<script>const s = new WebSocket('ws://a.test:${port}/sock'); s.onopen = () => document.title = 'ws-open'; s.onerror = () => document.title = 'ws-error'</script>`);
    case '/popup':
      return html(`<script>window.open('${other}/popped')</script>`);
    case '/download':
      return html('<a id="d" href="/file.bin">file</a>');
    case '/file.bin':
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"' });
      return void res.end('PAYLOAD');
    default:
      return html(`${host}${req.url}`);
  }
}

function blockedHits(): string[] {
  return hits.filter((h) => h.startsWith('blocked.test') || h.startsWith('b.test'));
}

interface Rig {
  launcher: ChromeLauncher;
  hosts: HostPolicy;
  browser: Browser | null;
  dir: string;
}

function plan(rig: Rig): ChromeProtectionPlan {
  return {
    matcher: () => compileHostPolicy(rig.hosts),
    resolve: (_host, p) => ({ host: '127.0.0.1', port: p }),
    ...(process.env.PROXY_DEBUG && { onDecision: (d) => console.log('DECIDE', JSON.stringify(d)) }),
  };
}

function makeRig(allow: string[]): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'wmux-protected-chrome-'));
  const rig: Rig = { launcher: null as unknown as ChromeLauncher, hosts: { mode: 'allowlist', allow, block: [] }, browser: null, dir };
  rig.launcher = new ChromeLauncher(dir, {
    portEnvVar: null,
    profileName: `protected-${allow.join('-') || 'none'}`,
    protection: () => plan(rig),
    // Headless for CI; a service worker needs a secure context, and a.test
    // over plain http is one only when Chrome is told so.
    // The isolate setup points HOME at a temp dir, where the macOS keychain
    // lookup for cookie encryption stalls the network stack; the mock
    // keychain (what Playwright's own launches use) avoids it.
    extraArgs: [
      '--headless=new',
      '--use-mock-keychain',
      '--password-store=basic',
      `--unsafely-treat-insecure-origin-as-secure=http://a.test:${port}`,
    ],
  });
  return rig;
}

async function attach(rig: Rig): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  const cdpPort = await rig.launcher.ensureRunning();
  rig.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  return rig.browser;
}

async function newPage(rig: Rig): Promise<Page> {
  const browser = rig.browser ?? (await attach(rig));
  const ctx = browser.contexts()[0];
  return ctx.newPage();
}

const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));

let rigA: Rig;
let rigB: Rig;
let skipReason: string | null = null;
const realUserProfile = process.env.WMUX_TEST_REAL_HOME;

beforeAll(async () => {
  server = http.createServer(serve);
  const wss = new WebSocketServer({ server });
  wss.on('connection', (_s, req) => hits.push(`${hostOf(req)} ws-connected`));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  // Chrome under the isolate setup's temp USERPROFILE refuses remote
  // debugging on Windows (see realProfileBrowserEnv); give it the real one.
  const savedProfile = process.env.USERPROFILE;
  if (process.platform === 'win32' && realUserProfile) process.env.USERPROFILE = realUserProfile;
  try {
    rigA = makeRig(['a.test']);
    rigB = makeRig(['b.test']);
    await attach(rigA);
  } catch (err) {
    skipReason = `Chrome could not be launched here: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
  } finally {
    if (process.platform === 'win32') process.env.USERPROFILE = savedProfile;
  }
}, 120_000);

afterAll(async () => {
  await rigA?.browser?.close().catch(() => undefined);
  await rigB?.browser?.close().catch(() => undefined);
  rigA?.launcher.dispose();
  rigB?.launcher.dispose();
  server?.close();
});

function skipUnless(ctx: { skip: (note?: string) => void }): boolean {
  if (!skipReason) return false;
  if (requiredOnThisRunner({ name: 'headless', headless: true })) throw new Error(skipReason);
  ctx.skip(skipReason);
  return true;
}

describe('protected Chrome profile (real Chrome)', { timeout: CASE_TIMEOUT_MS }, () => {
  it('Playwright click and fill still work on an allowed host', async (ctx) => {
    if (skipUnless(ctx)) return;
    const p = await newPage(rigA);
    await p.goto(`http://a.test:${port}/`);
    await p.fill('#f', 'hello');
    await p.click('#b');
    await expect.poll(() => p.title()).toBe('clicked:hello');
    await p.close();
  });

  it('makes zero requests to a blocked host across redirect, iframe, workers, WebSocket and popup', async (ctx) => {
    if (skipUnless(ctx)) return;
    const p = await newPage(rigA);
    await p.goto(`http://a.test:${port}/redirect`).catch(() => undefined);
    await p.goto(`http://a.test:${port}/iframe`);
    await settle();
    await p.goto(`http://a.test:${port}/worker`);
    await settle();
    await p.goto(`http://a.test:${port}/sw`);
    await expect.poll(() => p.title(), { timeout: 10_000 }).toBe('sw-registered');
    await settle();
    await p.goto(`http://a.test:${port}/ws`);
    await expect.poll(() => p.title(), { timeout: 10_000 }).toBe('ws-error');
    await p.goto(`http://a.test:${port}/popup`);
    await settle();
    await p.goto(`http://blocked.test:${port}/direct`).catch(() => undefined);
    expect(blockedHits()).toEqual([]);
    // The allowed host's own WebSocket still connects through the proxy.
    await p.goto(`http://a.test:${port}/ws-ok`);
    await expect.poll(() => p.title(), { timeout: 10_000 }).toBe('ws-open');
    await p.close();
  });

  it('stays enforced across a Playwright reconnect and after revocation', async (ctx) => {
    if (skipUnless(ctx)) return;
    await rigA.browser?.close();
    rigA.browser = null;
    const p = await newPage(rigA);
    await p.goto(`http://blocked.test:${port}/after-reconnect`).catch(() => undefined);
    expect(blockedHits()).toEqual([]);
    const before = hits.length;
    rigA.hosts = { mode: 'allowlist', allow: [], block: [] }; // revoked: takes effect on the next request
    await p.goto(`http://a.test:${port}/after-revoke`).catch(() => undefined);
    expect(hits.slice(before).filter((h) => h.includes('/after-revoke'))).toEqual([]);
    rigA.hosts = { mode: 'allowlist', allow: ['a.test'], block: [] };
    await p.close();
  });

  it('denies a click-triggered download while Playwright is attached', async (ctx) => {
    if (skipUnless(ctx)) return;
    const p = await newPage(rigA);
    await p.goto(`http://a.test:${port}/download`);
    const started = p.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
    await p.click('#d');
    const download = await started;
    // It starts (Playwright sees it) and is cancelled — never completed.
    expect(download).not.toBeNull();
    expect(await download?.failure()).toBe('canceled');
    await p.close();
  });

  it('runs two protected profiles side by side, each held to its own hosts', async (ctx) => {
    if (skipUnless(ctx)) return;
    const savedProfile = process.env.USERPROFILE;
    if (process.platform === 'win32' && realUserProfile) process.env.USERPROFILE = realUserProfile;
    try {
      await attach(rigB);
    } finally {
      if (process.platform === 'win32') process.env.USERPROFILE = savedProfile;
    }
    expect(rigA.launcher.currentPort()).not.toBe(rigB.launcher.currentPort());
    const pb = await newPage(rigB);
    await pb.goto(`http://b.test:${port}/mine`);
    expect(await pb.content()).toContain('b.test/mine');
    await pb.goto(`http://a.test:${port}/theirs`).catch(() => undefined);
    const pa = await newPage(rigA);
    await pa.goto(`http://b.test:${port}/not-mine`).catch(() => undefined);
    expect(hits.filter((h) => h.includes('/theirs') || h.includes('/not-mine'))).toEqual([]);
    await pa.close();
    await pb.close();
  });
});

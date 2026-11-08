// A real Chrome on a debugging pipe, driven through the multiplexer and its
// loopback endpoint by real Playwright clients.
//
// SKIPPED BY DEFAULT: it needs a Chrome binary. To run it:
//
//   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     npx vitest run -c vitest.runtime.config.ts src/main/browser-session/__tests__/CdpPipeMux.chrome.runtime.test.ts
//
// A temporary profile, headless, and data: pages only; nothing is fetched.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import WebSocket, { WebSocketServer } from 'ws';
import { CdpPipeMux } from '../CdpPipeMux';
import { CdpPipeEndpoint } from '../CdpPipeEndpoint';
import { ChromeLauncher } from '../ChromeLauncher';
import { CHROME_TEARDOWN_TIMEOUT_MS, stopChrome, tempChromeProfile, type TempChromeProfile } from '../../../test-utils/chromeProfile';

const CHROME = process.env.CHROME_PATH;

interface Started { child: ChildProcess; profile: string; mux: CdpPipeMux; endpoint: CdpPipeEndpoint; exited: Promise<void> }
const started: Started[] = [];
const browsers: Browser[] = [];
const relays: WebSocketServer[] = [];
/** Every temp profile a test made, removed after its Chrome is gone, launched or not. */
const profiles: TempChromeProfile[] = [];

async function startChrome(): Promise<Started> {
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
  const mux = new CdpPipeMux(child.stdio[3] as Writable, child.stdio[4] as Readable);
  let endpoint: CdpPipeEndpoint;
  try {
    endpoint = await CdpPipeEndpoint.open(mux);
  } catch (err) {
    // Not in `started`, so nothing else would stop it before its profile goes.
    mux.close();
    child.kill('SIGKILL');
    await exited;
    throw err;
  }
  const s = { child, profile, mux, endpoint, exited };
  started.push(s);
  return s;
}

/**
 * A loopback relay in front of the endpoint that records every frame one
 * client receives, so a test can see exactly what reached it.
 */
async function recordingRelay(upstream: string): Promise<{ url: string; received: Array<Record<string, unknown>> }> {
  const received: Array<Record<string, unknown>> = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  relays.push(wss);
  wss.on('connection', (down) => {
    const up = new WebSocket(upstream);
    const queued: string[] = [];
    up.on('open', () => { for (const m of queued.splice(0)) up.send(m); });
    down.on('message', (data) => {
      const text = data.toString();
      if (up.readyState === WebSocket.OPEN) up.send(text);
      else queued.push(text);
    });
    up.on('message', (data) => {
      const text = data.toString();
      received.push(JSON.parse(text) as Record<string, unknown>);
      down.send(text);
    });
    down.on('close', () => up.close());
    up.on('close', () => down.close());
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
    await s.endpoint.close();
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
  it('Playwright connects over CDP through the endpoint and drives a page', async () => {
    const { endpoint } = await startChrome();
    const browser = await chromium.connectOverCDP(endpoint.url);
    browsers.push(browser);
    const page = await browser.contexts()[0].newPage();
    await page.goto('data:text/html,<title>pipe</title><p id=x>one</p>');
    expect(await page.title()).toBe('pipe');
    expect(await page.evaluate(() => document.getElementById('x')?.textContent)).toBe('one');
  }, 60_000);

  it('two Playwright clients at once: targets stay visible to both, sessions stay private to each', async () => {
    const { endpoint } = await startChrome();
    const relayA = await recordingRelay(endpoint.url);
    const relayB = await recordingRelay(endpoint.url);
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

    // Targets stay visible: each client lists the other's page, as on the port.
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

  it('Chrome exits on the pipe closing, with no process or lock file left', async () => {
    const s = await startChrome();
    // A live browser first: the pipe answers.
    const browser = await chromium.connectOverCDP(s.endpoint.url);
    browsers.push(browser);
    expect(browser.version()).toMatch(/\d+\./);
    const started = Date.now();
    s.mux.close();
    const gone = await Promise.race([s.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5_000))]);
    expect(gone).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fs.readdirSync(s.profile).filter((f) => /^Singleton/.test(f))).toEqual([]);
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
      const first = (await launcher.endpoint()).wsEndpoint as string;
      const before = await chromium.connectOverCDP(first);
      await before.contexts()[0].addCookies([{ name: 'kept', value: '1', domain: 'probe.invalid', path: '/', expires: Math.floor(Date.now() / 1000) + 86_400 }]);
      await before.close();
      const pid = (launcher as unknown as { child: ChildProcess }).child.pid as number;
      process.kill(pid, 'SIGSTOP');
      const stoppedAt = Date.now();
      await expect(launcher.endpoint()).rejects.toThrow('ChromeLauncher: Chrome is not answering');
      await expect(launcher.endpoint()).rejects.toThrow('ChromeLauncher: Chrome is not answering');
      const second = (await launcher.endpoint()).wsEndpoint as string;
      const tookMs = Date.now() - stoppedAt;
      expect(second).not.toBe(first);
      expect(() => process.kill(pid, 0)).toThrow();
      const after = await chromium.connectOverCDP(second);
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

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChromeLauncher } from '../../browser-session/ChromeLauncher';
import { CHROME_TEARDOWN_TIMEOUT_MS, stopChrome, tempChromeProfile, type TempChromeProfile } from '../../../test-utils/chromeProfile';
import { createPhoneChromeDeps } from '../PhoneBrowserChrome';
import { createPhoneBrowserStreams, STREAM_LINE_LIMIT, type PhoneBrowserStreams } from '../PhoneBrowserStream';
import { handlePhoneBrowser } from '../PhoneBrowser';
import { MODES, requiredOnThisRunner, type Mode } from '../../../test-utils/realBrowserHarness';
import { deliberateSleep } from '../../../test-utils/waitFor';

// ---------------------------------------------------------------------------
// The phone browser stream against a REAL Chrome, launched by the production
// ChromeLauncher, streamed by the production stream manager and driven
// through the production preview input (handlePhoneBrowser). The daemon is a
// recorder that answers every push `known:true`.
//
// One Chrome per mode. Its profile zooms `localhost` to 120 % (a per-host
// zoom preference), so a tab there runs at browser zoom ≠ 100 % while the
// same pages on 127.0.0.1 do not.
// ---------------------------------------------------------------------------

const CASE_TIMEOUT_MS = 60_000;

const PAGES: Record<string, string> = {
  '/still': '<button id="b" onmousedown="document.title=\'hit\'">still</button>',
  // Classic scrollbars, and a target against the right edge of the client area.
  '/scroll': '<style>::-webkit-scrollbar{width:17px;height:17px;background:#ccc}::-webkit-scrollbar-thumb{background:#888}body{height:3000px;margin:0}</style>'
    + '<div id="t" style="position:fixed;right:0;top:100px;width:24px;height:40px;background:#c00" onmousedown="document.title=\'right-edge\'"></div>',
  // A search box that writes what is typed into the address, as it is typed.
  '/search': '<input id="q" oninput="history.pushState(null, \'\', \'/search?q=\' + encodeURIComponent(this.value))">',
  '/route': '<button id="b" onmousedown="document.title=\'hit\'" style="width:200px;height:100px">route</button>',
  // No viewport meta: under mobile emulation it lays out 980 px wide at ~0.4.
  '/wide': '<body style="margin:0"><div style="height:600px"></div>'
    + '<button id="t" style="margin-left:600px;width:120px;height:80px" onmousedown="document.title=\'hit\'">target</button></body>',
  // A phone page (viewport meta), with a target against the right edge of the client area.
  '/phone': '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{height:3000px;margin:0}</style>'
    + '<div id="t" style="position:fixed;right:0;top:100px;width:24px;height:40px;background:#c00" onmousedown="document.title=\'right-edge\'"></div>',
  // A text field, then a password field next in Tab order, then a button.
  '/form': '<input id="t" style="width:200px;height:40px"><input id="p" type="password" style="width:200px;height:40px"><button id="b">go</button>',
  // A link that opens its page in a new tab.
  '/opener': '<a id="t" href="/still" target="_blank" style="display:block;width:200px;height:80px">open</a>',
};

/** Answered this late, so a tab opened on it is still on its initial blank page for that long. */
const SLOW_MS = 1_500;

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = String(req.url ?? '/').split('?')[0].replace(/\/next$/, '');
  const answer = () => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body>${PAGES[path] ?? 'page'}</body></html>`);
  };
  if (path === '/slow') setTimeout(answer, SLOW_MS);
  else answer();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | undefined | null | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

/** Polls an async check until it holds. */
async function eventually(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}

type Push = Record<string, unknown>;

for (const mode of MODES) describeMode(mode);

function describeMode(mode: Mode): void {
  let server: http.Server;
  let port = 0;
  let launcher: ChromeLauncher | null = null;
  let profile: TempChromeProfile | null = null;
  let skipReason: string | null = null;
  const pushes: Push[] = [];
  let streams: PhoneBrowserStreams;
  let chrome: ReturnType<typeof createPhoneChromeDeps>;
  const realUserProfile = process.env.WMUX_TEST_REAL_HOME;

  beforeAll(async () => {
    server = http.createServer(serve);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    profile = tempChromeProfile('wmux-stream-chrome-', {
      preferences: { partition: { per_host_zoom_levels: { x: { localhost: { zoom_level: 1.0, last_modified: '13350000000000000' } } } } },
    });
    const dir = profile.dir;
    const savedProfile = process.env.USERPROFILE;
    if (process.platform === 'win32' && realUserProfile) process.env.USERPROFILE = realUserProfile;
    try {
      launcher = new ChromeLauncher(dir, {
        portEnvVar: null,
        profileName: `stream-${mode.name}`,
        extraArgs: [...(mode.headless ? ['--headless=new'] : []), '--use-mock-keychain', '--password-store=basic'],
      });
      await launcher.ensureRunning();
    } catch (err) {
      skipReason = `Chrome could not be launched here: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    } finally {
      if (process.platform === 'win32') process.env.USERPROFILE = savedProfile;
    }
    const own = launcher;
    chrome = createPhoneChromeDeps({
      registry: { profileFor: () => `stream-${mode.name}`, isPaneBound: () => false, peekLauncher: () => own ?? undefined },
      validateNavigation: async () => undefined,
    });
    streams = createPhoneBrowserStreams({
      push: async (params) => { pushes.push(params); return { ok: true, known: true }; },
      backend: () => 'chrome',
      chrome,
    });
  }, 120_000);

  afterEach(() => { streams?.stopAll(); });

  afterAll(async () => {
    await stopChrome(launcher);
    server?.close();
    // After Chrome has gone, launched or not.
    await profile?.remove();
  }, CHROME_TEARDOWN_TIMEOUT_MS);

  function skipUnless(ctx: { skip: (note?: string) => void }): boolean {
    if (!skipReason) return false;
    if (requiredOnThisRunner(mode)) throw new Error(skipReason);
    ctx.skip(skipReason);
    return true;
  }

  const browserDeps = () => ({
    backend: () => 'chrome',
    clearViewport: async () => undefined,
    nativeBounds: async () => ({ width: 1, height: 1 }),
    scroll: async () => undefined,
    input: async () => ({ id: 'x', ok: false as const, error: 'unused' }),
    targets: () => [],
    page: () => null,
    invoke: async () => ({ id: 'x', ok: false as const, error: 'unused' }),
    chrome,
    streams,
  });

  /**
   * Opens a tab of `ws-1` and waits for its page to load. The tab's initial
   * about:blank is `complete` too, so the page is the one at this URL.
   */
  async function open(path: string, host = '127.0.0.1'): Promise<string> {
    const url = `http://${host}:${port}${path}`;
    const { surfaceId } = await launcher!.openTab(url, 'ws-1');
    await eventually(async () => {
      const page = await evaluate(surfaceId, '[location.href, document.readyState]').catch(() => null) as [string, string] | null;
      return page?.[0] === url && page[1] === 'complete';
    }, 10_000);
    return surfaceId;
  }
  const evaluate = async (surfaceId: string, expression: string): Promise<unknown> => {
    const reply = await (await launcher!.pageSession(surfaceId)).send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as { result?: { value?: unknown } };
    return reply.result?.value;
  };
  const start = (surfaceId: string, extra: Record<string, unknown> = {}) => streams.handle('browser.streamStart', {
    workspaceId: 'ws-1', surfaceId, streamId: surfaceId, maxWidth: 1280, maxHeight: 1280, quality: 50, maxFps: 15, ...extra,
  });
  /** The daemon's `mobile` for the tab's stream; it applies after this answers. */
  const mobile = (surfaceId: string, value: boolean) =>
    streams.handle('browser.streamUpdate', { workspaceId: 'ws-1', surfaceId, streamId: surfaceId, mobile: value });
  /** The page's own view of its viewport. */
  const viewport = (surfaceId: string) => evaluate(surfaceId, '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints })') as Promise<{ w: number; h: number; dpr: number; touch: number }>;
  const of = (surfaceId: string, kind: string) => pushes.filter((p) => p.streamId === surfaceId && p.kind === kind);
  const lastFrame = (surfaceId: string) => of(surfaceId, 'frame').at(-1);
  const input = (command: string, surfaceId: string, body: Record<string, unknown>) =>
    handlePhoneBrowser(command, { workspaceId: 'ws-1', surfaceId, stream: true, ...body }, browserDeps());

  describe(`phone browser stream on real Chrome (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('a still page gets its first frame at once, with its URL and geometry', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/still');
      const started = Date.now();
      expect(await start(surfaceId)).toMatchObject({ backend: 'chrome', maxWidth: 1280, maxHeight: 1280, quality: 50 });
      const frame = await until(() => lastFrame(surfaceId), 5_000);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(frame).toMatchObject({ pageURL: `http://127.0.0.1:${port}/still` });
      expect(frame.geometry).toMatchObject({ scrollX: 0, scrollY: 0 });
      expect(frame.imageWidth).toBeGreaterThan(0);
    });

    it('a stream started before the tab\'s first page commits gets that page\'s frames once it does', async (ctx) => {
      if (skipUnless(ctx)) return;
      const url = `http://127.0.0.1:${port}/slow`;
      const { surfaceId } = await launcher!.openTab(url, 'ws-1');
      expect(await start(surfaceId)).toMatchObject({ backend: 'chrome' });
      const frame = await until(() => lastFrame(surfaceId), SLOW_MS + 8_000);
      expect(frame.pageURL).toBe(url);
      expect(await evaluate(surfaceId, 'location.href')).toBe(url);
    });

    it('classic scrollbars: the frame is wider than the client area, and a tap at the right edge lands', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/scroll');
      await start(surfaceId);
      const frame = await until(() => lastFrame(surfaceId)?.geometry ? lastFrame(surfaceId) : undefined);
      const geometry = frame.geometry as { width: number; height: number };
      const clientWidth = await evaluate(surfaceId, 'document.documentElement.clientWidth') as number;
      const spare = geometry.width - clientWidth;
      expect(spare).toBeGreaterThanOrEqual(0);
      expect(spare).toBeLessThanOrEqual(24);
      const rect = await evaluate(surfaceId, '(() => { const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()') as { x: number; y: number };
      expect(await input('browser.tap', surfaceId, { expectedURL: frame.pageURL, geometry, x: rect.x / geometry.width, y: rect.y / geometry.height })).toEqual({ applied: true, focus: { editable: false } });
      await eventually(async () => (await evaluate(surfaceId, 'document.title')) === 'right-edge');
    });

    it('under browser zoom a frame carries its URL but no geometry', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/still', 'localhost');
      // The profile's per-host zoom preference is what puts this tab at 120 %.
      const metrics = await (await launcher!.pageSession(surfaceId)).send('Page.getLayoutMetrics') as { cssVisualViewport?: { zoom?: number } };
      expect(metrics.cssVisualViewport?.zoom).toBeCloseTo(1.2, 2);
      await start(surfaceId);
      const frame = await until(() => lastFrame(surfaceId), 5_000);
      expect(frame.pageURL).toBe(`http://localhost:${port}/still`);
      expect(frame).not.toHaveProperty('geometry');
    });

    it('a tab is reported hidden exactly when Chrome hides it, and live again with a frame', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/still');
      await start(surfaceId);
      await until(() => lastFrame(surfaceId), 5_000);
      const other = await open('/still');
      await launcher!.selectSurface(other);
      // Hidden by Chrome means both: the page reads hidden, and it stopped painting.
      const readsHidden = await eventually(async () => (await evaluate(surfaceId, 'document.visibilityState')) === 'hidden', 3_000)
        .then(() => true, () => false);
      const painted = of(surfaceId, 'frame').length;
      await deliberateSleep(2_000, 'whether a background tab Chrome reads as hidden still paints');
      const hiddenByChrome = readsHidden && of(surfaceId, 'frame').length === painted;
      if (hiddenByChrome) {
        await until(() => of(surfaceId, 'state').find((p) => p.state === 'hidden'), 12_000);
        const frames = of(surfaceId, 'frame').length;
        await launcher!.selectSurface(surfaceId);
        await until(() => of(surfaceId, 'state').find((p) => p.state === 'live'), 8_000);
        await until(() => of(surfaceId, 'frame').length > frames || undefined, 8_000);
      } else {
        // This Chrome keeps the tab painting in the background: never hidden from silence.
        await deliberateSleep(7_000, 'past the 5 s quiet window, a tab Chrome still shows must not read as hidden');
        expect(of(surfaceId, 'state')).toEqual([]);
      }
      await launcher!.closeSurface(other);
    }, CASE_TIMEOUT_MS);

    it('a pushState search box typed in 150 ms pieces: every piece applies, none is refused', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/search');
      await start(surfaceId);
      await until(() => lastFrame(surfaceId), 5_000);
      await evaluate(surfaceId, 'q.focus()');
      /** What the phone last saw: the newest URL of a url event or a frame. */
      const seen = () => [...pushes].reverse().find((p) => p.streamId === surfaceId && (p.kind === 'url' || p.kind === 'frame') && typeof p.pageURL === 'string')?.pageURL as string;
      const pieces = ['he', 'll', 'o ', 'wo', 'rl', 'd'];
      for (const piece of pieces) {
        await sleep(150);
        expect(await input('browser.type', surfaceId, { expectedURL: seen(), text: piece })).toEqual({ applied: true });
      }
      expect(await evaluate(surfaceId, 'q.value')).toBe('hello world');
      await until(() => seen() === `http://127.0.0.1:${port}/search?q=hello%20world`, 5_000);
      // The URL changed under the phone each time, inside one document.
      expect(of(surfaceId, 'url').length).toBeGreaterThanOrEqual(2);
    });

    it('a tap after a pushState route change is browser-page-changed; at the live URL it lands', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/route');
      await start(surfaceId);
      const frame = await until(() => lastFrame(surfaceId)?.geometry ? lastFrame(surfaceId) : undefined);
      const before = frame.pageURL as string;
      await evaluate(surfaceId, "history.pushState(null, '', '/route/next')");
      const next = `http://127.0.0.1:${port}/route/next`;
      await until(() => of(surfaceId, 'url').find((p) => p.pageURL === next), 5_000);
      const geometry = (streams.tab(surfaceId, 'ws-1')?.geometry ?? frame.geometry) as Record<string, unknown>;
      expect(await input('browser.tap', surfaceId, { expectedURL: before, geometry, x: 0.05, y: 0.05 })).toEqual({ error: 'browser-page-changed' });
      expect(await evaluate(surfaceId, 'document.title')).not.toBe('hit');
      const rect = await evaluate(surfaceId, '(() => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()') as { x: number; y: number };
      const g = geometry as { width: number; height: number };
      expect(await input('browser.tap', surfaceId, { expectedURL: next, geometry, x: rect.x / g.width, y: rect.y / g.height })).toEqual({ applied: true, focus: { editable: false } });
      await eventually(async () => (await evaluate(surfaceId, 'document.title')) === 'hit');
    });

    it('a 300 KiB pushState URL: the stream lives on, its frames and url event carry no URL or geometry', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/still');
      await start(surfaceId);
      await until(() => lastFrame(surfaceId), 5_000);
      await evaluate(surfaceId, "history.pushState(null, '', '/still?state=' + 'x'.repeat(300 * 1024))");
      const url = await until(() => of(surfaceId, 'url').at(-1), 5_000);
      expect(url).not.toHaveProperty('pageURL');
      const frames = of(surfaceId, 'frame').length;
      await evaluate(surfaceId, "document.body.style.background = '#def'");
      await until(() => of(surfaceId, 'frame').length > frames || undefined, 8_000);
      const frame = lastFrame(surfaceId)!;
      expect(frame).not.toHaveProperty('pageURL');
      expect(frame).not.toHaveProperty('geometry');
      for (const p of pushes) expect(JSON.stringify(p).length).toBeLessThan(STREAM_LINE_LIMIT);
      expect(streams.tab(surfaceId, 'ws-1')).not.toBeNull();
    });

    it('a page without a viewport meta at scale ~0.4: the frame carries the scale and a tap lands on its target', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/wide');
      const page = await launcher!.pageSession(surfaceId);
      await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      try {
        await start(surfaceId);
        const frame = await until(() => {
          const f = lastFrame(surfaceId);
          const g = f?.geometry as { scale?: number } | undefined;
          return g?.scale !== undefined && g.scale < 0.6 ? f : undefined;
        });
        const geometry = frame.geometry as { width: number; height: number; scale: number };
        expect(geometry.width).toBe(390);
        const rect = await evaluate(surfaceId, '(() => { const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2 - visualViewport.offsetLeft, y: r.top + r.height / 2 - visualViewport.offsetTop }; })()') as { x: number; y: number };
        const x = (rect.x * geometry.scale) / geometry.width;
        const y = (rect.y * geometry.scale) / geometry.height;
        expect(await input('browser.tap', surfaceId, { expectedURL: frame.pageURL, geometry, x, y })).toEqual({ applied: true, focus: { editable: false } });
        await eventually(async () => (await evaluate(surfaceId, 'document.title')) === 'hit');
      } finally {
        await page.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      }
    });

    it('viewport=mobile: a phone\'s viewport at 2x with touch, frames at its size, a right-edge tap and a scroll land; off and detach restore the tab', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/phone');
      const desktop = await viewport(surfaceId);
      expect(desktop.w).toBeGreaterThan(390);
      await start(surfaceId, { mobile: true });
      const frame = await until(() => lastFrame(surfaceId)?.geometry ? lastFrame(surfaceId) : undefined);
      const geometry = frame.geometry as { width: number; height: number; scale?: number };
      expect(geometry.width).toBe(390);
      expect(geometry.scale).toBeUndefined();
      expect(await viewport(surfaceId)).toMatchObject({ w: 390, dpr: 2 });
      expect((await viewport(surfaceId)).touch).toBeGreaterThan(0);
      expect(frame.imageHeight).toBeLessThanOrEqual(1280);
      const rect = await evaluate(surfaceId, '(() => { const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()') as { x: number; y: number };
      expect(rect.x).toBeGreaterThan(370);
      expect(await input('browser.tap', surfaceId, { expectedURL: frame.pageURL, geometry, x: rect.x / geometry.width, y: rect.y / geometry.height })).toEqual({ applied: true, focus: { editable: false } });
      await eventually(async () => (await evaluate(surfaceId, 'document.title')) === 'right-edge');
      // A scroll lands too: half a viewport down.
      expect(await input('browser.scroll', surfaceId, { expectedURL: frame.pageURL, geometry, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 })).toEqual({ applied: true });
      await eventually(async () => (await evaluate(surfaceId, 'scrollY') as number) > 0);
      await mobile(surfaceId, false);
      await eventually(async () => (await viewport(surfaceId)).w === desktop.w);
      await mobile(surfaceId, true);
      await eventually(async () => (await viewport(surfaceId)).w === 390);
      // The stream stopping takes its emulation with it.
      streams.stopAll();
      await eventually(async () => (await viewport(surfaceId)).w === desktop.w);
      expect(await viewport(surfaceId)).toMatchObject({ w: desktop.w, dpr: desktop.dpr });
    });

    it('viewport=mobile on a page without a viewport meta: it lays out at ~0.4, the frame carries the scale and a tap lands on its target', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/wide');
      await start(surfaceId, { mobile: true });
      const frame = await until(() => {
        const f = lastFrame(surfaceId);
        const g = f?.geometry as { scale?: number } | undefined;
        return g?.scale !== undefined && g.scale < 0.6 ? f : undefined;
      });
      const geometry = frame.geometry as { width: number; height: number; scale: number };
      expect(geometry.width).toBe(390);
      expect(geometry.scale).toBeGreaterThan(0.3);
      const rect = await evaluate(surfaceId, '(() => { const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2 - visualViewport.offsetLeft, y: r.top + r.height / 2 - visualViewport.offsetTop }; })()') as { x: number; y: number };
      const x = (rect.x * geometry.scale) / geometry.width;
      const y = (rect.y * geometry.scale) / geometry.height;
      expect(await input('browser.tap', surfaceId, { expectedURL: frame.pageURL, geometry, x, y })).toEqual({ applied: true, focus: { editable: false } });
      await eventually(async () => (await evaluate(surfaceId, 'document.title')) === 'hit');
    });

    // Chrome keeps one device-metrics override per page: whoever set it last
    // wins, and the stream turning mobile off, or its session detaching,
    // returns the page to its real size, an agent's override included. A
    // stream that never applied mobile leaves an agent's override alone.
    it('viewport=mobile next to an agent\'s own device metrics on another session: the last one set wins, and the stream\'s clear removes both', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/phone');
      const agent = await launcher!.pageSession(surfaceId);
      const real = (await viewport(surfaceId)).w;
      /** The page settles at `w` CSS px wide. */
      const widthIs = (w: number) => eventually(async () => (await viewport(surfaceId)).w === w);
      const override = (width: number) => agent.send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false });
      await override(800);
      await widthIs(800);
      // The stream applied last: the phone's viewport.
      await start(surfaceId, { mobile: true });
      await until(() => lastFrame(surfaceId), 5_000);
      await widthIs(390);
      // The stream turning mobile off: the real size, not the agent's 800.
      await mobile(surfaceId, false);
      await widthIs(real);
      await override(800);
      await widthIs(800);
      await mobile(surfaceId, true);
      await widthIs(390);
      // The agent applied last: its own.
      await override(700);
      await widthIs(700);
      // The stream stopping: the real size again, the agent's 700 gone too.
      streams.stopAll();
      await widthIs(real);
      // A stream that never applied mobile leaves the agent's override alone.
      await override(800);
      await widthIs(800);
      await start(surfaceId);
      await until(() => lastFrame(surfaceId), 5_000);
      streams.stopAll();
      await deliberateSleep(500, 'a stream that never applied mobile detaching must leave the agent\'s override as it is');
      expect((await viewport(surfaceId)).w).toBe(800);
      await agent.send('Emulation.clearDeviceMetricsOverride');
      await widthIs(real);
    });

    it('focus events: a tap on a field, Tab to a password, a script focusing a button, then a new page', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/form');
      await start(surfaceId);
      const frame = await until(() => lastFrame(surfaceId)?.geometry ? lastFrame(surfaceId) : undefined);
      const focus = () => of(surfaceId, 'focus').map((p) => p.focus as { editable: boolean; kind?: string });
      await until(() => focus().length > 0, 5_000);
      expect(focus()[0]).toEqual({ editable: false });
      const geometry = frame.geometry as { width: number; height: number };
      const rect = await evaluate(surfaceId, "(() => { const r = document.getElementById('t').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()") as { x: number; y: number };
      expect(await input('browser.tap', surfaceId, { expectedURL: frame.pageURL, geometry, x: rect.x / geometry.width, y: rect.y / geometry.height }))
        .toEqual({ applied: true, focus: { editable: true, kind: 'text' } });
      await until(() => focus().at(-1)?.kind === 'text', 5_000);
      expect(await input('browser.key', surfaceId, { expectedURL: frame.pageURL, key: 'Tab' })).toEqual({ applied: true });
      await until(() => focus().at(-1)?.kind === 'password', 5_000);
      await evaluate(surfaceId, "document.getElementById('b').focus()");
      await until(() => focus().at(-1)?.editable === false, 5_000);
      await evaluate(surfaceId, "document.getElementById('t').focus()");
      await until(() => focus().at(-1)?.kind === 'text', 5_000);
      await evaluate(surfaceId, "location.href = '/still'");
      await until(() => focus().at(-1)?.editable === false, 5_000);
      // Each one a change, and none carries more than the two fields.
      const all = focus();
      for (let i = 1; i < all.length; i++) expect(all[i]).not.toEqual(all[i - 1]);
      for (const p of of(surfaceId, 'focus')) expect(Object.keys(p).sort()).toEqual(['focus', 'kind', 'streamId']);
    });

    it('a tab the streamed tab opens is a tabOpened push naming it, the tab the tap reply names', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/opener');
      await start(surfaceId);
      const frame = await until(() => lastFrame(surfaceId)?.geometry ? lastFrame(surfaceId) : undefined);
      const geometry = frame.geometry as { width: number; height: number };
      const rect = await evaluate(surfaceId, '(() => { const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()') as { x: number; y: number };
      const reply = await input('browser.tap', surfaceId, { expectedURL: frame.pageURL, geometry, x: rect.x / geometry.width, y: rect.y / geometry.height }) as { opened?: { surfaceId: string } };
      const popup = reply.opened?.surfaceId ?? '';
      expect(popup).toMatch(/^chrome-/);
      const pushed = await until(() => of(surfaceId, 'tabOpened').at(-1), 5_000);
      expect(pushed).toMatchObject({ streamId: surfaceId, kind: 'tabOpened', surfaceId: popup });
      if (pushed.pageURL !== undefined) expect(pushed.pageURL).toBe(`http://127.0.0.1:${port}/still`);
      expect(of(surfaceId, 'tabOpened')).toHaveLength(1);
      await launcher?.closeSurface(popup);
    });

    it('closing the tab ends the stream with browser-tab-gone', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/still');
      await start(surfaceId);
      await until(() => lastFrame(surfaceId), 5_000);
      await launcher!.closeSurface(surfaceId);
      expect(await until(() => of(surfaceId, 'end').at(-1), 8_000)).toEqual({ streamId: surfaceId, kind: 'end', error: 'browser-tab-gone' });
      expect(streams.tab(surfaceId, 'ws-1')).toBeNull();
    });
  });
}

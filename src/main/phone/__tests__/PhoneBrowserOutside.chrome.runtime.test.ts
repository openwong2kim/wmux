import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { ChromeLauncher } from '../../browser-session/ChromeLauncher';
import { CHROME_TEARDOWN_TIMEOUT_MS, stopChrome, tempChromeProfile, type TempChromeProfile } from '../../../test-utils/chromeProfile';
import { createPhoneChromeDeps, type PhoneChromeRegistry } from '../PhoneBrowserChrome';
import { handlePhoneBrowser } from '../PhoneBrowser';
import { MODES, requiredOnThisRunner, type Mode } from '../../../test-utils/realBrowserHarness';

// ---------------------------------------------------------------------------
// A profile bound to one pane of a workspace, against a REAL Chrome launched
// by the production ChromeLauncher: the tabs another CDP client opens in it
// (PUT /json/new, Target.createTarget) are listed for the phone and driven,
// with no tab wmux opened first and the tab watcher not started beforehand,
// and no agent lane ever sees them. Once the workspace may no longer see the
// profile, they are gone from the phone too.
// ---------------------------------------------------------------------------

const CASE_TIMEOUT_MS = 60_000;
const WS = 'ws-blog';

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = String(req.url ?? '/').split('?')[0];
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${path}</title><body style="margin:0"><input id="field" style="display:block;width:400px;height:60px"></body>`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

/** An outside CDP client's Target.createTarget, on its own connection to the browser. */
async function createTarget(port: number, url: string): Promise<string> {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    const reply = await new Promise<{ result?: { targetId?: string } }>((resolve) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as { id?: number; result?: { targetId?: string } };
        if (message.id === 1) resolve(message);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } }));
    });
    return reply.result?.targetId ?? '';
  } finally {
    ws.close();
  }
}

for (const mode of MODES) describeMode(mode);

function describeMode(mode: Mode): void {
  let server: http.Server;
  let origin = '';
  let launcher: ChromeLauncher | null = null;
  let profile: TempChromeProfile | null = null;
  let skipReason: string | null = null;
  const profileName = `pane-${mode.name}`;
  let bound = true;

  beforeAll(async () => {
    server = http.createServer(serve);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    profile = tempChromeProfile('wmux-outside-chrome-');
    try {
      launcher = new ChromeLauncher(profile.dir, {
        portEnvVar: null,
        profileName,
        extraArgs: [...(mode.headless ? ['--headless=new'] : []), '--use-mock-keychain', '--password-store=basic'],
      });
      await launcher.ensureRunning();
    } catch (err) {
      skipReason = `Chrome could not be launched here: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    }
  }, 120_000);

  afterAll(async () => {
    await stopChrome(launcher);
    server?.close();
    await profile?.remove();
  }, CHROME_TEARDOWN_TIMEOUT_MS);

  function skipUnless(ctx: { skip: (note?: string) => void }): boolean {
    if (!skipReason) return false;
    if (requiredOnThisRunner(mode)) throw new Error(skipReason);
    ctx.skip(skipReason);
    return true;
  }

  const running = (): ChromeLauncher => {
    if (!launcher) throw new Error('Chrome is not running');
    return launcher;
  };

  // The workspace has no profile of its own; one of its panes is bound to this one.
  const registry: PhoneChromeRegistry = {
    profileFor: () => 'default',
    isPaneBound: (p) => p === profileName,
    peekLauncher: (p) => (p === profileName ? launcher ?? undefined : undefined),
    paneProfiles: (ws) => ({ profiles: bound && ws === WS ? [profileName] : [], unknown: false }),
  };
  const chrome = createPhoneChromeDeps({ registry, validateNavigation: async () => undefined });
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
  });
  type Row = { id: string; url: string; openedBy?: string };
  const list = async () => await handlePhoneBrowser('browser.list', { workspaceId: WS, chrome: true }, browserDeps()) as { pages: Row[]; chromeOutside?: string };

  describe(`a pane profile's tabs on real Chrome (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('lists, captures and types into tabs an outside client opened, and no agent lane sees them', async (ctx) => {
      if (skipUnless(ctx)) return;
      const port = running().currentPort();
      if (port === null) throw new Error('no DevTools port');
      // What a script reading DevToolsActivePort does: no wmux tab, no watcher yet.
      await fetch(`http://127.0.0.1:${port}/json/new?${origin}/json-new`, { method: 'PUT' });
      await createTarget(port, `${origin}/create-target`);

      const reply = await eventually(list, (r) => r.pages.filter((p) => p.openedBy === 'outside').length === 2);
      expect(reply.chromeOutside).toBeUndefined();
      const rows = reply.pages.filter((p) => p.openedBy === 'outside');
      expect(rows.map((p) => new URL(p.url).pathname).sort()).toEqual(['/create-target', '/json-new']);
      expect(rows.every((p) => p.id.startsWith('chrome-x-'))).toBe(true);

      const target = rows.find((p) => p.url.endsWith('/json-new')) as Row;
      const scope = { workspaceId: WS, surfaceId: target.id };
      await chrome.focus(target.id, WS);
      const capture = await handlePhoneBrowser('browser.capture', scope, browserDeps()) as { data?: string; geometry?: { width: number; height: number }; pageURL?: string };
      expect(capture.data?.length).toBeGreaterThan(0);
      const g = capture.geometry;
      if (!g) throw new Error('the capture carries no geometry to tap with');
      // The field spans 400 x 60 CSS pixels from the top-left corner.
      await handlePhoneBrowser('browser.tap', { ...scope, expectedURL: capture.pageURL, geometry: g, x: 100 / g.width, y: 30 / g.height }, browserDeps());
      await handlePhoneBrowser('browser.type', { ...scope, expectedURL: capture.pageURL, text: 'typed from the phone' }, browserDeps());
      const session = await running().outsidePageSession(target.id);
      const value = await session.send('Runtime.evaluate', { expression: 'document.getElementById("field").value', returnByValue: true }) as { result?: { value?: unknown } };
      expect(value.result?.value).toBe('typed from the phone');

      // A stream session of its own on the same tab delivers frames.
      const stream = await running().outsideStreamSession(target.id);
      try {
        const frame = new Promise<unknown>((resolve) => stream.on('Page.screencastFrame', resolve));
        await stream.send('Page.startScreencast', { format: 'jpeg', quality: 50, everyNthFrame: 1 });
        await stream.send('Runtime.evaluate', { expression: 'document.body.style.background = "#abc"' });
        expect(await Promise.race([frame, sleep(10_000).then(() => 'no frame')])).not.toBe('no frame');
      } finally {
        await stream.detach();
      }

      // No agent lane: the records, the lists main serves agents.
      for (const listed of [await running().listTargets(WS), await running().listTargets(), await running().cdpInfoTargets(WS)]) {
        expect(listed.some((t) => t.url.includes('/json-new') || t.url.includes('/create-target'))).toBe(false);
      }
      expect(running().recordFor(target.id)).toBeUndefined();

      // A tab wmux opens for the workspace is listed as before, without the label.
      const own = await running().openTab(`${origin}/wmux-opened`, WS);
      const withOwn = await eventually(list, (r) => r.pages.some((p) => p.id === own.surfaceId && p.url.endsWith('/wmux-opened')));
      expect(withOwn.pages.find((p) => p.id === own.surfaceId)).not.toHaveProperty('openedBy');
      expect(withOwn.pages.filter((p) => p.openedBy === 'outside')).toHaveLength(2);
    });

    it('once the workspace may no longer see the profile, its outside tabs are gone from the phone', async (ctx) => {
      if (skipUnless(ctx)) return;
      const port = running().currentPort();
      if (port === null) throw new Error('no DevTools port');
      await fetch(`http://127.0.0.1:${port}/json/new?${origin}/later`, { method: 'PUT' });
      const reply = await eventually(list, (r) => r.pages.some((p) => p.openedBy === 'outside' && p.url.endsWith('/later')));
      const row = reply.pages.find((p) => p.url.endsWith('/later')) as Row;
      bound = false;
      try {
        const after = await list();
        expect(after.pages.some((p) => p.openedBy === 'outside')).toBe(false);
        expect(after.chromeOutside).toBe('not-bound');
        expect(await handlePhoneBrowser('browser.capture', { workspaceId: WS, surfaceId: row.id }, browserDeps())).toEqual({ error: 'browser-tab-gone' });
      } finally {
        bound = true;
      }
    });
  });
}

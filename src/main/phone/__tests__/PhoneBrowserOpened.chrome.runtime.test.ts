import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeLauncher } from '../../browser-session/ChromeLauncher';
import { createPhoneChromeDeps } from '../PhoneBrowserChrome';
import { handlePhoneBrowser } from '../PhoneBrowser';
import { MODES, requiredOnThisRunner, type Mode } from '../../../test-utils/realBrowserHarness';

// ---------------------------------------------------------------------------
// Contract v1.7 against a REAL Chrome, launched by the production
// ChromeLauncher: a tab a workspace's tab opens (target=_blank with and
// without noopener, window.open with and without noopener) becomes a tab of
// that workspace, the phone's tap reply names it, and a tab of another
// workspace never opens into this one.
// ---------------------------------------------------------------------------

const CASE_TIMEOUT_MS = 60_000;

/** The ways a page opens a tab, by the id of the element that does it. */
const OPENERS = ['plain', 'noopener', 'noref', 'wo', 'wonoopener'] as const;

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = String(req.url ?? '/').split('?')[0];
  res.writeHead(200, { 'content-type': 'text/html' });
  if (path !== '/') return void res.end(`<!doctype html><title>${path}</title><p>${path}</p>`);
  res.end('<!doctype html><body style="margin:0">'
    + '<style>a,button{display:block;width:300px;height:40px;margin:4px}</style>'
    + '<a id="plain" target="_blank" href="/plain">plain</a>'
    + '<a id="noopener" target="_blank" rel="noopener" href="/noopener">noopener</a>'
    + '<a id="noref" target="_blank" rel="noopener noreferrer" href="/noref">noref</a>'
    + '<button id="wo" onclick="window.open(\'/wo\')">wo</button>'
    + '<button id="wonoopener" onclick="window.open(\'/wonoopener\', \'_blank\', \'noopener\')">wonoopener</button>'
    + '<a id="same" href="/same">same</a>'
    + '<button id="nothing">nothing</button>'
    + '</body>');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}

for (const mode of MODES) describeMode(mode);

function describeMode(mode: Mode): void {
  let server: http.Server;
  let port = 0;
  let launcher: ChromeLauncher | null = null;
  let skipReason: string | null = null;
  let chrome: ReturnType<typeof createPhoneChromeDeps>;
  const realUserProfile = process.env.WMUX_TEST_REAL_HOME;

  beforeAll(async () => {
    server = http.createServer(serve);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), 'wmux-opened-chrome-'));
    const savedProfile = process.env.USERPROFILE;
    if (process.platform === 'win32' && realUserProfile) process.env.USERPROFILE = realUserProfile;
    try {
      launcher = new ChromeLauncher(dir, {
        portEnvVar: null,
        profileName: `opened-${mode.name}`,
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
      // Every workspace on one dedicated profile, as the default binding has it.
      registry: { profileFor: () => `opened-${mode.name}`, isPaneBound: () => false, peekLauncher: () => own ?? undefined },
      validateNavigation: async () => undefined,
    });
  }, 120_000);

  afterAll(async () => {
    await launcher?.dispose();
    server?.close();
  }, 60_000);

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
  });

  const evaluate = async (surfaceId: string, expression: string): Promise<unknown> => {
    const reply = await (await launcher!.pageSession(surfaceId)).send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as { result?: { value?: unknown } };
    return reply.result?.value;
  };

  /** A tab of `workspaceId` on the fixture page, loaded and in front. */
  async function open(workspaceId: string): Promise<string> {
    const { surfaceId } = await launcher!.openTab(`http://127.0.0.1:${port}/`, workspaceId);
    await eventually(async () => (await evaluate(surfaceId, 'document.readyState').catch(() => null)) === 'complete');
    return surfaceId;
  }

  /** The phone's tap on the middle of element `id`, through the production preview input. */
  async function tap(surfaceId: string, workspaceId: string, id: string): Promise<{ applied?: boolean; opened?: { surfaceId: string } }> {
    const scope = { workspaceId, surfaceId };
    await launcher!.selectSurface(surfaceId);
    const capture = await handlePhoneBrowser('browser.capture', scope, browserDeps()) as { geometry?: { width: number; height: number }; pageURL?: string };
    expect(capture.geometry).toBeDefined();
    const g = capture.geometry!;
    const at = await evaluate(surfaceId, `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
    return await handlePhoneBrowser('browser.tap', { ...scope, expectedURL: capture.pageURL, geometry: g, x: at.x / g.width, y: at.y / g.height }, browserDeps()) as { applied?: boolean; opened?: { surfaceId: string } };
  }

  const listed = async (workspaceId: string) => (await chrome.tabs(workspaceId)).map((t) => ({ surfaceId: t.surfaceId, path: new URL(t.url).pathname }));

  describe(`tabs a tab opens, on real Chrome (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('every way a page opens a tab is adopted into the tapping tab\'s workspace and named in the tap reply', async (ctx) => {
      if (skipUnless(ctx)) return;
      const opener = await open('ws-1');
      for (const id of OPENERS) {
        const reply = await tap(opener, 'ws-1', id);
        expect(reply, id).toMatchObject({ applied: true, opened: { surfaceId: expect.stringMatching(/^chrome-/) } });
        const popup = reply.opened!.surfaceId;
        expect(launcher!.recordFor(popup)?.workspaceId, id).toBe('ws-1');
        // The phone's list has it once its page has committed.
        await eventually(async () => (await listed('ws-1')).some((t) => t.surfaceId === popup && t.path === `/${id}`));
        expect(await launcher!.closeSurface(popup)).toBe(true);
      }
    });

    it('a tap that opens no tab says nothing of one, and adopts nothing', async (ctx) => {
      if (skipUnless(ctx)) return;
      const opener = await open('ws-1');
      const before = (await listed('ws-1')).length;
      expect(await tap(opener, 'ws-1', 'nothing')).not.toHaveProperty('opened');
      expect(await tap(opener, 'ws-1', 'same')).not.toHaveProperty('opened');
      await sleep(500);
      expect((await listed('ws-1')).length).toBe(before);
    });

    it('a tab of another workspace opens into its own workspace, never into yours', async (ctx) => {
      if (skipUnless(ctx)) return;
      const mine = await open('ws-1');
      const theirs = await open('ws-2');
      const heardByMine: string[] = [];
      const stop = chrome.onTabOpened?.(mine, 'ws-1', (tab) => heardByMine.push(tab.surfaceId));
      try {
        const reply = await tap(theirs, 'ws-2', 'noopener');
        const popup = reply.opened?.surfaceId;
        expect(popup).toMatch(/^chrome-/);
        expect(launcher!.recordFor(popup!)?.workspaceId).toBe('ws-2');
        await eventually(async () => (await listed('ws-2')).some((t) => t.surfaceId === popup));
        expect((await listed('ws-1')).some((t) => t.surfaceId === popup)).toBe(false);
        expect(heardByMine).toEqual([]);
        await launcher!.closeSurface(popup!);
      } finally {
        stop?.();
      }
    });
  });
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChromeLauncher } from '../../browser-session/ChromeLauncher';
import { CHROME_TEARDOWN_TIMEOUT_MS, stopChrome, tempChromeProfile, type TempChromeProfile } from '../../../test-utils/chromeProfile';
import { createPhoneChromeDeps } from '../PhoneBrowserChrome';
import { handlePhoneBrowser } from '../PhoneBrowser';
import { readFocus, watchFocus, type FocusCdp } from '../PhoneBrowserFocus';
import type { PhoneBrowserFocus } from '../../../shared/phoneBrowserPreview';
import { MODES, requiredOnThisRunner, type Mode } from '../../../test-utils/realBrowserHarness';
import { deliberateSleep } from '../../../test-utils/waitFor';

// ---------------------------------------------------------------------------
// Contract v1.6 focus against a REAL Chrome, launched by the production
// ChromeLauncher: the tap reply's `focus` through the production preview
// input (handlePhoneBrowser), and the stream's watcher on a production stream
// session. Headed is the product's case: a dedicated Chrome window that is
// usually not the focused one, where Chromium sends the page no focus events.
// ---------------------------------------------------------------------------

const CASE_TIMEOUT_MS = 60_000;
/**
 * How long the test page takes to arrive. A new tab shows its first document,
 * an empty one that is already `complete`, until the page commits: on a
 * loaded runner that took long enough for a test to act on the empty one. The
 * page is always slow here, so a test that doesn't wait for it fails every run.
 */
const PAGE_DELAY_MS = 300;

/** The same page on the other loopback name: another site, so a cross-origin frame. */
function otherOrigin(host: string): string {
  return host.startsWith('127.0.0.1') ? host.replace('127.0.0.1', 'localhost') : host.replace('localhost', '127.0.0.1');
}

function serve(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = String(req.url ?? '/').split('?')[0];
  const host = String(req.headers.host ?? '');
  res.writeHead(200, { 'content-type': 'text/html' });
  if (path === '/inner') return void res.end('<!doctype html><body style="margin:0"><input id="in" type="search" style="width:200px;height:30px"></body>');
  if (path === '/other') return void res.end('<!doctype html><body><p>other page</p></body>');
  setTimeout(() => res.end('<!doctype html><html><body style="margin:0">'
    + '<style>input,button,textarea,.f{display:block;width:240px;height:36px;margin:6px;box-sizing:border-box}iframe{display:block;width:260px;height:44px;margin:6px}</style>'
    + '<input id="t" name="card" value="4111" placeholder="Card number"><input id="p" type="password" value="hunter2"><button id="b">go</button>'
    + '<textarea id="ta"></textarea><div id="ce" class="f" contenteditable="true">edit</div><div id="host" class="f"></div><input id="ro" readonly>'
    + `<iframe id="same" src="/inner"></iframe><iframe id="cross" src="http://${otherOrigin(host)}/inner"></iframe>`
    + '<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = \'<input id="sh" type="email">\';</script>'
    + '</body></html>'), PAGE_DELAY_MS);
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
async function eventually(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
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
  let profile: TempChromeProfile | null = null;
  let skipReason: string | null = null;
  let chrome: ReturnType<typeof createPhoneChromeDeps>;

  beforeAll(async () => {
    server = http.createServer(serve);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    profile = tempChromeProfile('wmux-focus-chrome-');
    const dir = profile.dir;
    try {
      launcher = new ChromeLauncher(dir, {
        portEnvVar: null,
        profileName: `focus-${mode.name}`,
        extraArgs: [...(mode.headless ? ['--headless=new'] : []), '--use-mock-keychain', '--password-store=basic'],
      });
      await launcher.ensureRunning();
    } catch (err) {
      skipReason = `Chrome could not be launched here: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    }
    const own = launcher;
    chrome = createPhoneChromeDeps({
      registry: { profileFor: () => `focus-${mode.name}`, isPaneBound: () => false, peekLauncher: () => own ?? undefined },
      validateNavigation: async () => undefined,
    });
  }, 120_000);

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
  });

  /**
   * Opens a tab of `ws-1` and waits for its page, frames included, to load:
   * the page itself, not the empty first document a new tab starts with,
   * which is `complete` before the page has even arrived.
   */
  async function open(path: string): Promise<string> {
    const { surfaceId } = await launcher!.openTab(`http://127.0.0.1:${port}${path}`, 'ws-1');
    const loaded = `${path}|complete`;
    await eventually(async () => (await evaluate(surfaceId, 'location.pathname + "|" + document.readyState').catch(() => null)) === loaded, 10_000);
    return surfaceId;
  }
  /** The page's own (main-world) script. */
  const evaluate = async (surfaceId: string, expression: string): Promise<unknown> => {
    const reply = await (await launcher!.pageSession(surfaceId)).send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as { result?: { value?: unknown } };
    return reply.result?.value;
  };
  const scope = (surfaceId: string) => ({ workspaceId: 'ws-1', surfaceId });

  /** Taps the middle of the element `locate` finds (a main-world expression giving its viewport rect). */
  async function tapAt(surfaceId: string, locate: string): Promise<unknown> {
    const capture = await handlePhoneBrowser('browser.capture', scope(surfaceId), browserDeps()) as { geometry?: { width: number; height: number }; pageURL?: string };
    expect(capture.geometry).toBeDefined();
    const rect = await evaluate(surfaceId, `(() => { const r = ${locate}; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
    const g = capture.geometry!;
    return handlePhoneBrowser('browser.tap', { ...scope(surfaceId), expectedURL: capture.pageURL, geometry: g, x: rect.x / g.width, y: rect.y / g.height }, browserDeps());
  }
  const rectOf = (id: string) => `document.getElementById('${id}').getBoundingClientRect()`;
  /** An element inside the frame `frame`: its rect in the top viewport. */
  const rectIn = (frame: string, id: string) => `(() => { const f = document.getElementById('${frame}'); const o = f.getBoundingClientRect(); const r = f.contentDocument.getElementById('${id}').getBoundingClientRect(); return { left: o.left + f.clientLeft + r.left, top: o.top + f.clientTop + r.top, width: r.width, height: r.height }; })()`;

  describe(`phone browser focus on real Chrome (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('a tap reply says what the tap focused: a text field, a password field, a button', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/form');
      const text = await tapAt(surfaceId, rectOf('t'));
      expect(text).toEqual({ applied: true, focus: { editable: true, kind: 'text' } });
      // The kind only: never the field's value, name or placeholder.
      expect(JSON.stringify(text)).not.toMatch(/4111|card|Card/);
      expect(await tapAt(surfaceId, rectOf('p'))).toEqual({ applied: true, focus: { editable: true, kind: 'password' } });
      expect(await tapAt(surfaceId, rectOf('b'))).toEqual({ applied: true, focus: { editable: false } });
      expect(await evaluate(surfaceId, 'document.activeElement.id')).toBe('b');
    });

    it('a tap into a same-origin frame follows it; a cross-origin frame reads as not editable', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/form');
      await eventually(async () => (await evaluate(surfaceId, "!!document.getElementById('same').contentDocument?.getElementById('in')")) === true);
      expect(await tapAt(surfaceId, rectIn('same', 'in'))).toEqual({ applied: true, focus: { editable: true, kind: 'search' } });
      const cross = await evaluate(surfaceId, `(() => { const r = ${rectOf('cross')}; return { left: r.left + 10, top: r.top + 8, width: 20, height: 20 }; })()`) as Record<string, number>;
      expect(await tapAt(surfaceId, JSON.stringify(cross))).toEqual({ applied: true, focus: { editable: false } });
    });

    it('reads a textarea, contenteditable, an open shadow root and a read-only field', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/form');
      const page = await launcher!.pageSession(surfaceId);
      const read = async (focus: string) => { await evaluate(surfaceId, focus); return readFocus((m, p) => page.send(m, p)); };
      expect(await read("document.getElementById('ta').focus()")).toEqual({ editable: true, kind: 'textarea' });
      expect(await read("document.getElementById('ce').focus()")).toEqual({ editable: true, kind: 'contenteditable' });
      expect(await read("document.getElementById('host').shadowRoot.getElementById('sh').focus()")).toEqual({ editable: true, kind: 'email' });
      expect(await read("document.getElementById('ro').focus()")).toEqual({ editable: false });
      expect(await read('document.activeElement.blur()')).toEqual({ editable: false });
    });

    it('watchFocus reports a script moving focus, and a cross-document commit resets it', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/form');
      const session = await launcher!.streamSession(surfaceId);
      const seen: PhoneBrowserFocus[] = [];
      const watch = await watchFocus(session, (focus) => seen.push(focus));
      try {
        await until(() => seen.length > 0, 5_000);
        expect(seen[0]).toEqual({ editable: false });
        await evaluate(surfaceId, "document.getElementById('t').focus()");
        await until(() => seen.at(-1)?.kind === 'text', 5_000);
        await evaluate(surfaceId, "document.getElementById('p').focus()");
        await until(() => seen.at(-1)?.kind === 'password', 5_000);
        // Into a same-origin frame, by script.
        await evaluate(surfaceId, "document.getElementById('same').contentDocument.getElementById('in').focus()");
        await until(() => seen.at(-1)?.kind === 'search', 5_000);
        await evaluate(surfaceId, "document.getElementById('t').focus()");
        await until(() => seen.at(-1)?.kind === 'text', 5_000);
        const before = seen.length;
        await evaluate(surfaceId, "location.href = '/other'");
        await until(() => seen.length > before && seen.at(-1)?.editable === false, 5_000);
        // Every report was a change.
        for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toEqual(seen[i - 1]);
        // The next page's own fields are watched too.
        await eventually(async () => (await evaluate(surfaceId, 'location.pathname')) === '/other');
        await evaluate(surfaceId, "document.body.insertAdjacentHTML('beforeend', '<input id=n type=url>'); document.getElementById('n').focus()");
        await until(() => seen.at(-1)?.kind === 'url', 5_000);
      } finally {
        await watch.stop();
        await session.detach();
      }
    });

    it('a page script cannot trigger the binding, nor fake what the watcher reads', async (ctx) => {
      if (skipUnless(ctx)) return;
      const surfaceId = await open('/form');
      const session = await launcher!.streamSession(surfaceId);
      // The binding's name, as the watcher asks Chrome for it.
      let name = '';
      const methods: string[] = [];
      const spied: FocusCdp = {
        send: (method, params) => {
          methods.push(method);
          if (method === 'Runtime.addBinding') name = String(params?.name);
          return session.send(method, params);
        },
        on: (method, handler) => session.on(method, handler),
      };
      const called: string[] = [];
      session.on('Runtime.bindingCalled', (params) => { if (params.name === name) called.push(String(params.payload)); });
      const seen: PhoneBrowserFocus[] = [];
      const watch = await watchFocus(spied, (focus) => seen.push(focus));
      try {
        await until(() => seen.length > 0, 5_000);
        await deliberateSleep(300, 'the detectors\' own first checks settle');
        called.length = 0;
        expect(name).toMatch(/^__wmuxFocus_[0-9a-f]{16}$/);
        // Runtime is never enabled: the binding is added to one world by its context id.
        expect(methods).not.toContain('Runtime.enable');
        // The page's own world has no such function, and calling one by that name reaches nothing.
        expect(await evaluate(surfaceId, `typeof window[${JSON.stringify(name)}]`)).toBe('undefined');
        expect(await evaluate(surfaceId, `(() => { try { window[${JSON.stringify(name)}]('{"editable":true,"kind":"password"}'); return 'called'; } catch (e) { return 'threw'; } })()`)).toBe('threw');
        // A page that lies about its focus in its own world, and says so loudly.
        await evaluate(surfaceId, [
          `window[${JSON.stringify(name)}] = () => undefined;`,
          `window[${JSON.stringify(name)}]('{"editable":true,"kind":"password"}');`,
          "Object.defineProperty(Document.prototype, 'activeElement', { get() { return document.getElementById('p'); } });",
          "document.getElementById('p').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));",
          "document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));",
        ].join('\n'));
        expect(await evaluate(surfaceId, 'document.activeElement.id')).toBe('p');
        await deliberateSleep(1_500, 'past an unfocused page\'s re-read, nothing reported changes');
        expect(called).toEqual([]);
        expect(watch.current).toEqual({ editable: false });
        expect(seen).toEqual([{ editable: false }]);
        // The truth still comes through.
        await evaluate(surfaceId, "HTMLElement.prototype.focus.call(document.getElementById('t'))");
        await until(() => seen.at(-1)?.kind === 'text', 5_000);
      } finally {
        await watch.stop();
        await session.detach();
      }
    });
  });
}

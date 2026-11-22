import type { IncomingMessage, ServerResponse } from 'node:http';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { trackRequestBaseline } from '../actionSettle';
import { attachPageCapture, ensurePageCapture, readEntryBody } from '../pageCapture';
import { networkTapReady } from '../pageNetwork';
import { MODES, harnessFor } from '../../../test-utils/realBrowserHarness';
import { deliberateSleep } from '../../../test-utils/waitFor';

// ---------------------------------------------------------------------------
// The 4.16.0 leak, against real Chrome: a page that re-fetches one large
// script on every load. Capture used to read each textual body with
// response.text(), and Playwright kept that Buffer on the Response for the
// page's life, so `external` grew by the bundle size on every reload (an MCP
// process reached 760MB). Capture now copies no body into this process; one
// is fetched from Chrome only when browser_response_body asks.
// ---------------------------------------------------------------------------

const BUNDLE_BYTES = 5 * 1024 * 1024;
const RELOADS = 100;
const MAX_EXTERNAL_GROWTH = 50 * 1024 * 1024;

// One line repeated: valid JS, served as text/javascript, the content type
// capture treats as textual (application/javascript never was).
const line = '/* padding padding padding padding padding padding padding */\n';
const BUNDLE = `${line.repeat(Math.ceil(BUNDLE_BYTES / line.length))}window.bundleLoaded = (window.bundleLoaded || 0) + 1;\n`;

function serve(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/api.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"rows":[1,2,3]}');
    return;
  }
  if (req.url === '/fetches') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end("<!doctype html><title>f</title><script>fetch('/api.json').then((r) => r.json()).then(() => { document.title = 'done'; })</script>");
    return;
  }
  if (req.url?.startsWith('/bundle.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
    res.end(BUNDLE);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end('<!doctype html><title>bundle</title><script src="/bundle.js"></script>');
}

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

async function settledExternal(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return process.memoryUsage().external;
}

/** Client-side Playwright objects by type, read off the page's connection (a measurement aid only). */
function clientObjects(page: Page, type: string): number {
  const objects = (page as unknown as { _connection?: { _objects?: Map<string, { _type?: string }> } })._connection?._objects;
  let count = 0;
  for (const object of objects?.values() ?? []) if (object._type === type) count++;
  return count;
}

const mode = MODES[0]; // headless: the claim is about this process, not the window
const h = harnessFor(mode, { suiteName: 'pageCapture.memory.chrome', serve });

describe(`network capture memory against real Chrome (${mode.name})`, () => {
  it(`keeps external memory flat over ${RELOADS} reloads of a 5MB script`, async (ctx) => {
    if (h.skipUnless(ctx)) return;
    const page = (await h.browser().newPage()) as Page;
    try {
      // What PlaywrightEngine does on every page resolve under 'chrome'.
      trackRequestBaseline(page);
      attachPageCapture(page);
      await page.goto(h.origin(), { waitUntil: 'load' });
      const before = await settledExternal();
      const requestsBefore = clientObjects(page, 'Request');

      for (let i = 0; i < RELOADS; i++) await page.reload({ waitUntil: 'load' });
      await deliberateSleep(500, 'a body read still in flight (the old code read every one) lands before measuring');
      const after = await settledExternal();
      const requestsAfter = clientObjects(page, 'Request');

      console.log(
        `[pageCapture.memory] external ${Math.round(before / 2 ** 20)}MB -> ${Math.round(after / 2 ** 20)}MB` +
          ` over ${RELOADS} reloads; client Request objects ${requestsBefore} -> ${requestsAfter}`,
      );
      expect(after - before).toBeLessThan(MAX_EXTERNAL_GROWTH);

      // The body is still there on demand, from Chrome.
      const state = ensurePageCapture(page);
      const last = [...state.network].reverse().find((e) => e.url.endsWith('/bundle.js') && e.bodyReadable);
      expect(last).toBeDefined();
      const answer = await readEntryBody(page, last!);
      expect('body' in answer && answer.body.startsWith('/* padding')).toBe(true);
    } finally {
      await page.close();
    }
  }, 180_000);

  it('lists the document of a navigation started right after the page is resolved', async (ctx) => {
    if (h.skipUnless(ctx)) return;
    const page = (await h.browser().newPage()) as Page;
    try {
      // PlaywrightEngine.getPageForScope: attach, then wait for the session to listen.
      trackRequestBaseline(page);
      attachPageCapture(page);
      expect(await networkTapReady(page, 2_000)).toBe(true);
      await page.goto(h.origin(), { waitUntil: 'load' });
      const urls = ensurePageCapture(page).network.map((e) => e.url);
      expect(urls).toContain(h.origin());
      expect(urls.some((u) => u.endsWith('/bundle.js'))).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('still returns a fetch body after the page navigates away', async (ctx) => {
    if (h.skipUnless(ctx)) return;
    const page = (await h.browser().newPage()) as Page;
    try {
      attachPageCapture(page);
      expect(await networkTapReady(page, 2_000)).toBe(true);
      await page.goto(`${h.origin()}fetches`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.title === 'done');
      const entry = () => ensurePageCapture(page).network.find((e) => e.url.endsWith('/api.json'));
      await vi.waitFor(() => expect(entry()?.response?.body).toBeDefined(), { timeout: 5_000 });
      await page.goto(h.origin(), { waitUntil: 'load' });

      await expect(readEntryBody(page, entry()!)).resolves.toEqual({ body: '{"rows":[1,2,3]}' });
    } finally {
      await page.close();
    }
  }, 60_000);
});

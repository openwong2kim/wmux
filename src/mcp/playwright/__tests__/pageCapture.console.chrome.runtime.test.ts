import type { IncomingMessage, ServerResponse } from 'node:http';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { CDPSession, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { attachPageCapture, ensurePageCapture } from '../pageCapture';
import { networkTapReady } from '../pageNetwork';
import { MODES, harnessFor } from '../../../test-utils/realBrowserHarness';

// ---------------------------------------------------------------------------
// Console capture against real Chrome. It used to listen to page.on('console'),
// which makes Playwright keep a JSHandle per console argument until the page
// closes (up to 100k), in the one process a broker shares across clients: a
// page logging objects in a loop grew it without bound. It now reads the
// page's own CDP session and keeps only text. These tests hold it to the same
// output Playwright gave, and to flat growth.
// ---------------------------------------------------------------------------

const LOGS = 3_000;
/** Each logged call carries two object arguments: the old path kept a handle for each. */
const MAX_HANDLE_GROWTH = 100;
// Measured +1.2MB; the old path grew +30MB. The handle count is the sharp check.
const MAX_HEAP_GROWTH = 15 * 1024 * 1024;

const MATRIX = `
  console.log('plain string');
  console.log('%s and %d', 'fmt', 42);
  console.log(1, 2.5, true, null, undefined, NaN, -0, Infinity);
  console.log({ a: 1, nested: { b: [1, 2] }, s: 'str' });
  console.log([1, 'two', { three: 3 }], [1, , , 4]);
  console.log(new Error('logged error'));
  console.log(document.body, function named() { return 1; }, Symbol('sym'));
  console.log(new Map([[1, 2]]), new Set([1]), new Date(0), /re/g);
  console.warn('a warning');
  console.error('an error', { code: 7 });
  console.info('info');
  console.debug('debug');
  setTimeout(() => { throw new TypeError('thrown later'); }, 0);
  setTimeout(() => { throw 'a thrown string'; }, 0);
  Promise.reject(new RangeError('rejected'));
  fetch('/missing.json').catch(() => undefined);
`;

function serve(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/missing.json') {
    res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{}');
    return;
  }
  if (req.url === '/matrix') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>matrix</title><body><script>${MATRIX}</script></body>`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end('<!doctype html><title>blank</title>');
}

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

async function settledHeap(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return process.memoryUsage().heapUsed;
}

/** Client-side Playwright objects by type, read off the page's connection (a measurement aid only). */
function clientObjects(page: Page, type: string): number {
  const objects = (page as unknown as { _connection?: { _objects?: Map<string, { _type?: string }> } })._connection?._objects;
  let count = 0;
  for (const object of objects?.values() ?? []) if (object._type === type) count++;
  return count;
}

const mode = MODES[0]; // headless: the claim is about this process, not the window
const h = harnessFor(mode, { suiteName: 'pageCapture.console.chrome', serve });

describe(`console capture against real Chrome (${mode.name})`, () => {
  it(`keeps this process flat while a page logs objects ${LOGS} times`, async (ctx) => {
    if (h.skipUnless(ctx)) return;
    const page = (await h.browser().newPage()) as Page;
    try {
      attachPageCapture(page);
      expect(await networkTapReady(page, 2_000)).toBe(true);
      await page.goto(h.origin(), { waitUntil: 'load' });
      const heapBefore = await settledHeap();
      const handlesBefore = clientObjects(page, 'JSHandle');

      await page.evaluate((n) => {
        for (let i = 0; i < n; i++) console.log('row', { i, pad: 'x'.repeat(2_000) }, [i, i]);
      }, LOGS);
      const last = () => {
        const entries = ensurePageCapture(page).console;
        return entries[entries.length - 1]?.text ?? '';
      };
      await vi.waitFor(() => expect(last()).toContain(`i: ${LOGS - 1}`), { timeout: 30_000 });

      const heapAfter = await settledHeap();
      const handlesAfter = clientObjects(page, 'JSHandle');
      console.log(
        `[pageCapture.console] heapUsed ${(heapBefore / 2 ** 20).toFixed(1)}MB -> ${(heapAfter / 2 ** 20).toFixed(1)}MB` +
          ` over ${LOGS} logs; client JSHandle objects ${handlesBefore} -> ${handlesAfter}`,
      );
      expect(handlesAfter - handlesBefore).toBeLessThan(MAX_HANDLE_GROWTH);
      expect(heapAfter - heapBefore).toBeLessThan(MAX_HEAP_GROWTH);
      expect(ensurePageCapture(page).console).toHaveLength(1_000);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("reads the same as Playwright's console and pageerror events", async (ctx) => {
    if (h.skipUnless(ctx)) return;
    const page = (await h.browser().newPage()) as Page;
    // The reference: what capture used to record, from the listeners it used.
    const reference: Array<{ level: string; text: string }> = [];
    const referenceErrors: string[] = [];
    page.on('console', (msg) => reference.push({ level: msg.type() === 'warning' ? 'warn' : msg.type(), text: msg.text() }));
    page.on('pageerror', (error) => referenceErrors.push(`Uncaught ${error.stack || `${error.name}: ${error.message}`}`));
    try {
      attachPageCapture(page);
      expect(await networkTapReady(page, 2_000)).toBe(true);
      await page.goto(`${h.origin()}matrix`, { waitUntil: 'load' });
      // setContent's internal marker must stay out, as Playwright kept it out.
      await page.setContent('<!doctype html><title>set</title><script>console.log("after setContent")</script>');
      const ours = () => ensurePageCapture(page).console;
      const errors = () => ours().filter((e) => e.text.startsWith('Uncaught '));
      const rest = () => ours().filter((e) => !e.text.startsWith('Uncaught '));
      await vi.waitFor(() => {
        expect(referenceErrors).toHaveLength(3);
        expect(errors()).toHaveLength(3);
        expect(reference.some((e) => e.text.startsWith('Failed to load resource'))).toBe(true);
        expect(reference.some((e) => e.text === 'after setContent')).toBe(true);
        expect(rest()).toHaveLength(reference.length);
      }, { timeout: 10_000 });

      console.log('[pageCapture.console] rendered:\n' + ours().map((e) => `  [${e.level}] ${e.text.split('\n')[0]}`).join('\n'));
      expect(rest()).toEqual(reference);
      expect(errors().map((e) => e.text)).toEqual(referenceErrors);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("releases what a session's console events pinned with the 'console' object group", async (ctx) => {
    if (h.skipUnless(ctx)) return;
    // The release pageNetwork sends rests on Chrome wrapping console arguments
    // and thrown values in that group; check the assumption itself.
    const page = (await h.browser().newPage()) as Page;
    let session: CDPSession | undefined;
    try {
      await page.goto(h.origin(), { waitUntil: 'load' });
      const cdp = await page.context().newCDPSession(page);
      session = cdp;
      const ids: string[] = [];
      cdp.on('Runtime.consoleAPICalled', (p) => {
        for (const arg of p.args) if (arg.objectId) ids.push(arg.objectId);
      });
      cdp.on('Runtime.exceptionThrown', (p) => {
        if (p.exceptionDetails.exception?.objectId) ids.push(p.exceptionDetails.exception.objectId);
      });
      await cdp.send('Runtime.enable');
      await page.evaluate(() => {
        console.log({ kept: true });
        setTimeout(() => {
          throw new Error('kept too');
        }, 0);
      });
      await vi.waitFor(() => expect(ids).toHaveLength(2), { timeout: 5_000 });
      const reachable = (objectId: string) =>
        cdp.send('Runtime.getProperties', { objectId }).then(() => true, () => false);
      expect(await Promise.all(ids.map(reachable))).toEqual([true, true]);

      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'console' });
      expect(await Promise.all(ids.map(reachable))).toEqual([false, false]);
    } finally {
      await session?.detach().catch(() => undefined);
      await page.close();
    }
  }, 60_000);
});

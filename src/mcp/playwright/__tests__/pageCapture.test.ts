import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Page } from 'playwright-core';
import {
  attachPageCapture,
  CAPTURE_BOUNDS,
  clearConsoleCapture,
  clearNetworkCapture,
  ensurePageCapture,
  readEntryBody,
} from '../pageCapture';
import { NETWORK_BUFFER, networkTapReady } from '../pageNetwork';
import { fakeNetwork, type FakeNetwork } from './fakeNetworkSession';

// A Page stand-in: the capture module calls url(), mainFrame(), on() and off(),
// and opens its network session through context().newCDPSession (pageNetwork).
interface FakePage extends EventEmitter {
  url: () => string;
  mainFrame: () => object;
  context: () => { newCDPSession: () => Promise<unknown> };
  __mainFrame: object;
  net: FakeNetwork;
}

function makePage(url = 'about:blank'): FakePage {
  const page = new EventEmitter() as FakePage;
  const { newCDPSession, net } = fakeNetwork();
  page.url = () => url;
  page.__mainFrame = { name: 'main' };
  page.mainFrame = () => page.__mainFrame;
  page.context = () => ({ newCDPSession });
  page.net = net;
  return page;
}

function asPage(page: FakePage): Page {
  return page as unknown as Page;
}


const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('attachPageCapture', () => {
  it('records what the page logs before anything reads the buffer', async () => {
    const page = makePage();
    attachPageCapture(asPage(page));
    await page.net.ready();

    // No read has happened yet — this is the load-time window that used to be
    // lost because the listener only attached on the first browser_console.
    page.net.console('error', 'boom during load');

    expect(ensurePageCapture(asPage(page)).console).toEqual([
      { level: 'error', text: 'boom during load' },
    ]);
  });

  it('attaches once per page, so a re-resolved page does not double-record', async () => {
    const page = makePage();
    attachPageCapture(asPage(page));
    attachPageCapture(asPage(page));
    ensurePageCapture(asPage(page));
    await page.net.ready();

    page.net.console('log', 'once');
    expect(ensurePageCapture(asPage(page)).console).toEqual([{ level: 'log', text: 'once' }]);
  });

  it('keeps the newest entries when the console ring overflows', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();
    const overflow = CAPTURE_BOUNDS.MAX_CAPTURE_ENTRIES + 5;

    for (let i = 0; i < overflow; i++) {
      page.net.console('log', `msg-${i}`);
    }

    expect(state.console).toHaveLength(CAPTURE_BOUNDS.MAX_CAPTURE_ENTRIES);
    expect(state.console[0].text).toBe('msg-5');
    expect(state.console[state.console.length - 1].text).toBe(`msg-${overflow - 1}`);
  });

  it('keeps the newest entries when the network ring overflows', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();
    const overflow = CAPTURE_BOUNDS.MAX_CAPTURE_ENTRIES + 3;

    for (let i = 0; i < overflow; i++) {
      page.net.request(`https://x.test/${i}`);
    }

    expect(state.network).toHaveLength(CAPTURE_BOUNDS.MAX_CAPTURE_ENTRIES);
    expect(state.network[0].url).toBe('https://x.test/3');
    expect(state.network[state.network.length - 1].url).toBe(`https://x.test/${overflow - 1}`);
  });

  it('caps a single oversized console line instead of buffering it whole', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    page.net.console('log', 'x'.repeat(CAPTURE_BOUNDS.MAX_CONSOLE_TEXT_CHARS * 3));

    expect(state.console[0].text.length).toBeLessThan(CAPTURE_BOUNDS.MAX_CONSOLE_TEXT_CHARS + 64);
    expect(state.console[0].text).toContain('[truncated');
  });

  it('pairs a response with its request and copies no script body until one is asked for', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    page.net.exchange('https://x.test/api', 201, { method: 'POST', type: 'Script', body: '{"ok":true}' });
    await tick();

    expect(state.network[0]).toMatchObject({ method: 'POST', status: 201, bodyReadable: true });
    expect(JSON.stringify(state.network[0])).not.toContain('"ok"');
    expect(page.net.sent.some((c) => c.method === 'Network.getResponseBody')).toBe(false);

    await expect(readEntryBody(asPage(page), state.network[0])).resolves.toEqual({ body: '{"ok":true}' });
  });

  it('bounds the browser-side body buffer when it enables the Network domain', async () => {
    const page = makePage();
    attachPageCapture(asPage(page));
    await page.net.ready();

    expect(page.net.sent.find((c) => c.method === 'Network.enable')?.params).toEqual(NETWORK_BUFFER);
  });

  it('answers "gone" for a body the browser no longer holds', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    const id = page.net.exchange('https://x.test/api', 200, { body: '{}' });
    page.net.dropBody(id);

    await expect(readEntryBody(asPage(page), state.network[0])).resolves.toEqual({ unavailable: 'gone' });
  });

  it('caps one large body in the answer', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    page.net.exchange('https://x.test/big', 200, { body: 'y'.repeat(CAPTURE_BOUNDS.MAX_RESPONSE_BODY_BYTES * 2) });

    const answer = await readEntryBody(asPage(page), state.network[0]);
    expect('body' in answer && answer.body.length).toBeLessThan(CAPTURE_BOUNDS.MAX_RESPONSE_BODY_BYTES + 64);
    expect('body' in answer && answer.body).toContain('[truncated');
  });

  it('does not offer the body of a request still loading, a redirect hop, or a binary response', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    const loading = page.net.request('https://x.test/slow');
    page.net.respond(loading, 200, { body: '{}' });
    const moved = page.net.request('https://x.test/old');
    page.net.respond(moved, 302, { contentType: 'text/html', body: 'moved' });
    page.net.finish(moved);
    page.net.exchange('https://x.test/logo.png', 200, { contentType: 'image/png', body: 'png' });

    expect(state.network.map((e) => e.bodyReadable ?? false)).toEqual([false, false, false]);
  });

  it('reports a pre-attach gap when it starts on a page that is already loaded', () => {
    const fresh = attachPageCapture(asPage(makePage('about:blank')));
    expect(fresh.consoleWindow.missedBefore).toBe(false);

    const late = attachPageCapture(asPage(makePage('https://x.test/already-here')));
    expect(late.consoleWindow.missedBefore).toBe(true);
    expect(late.networkWindow.missedBefore).toBe(true);
  });

  it('restarts only the cleared buffer window', async () => {
    const page = makePage('https://x.test/already-here');
    const state = attachPageCapture(asPage(page));
    await page.net.ready();
    const networkWindowBefore = state.networkWindow;

    page.net.console('log', 'before clear');
    page.net.request('https://x.test/keep');
    clearConsoleCapture(state);

    expect(state.console).toEqual([]);
    expect(state.consoleWindow.missedBefore).toBe(false);
    // The network buffer is untouched, and still admits its own gap.
    expect(state.network).toHaveLength(1);
    expect(state.networkWindow).toBe(networkWindowBefore);
    expect(state.networkWindow.missedBefore).toBe(true);

    page.net.console('log', 'after clear');
    expect(state.console).toEqual([{ level: 'log', text: 'after clear' }]);

    clearNetworkCapture(state);
    expect(state.network).toEqual([]);
    expect(state.networkWindow.missedBefore).toBe(false);
  });

  it('drops the buffers when the page closes', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();
    page.net.console('log', 'pre-close');
    expect(state.console).toHaveLength(1);

    page.emit('close');

    // A fresh state, not the old buffer.
    expect(ensurePageCapture(asPage(page)).console).toEqual([]);
  });

  it('removes its listeners on close, so re-attaching does not double-record', async () => {
    const page = makePage();
    attachPageCapture(asPage(page));
    await page.net.ready();
    page.emit('close');
    expect(page.listenerCount('close')).toBe(0);

    // Same Page object resolved again: the WeakMap miss re-attaches, and a
    // listener left over from the closed state would record a second copy.
    const revived = ensurePageCapture(asPage(page));
    await page.net.ready();
    page.net.console('log', 'after revive');

    expect(revived.console).toEqual([{ level: 'log', text: 'after revive' }]);
  });
});

describe('attachPageCapture — uncaught exceptions (#1081)', () => {
  it('records an uncaught exception, which Playwright routes away from console', () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));

    const error = new Error('boom during load');
    error.stack = 'Error: boom during load\n    at http://x.test/app.js:1:1';
    page.emit('pageerror', error);

    expect(state.console).toHaveLength(1);
    expect(state.console[0].level).toBe('error');
    expect(state.console[0].text).toContain('boom during load');
    expect(state.console[0].text).toContain('app.js:1:1');
  });

  it('falls back to name and message when there is no stack', () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));

    const error = new Error('no stack here');
    error.stack = undefined;
    page.emit('pageerror', error);

    expect(state.console[0].text).toContain('Error: no stack here');
  });

  it('caps a pathological stack like any other console line', () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));

    const error = new Error('deep');
    error.stack = 'x'.repeat(CAPTURE_BOUNDS.MAX_CONSOLE_TEXT_CHARS * 3);
    page.emit('pageerror', error);

    expect(state.console[0].text.length).toBeLessThan(CAPTURE_BOUNDS.MAX_CONSOLE_TEXT_CHARS + 64);
  });

  it('records an exception once: the CDP event only lets go of the thrown value', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    page.net.exception({ text: 'Uncaught', exception: { type: 'object', subtype: 'error', objectId: 'e', description: 'Error: once' } });
    page.emit('pageerror', Object.assign(new Error('once'), { stack: 'Error: once' }));

    expect(state.console).toEqual([{ level: 'error', text: 'Uncaught Error: once' }]);
    expect(page.net.sent.filter((c) => c.method === 'Runtime.releaseObjectGroup')).toHaveLength(1);
  });

  it('stops listening for page errors on close', () => {
    const page = makePage();
    attachPageCapture(asPage(page));
    expect(page.listenerCount('pageerror')).toBe(1);
    page.emit('close');
    expect(page.listenerCount('pageerror')).toBe(0);
  });
});

describe('attachPageCapture — console from the CDP session, not Playwright handles', () => {
  it('turns on Runtime and Log on the page session', async () => {
    const page = makePage();
    attachPageCapture(asPage(page));
    await page.net.ready();

    const methods = page.net.sent.map((c) => c.method);
    expect(methods).toContain('Runtime.enable');
    expect(methods).toContain('Log.enable');
  });

  it('renders arguments as Playwright did', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    page.net.console(
      'log',
      'n',
      { type: 'number', value: 3 },
      { type: 'undefined' },
      { type: 'object', subtype: 'null', value: null },
      { type: 'number', unserializableValue: '-0' },
      { type: 'number', unserializableValue: 'NaN' },
      { type: 'object', objectId: 'o', description: 'Object', preview: { properties: [{ name: 'a', value: '1' }, { name: 'b', value: 'Object' }] } },
      { type: 'object', subtype: 'array', objectId: 'a', description: 'Array(4)', preview: { properties: [{ name: '0', value: '1' }, { name: '3', value: '4' }] } },
      { type: 'object', subtype: 'node', objectId: 'd', description: 'div#app' },
      { type: 'function', objectId: 'f', description: 'function f() {}' },
    );

    expect(state.console[0].text).toBe('n 3 undefined null 0 NaN {a: 1, b: Object} [1, empty x 2, 4] JSHandle@node function f() {}');
  });

  it('keeps the browser\'s own log lines, but not a worker\'s', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    page.net.log('error', 'Failed to load resource: the server responded with a status of 404 (Not Found)');
    page.net.log('warning', 'from a worker', { source: 'worker' });
    // Playwright's page.setContent marker, which its console never showed.
    page.net.console('debug', '--playwright--set--content--frame-1--1--');

    expect(state.console).toEqual([
      { level: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)' },
    ]);
  });

  it('leaves out what Runtime.enable replays from before capture started', async () => {
    const page = makePage('https://x.test/already-here');
    const state = attachPageCapture(asPage(page));
    await page.net.ready();
    const before = state.consoleWindow.since - 1_000;

    page.net.session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'old' }], executionContextId: 1, timestamp: before });
    page.net.log('error', 'old log', { timestamp: before });
    page.net.console('log', 'new');

    expect(state.console).toEqual([{ level: 'log', text: 'new' }]);
    expect(state.consoleWindow.missedBefore).toBe(true);
  });

  it('a session opened later replays nothing from before clear:true', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.now();
      const page = makePage();
      const real = page.context().newCDPSession;
      let refuse = true;
      page.context = () => ({ newCDPSession: () => (refuse ? Promise.reject(new Error('relay busy')) : real()) });
      const state = attachPageCapture(asPage(page));
      expect(await networkTapReady(asPage(page), 100)).toBe(false);

      vi.setSystemTime(t0 + 10_000);
      clearConsoleCapture(state);
      // Past the reopen cooldown; the next reader retries the session.
      vi.setSystemTime(t0 + 40_000);
      refuse = false;
      expect(await networkTapReady(asPage(page), 100)).toBe(true);

      const replay = (text: string, timestamp: number) =>
        page.net.session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: text }], executionContextId: 1, timestamp });
      replay('cleared before the reopen', t0 + 5_000);
      replay('after the clear', t0 + 20_000);
      page.net.console('log', 'live');

      expect(state.console.map((e) => e.text)).toEqual(['after the clear', 'live']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the console object group once per burst, and not for plain strings', async () => {
    const page = makePage();
    attachPageCapture(asPage(page));
    await page.net.ready();
    const releases = () => page.net.sent.filter((c) => c.method === 'Runtime.releaseObjectGroup');

    page.net.console('log', 'only strings');
    expect(releases()).toHaveLength(0);

    const big = { type: 'object', objectId: 'big', description: 'Object', preview: { properties: [] } };
    page.net.console('log', big);
    expect(releases()).toEqual([{ method: 'Runtime.releaseObjectGroup', params: { objectGroup: 'console' } }]);
    await tick();
    // A single event, settled: one release and no follow-up.
    expect(releases()).toHaveLength(1);

    // A burst while one is in flight: one more release once it answers, not 50.
    for (let i = 0; i < 50; i++) page.net.console('log', big);
    expect(releases()).toHaveLength(2);
    await tick();
    expect(releases()).toHaveLength(3);
    await tick();
    expect(releases()).toHaveLength(3);
  });
});

describe('attachPageCapture — small xhr/fetch bodies outlive a navigation', () => {
  it('copies a small fetch body as it finishes, so it is there after Chrome drops it', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    const id = page.net.exchange('https://x.test/api', 200, { body: '{"kept":true}' });
    await tick();
    page.net.dropBody(id); // the page navigated away

    expect(state.network[0].response?.body).toBe('{"kept":true}');
    await expect(readEntryBody(asPage(page), state.network[0])).resolves.toEqual({ body: '{"kept":true}' });
  });

  it('copies no script, document, or over-cap body; those stay on demand', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    page.net.exchange('https://x.test/app.js', 200, { type: 'Script', contentType: 'text/javascript', body: 'x=1' });
    page.net.exchange('https://x.test/', 200, { type: 'Document', contentType: 'text/html', body: '<p>' });
    page.net.exchange('https://x.test/big', 200, { body: 'y'.repeat(CAPTURE_BOUNDS.MAX_RESPONSE_BODY_BYTES + 1) });
    await tick();

    expect(state.network.map((e) => e.response?.body)).toEqual([undefined, undefined, undefined]);
    expect(state.totalBodyBytes).toBe(0);
    await expect(readEntryBody(asPage(page), state.network[0])).resolves.toEqual({ body: 'x=1' });
  });

  it('keeps no copy of a body that is small on the wire but over the cap once decoded', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    // A gzipped 1MB JSON: 20KB on the wire.
    const id = page.net.request('https://x.test/zipped');
    page.net.respond(id, 200, { body: 'z'.repeat(1024 * 1024) });
    page.net.finish(id, 20 * 1024);
    await tick();

    expect(state.network[0].response?.body).toBeUndefined();
    expect(state.totalBodyBytes).toBe(0);
    const answer = await readEntryBody(asPage(page), state.network[0]);
    expect('body' in answer && answer.body).toContain('[truncated');
  });

  it('drops the oldest retained bodies once the total body budget is exceeded', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();
    const body = 'y'.repeat(CAPTURE_BOUNDS.MAX_RESPONSE_BODY_BYTES);
    const count = Math.ceil(CAPTURE_BOUNDS.MAX_TOTAL_BODY_BYTES / body.length) + 2;

    for (let i = 0; i < count; i++) page.net.exchange(`https://x.test/big/${i}`, 200, { body });
    await tick();

    expect(state.totalBodyBytes).toBeLessThanOrEqual(CAPTURE_BOUNDS.MAX_TOTAL_BODY_BYTES);
    expect(state.network[0].response?.body).toBeUndefined();
    expect(state.network[count - 1].response?.body).toBeDefined();
  });

  it('charges nothing for a body that lands after clear:true', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    page.net.exchange('https://x.test/api', 200, { body: 'z'.repeat(1000) });
    clearNetworkCapture(state); // before the body fetch resolves
    await tick();

    expect(state.totalBodyBytes).toBe(0);
  });
});

describe('attachPageCapture — the network session lives as long as the page', () => {
  it('detaches its CDP session when the page closes', async () => {
    const page = makePage();
    attachPageCapture(asPage(page));
    await page.net.ready();
    expect(page.net.detached()).toBe(false);

    page.emit('close');
    await tick();

    expect(page.net.detached()).toBe(true);
  });

  it('a response after clear:true touches nothing', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    const id = page.net.request('https://x.test/slow');
    clearNetworkCapture(state);
    page.net.respond(id, 200);
    page.net.finish(id);

    expect(state.network).toEqual([]);
    expect(state.byRequestId.size).toBe(0);
  });

  it('lists a stream without offering its body', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    page.net.exchange('https://x.test/events', 200, { contentType: 'text/event-stream; charset=utf-8', body: 'data: 1' });

    expect(state.network[0]).toMatchObject({ url: 'https://x.test/events', status: 200 });
    expect(state.network[0].bodyReadable).toBeUndefined();
  });
});

describe('attachPageCapture — the gap claim expires with the document (#1081)', () => {
  it('stops claiming a pre-attach gap once the main frame navigates away', () => {
    const page = makePage('https://x.test/opened-before-the-agent-arrived');
    const state = attachPageCapture(asPage(page));
    expect(state.consoleWindow.missedBefore).toBe(true);

    page.emit('framenavigated', page.__mainFrame);

    // The document whose early life went unrecorded is gone; the buffer covers
    // the new one completely, so the footnote would now be misleading.
    expect(state.consoleWindow.missedBefore).toBe(false);
    expect(state.networkWindow.missedBefore).toBe(false);
  });

  it('a subframe navigation does not retire the gap', () => {
    const page = makePage('https://x.test/opened-before-the-agent-arrived');
    const state = attachPageCapture(asPage(page));

    page.emit('framenavigated', { name: 'an-iframe' });

    expect(state.consoleWindow.missedBefore).toBe(true);
  });
});

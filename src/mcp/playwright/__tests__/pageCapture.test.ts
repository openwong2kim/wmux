import { describe, expect, it } from 'vitest';
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
import { NETWORK_BUFFER } from '../pageNetwork';
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

function consoleMessage(level: string, text: string) {
  return { type: () => level, text: () => text };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('attachPageCapture', () => {
  it('records what the page logs before anything reads the buffer', () => {
    const page = makePage();
    attachPageCapture(asPage(page));

    // No read has happened yet — this is the load-time window that used to be
    // lost because the listener only attached on the first browser_console.
    page.emit('console', consoleMessage('error', 'boom during load'));

    expect(ensurePageCapture(asPage(page)).console).toEqual([
      { level: 'error', text: 'boom during load' },
    ]);
  });

  it('attaches once per page, so a re-resolved page does not double-record', () => {
    const page = makePage();
    attachPageCapture(asPage(page));
    attachPageCapture(asPage(page));
    ensurePageCapture(asPage(page));

    expect(page.listenerCount('console')).toBe(1);
    page.emit('console', consoleMessage('log', 'once'));
    expect(ensurePageCapture(asPage(page)).console).toEqual([{ level: 'log', text: 'once' }]);
  });

  it('keeps the newest entries when the console ring overflows', () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    const overflow = CAPTURE_BOUNDS.MAX_CAPTURE_ENTRIES + 5;

    for (let i = 0; i < overflow; i++) {
      page.emit('console', consoleMessage('log', `msg-${i}`));
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

  it('caps a single oversized console line instead of buffering it whole', () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));

    page.emit('console', consoleMessage('log', 'x'.repeat(CAPTURE_BOUNDS.MAX_CONSOLE_TEXT_CHARS * 3)));

    expect(state.console[0].text.length).toBeLessThan(CAPTURE_BOUNDS.MAX_CONSOLE_TEXT_CHARS + 64);
    expect(state.console[0].text).toContain('[truncated');
  });

  it('pairs a response with its request and copies no body until one is asked for', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    await page.net.ready();

    page.net.exchange('https://x.test/api', 201, { method: 'POST', body: '{"ok":true}' });
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

    page.emit('console', consoleMessage('log', 'before clear'));
    page.net.request('https://x.test/keep');
    clearConsoleCapture(state);

    expect(state.console).toEqual([]);
    expect(state.consoleWindow.missedBefore).toBe(false);
    // The network buffer is untouched, and still admits its own gap.
    expect(state.network).toHaveLength(1);
    expect(state.networkWindow).toBe(networkWindowBefore);
    expect(state.networkWindow.missedBefore).toBe(true);

    page.emit('console', consoleMessage('log', 'after clear'));
    expect(state.console).toEqual([{ level: 'log', text: 'after clear' }]);

    clearNetworkCapture(state);
    expect(state.network).toEqual([]);
    expect(state.networkWindow.missedBefore).toBe(false);
  });

  it('drops the buffers when the page closes', () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    page.emit('console', consoleMessage('log', 'pre-close'));
    expect(state.console).toHaveLength(1);

    page.emit('close');

    // A fresh state, not the old buffer.
    expect(ensurePageCapture(asPage(page)).console).toEqual([]);
  });

  it('removes its listeners on close, so re-attaching does not double-record', () => {
    const page = makePage();
    attachPageCapture(asPage(page));
    page.emit('close');
    expect(page.listenerCount('console')).toBe(0);
    expect(page.listenerCount('close')).toBe(0);

    // Same Page object resolved again: the WeakMap miss re-attaches, and a
    // listener left over from the closed state would record a second copy.
    const revived = ensurePageCapture(asPage(page));
    page.emit('console', consoleMessage('log', 'after revive'));

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

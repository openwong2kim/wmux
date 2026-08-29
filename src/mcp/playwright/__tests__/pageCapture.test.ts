import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import type { Page } from 'playwright-core';
import {
  attachPageCapture,
  CAPTURE_BOUNDS,
  clearConsoleCapture,
  clearNetworkCapture,
  ensurePageCapture,
} from '../pageCapture';

// A Page stand-in: the capture module only ever calls url(), mainFrame(), on()
// and off(), and reads the event objects Playwright hands it.
interface FakePage extends EventEmitter {
  url: () => string;
  mainFrame: () => object;
  __mainFrame: object;
}

function makePage(url = 'about:blank'): FakePage {
  const page = new EventEmitter() as FakePage;
  page.url = () => url;
  page.__mainFrame = { name: 'main' };
  page.mainFrame = () => page.__mainFrame;
  return page;
}

function asPage(page: FakePage): Page {
  return page as unknown as Page;
}

function consoleMessage(level: string, text: string) {
  return { type: () => level, text: () => text };
}

function request(url: string, method = 'GET') {
  return { url: () => url, method: () => method };
}

function response(url: string, status: number, body?: string, contentType = 'application/json') {
  return {
    url: () => url,
    status: () => status,
    headers: () => ({ 'content-type': contentType }),
    text: async () => body ?? '',
  };
}

/** A response whose body arrives only when the returned `settle` is called. */
function deferredResponse(url: string, contentType = 'application/json') {
  let settle: (body: string) => void = () => undefined;
  const body = new Promise<string>((resolve) => {
    settle = resolve;
  });
  return {
    response: {
      url: () => url,
      status: () => 200,
      headers: () => ({ 'content-type': contentType }),
      text: () => body,
    },
    settle: (value: string) => settle(value),
  };
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

  it('keeps the newest entries when the network ring overflows', () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    const overflow = CAPTURE_BOUNDS.MAX_CAPTURE_ENTRIES + 3;

    for (let i = 0; i < overflow; i++) {
      page.emit('request', request(`https://x.test/${i}`));
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

  it('pairs a response with its request and retains a textual body', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));

    page.emit('request', request('https://x.test/api', 'POST'));
    page.emit('response', response('https://x.test/api', 201, '{"ok":true}'));
    await tick();

    expect(state.network[0]).toMatchObject({ method: 'POST', status: 201 });
    expect(state.network[0].response?.body).toBe('{"ok":true}');
  });

  it('drops the oldest retained bodies once the total body budget is exceeded', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    const body = 'y'.repeat(CAPTURE_BOUNDS.MAX_RESPONSE_BODY_BYTES);
    const count = Math.ceil(CAPTURE_BOUNDS.MAX_TOTAL_BODY_BYTES / body.length) + 2;

    for (let i = 0; i < count; i++) {
      page.emit('request', request(`https://x.test/big/${i}`));
      page.emit('response', response(`https://x.test/big/${i}`, 200, body));
      await tick();
    }

    expect(state.totalBodyBytes).toBeLessThanOrEqual(CAPTURE_BOUNDS.MAX_TOTAL_BODY_BYTES);
    // Metadata survives eviction — only the payload is dropped.
    expect(state.network).toHaveLength(count);
    expect(state.network[0].response?.body).toBeUndefined();
    expect(state.network[count - 1].response?.body).toBeDefined();
  });

  it('reports a pre-attach gap when it starts on a page that is already loaded', () => {
    const fresh = attachPageCapture(asPage(makePage('about:blank')));
    expect(fresh.consoleWindow.missedBefore).toBe(false);

    const late = attachPageCapture(asPage(makePage('https://x.test/already-here')));
    expect(late.consoleWindow.missedBefore).toBe(true);
    expect(late.networkWindow.missedBefore).toBe(true);
  });

  it('restarts only the cleared buffer window', () => {
    const page = makePage('https://x.test/already-here');
    const state = attachPageCapture(asPage(page));
    const networkWindowBefore = state.networkWindow;

    page.emit('console', consoleMessage('log', 'before clear'));
    page.emit('request', request('https://x.test/keep'));
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
    expect(state.totalBodyBytes).toBe(0);
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
    expect(page.listenerCount('response')).toBe(0);
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

describe('attachPageCapture — late response bodies cannot leak the budget (#1081)', () => {
  it('ignores a body that arrives after its entry left the ring', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));

    const { response: pending, settle } = deferredResponse('https://x.test/slow');
    page.emit('request', request('https://x.test/slow'));
    page.emit('response', pending);

    // Push the entry out of the ring while text() is still in flight.
    for (let i = 0; i < CAPTURE_BOUNDS.MAX_CAPTURE_ENTRIES; i++) {
      page.emit('request', request(`https://x.test/flood/${i}`));
    }
    expect(state.network.some((e) => e.url.includes('/slow'))).toBe(false);

    settle('a'.repeat(1000));
    await tick();

    // Charging a dead entry would leak the budget permanently: it is no longer
    // reachable from state.network, so evictBodies could never reclaim it.
    expect(state.totalBodyBytes).toBe(0);
  });

  it('ignores a body that arrives after clear:true replaced the buffer', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));

    const { response: pending, settle } = deferredResponse('https://x.test/slow');
    page.emit('request', request('https://x.test/slow'));
    page.emit('response', pending);

    clearNetworkCapture(state);
    settle('b'.repeat(1000));
    await tick();

    expect(state.totalBodyBytes).toBe(0);
    expect(state.network).toEqual([]);
  });

  it('does not read the body of a stream that never ends', async () => {
    const page = makePage();
    const state = attachPageCapture(asPage(page));
    let readAttempted = false;

    page.emit('request', request('https://x.test/events'));
    page.emit('response', {
      url: () => 'https://x.test/events',
      status: () => 200,
      headers: () => ({ 'content-type': 'text/event-stream; charset=utf-8' }),
      text: () => {
        readAttempted = true;
        // A real SSE stream settles only when the stream closes.
        return new Promise<string>(() => undefined);
      },
    });
    await tick();

    expect(readAttempted).toBe(false);
    // The request itself is still listed — only its body is skipped.
    expect(state.network[0]).toMatchObject({ url: 'https://x.test/events', status: 200 });
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

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

// A Page stand-in: the capture module only ever calls url() and on(), and
// reads the event objects Playwright hands it.
interface FakePage extends EventEmitter {
  url: () => string;
}

function makePage(url = 'about:blank'): FakePage {
  const page = new EventEmitter() as FakePage;
  page.url = () => url;
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
});

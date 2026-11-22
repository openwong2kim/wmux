import { describe, expect, it, vi } from 'vitest';
import { fakeNetwork } from './fakeNetworkSession';
import {
  PENDING_RECENCY_MS,
  attachPageCapture,
  clearNetworkCapture,
  countRecentPendingRequests,
  peekRecentPendingRequests,
} from '../pageCapture';

type Handler = (arg: unknown) => void;

/** Minimal Page double: records listeners so the test can fire them. */
function makePage() {
  const handlers = new Map<string, Set<Handler>>();
  const { newCDPSession, net } = fakeNetwork();
  return {
    handlers,
    net,
    context: () => ({ newCDPSession }),
    on(event: string, fn: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(fn);
      handlers.set(event, set);
    },
    off(event: string, fn: Handler) {
      handlers.get(event)?.delete(fn);
    },
    emit(event: string, arg: unknown) {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(arg);
    },
    url: () => 'https://example.test/',
    mainFrame: () => ({}),
    evaluate: vi.fn(),
  };
}

describe('pageCapture pending-request tracking', () => {
  it('counts a started request and drops it when it finishes', async () => {
    const page = makePage();
    const state = attachPageCapture(page as never);
    await page.net.ready();
    const req = page.net.request('https://example.test/a.json');
    expect(countRecentPendingRequests(state)).toBe(1);

    page.net.finish(req);
    expect(countRecentPendingRequests(state)).toBe(0);
  });

  it('drops it on a failure too — a counter that only settles on success leaks', async () => {
    const page = makePage();
    const state = attachPageCapture(page as never);
    await page.net.ready();
    const req = page.net.request('https://example.test/blocked.js');
    page.net.fail(req);
    expect(countRecentPendingRequests(state)).toBe(0);
  });

  it('excludes a request older than the recency window', async () => {
    const page = makePage();
    const state = attachPageCapture(page as never);
    await page.net.ready();
    page.net.request('https://example.test/events');

    const later = Date.now() + PENDING_RECENCY_MS + 1;
    expect(countRecentPendingRequests(state, later)).toBe(0);
    // Still tracked — only the settle events remove it.
    expect(state.pendingRequests.size).toBe(1);
  });

  it('counts a redirected request once, under its one id', async () => {
    const page = makePage();
    const state = attachPageCapture(page as never);
    await page.net.ready();
    const id = page.net.request('https://example.test/old');
    page.net.session.emit('Network.requestWillBeSent', {
      requestId: id,
      loaderId: 'l',
      type: 'Fetch',
      request: { url: 'https://example.test/new', method: 'GET' },
      redirectResponse: { url: 'https://example.test/old', status: 302, headers: {} },
    });
    expect(countRecentPendingRequests(state)).toBe(1);
    expect(state.network.map((e) => [e.url, e.status])).toEqual([
      ['https://example.test/old', 302],
      ['https://example.test/new', undefined],
    ]);
    page.net.finish(id);
    expect(countRecentPendingRequests(state)).toBe(0);
  });

  it('clears pending state with the network buffer', async () => {
    const page = makePage();
    const state = attachPageCapture(page as never);
    await page.net.ready();
    page.net.request('https://example.test/a');
    clearNetworkCapture(state);
    expect(countRecentPendingRequests(state)).toBe(0);
  });

  it('peeks at 0 for a page that has no capture attached', () => {
    const page = makePage();
    expect(peekRecentPendingRequests(page as never)).toBe(0);
  });

  it('stops tracking once the page closes', () => {
    const page = makePage();
    attachPageCapture(page as never);
    page.emit('close', undefined);
    expect(peekRecentPendingRequests(page as never)).toBe(0);
  });
});

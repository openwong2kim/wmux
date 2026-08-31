import { describe, expect, it, vi } from 'vitest';
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
  return {
    handlers,
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

function request(url: string) {
  return { url: () => url, method: () => 'GET' };
}

describe('pageCapture pending-request tracking', () => {
  it('counts a started request and drops it on requestfinished', () => {
    const page = makePage();
    const state = attachPageCapture(page as never);
    const req = request('https://example.test/a.json');

    page.emit('request', req);
    expect(countRecentPendingRequests(state)).toBe(1);

    page.emit('requestfinished', req);
    expect(countRecentPendingRequests(state)).toBe(0);
  });

  it('drops it on requestfailed too — a counter that only settles on success leaks', () => {
    const page = makePage();
    const state = attachPageCapture(page as never);
    const req = request('https://example.test/blocked.js');

    page.emit('request', req);
    page.emit('requestfailed', req);
    expect(countRecentPendingRequests(state)).toBe(0);
  });

  it('excludes a request older than the recency window', () => {
    const page = makePage();
    const state = attachPageCapture(page as never);
    const stream = request('https://example.test/events');
    page.emit('request', stream);

    const later = Date.now() + PENDING_RECENCY_MS + 1;
    expect(countRecentPendingRequests(state, later)).toBe(0);
    // Still tracked — only the settle events remove it.
    expect(state.pendingRequests.size).toBe(1);
  });

  it('clears pending state with the network buffer', () => {
    const page = makePage();
    const state = attachPageCapture(page as never);
    page.emit('request', request('https://example.test/a'));
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

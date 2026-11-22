import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkTapReady, tapPageNetwork } from '../pageNetwork';
import { fakeNetwork } from './fakeNetworkSession';

afterEach(() => {
  vi.useRealTimers();
});

describe('tapPageNetwork', () => {
  it('tries a failed session open again after the cooldown, keeping the listeners', async () => {
    vi.useFakeTimers();
    const { newCDPSession, net } = fakeNetwork();
    let fail = true;
    const open = vi.fn(async () => {
      if (fail) throw new Error('relay hiccup');
      return newCDPSession();
    });
    const page = Object.assign(new EventEmitter(), { context: () => ({ newCDPSession: open }) }) as unknown as Page;
    const seen: string[] = [];
    tapPageNetwork(page, { onRequest: (r) => seen.push(r.url) });
    expect(await networkTapReady(page, 1_000)).toBe(false);

    // Inside the cooldown: no new attempt.
    tapPageNetwork(page, {});
    expect(open).toHaveBeenCalledTimes(1);

    fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    tapPageNetwork(page, {});
    expect(await networkTapReady(page, 1_000)).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
    net.request('https://x.test/after-retry');
    expect(seen).toEqual(['https://x.test/after-retry']);

    // A session that is open is never reopened.
    await vi.advanceTimersByTimeAsync(60_000);
    tapPageNetwork(page, {});
    expect(open).toHaveBeenCalledTimes(2);
  });
});

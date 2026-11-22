import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_SESSIONS, networkTapReady, tapPageNetwork } from '../pageNetwork';
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

  it('opens one session per out-of-process iframe, capped, and detaches it with the frame', async () => {
    const main = fakeNetwork();
    const mainFrame = { isDetached: () => false };
    const inProcess = { isDetached: () => false };
    const oopifs = Array.from({ length: MAX_FRAME_SESSIONS + 2 }, () => ({ frame: { isDetached: () => false }, ...fakeNetwork() }));
    const emitter = new EventEmitter();
    const page = Object.assign(emitter, {
      mainFrame: () => mainFrame,
      frames: () => [mainFrame, inProcess, oopifs[0].frame],
      context: () => ({
        newCDPSession: async (target: unknown) => {
          if (target === page) return main.newCDPSession();
          const oopif = oopifs.find((o) => o.frame === target);
          if (!oopif) throw new Error('This frame does not have a separate CDP session');
          return oopif.newCDPSession();
        },
      }),
    }) as unknown as Page & EventEmitter;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: Array<[string, boolean]> = [];
    tapPageNetwork(page, { onRequest: (r) => seen.push([r.url, r.mainFrame]) });
    expect(await networkTapReady(page, 1_000)).toBe(true);
    await oopifs[0].net.ready();

    // An iframe present at attach is tapped; its requests are not the main frame's.
    oopifs[0].net.request('https://ads.test/beacon');
    expect(seen).toEqual([['https://ads.test/beacon', false]]);

    // Later iframes are tapped as they navigate, up to the cap, which is logged once.
    for (const o of oopifs.slice(1)) emitter.emit('framenavigated', o.frame);
    for (const o of oopifs) await o.net.ready();
    const enabled = oopifs.filter((o) => o.net.sent.some((c) => c.method === 'Network.enable'));
    expect(enabled).toHaveLength(MAX_FRAME_SESSIONS);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('iframe sessions'))).toHaveLength(1);

    emitter.emit('framedetached', oopifs[0].frame);
    await oopifs[0].net.ready();
    expect(oopifs[0].net.detached()).toBe(true);
    err.mockRestore();
  });
});

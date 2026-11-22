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
    // The readiness wait a tool resolve makes is enough to try again.
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
    const oopifs = Array.from({ length: MAX_FRAME_SESSIONS + 2 }, () => ({ frame: { isDetached: (): boolean => false }, ...fakeNetwork() }));
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

    // In-process iframes do not take cross-site ones' places, even when tapped all at once.
    const busy = Array.from({ length: MAX_FRAME_SESSIONS + 4 }, () => ({ isDetached: () => false }));
    const fresh = fakeNetwork();
    const crossSite = { isDetached: () => false };
    oopifs.push({ frame: crossSite, ...fresh });
    for (const o of oopifs.slice(1, MAX_FRAME_SESSIONS + 1)) emitter.emit('framedetached', o.frame);
    for (const f of busy) emitter.emit('framenavigated', f);
    emitter.emit('framenavigated', crossSite);
    await fresh.net.ready();
    expect(fresh.net.sent.some((c) => c.method === 'Network.enable')).toBe(true);

    emitter.emit('framedetached', oopifs[0].frame);
    await oopifs[0].net.ready();
    expect(oopifs[0].net.detached()).toBe(true);
    err.mockRestore();
  });

  it('fails a dropped iframe session\'s unsettled requests, so nothing waits on them', async () => {
    const main = fakeNetwork();
    const frameNet = fakeNetwork();
    const mainFrame = { isDetached: () => false };
    const frame = { isDetached: () => false };
    const emitter = new EventEmitter();
    const page = Object.assign(emitter, {
      mainFrame: () => mainFrame,
      frames: () => [mainFrame, frame],
      context: () => ({ newCDPSession: async (t: unknown) => (t === page ? main.newCDPSession() : frameNet.newCDPSession()) }),
    }) as unknown as Page & EventEmitter;
    const failed: string[] = [];
    tapPageNetwork(page, { onFailed: (id) => failed.push(id) });
    await networkTapReady(page, 1_000);
    await frameNet.net.ready();

    const done = frameNet.net.request('https://ads.test/done');
    frameNet.net.finish(done);
    const hung = frameNet.net.request('https://ads.test/long-poll');
    emitter.emit('framedetached', frame);

    expect(failed).toEqual([hung]);
    await frameNet.net.ready();
    expect(frameNet.net.detached()).toBe(true);
  });

  it('looks at a frame again when it navigated while its session was being opened', async () => {
    const main = fakeNetwork();
    const frameNet = fakeNetwork();
    const mainFrame = { isDetached: () => false };
    const frame = { isDetached: () => false };
    let crossSite = false;
    let releaseFirst: () => void = () => undefined;
    const emitter = new EventEmitter();
    const page = Object.assign(emitter, {
      mainFrame: () => mainFrame,
      frames: () => [mainFrame],
      context: () => ({
        newCDPSession: async (t: unknown) => {
          if (t === page) return main.newCDPSession();
          if (!crossSite) {
            // about:blank: in-process, and the answer takes a while.
            await new Promise<void>((resolve) => { releaseFirst = resolve; });
            throw new Error('This frame does not have a separate CDP session');
          }
          return frameNet.newCDPSession();
        },
      }),
    }) as unknown as Page & EventEmitter;
    tapPageNetwork(page, {});
    await networkTapReady(page, 1_000);

    emitter.emit('framenavigated', frame); // about:blank commit
    await main.net.ready();
    crossSite = true;
    emitter.emit('framenavigated', frame); // cross-site commit, mid-open
    releaseFirst();
    await frameNet.net.ready();

    expect(frameNet.net.sent.some((c) => c.method === 'Network.enable')).toBe(true);
  });
});

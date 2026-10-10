import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  COLLECT_WINDOW_MS,
  REQUEST_GRACE_MS,
  SETTLE_CAP_MS,
  settleAfterAction,
  trackRequestBaseline,
} from '../../actionSettle';
import { fakeRequest, makeFakePage } from './fakePage';

/*
 * The settle decision table. Fake timers make every row exact: the claim under
 * test is not "fast enough" but "returns at this tick", which is what the
 * no-regression promise (nothing past the 100ms grace when the action starts
 * no request) actually says.
 */

type Fake = ReturnType<typeof makeFakePage>;

/** Run settle and report the fake-clock ms at which it resolved. */
function track(fake: Fake, fn: () => Promise<unknown> = async () => 'done') {
  const started = Date.now();
  let settledAt: number | undefined;
  const promise = settleAfterAction(fake.page as unknown as Page, fn).then((value) => {
    settledAt = Date.now() - started;
    return value;
  });
  return { promise, settledAt: () => settledAt };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('settleAfterAction decision table', () => {
  it('no request within the grace window: returns at the grace tick, no later', async () => {
    const fake = makeFakePage();
    const run = track(fake);

    await vi.advanceTimersByTimeAsync(REQUEST_GRACE_MS - 1);
    expect(run.settledAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.settledAt()).toBe(REQUEST_GRACE_MS);
    await expect(run.promise).resolves.toBe('done');
  });

  it('a page with no event API runs the action and adds no wait at all', async () => {
    await expect(settleAfterAction({} as Page, async () => 7)).resolves.toBe(7);
  });

  it('an xhr waits past the collect window until it finishes', async () => {
    const fake = makeFakePage();
    const xhr = fakeRequest('xhr');
    const run = track(fake, async () => {
      fake.page.emit('request', xhr);
    });

    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 200);
    expect(run.settledAt()).toBeUndefined();
    fake.page.emit('requestfinished', xhr);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 200);
  });

  it('a request that finished inside the collect window costs exactly the window', async () => {
    const fake = makeFakePage();
    const xhr = fakeRequest('fetch');
    const run = track(fake, async () => {
      fake.page.emit('request', xhr);
    });
    await vi.advanceTimersByTimeAsync(50);
    fake.page.emit('requestfinished', xhr);
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS);
  });

  it('a failed request counts as done (no 5s penalty for a blocked tracker)', async () => {
    const fake = makeFakePage();
    const xhr = fakeRequest('xhr');
    const run = track(fake, async () => {
      fake.page.emit('request', xhr);
    });
    await vi.advanceTimersByTimeAsync(10);
    fake.page.emit('requestfailed', xhr);
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS);
  });

  it('a request that starts late, inside the grace window, still counts', async () => {
    const fake = makeFakePage();
    const run = track(fake);
    await vi.advanceTimersByTimeAsync(60);
    const xhr = fakeRequest('xhr');
    fake.page.emit('request', xhr);
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(run.settledAt()).toBeUndefined();
    fake.page.emit('requestfinished', xhr);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settledAt()).toBe(60 + COLLECT_WINDOW_MS);
  });

  it('images, beacons and pings do not count as traffic: grace tick, not the window', async () => {
    const fake = makeFakePage();
    const run = track(fake, async () => {
      fake.page.emit('request', fakeRequest('image'));
      fake.page.emit('request', fakeRequest('ping'));
      fake.page.emit('request', fakeRequest('beacon'));
    });
    await vi.advanceTimersByTimeAsync(REQUEST_GRACE_MS);
    expect(run.settledAt()).toBe(REQUEST_GRACE_MS);
  });

  it('requests starting after the collect window are not waited for (polling)', async () => {
    const fake = makeFakePage();
    const first = fakeRequest('xhr');
    const run = track(fake, async () => {
      fake.page.emit('request', first);
    });
    await vi.advanceTimersByTimeAsync(20);
    fake.page.emit('requestfinished', first);
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS - 20 - 1);
    expect(run.settledAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    // The poll fires right after the window closed; it never finishes.
    fake.page.emit('request', fakeRequest('xhr'));
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS);
  });

  it('a URL that starts twice in the window is polling: not waited for', async () => {
    const fake = makeFakePage();
    const poll = () => fakeRequest('fetch', { url: 'https://site.test/poll?t=' + Math.random() });
    const run = track(fake, async () => {
      fake.page.emit('request', poll());
    });
    await vi.advanceTimersByTimeAsync(200);
    fake.page.emit('request', poll());
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS - 200);
    // Both polls are still open, but neither belongs to the action.
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS);
  });

  it('the action’s own request is still waited for next to a poll', async () => {
    const fake = makeFakePage();
    const own = fakeRequest('xhr', { url: 'https://site.test/api/save' });
    const run = track(fake, async () => {
      fake.page.emit('request', own);
      fake.page.emit('request', fakeRequest('fetch', { url: 'https://site.test/poll?a' }));
      fake.page.emit('request', fakeRequest('fetch', { url: 'https://site.test/poll?b' }));
    });
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 100);
    expect(run.settledAt()).toBeUndefined();
    fake.page.emit('requestfinished', own);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 100);
  });

  it('a navigation whose document finished before the commit still waits for load', async () => {
    const fake = makeFakePage();
    const nav = fakeRequest('document', { navigation: true, frame: fake.mainFrame });
    const run = track(fake, async () => {
      fake.page.emit('request', nav);
    });
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 10);
    fake.page.emit('requestfinished', nav);
    await vi.advanceTimersByTimeAsync(20);
    fake.page.emit('framenavigated', fake.mainFrame);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.page.waitForLoadState).toHaveBeenCalled();
    expect(run.settledAt()).toBeUndefined();
    fake.finishLoad();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 30);
  });

  describe('per-page request baseline', () => {
    const poll = () => fakeRequest('fetch', { url: 'https://site.test/poll?t=' + Math.random() });

    /** The page polls every `period` ms, `count` times, before the action. */
    async function pollBefore(fake: Fake, period: number, count: number) {
      trackRequestBaseline(fake.page as unknown as Page);
      for (let i = 0; i < count; i++) {
        fake.page.emit('request', poll());
        await vi.advanceTimersByTimeAsync(period);
      }
    }

    it('a poll the page already repeats lands in the grace window: no extra wait', async () => {
      const fake = makeFakePage();
      await pollBefore(fake, 150, 3);
      const run = track(fake);
      await vi.advanceTimersByTimeAsync(20);
      fake.page.emit('request', poll()); // the page's next poll, not the click's
      await vi.advanceTimersByTimeAsync(REQUEST_GRACE_MS - 20);
      expect(run.settledAt()).toBe(REQUEST_GRACE_MS);
    });

    it('the action’s own XHR is still waited for on a polling page', async () => {
      const fake = makeFakePage();
      await pollBefore(fake, 150, 3);
      const own = fakeRequest('xhr', { url: 'https://site.test/api/save' });
      const run = track(fake, async () => {
        fake.page.emit('request', poll());
        fake.page.emit('request', own);
      });
      await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 100);
      expect(run.settledAt()).toBeUndefined();
      fake.page.emit('requestfinished', own);
      await vi.advanceTimersByTimeAsync(0);
      expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 100);
    });

    it('a request seen only once before has no rhythm yet and still counts', async () => {
      const fake = makeFakePage();
      await pollBefore(fake, 150, 1);
      const again = poll();
      const run = track(fake, async () => {
        fake.page.emit('request', again);
      });
      await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 50);
      expect(run.settledAt()).toBeUndefined();
      fake.page.emit('requestfinished', again);
      await vi.advanceTimersByTimeAsync(0);
      expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 50);
    });

    it('a rhythm that stopped long before the action no longer excuses the request', async () => {
      const fake = makeFakePage();
      await pollBefore(fake, 150, 3);
      await vi.advanceTimersByTimeAsync(5_000);
      const late = poll();
      const run = track(fake, async () => {
        fake.page.emit('request', late);
      });
      await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 50);
      expect(run.settledAt()).toBeUndefined();
      fake.page.emit('requestfinished', late);
      await vi.advanceTimersByTimeAsync(0);
      expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 50);
    });

    it('an agent repeating the same click does not teach the page a rhythm', async () => {
      const fake = makeFakePage();
      trackRequestBaseline(fake.page as unknown as Page);
      for (let i = 0; i < 3; i++) {
        const own = fakeRequest('xhr', { url: 'https://site.test/api/load' });
        const run = track(fake, async () => {
          fake.page.emit('request', own);
        });
        await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 30);
        // Waited for every time, the third click included.
        expect(run.settledAt()).toBeUndefined();
        fake.page.emit('requestfinished', own);
        await vi.advanceTimersByTimeAsync(0);
        expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 30);
        await vi.advanceTimersByTimeAsync(100);
      }
    });

    it('a different method on the same URL is a different request', async () => {
      const fake = makeFakePage();
      await pollBefore(fake, 150, 3);
      const post = { ...poll(), method: () => 'POST' };
      const run = track(fake, async () => {
        fake.page.emit('request', post);
      });
      await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 10);
      expect(run.settledAt()).toBeUndefined();
      fake.page.emit('requestfinished', post);
      await vi.advanceTimersByTimeAsync(0);
      expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 10);
    });
  });

  it('a hung request is capped at SETTLE_CAP_MS', async () => {
    const fake = makeFakePage();
    const run = track(fake, async () => {
      fake.page.emit('request', fakeRequest('fetch'));
    });
    await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS - 1);
    expect(run.settledAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.settledAt()).toBe(SETTLE_CAP_MS);
  });

  it('a main-frame navigation waits for its own commit, then for load', async () => {
    const fake = makeFakePage();
    const run = track(fake, async () => {
      fake.page.emit('request', fakeRequest('document', { navigation: true, frame: fake.mainFrame }));
    });
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 300);
    // Not committed yet: the old document's `load` must not count.
    expect(fake.page.waitForLoadState).not.toHaveBeenCalled();
    fake.page.emit('framenavigated', fake.mainFrame);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.page.waitForLoadState).toHaveBeenCalledWith('load', expect.any(Object));
    expect(run.settledAt()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    fake.finishLoad();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 400);
  });

  it('a navigation that is aborted before it commits stops the wait', async () => {
    const fake = makeFakePage();
    const nav = fakeRequest('document', { navigation: true, frame: fake.mainFrame });
    const run = track(fake, async () => {
      fake.page.emit('request', nav);
    });
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 50);
    fake.page.emit('requestfailed', nav);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 50);
    expect(fake.page.waitForLoadState).not.toHaveBeenCalled();
  });

  it('an iframe navigation does not wait for the main frame', async () => {
    const fake = makeFakePage();
    const doc = fakeRequest('document', { navigation: true, frame: { name: 'child' } });
    const run = track(fake, async () => {
      fake.page.emit('request', doc);
    });
    await vi.advanceTimersByTimeAsync(20);
    fake.page.emit('requestfinished', doc);
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(fake.page.waitForLoadState).not.toHaveBeenCalled();
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS);
  });

  it('the action’s own rejection escapes; a settle wait never turns into one', async () => {
    const fake = makeFakePage();
    await expect(
      settleAfterAction(fake.page as unknown as Page, async () => {
        throw new Error('ref vanished');
      }),
    ).rejects.toThrow('ref vanished');

    const fake2 = makeFakePage();
    fake2.page.waitForLoadState.mockImplementation(() => Promise.reject(new Error('page closed')));
    const run = track(fake2, async () => {
      fake2.page.emit('request', fakeRequest('document', { navigation: true, frame: fake2.mainFrame }));
      fake2.page.emit('framenavigated', fake2.mainFrame);
    });
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    await expect(run.promise).resolves.toBeUndefined();
  });

  it('detaches every per-action listener; only the page baseline stays', async () => {
    const fake = makeFakePage();
    const run = track(fake);
    await vi.advanceTimersByTimeAsync(REQUEST_GRACE_MS);
    await run.promise;
    for (const event of ['requestfinished', 'requestfailed', 'framenavigated']) {
      expect(fake.page.listenerCount(event)).toBe(0);
    }
    // The baseline's one persistent listener, attached once per page.
    expect(fake.page.listenerCount('request')).toBe(1);
    const again = track(fake);
    await vi.advanceTimersByTimeAsync(REQUEST_GRACE_MS);
    await again.promise;
    expect(fake.page.listenerCount('request')).toBe(1);
  });
});

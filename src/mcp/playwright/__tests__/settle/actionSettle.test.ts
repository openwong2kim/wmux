import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  COLLECT_WINDOW_MS,
  REQUEST_GRACE_MS,
  SETTLE_CAP_MS,
  settleAfterAction,
} from '../../actionSettle';
import { attachModalTracking, beginAgentWindow } from '../../modalState';
import { fakeDialog, fakeRequest, makeFakePage } from './fakePage';

/*
 * The settle decision table. Fake timers make every row exact: the claim under
 * test is not "fast enough" but "returns at this tick", which is what the
 * no-regression promise (zero extra wait past the 100ms grace when the action
 * starts no request) actually says.
 */

type Fake = ReturnType<typeof makeFakePage>;

/** Run settle and report the fake-clock ms at which it resolved. */
function track(fake: Fake, fn: () => Promise<unknown> = async () => 'done') {
  const started = Date.now();
  let settledAt: number | undefined;
  const promise = settleAfterAction(fake.page as unknown as Page, fn).then((outcome) => {
    settledAt = Date.now() - started;
    return outcome;
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
    await expect(run.promise).resolves.toEqual({ interrupted: false, value: 'done' });
  });

  it('a page with no event API runs the action and adds no wait at all', async () => {
    const outcome = await settleAfterAction({} as Page, async () => 7);
    expect(outcome).toEqual({ interrupted: false, value: 7 });
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

  it('untracked types (image, ping) never hold it past the collect window', async () => {
    const fake = makeFakePage();
    const run = track(fake, async () => {
      fake.page.emit('request', fakeRequest('image'));
      fake.page.emit('request', fakeRequest('ping'));
    });
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS);
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

  it('a main-frame navigation waits for load', async () => {
    const fake = makeFakePage();
    const run = track(fake, async () => {
      fake.page.emit('request', fakeRequest('document', { navigation: true, frame: fake.mainFrame }));
    });
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + 300);
    expect(fake.page.waitForLoadState).toHaveBeenCalledWith('load', expect.any(Object));
    expect(run.settledAt()).toBeUndefined();
    fake.finishLoad();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.settledAt()).toBe(COLLECT_WINDOW_MS + 300);
  });

  it('an iframe navigation does not wait for the main frame to load', async () => {
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

  it('the action’s own rejection escapes; a settle wait never does', async () => {
    const fake = makeFakePage();
    const failing = settleAfterAction(fake.page as unknown as Page, async () => {
      throw new Error('ref vanished');
    });
    await expect(failing).rejects.toThrow('ref vanished');

    const fake2 = makeFakePage();
    fake2.page.waitForLoadState.mockImplementation(() => Promise.reject(new Error('page closed')));
    const run = track(fake2, async () => {
      fake2.page.emit('request', fakeRequest('document', { navigation: true, frame: fake2.mainFrame }));
    });
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    await expect(run.promise).resolves.toEqual({ interrupted: false, value: undefined });
  });

  it('detaches every listener it added', async () => {
    const fake = makeFakePage();
    const run = track(fake);
    await vi.advanceTimersByTimeAsync(REQUEST_GRACE_MS);
    await run.promise;
    for (const event of ['request', 'requestfinished', 'requestfailed']) {
      expect(fake.page.listenerCount(event)).toBe(0);
    }
  });

  it('a dialog opening mid-action returns at once, reported as interrupted', async () => {
    const fake = makeFakePage();
    const page = fake.page as unknown as Page;
    attachModalTracking(page, { scopeKey: 'ws:w:surf:s', fileChooser: false });
    const end = beginAgentWindow('w', 's');
    // A click whose dispatch cannot return while the alert is up.
    const outcome = settleAfterAction(page, () => {
      fake.page.emit('dialog', fakeDialog('alert', 'Saved!'));
      return new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(outcome).resolves.toMatchObject({
      interrupted: true,
      modal: { type: 'alert', message: 'Saved!', causedByAgent: true },
    });
    end();
  });
});

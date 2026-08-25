/**
 * UsagePoller lifecycle tests. Uses fake timers and injected fetch/load
 * so a real polling cadence is simulated in milliseconds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UsagePoller, type PollerState } from '../UsagePoller';
import type { LoadResult } from '../claudeCredential';

const ANY_TOKEN = 'sk-ant-test-1234567890';

const OK_CREDENTIAL: LoadResult = {
  ok: true,
  credential: {
    accessToken: ANY_TOKEN,
    subscriptionType: 'pro',
    rateLimitTier: 'standard',
    expiresAtMs: null,
  },
};

function makeOkFetch(): typeof fetch {
  const headers = new Headers({
    'anthropic-ratelimit-unified-5h-utilization': '0.5',
    'anthropic-ratelimit-unified-5h-reset': '1700000000',
    'anthropic-ratelimit-unified-7d-utilization': '0.1',
    'anthropic-ratelimit-unified-7d-reset': '1700100000',
  });
  return vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers })) as unknown as typeof fetch;
}

/** Build a credential result around a token the caller can swap, so a
 *  test can stand in for Claude Code rewriting `.credentials.json`. */
function credentialFor(accessToken: string): LoadResult {
  return {
    ok: true,
    credential: {
      accessToken,
      subscriptionType: 'pro',
      rateLimitTier: 'standard',
      expiresAtMs: null,
    },
  };
}

/** Call count of an injected fetch stub. The suite types its stubs as
 *  `typeof fetch`, which TS will not narrow back to a mock on its own. */
function callCount(impl: typeof fetch): number {
  return (impl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

/** The `authorization` header of the nth call to an injected fetch stub. */
function bearerOf(impl: typeof fetch, callIndex: number): string {
  const calls = (impl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  const headers = calls[callIndex][1].headers as Record<string, string>;
  return headers.authorization;
}

/** A fresh 200 with the rate-limit headers the parser reads. New each
 *  call, because a Response body can only be consumed once. */
function okUsageResponse(): Response {
  return new Response('{}', {
    status: 200,
    headers: new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-5h-reset': '1700000000',
      'anthropic-ratelimit-unified-7d-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-reset': '1700100000',
    }),
  });
}

function makeFlushPromises(): () => Promise<void> {
  // Microtask queue is drained by `await Promise.resolve()` chains; we
  // need enough chains to cover queueMicrotask → loadCredential await
  // → fetchUsage await → setState. 5 chains is overkill-safe.
  return async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };
}

describe('UsagePoller', () => {
  let flushPromises: () => Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushPromises = makeFlushPromises();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in idle state', () => {
    const poller = new UsagePoller({
      intervalMs: 1000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl: makeOkFetch(),
    });
    expect(poller.getState().status).toBe('idle');
    poller.dispose();
  });

  it('fires an immediate fetch on start (setTimeout(0), not the interval)', async () => {
    const onState = vi.fn();
    const poller = new UsagePoller({
      intervalMs: 100_000, // way beyond test, ensures the microtask is the source
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl: makeOkFetch(),
    });
    poller.onStateChange(onState);
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    const state = poller.getState();
    expect(state.status).toBe('ok');
    expect(state.snapshot?.sessionPct).toBe(50);
    poller.dispose();
  });

  it('records subscriptionType from the credential on success', async () => {
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl: makeOkFetch(),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().subscriptionType).toBe('pro');
    poller.dispose();
  });

  it('emits token-missing when credential not found', async () => {
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: async () => ({ ok: false, reason: 'not-found' }),
      fetchImpl: makeOkFetch(),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().status).toBe('token-missing');
    poller.dispose();
  });

  it('emits unauthorized on 401 and stops re-sending the refused token', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response('unauth', { status: 401 })) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      unauthorizedRecheckMs: 1000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().status).toBe('unauthorized');
    // The interval stays armed (that is what lets the status recover on
    // its own), but every one of those recheck ticks stops at the
    // credential read: the token on disk is the one already refused, so
    // Anthropic still sees exactly the first 401 and no more.
    expect(callCount(fetchImpl)).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(poller.getState().status).toBe('unauthorized');
    expect(callCount(fetchImpl)).toBe(1);
    poller.dispose();
  });

  it('retries a still-refused token once per poll interval, not once per recheck', async () => {
    // A 401 is not proof the token is bad — an auth outage or a policy
    // since reverted produces one too, and no credential will ever
    // change to release it. So the skip expires after intervalMs: the
    // rechecks in between cost nothing, and the retry rate settles at
    // exactly what a healthy poller spends.
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response('unauth', { status: 401 })) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 10_000,
      unauthorizedRecheckMs: 1000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(1);

    // Nine rechecks inside the poll period: credential read each time,
    // no request.
    await vi.advanceTimersByTimeAsync(9_000);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(1);

    // The period elapses — exactly one retry, and it restarts the clock
    // rather than opening the gate for every recheck after it.
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(2);

    // A second full period behaves the same, so the rate is a steady one
    // request per interval and not a one-off that then drifts.
    await vi.advanceTimersByTimeAsync(6_000);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(3);
    expect(poller.getState().status).toBe('unauthorized');
    poller.dispose();
  });

  it('clears unauthorized by itself once Claude Code writes a new token (#1012)', async () => {
    let token = 'stale-token';
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => new Response('unauth', { status: 401 }))
      .mockImplementation(
        async () =>
          new Response('{}', {
            status: 200,
            headers: new Headers({
              'anthropic-ratelimit-unified-5h-utilization': '0.5',
              'anthropic-ratelimit-unified-5h-reset': '1700000000',
              'anthropic-ratelimit-unified-7d-utilization': '0.1',
              'anthropic-ratelimit-unified-7d-reset': '1700100000',
            }),
          }),
      ) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      unauthorizedRecheckMs: 1000,
      loadCredential: async () => credentialFor(token),
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().status).toBe('unauthorized');
    expect(bearerOf(fetchImpl, 0)).toBe('Bearer stale-token');

    // The re-login. No toggle, no button, no window event — only the
    // credential on disk changing under a poller that stayed armed.
    token = 'fresh-token';
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(2);
    expect(bearerOf(fetchImpl, 1)).toBe('Bearer fresh-token');
    expect(poller.getState().status).toBe('ok');
    expect(poller.getState().snapshot?.sessionPct).toBe(50);

    // And it is back on the normal cadence, not the recheck one: the
    // recheck interval elapsing must not, on its own, buy a new fetch.
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(2);
    poller.dispose();
  });

  it('keeps re-reading the credential on every recheck while it withholds the request', async () => {
    // The recheck is only worth arming if it actually looks. Count the
    // credential reads as well as the requests: many of the first, one
    // of the second.
    let loads = 0;
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response('unauth', { status: 401 })) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      unauthorizedRecheckMs: 1000,
      loadCredential: async () => {
        loads += 1;
        return OK_CREDENTIAL;
      },
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().status).toBe('unauthorized');
    const loadsAfterFirst = loads;
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(loads).toBeGreaterThanOrEqual(loadsAfterFirst + 9);
    expect(callCount(fetchImpl)).toBe(1);
    poller.dispose();
  });

  it('does not let a momentary credential miss cost a whole poll interval', async () => {
    // Claude Code replacing .credentials.json is exactly when a read can
    // come back empty, and it is exactly when recovery is arriving. If
    // that one tick dropped back to the hourly cadence, the new token
    // would sit unprobed for up to an hour — the #1012 symptom again,
    // one state over.
    let call = 0;
    const load = async (): Promise<LoadResult> => {
      call += 1;
      if (call === 1) return credentialFor('stale-token');
      if (call === 2) return { ok: false, reason: 'not-found' };
      return credentialFor('fresh-token');
    };
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => new Response('unauth', { status: 401 }))
      .mockImplementation(async () => okUsageResponse()) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      unauthorizedRecheckMs: 1000,
      loadCredential: load,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().status).toBe('unauthorized');

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(poller.getState().status).toBe('token-missing');

    // One more recheck period, not one more poll interval.
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(poller.getState().status).toBe('ok');
    expect(bearerOf(fetchImpl, 1)).toBe('Bearer fresh-token');
    poller.dispose();
  });

  it('abandons a tick whose session was stopped while it read the credential', async () => {
    // The recheck introduced an await that runs while the poller is in
    // its wrong state, so stop() can now land inside one. Without a
    // lifecycle guard the tick resumes into a cleared pin, finds the
    // skip no longer true, and sends the very credential the skip
    // exists to withhold — after the user turned the meter off.
    // Definite-assignment: the executor runs synchronously inside the
    // second load(), but TS cannot see a closure assignment as a
    // reassignment and would narrow a nullable binding to `never`.
    let release!: (value: LoadResult) => void;
    let call = 0;
    const load = (): Promise<LoadResult> => {
      call += 1;
      if (call === 1) return Promise.resolve(OK_CREDENTIAL);
      return new Promise<LoadResult>((resolve) => {
        release = resolve;
      });
    };
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response('unauth', { status: 401 })) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      unauthorizedRecheckMs: 1000,
      loadCredential: load,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().status).toBe('unauthorized');
    expect(callCount(fetchImpl)).toBe(1);

    await vi.advanceTimersByTimeAsync(1000); // the recheck is now awaiting the read
    expect(typeof release).toBe('function');
    poller.stop();
    expect(poller.getState().status).toBe('idle');

    release(OK_CREDENTIAL);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(1);
    expect(poller.getState().status).toBe('idle');
    poller.dispose();
  });

  it('refreshNow() waits out an in-flight tick instead of being dropped by it', async () => {
    // Before the recheck cadence existed there were no background ticks
    // at all in the unauthorized state, so the re-entry guard could not
    // eat a manual refresh. Now there are, and the button has to survive
    // landing on one.
    let release!: (value: LoadResult) => void;
    let call = 0;
    const load = (): Promise<LoadResult> => {
      call += 1;
      if (call === 1) {
        return new Promise<LoadResult>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(OK_CREDENTIAL);
    };
    const fetchImpl = makeOkFetch();
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: load,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1); // the first tick is awaiting the read
    expect(typeof release).toBe('function');
    const refreshed = poller.refreshNow();
    release(OK_CREDENTIAL);
    await refreshed;
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(2);
    poller.dispose();
  });

  it('abandons a tick whose session was stopped while it awaited the request', async () => {
    // The sibling case to the credential-read one: the lifecycle guard
    // has to hold on BOTH awaits, or a response that outlives its own
    // session repaints a status the toggle already turned off — and,
    // for a 401, pins a token for a poller that is no longer running.
    let release!: (value: Response) => void;
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      unauthorizedRecheckMs: 1000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(typeof release).toBe('function');

    poller.stop();
    expect(poller.getState().status).toBe('idle');
    release(new Response('unauth', { status: 401 }));
    await flushPromises();
    // Neither the status nor the cadence may come from a session that
    // ended: no repaint, and no interval put back by the stale finally.
    expect(poller.getState().status).toBe('idle');
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(1);
    expect(poller.getState().status).toBe('idle');
    poller.dispose();
  });

  it('keeps the fast cadence through an unreadable credential too, not just a missing one', async () => {
    // Same reasoning as the not-found case: a read that fails once is
    // not evidence that the refusal is settled, and dropping back to
    // the hourly poll there would cost the new token an hour.
    let call = 0;
    const load = async (): Promise<LoadResult> => {
      call += 1;
      if (call === 1) return credentialFor('stale-token');
      if (call === 2) return { ok: false, reason: 'read-error', detail: 'EBUSY' };
      return credentialFor('fresh-token');
    };
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => new Response('unauth', { status: 401 }))
      .mockImplementation(async () => okUsageResponse()) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      unauthorizedRecheckMs: 1000,
      loadCredential: load,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().status).toBe('unauthorized');

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(poller.getState().status).toBe('read-error');

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(poller.getState().status).toBe('ok');
    expect(bearerOf(fetchImpl, 1)).toBe('Bearer fresh-token');
    poller.dispose();
  });

  it('gives every queued manual refresh its own pass, not just the first', async () => {
    // Two clicks landing on one hung read used to leave the second
    // caller with nothing: it woke up, saw the first waiter had already
    // taken the slot, and returned as if it had been served.
    let release!: (value: LoadResult) => void;
    let call = 0;
    const load = (): Promise<LoadResult> => {
      call += 1;
      if (call === 1) {
        return new Promise<LoadResult>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(OK_CREDENTIAL);
    };
    const fetchImpl = makeOkFetch();
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: load,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(typeof release).toBe('function');
    const first = poller.refreshNow();
    const second = poller.refreshNow();
    release(OK_CREDENTIAL);
    await Promise.all([first, second]);
    await flushPromises();
    // One for the tick that was already running, one for each click.
    expect(callCount(fetchImpl)).toBe(3);
    poller.dispose();
  });

  it("does not let a stopped session's in-flight tick swallow the next session's first fetch", async () => {
    // Toggling off and back on during a slow credential read leaves a
    // tick from the dead session in flight. The new session's opening
    // fetch must not stand down for it — that pass is going to throw
    // its own result away, and standing down for it costs the widget a
    // whole poll interval of emptiness.
    let release!: (value: LoadResult) => void;
    let call = 0;
    const load = (): Promise<LoadResult> => {
      call += 1;
      if (call === 1) {
        return new Promise<LoadResult>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(OK_CREDENTIAL);
    };
    const fetchImpl = makeOkFetch();
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: load,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1); // first tick is awaiting the read
    expect(typeof release).toBe('function');
    poller.stop();
    poller.start();
    await vi.advanceTimersByTimeAsync(1); // the new session's immediate tick
    release(OK_CREDENTIAL);
    await flushPromises();
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(1);
    expect(poller.getState().status).toBe('ok');
    poller.dispose();
  });

  it('does not run a queued tick for a session that was stopped while it waited', async () => {
    // The wait for a busy slot is the one place a tick can outlive its
    // own session without being inside an await of its own. If it takes
    // the generation that happens to be current when the slot opens
    // rather than the one it was scheduled under, a stop() in between
    // buys a credential read and a request with the meter switched off,
    // and a status no live timer is left to correct.
    let release!: (value: LoadResult) => void;
    let call = 0;
    const load = (): Promise<LoadResult> => {
      call += 1;
      if (call === 1) {
        return new Promise<LoadResult>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(OK_CREDENTIAL);
    };
    const fetchImpl = makeOkFetch();
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: load,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1); // tick A is hung on the read
    expect(typeof release).toBe('function');
    const refreshed = poller.refreshNow(); // queued behind A
    poller.stop();
    release(OK_CREDENTIAL);
    await refreshed;
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(0);
    expect(poller.getState().status).toBe('idle');
    poller.dispose();
  });

  it('still withholds a refused token that reappears unchanged after a failed read', async () => {
    // The skip is the pin and its age, and nothing else. Keying it on
    // the displayed status too would release it here: one unreadable
    // read moves the chip off 'unauthorized' while the credential
    // underneath never changed, and the next tick would re-send exactly
    // the token the skip exists to withhold.
    let call = 0;
    const load = async (): Promise<LoadResult> => {
      call += 1;
      if (call === 2) return { ok: false, reason: 'read-error', detail: 'EBUSY' };
      return credentialFor('stale-token');
    };
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response('unauth', { status: 401 })) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      unauthorizedRecheckMs: 1000,
      loadCredential: load,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().status).toBe('unauthorized');
    expect(callCount(fetchImpl)).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(poller.getState().status).toBe('read-error');

    // The same token is back and the poll period has not elapsed, so
    // nothing goes out — however the chip currently reads.
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(1);
    expect(call).toBeGreaterThan(10);
    poller.dispose();
  });

  it("coalesces the interval ticks that pile up behind a stopped session's read", async () => {
    // Several firings of the new session's interval can queue on one
    // slow read left by the old session. They are all asking the same
    // question, so the slot opening must buy one pass, not one per
    // firing.
    let release!: (value: LoadResult) => void;
    let call = 0;
    const load = (): Promise<LoadResult> => {
      call += 1;
      if (call === 1) {
        return new Promise<LoadResult>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(OK_CREDENTIAL);
    };
    const fetchImpl = makeOkFetch();
    const poller = new UsagePoller({
      intervalMs: 1000,
      loadCredential: load,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1); // tick A hangs, session 1
    expect(typeof release).toBe('function');
    poller.stop();
    poller.start(); // session 2; A is now a corpse the new ticks may pass
    await vi.advanceTimersByTimeAsync(3_500); // immediate tick + 3 interval firings
    release(OK_CREDENTIAL);
    // Drained without advancing the clock, so anything that runs here
    // ran because a waiter took the slot, not because a new firing did.
    // Generous enough for four sequential passes to complete if the
    // waiters were not coalescing.
    for (let i = 0; i < 20; i++) await flushPromises();
    expect(callCount(fetchImpl)).toBe(1);
    expect(poller.getState().status).toBe('ok');
    poller.dispose();
  });

  it('refreshNow() re-sends even a token that was already refused', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response('unauth', { status: 401 })) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      unauthorizedRecheckMs: 1000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(callCount(fetchImpl)).toBe(1);
    // The button is an explicit user action, so it outranks the skip —
    // the user may have fixed something the credential file cannot show.
    await poller.refreshNow();
    expect(callCount(fetchImpl)).toBe(2);
    expect(bearerOf(fetchImpl, 1)).toBe(bearerOf(fetchImpl, 0));
    expect(poller.getState().status).toBe('unauthorized');
    poller.dispose();
  });

  it('refreshNow() is honored while the window is hidden past the skip threshold', async () => {
    const fetchImpl = makeOkFetch();
    let mockNow = 1_700_000_000_000;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      hiddenSkipThresholdMs: 5000,
      now: () => mockNow,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    poller.setWindowVisible(false);
    mockNow += 10_000;
    const before = callCount(fetchImpl);
    await poller.refreshNow();
    expect(callCount(fetchImpl)).toBe(before + 1);
    poller.dispose();
  });

  it('keeps poller running on network error (retries on next tick)', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 200,
          headers: new Headers({
            'anthropic-ratelimit-unified-5h-utilization': '0.42',
            'anthropic-ratelimit-unified-5h-reset': '1700000000',
            'anthropic-ratelimit-unified-7d-utilization': '0.05',
            'anthropic-ratelimit-unified-7d-reset': '1700100000',
          }),
        }),
      ) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 1000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().status).toBe('network-error');
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(poller.getState().status).toBe('ok');
    expect(poller.getState().snapshot?.sessionPct).toBe(42);
    poller.dispose();
  });

  it('refreshNow() bypasses interval timing', async () => {
    const fetchImpl = makeOkFetch();
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    const firstCall = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await poller.refreshNow();
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(firstCall + 1);
    poller.dispose();
  });

  it('hidden-window skip applies after threshold, NOT before', async () => {
    const fetchImpl = makeOkFetch();
    let mockNow = 1_700_000_000_000;
    const poller = new UsagePoller({
      intervalMs: 1000,
      hiddenSkipThresholdMs: 5000,
      now: () => mockNow,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    const initialCallCount = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    // Hide window.
    poller.setWindowVisible(false);
    // 2s later — within threshold — interval should still fire.
    mockNow += 2000;
    vi.advanceTimersByTime(1000);
    await flushPromises();
    const within = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(within).toBeGreaterThan(initialCallCount);
    // 10s later — past threshold — interval should skip.
    mockNow += 10_000;
    const beforeSkip = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(beforeSkip);
    poller.dispose();
  });

  it('window-show triggers an immediate catch-up fetch', async () => {
    const fetchImpl = makeOkFetch();
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    poller.setWindowVisible(false);
    const beforeShow = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    poller.setWindowVisible(true);
    await flushPromises();
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(beforeShow + 1);
    poller.dispose();
  });

  it('stop() returns to idle and stops the interval', async () => {
    const fetchImpl = makeOkFetch();
    const poller = new UsagePoller({
      intervalMs: 1000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    poller.stop();
    expect(poller.getState().status).toBe('idle');
    const before = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    vi.advanceTimersByTime(10_000);
    await flushPromises();
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
    poller.dispose();
  });

  it('multiple subscribers receive identical state updates', async () => {
    const sub1 = vi.fn();
    const sub2 = vi.fn();
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl: makeOkFetch(),
    });
    poller.onStateChange(sub1);
    poller.onStateChange(sub2);
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(sub1).toHaveBeenCalled();
    expect(sub2).toHaveBeenCalled();
    const last1 = sub1.mock.calls[sub1.mock.calls.length - 1][0] as PollerState;
    const last2 = sub2.mock.calls[sub2.mock.calls.length - 1][0] as PollerState;
    expect(last1).toEqual(last2);
    poller.dispose();
  });

  it('unsubscribe stops further callbacks (idempotent)', async () => {
    const sub = vi.fn();
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl: makeOkFetch(),
    });
    const unsub = poller.onStateChange(sub);
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    const initial = sub.mock.calls.length;
    unsub();
    unsub(); // idempotent
    await poller.refreshNow();
    expect(sub.mock.calls.length).toBe(initial);
    poller.dispose();
  });
});

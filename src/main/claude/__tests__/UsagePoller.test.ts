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

  it('fires an immediate fetch on start (queueMicrotask, not interval)', async () => {
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

  it('stops poller and emits unauthorized on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('unauth', { status: 401 }),
    ) as unknown as typeof fetch;
    const poller = new UsagePoller({
      intervalMs: 100_000,
      loadCredential: async () => OK_CREDENTIAL,
      fetchImpl,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(poller.getState().status).toBe('unauthorized');
    // Interval should be cleared — advancing time should NOT trigger a refetch.
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockClear();
    vi.advanceTimersByTime(300_000);
    await flushPromises();
    expect(poller.getState().status).toBe('unauthorized');
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

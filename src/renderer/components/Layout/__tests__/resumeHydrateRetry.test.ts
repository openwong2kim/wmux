// #3028 — the resume hydrate after a daemon (re)connect is tried again when
// its pty.list fails, and only while that connection stands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateWithRetry, RESUME_HYDRATE_RETRY_MS } from '../resumeHydrateRetry';

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('hydrateWithRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tries again after each wait until the hydrate succeeds', async () => {
    const hydrate = vi.fn()
      .mockRejectedValueOnce(new Error('list failed'))
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValue(undefined);
    hydrateWithRetry(hydrate, () => true);
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RESUME_HYDRATE_RETRY_MS[0] - 1);
    expect(hydrate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hydrate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RESUME_HYDRATE_RETRY_MS[1]);
    expect(hydrate).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hydrate).toHaveBeenCalledTimes(3);
  });

  it('gives up after its last wait', async () => {
    const hydrate = vi.fn().mockRejectedValue(new Error('list failed'));
    hydrateWithRetry(hydrate, () => true);
    await vi.advanceTimersByTimeAsync(RESUME_HYDRATE_RETRY_MS.reduce((a, b) => a + b, 0) + 60_000);
    expect(hydrate).toHaveBeenCalledTimes(1 + RESUME_HYDRATE_RETRY_MS.length);
  });

  it('stops once the connection it was started for is gone, or when cancelled', async () => {
    let current = true;
    const hydrate = vi.fn().mockRejectedValue(new Error('list failed'));
    hydrateWithRetry(hydrate, () => current);
    await flush();
    current = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hydrate).toHaveBeenCalledTimes(1);

    const again = vi.fn().mockRejectedValue(new Error('list failed'));
    const cancel = hydrateWithRetry(again, () => true);
    await flush();
    cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('tells a pending hydrate when its connection is gone or it was cancelled', () => {
    let connection = 1;
    const seen: Array<() => boolean> = [];
    const hydrate = (current: () => boolean) => { seen.push(current); return new Promise<void>(() => undefined); };
    hydrateWithRetry(hydrate, () => connection === 1);
    expect(seen[0]()).toBe(true);
    connection = 2;
    expect(seen[0]()).toBe(false);

    const cancel = hydrateWithRetry(hydrate, () => true);
    expect(seen[1]()).toBe(true);
    cancel();
    expect(seen[1]()).toBe(false);
  });
});

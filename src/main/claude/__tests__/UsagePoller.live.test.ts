/**
 * UsagePoller × live statusline samples (usage.rateLimits).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UsagePoller, type PollerState } from '../UsagePoller';
import type { LoadResult } from '../claudeCredential';

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = NOW_MS / 1000;
const HOUR = 3600;
const INTERVAL = 15 * 60 * 1000;

const OK_CREDENTIAL: LoadResult = {
  ok: true,
  credential: { accessToken: 'sk-ant-test', subscriptionType: 'max', rateLimitTier: null, expiresAtMs: null },
};

function httpFetch(sessionPct: number, sessionResetSec: number): typeof fetch {
  return vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    five_hour: { utilization: sessionPct, resets_at: new Date(sessionResetSec * 1000).toISOString() },
    seven_day: { utilization: 30, resets_at: new Date((NOW_SEC + 90 * HOUR) * 1000).toISOString() },
  }), { status: 200 })) as unknown as typeof fetch;
}

const LIVE = {
  session: { pct: 7, resetEpochSec: NOW_SEC + 4 * HOUR },
  weekly: { pct: 31, resetEpochSec: NOW_SEC + 90 * HOUR },
};

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('UsagePoller live ingest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores silently while off, then start() publishes it without an HTTP call', async () => {
    const fetchImpl = httpFetch(50, NOW_SEC + HOUR);
    const poller = new UsagePoller({ fetchImpl, loadCredential: async () => OK_CREDENTIAL });
    const seen: PollerState[] = [];
    poller.onStateChange((s) => seen.push(s));

    poller.ingestLive(LIVE);
    expect(seen).toHaveLength(0);

    poller.start();
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(seen.at(-1)?.status).toBe('ok');
    expect(seen.at(-1)?.snapshot?.sessionPct).toBe(7);
    poller.dispose();
  });

  it('skips interval ticks while a live sample is fresh, resumes after', async () => {
    const fetchImpl = httpFetch(50, NOW_SEC + HOUR);
    const poller = new UsagePoller({ fetchImpl, loadCredential: async () => OK_CREDENTIAL });
    poller.start();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    poller.ingestLive({ ...LIVE, session: { pct: 60, resetEpochSec: NOW_SEC + HOUR } });
    await vi.advanceTimersByTimeAsync(INTERVAL - 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('an HTTP answer for an older window does not overwrite a newer live one', async () => {
    const fetchImpl = httpFetch(95, NOW_SEC + 60);
    const poller = new UsagePoller({ fetchImpl, loadCredential: async () => OK_CREDENTIAL });
    poller.start();
    poller.ingestLive(LIVE);
    await poller.refreshNow();
    expect(fetchImpl).toHaveBeenCalled();
    expect(poller.getState().snapshot?.sessionPct).toBe(7);
    expect(poller.getState().snapshot?.sessionResetEpochSec).toBe(NOW_SEC + 4 * HOUR);
    poller.dispose();
  });
});

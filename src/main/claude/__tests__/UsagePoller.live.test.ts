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

const LIVE_HIGHER = {
  session: { pct: 60, resetEpochSec: NOW_SEC + 4 * HOUR },
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

  it('stores silently while off; start() republishes it without HTTP when HTTP ran recently', async () => {
    const fetchImpl = httpFetch(50, NOW_SEC + 4 * HOUR);
    const poller = new UsagePoller({ fetchImpl, loadCredential: async () => OK_CREDENTIAL });
    poller.start();
    await flush();
    poller.stop();
    const seen: PollerState[] = [];
    poller.onStateChange((s) => seen.push(s));

    poller.ingestLive(LIVE_HIGHER);
    expect(seen).toHaveLength(0);

    poller.start();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.status).toBe('ok');
    expect(seen.at(-1)?.snapshot?.sessionPct).toBe(60);
    poller.dispose();
  });

  it('with a fresh live sample, HTTP slows to every third interval instead of stopping', async () => {
    const fetchImpl = httpFetch(50, NOW_SEC + 4 * HOUR);
    const poller = new UsagePoller({ fetchImpl, loadCredential: async () => OK_CREDENTIAL });
    poller.start();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (let tick = 1; tick <= 3; tick++) {
      await vi.advanceTimersByTimeAsync(INTERVAL - 1000);
      poller.ingestLive({ session: { pct: 50 + tick, resetEpochSec: NOW_SEC + 4 * HOUR } });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('HTTP is authoritative: an ok result replaces a higher live value in the same window', async () => {
    const fetchImpl = httpFetch(20, NOW_SEC + 4 * HOUR);
    const poller = new UsagePoller({ fetchImpl, loadCredential: async () => OK_CREDENTIAL });
    poller.start();
    poller.ingestLive(LIVE_HIGHER);
    await poller.refreshNow();
    expect(poller.getState().snapshot?.sessionPct).toBe(20);
    poller.dispose();
  });

  it('a live sample does not clear a credential verdict', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;
    const poller = new UsagePoller({ fetchImpl, loadCredential: async () => OK_CREDENTIAL });
    poller.start();
    await flush();
    expect(poller.getState().status).toBe('unauthorized');
    expect(poller.ingestLive(LIVE)).toBe(true);
    expect(poller.getState().status).toBe('unauthorized');
    expect(poller.getState().snapshot?.sessionPct).toBe(7);
    poller.dispose();
  });

  it('reports a partial sample with nothing to merge onto as not applied', () => {
    const poller = new UsagePoller({ fetchImpl: vi.fn() as unknown as typeof fetch, loadCredential: async () => OK_CREDENTIAL });
    expect(poller.ingestLive({ session: LIVE.session })).toBe(false);
    expect(poller.ingestLive(LIVE)).toBe(true);
    expect(poller.ingestLive(LIVE)).toBe(true); // unchanged still counts as accepted
    poller.dispose();
  });
});

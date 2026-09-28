/**
 * AccountUsageService × live statusline samples (usage.rateLimits).
 */
import { describe, it, expect, vi } from 'vitest';
import { AccountUsageService, type AccountUsageEntry } from '../AccountUsageService';
import type { LoadResult } from '../../claude/claudeCredential';

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = NOW_MS / 1000;
const HOUR = 3600;

const OK_CRED: LoadResult = {
  ok: true,
  credential: { accessToken: 'sk-ant-test', subscriptionType: 'max', rateLimitTier: null, expiresAtMs: null },
};

const LIVE = {
  session: { pct: 7, resetEpochSec: NOW_SEC + 4 * HOUR },
  weekly: { pct: 31, resetEpochSec: NOW_SEC + 90 * HOUR },
};

function okFetch(sessionPct: number): typeof fetch {
  const body = JSON.stringify({
    five_hour: { utilization: sessionPct, resets_at: new Date((NOW_SEC + 4 * HOUR) * 1000).toISOString() },
    seven_day: { utilization: 30, resets_at: new Date((NOW_SEC + 90 * HOUR) * 1000).toISOString() },
  });
  return vi.fn().mockImplementation(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

function make(now: () => number, fetchImpl: typeof fetch): AccountUsageService {
  return new AccountUsageService({
    now,
    fetchImpl,
    loadCredential: async () => OK_CRED,
    getConfigDir: (id) => `/dirs/${id}`,
    listKnownIds: () => new Set(['A']),
  });
}

describe('AccountUsageService live ingest', () => {
  it('stores while off without notifying; notifies while on', () => {
    const svc = make(() => NOW_MS, vi.fn() as unknown as typeof fetch);
    const seen: AccountUsageEntry[] = [];
    svc.onChange((e) => seen.push(e));
    svc.ingestLive('A', LIVE);
    expect(seen).toHaveLength(0);
    expect(svc.getAll()[0]?.snapshot?.sessionPct).toBe(7);

    svc.setEnabled(true);
    svc.ingestLive('A', { session: { pct: 9, resetEpochSec: NOW_SEC + 4 * HOUR } });
    expect(seen.at(-1)?.snapshot?.sessionPct).toBe(9);
    expect(seen.at(-1)?.status).toBe('ok');
    svc.dispose();
  });

  it('a fresh live sample slows automatic probes to every third refresh interval', async () => {
    let now = NOW_MS;
    const fetchImpl = okFetch(10);
    const svc = make(() => now, fetchImpl);
    svc.setEnabled(true);
    await svc.maybeProbe('A');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 2; i++) {
      now += 15 * 60 * 1000;
      svc.ingestLive('A', { session: { pct: 10 + i, resetEpochSec: NOW_SEC + 4 * HOUR } });
      await svc.maybeProbe('A');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 15 * 60 * 1000;
    svc.ingestLive('A', { session: { pct: 13, resetEpochSec: NOW_SEC + 4 * HOUR } });
    await svc.maybeProbe('A');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  it('HTTP is authoritative: an ok result replaces a higher live value', async () => {
    const svc = make(() => NOW_MS, okFetch(3));
    svc.ingestLive('A', LIVE);
    await svc.refreshNow('A');
    expect(svc.getAll()[0]?.snapshot?.sessionPct).toBe(3);
    svc.dispose();
  });

  it('an HTTP failure keeps a live snapshot that landed during the request', async () => {
    let fail!: (r: Response) => void;
    const fetchImpl = vi.fn().mockImplementation(() => new Promise<Response>((r) => { fail = r; })) as unknown as typeof fetch;
    const svc = make(() => NOW_MS, fetchImpl);
    const pending = svc.refreshNow('A');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    svc.ingestLive('A', LIVE);
    fail(new Response('', { status: 500 }));
    await pending;
    const entry = svc.getAll()[0];
    expect(entry?.status).toBe('error');
    expect(entry?.snapshot?.sessionPct).toBe(7);
    svc.dispose();
  });

  it('a stale live sample does not overwrite a newer window', () => {
    const svc = make(() => NOW_MS, vi.fn() as unknown as typeof fetch);
    svc.ingestLive('A', LIVE);
    svc.ingestLive('A', { session: { pct: 98, resetEpochSec: NOW_SEC + 120 } });
    expect(svc.getAll()[0]?.snapshot?.sessionPct).toBe(7);
    svc.dispose();
  });
});

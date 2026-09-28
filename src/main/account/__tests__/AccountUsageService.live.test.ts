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

  it('a fresh live sample suppresses automatic probes past the cooldown', async () => {
    let now = NOW_MS;
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const svc = make(() => now, fetchImpl);
    svc.setEnabled(true);
    svc.ingestLive('A', LIVE);
    now += 10 * 60 * 1000; // past the 5-min cooldown, inside the 15-min refresh
    await svc.maybeProbe('A');
    expect(fetchImpl).not.toHaveBeenCalled();
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

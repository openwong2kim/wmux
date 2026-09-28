/**
 * UsageApi tests — the pure `/api/oauth/usage` body parser, Retry-After /
 * backoff math, and the typed-error mapping. Network is mocked via a stub
 * fetchImpl so the test doesn't touch Anthropic.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fetchUsage,
  parseRetryAfter,
  parseUsageBody,
  rateLimitBackoffMs,
  setUsageClientVersion,
  UsageApiException,
} from '../UsageApi';

const FIXED_NOW = 1_700_000_000_000;
const TOKEN = 'test-token-not-real';

/** Trimmed copy of a real 2026-09-28 response (no identifiers in it). */
const FULL_BODY = {
  five_hour: {
    utilization: 48.0,
    resets_at: '2026-09-28T15:39:59.995150+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day: {
    utilization: 12.0,
    resets_at: '2026-10-02T05:59:59.995175+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 48,
      severity: 'normal',
      resets_at: '2026-09-28T15:39:59.995150+00:00',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 12,
      severity: 'normal',
      resets_at: '2026-10-02T05:59:59.995175+00:00',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 0,
      severity: 'normal',
      resets_at: '2026-10-02T06:00:00+00:00',
      scope: { model: { id: null, display_name: 'Opus' }, surface: null },
      is_active: false,
    },
  ],
  member_dashboard_available: false,
};

const sec = (iso: string): number => Math.round(Date.parse(iso) / 1000);

describe('parseUsageBody (pure)', () => {
  it('parses the full real-shaped response', () => {
    const s = parseUsageBody(FULL_BODY, FIXED_NOW);
    expect(s).toEqual({
      sessionPct: 48,
      sessionResetEpochSec: sec('2026-09-28T15:39:59.995150+00:00'),
      weeklyPct: 12,
      weeklyResetEpochSec: sec('2026-10-02T05:59:59.995175+00:00'),
      fetchedAtMs: FIXED_NOW,
      scoped: [
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          pct: 0,
          resetEpochSec: sec('2026-10-02T06:00:00+00:00'),
          scope: 'Opus',
        },
      ],
    });
  });

  it('falls back to limits[] when five_hour / seven_day are null', () => {
    const body = { ...FULL_BODY, five_hour: null, seven_day: null };
    const s = parseUsageBody(body, FIXED_NOW)!;
    expect(s.sessionPct).toBe(48);
    expect(s.weeklyPct).toBe(12);
    expect(s.sessionResetEpochSec).toBe(sec('2026-09-28T15:39:59.995150+00:00'));
  });

  it('prefers five_hour over limits[] when both are present', () => {
    const body = { ...FULL_BODY, five_hour: { utilization: 73.6, resets_at: null } };
    const s = parseUsageBody(body, FIXED_NOW)!;
    expect(s.sessionPct).toBe(74);
    expect(s.sessionResetEpochSec).toBe(0); // unknown reset → 0
  });

  it('maps every weekly_scoped limit; string or missing scope tolerated', () => {
    const body = {
      five_hour: { utilization: 1, resets_at: null },
      limits: [
        { kind: 'weekly_scoped', group: 'weekly', percent: 55.2, resets_at: null, scope: 'sonnet' },
        { kind: 'weekly_scoped', percent: 3 },
        { kind: 'weekly_scoped', percent: 'n/a' }, // unusable → dropped
        { kind: 'something_new', percent: 9 },
      ],
    };
    const s = parseUsageBody(body, FIXED_NOW)!;
    expect(s.scoped).toEqual([
      { kind: 'weekly_scoped', group: 'weekly', pct: 55, resetEpochSec: null, scope: 'sonnet' },
      { kind: 'weekly_scoped', group: 'weekly', pct: 3, resetEpochSec: null, scope: null },
    ]);
  });

  it('omits scoped when none are reported, clamps percent to [0,100]', () => {
    const s = parseUsageBody(
      { five_hour: { utilization: 123 }, seven_day: { utilization: -4 } },
      FIXED_NOW,
    )!;
    expect(s.sessionPct).toBe(100);
    expect(s.weeklyPct).toBe(0);
    expect(s.scoped).toBeUndefined();
  });

  it('all-null windows and no limits → null (caller reports error, not 0%)', () => {
    expect(parseUsageBody({ ...FULL_BODY, five_hour: null, seven_day: null, limits: [] }, FIXED_NOW)).toBeNull();
  });

  it('garbage never throws and yields null', () => {
    for (const junk of [null, 42, 'x', [], {}, { limits: 'no' }, { five_hour: 'x', seven_day: [1] }]) {
      expect(parseUsageBody(junk, FIXED_NOW)).toBeNull();
    }
  });
});

describe('Retry-After and backoff', () => {
  it('parses delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('120', FIXED_NOW)).toBe(120_000);
    expect(parseRetryAfter(new Date(FIXED_NOW + 30_000).toUTCString(), FIXED_NOW)).toBe(30_000);
    expect(parseRetryAfter(null, FIXED_NOW)).toBeNull();
    expect(parseRetryAfter('soon', FIXED_NOW)).toBeNull();
  });

  it('honors Retry-After, else doubles from 5 min, capped at 60 min', () => {
    const MIN = 60_000;
    expect(rateLimitBackoffMs(1, 90_000)).toBe(90_000);
    expect(rateLimitBackoffMs(1, 5 * 60 * MIN)).toBe(60 * MIN);
    expect([1, 2, 3, 4, 5, 9].map((n) => rateLimitBackoffMs(n, null) / MIN)).toEqual([5, 10, 20, 40, 60, 60]);
  });
});

describe('fetchUsage (with mocked fetch)', () => {
  function makeFetch(response: Response): typeof fetch {
    return vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
  }

  it('returns parsed snapshot on 200', async () => {
    const fetchImpl = makeFetch(new Response(JSON.stringify(FULL_BODY), { status: 200 }));
    const snapshot = await fetchUsage(TOKEN, fetchImpl);
    expect(snapshot.sessionPct).toBe(48);
    expect(snapshot.weeklyPct).toBe(12);
  });

  it('throws malformed on a 200 with no usage windows', async () => {
    const fetchImpl = makeFetch(new Response('{"five_hour":null}', { status: 200 }));
    await expect(fetchUsage(TOKEN, fetchImpl)).rejects.toMatchObject({ detail: { kind: 'malformed' } });
  });

  it('throws malformed on a non-JSON 200', async () => {
    const fetchImpl = makeFetch(new Response('<html>', { status: 200 }));
    await expect(fetchUsage(TOKEN, fetchImpl)).rejects.toMatchObject({ detail: { kind: 'malformed' } });
  });

  it('throws UsageApiException(unauthorized) on 401 and 403', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = makeFetch(new Response('no', { status }));
      await expect(fetchUsage(TOKEN, fetchImpl)).rejects.toMatchObject({ detail: { kind: 'unauthorized' } });
    }
  });

  it('throws rate-limited with Retry-After on 429', async () => {
    const fetchImpl = makeFetch(new Response('slow down', { status: 429, headers: { 'retry-after': '300' } }));
    await expect(fetchUsage(TOKEN, fetchImpl)).rejects.toMatchObject({
      detail: { kind: 'rate-limited', retryAfterMs: 300_000 },
    });
  });

  it('throws rate-limited with null retryAfterMs when the header is absent', async () => {
    const fetchImpl = makeFetch(new Response('slow down', { status: 429 }));
    await expect(fetchUsage(TOKEN, fetchImpl)).rejects.toMatchObject({
      detail: { kind: 'rate-limited', retryAfterMs: null },
    });
  });

  it('throws UsageApiException(http) on 5xx with status preserved', async () => {
    const fetchImpl = makeFetch(new Response('overload', { status: 529, statusText: 'Overloaded' }));
    const err = await fetchUsage(TOKEN, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageApiException);
    expect((err as UsageApiException).detail).toEqual({ kind: 'http', status: 529, statusText: 'Overloaded' });
  });

  it('throws UsageApiException(network) when fetch itself rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(fetchUsage(TOKEN, fetchImpl)).rejects.toMatchObject({
      detail: { kind: 'network', message: 'ECONNREFUSED' },
    });
  });

  it('GETs the usage endpoint with Bearer token, oauth beta and a wmux UA', async () => {
    setUsageClientVersion('9.9.9');
    const fetchImpl = makeFetch(new Response(JSON.stringify(FULL_BODY), { status: 200 }));
    await fetchUsage(TOKEN, fetchImpl);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['user-agent']).toBe('wmux/9.9.9');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });
});

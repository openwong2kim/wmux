/**
 * UsageApi tests — focus on the pure header-parser and the typed-error
 * mapping. Network is mocked via a stub fetchImpl so the test doesn't
 * touch Anthropic. The mock response is constructed with the global
 * `Response` constructor (available in vitest's node 22 runtime).
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchUsage, parseSnapshot, UsageApiException } from '../UsageApi';

const FIXED_NOW = 1_700_000_000_000;

describe('parseSnapshot (pure)', () => {
  it('converts decimal utilization to integer percent, rounded', () => {
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.234',
      'anthropic-ratelimit-unified-5h-reset': '1700001234',
      'anthropic-ratelimit-unified-7d-utilization': '0.078',
      'anthropic-ratelimit-unified-7d-reset': '1700009999',
    });
    const snapshot = parseSnapshot(headers, FIXED_NOW);
    expect(snapshot.sessionPct).toBe(23);
    expect(snapshot.weeklyPct).toBe(8);
    expect(snapshot.sessionResetEpochSec).toBe(1700001234);
    expect(snapshot.weeklyResetEpochSec).toBe(1700009999);
    expect(snapshot.fetchedAtMs).toBe(FIXED_NOW);
  });

  it('clamps percent to [0, 100]', () => {
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '1.234', // 123% → 100
      'anthropic-ratelimit-unified-7d-utilization': '-0.5', // negative → 0
    });
    const snapshot = parseSnapshot(headers, FIXED_NOW);
    expect(snapshot.sessionPct).toBe(100);
    expect(snapshot.weeklyPct).toBe(0);
  });

  it('reports 0 for missing headers (caller distinguishes via fetch status)', () => {
    const headers = new Headers();
    const snapshot = parseSnapshot(headers, FIXED_NOW);
    expect(snapshot).toEqual({
      sessionPct: 0,
      sessionResetEpochSec: 0,
      weeklyPct: 0,
      weeklyResetEpochSec: 0,
      fetchedAtMs: FIXED_NOW,
    });
  });

  it('reports 0 for non-numeric headers', () => {
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': 'not a number',
      'anthropic-ratelimit-unified-5h-reset': 'NaN',
    });
    const snapshot = parseSnapshot(headers, FIXED_NOW);
    expect(snapshot.sessionPct).toBe(0);
    expect(snapshot.sessionResetEpochSec).toBe(0);
  });

  it('rounds reset epoch to integer seconds', () => {
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-reset': '1700001234.6',
    });
    expect(parseSnapshot(headers, FIXED_NOW).sessionResetEpochSec).toBe(1700001235);
  });
});

describe('fetchUsage (with mocked fetch)', () => {
  function makeFetch(response: Response): typeof fetch {
    return vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
  }

  it('returns parsed snapshot on 200', async () => {
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': '1700001000',
      'anthropic-ratelimit-unified-7d-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-reset': '1700009000',
    });
    const fetchImpl = makeFetch(new Response('{}', { status: 200, headers }));
    const snapshot = await fetchUsage('sk-ant-token-1234567890', fetchImpl);
    expect(snapshot.sessionPct).toBe(42);
    expect(snapshot.weeklyPct).toBe(12);
  });

  it('throws UsageApiException(unauthorized) on 401', async () => {
    const fetchImpl = makeFetch(new Response('unauth', { status: 401 }));
    await expect(fetchUsage('sk-ant-token-1234567890', fetchImpl)).rejects.toMatchObject({
      detail: { kind: 'unauthorized' },
    });
  });

  it('throws UsageApiException(unauthorized) on 403', async () => {
    const fetchImpl = makeFetch(new Response('forbidden', { status: 403 }));
    await expect(fetchUsage('sk-ant-token-1234567890', fetchImpl)).rejects.toMatchObject({
      detail: { kind: 'unauthorized' },
    });
  });

  it('throws UsageApiException(http) on 5xx with status preserved', async () => {
    const fetchImpl = makeFetch(new Response('overload', { status: 529, statusText: 'Overloaded' }));
    try {
      await fetchUsage('sk-ant-token-1234567890', fetchImpl);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageApiException);
      expect((err as UsageApiException).detail).toEqual({
        kind: 'http',
        status: 529,
        statusText: 'Overloaded',
      });
    }
  });

  it('throws UsageApiException(network) when fetch itself rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    try {
      await fetchUsage('sk-ant-token-1234567890', fetchImpl);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageApiException);
      const detail = (err as UsageApiException).detail;
      expect(detail.kind).toBe('network');
      if (detail.kind === 'network') {
        expect(detail.message).toBe('ECONNREFUSED');
      }
    }
  });

  it('sends Bearer token + claude-code UA + oauth beta header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: new Headers() })) as unknown as typeof fetch;
    await fetchUsage('sk-ant-test-1234567890', fetchImpl);
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-ant-test-1234567890');
    expect(headers['user-agent']).toMatch(/^claude-code\//);
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(init.method).toBe('POST');
  });
});

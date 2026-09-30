import { describe, it, expect } from 'vitest';
import { CodexAccountStatusError, createCodexAccountStatusReader } from '../codexAccountStatus';

const auth = { authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true };
const limits = {
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1_790_000_000 },
    secondary: null, planType: 'plus', rateLimitReachedType: null },
  rateLimitsByLimitId: null, accountId: 'acct-0000',
};

function harness(answer: (method: string) => unknown) {
  const calls: Array<{ path: string; method: string; params: Record<string, unknown> }> = [];
  const clock = { now: 1_000 };
  const stamps = new Map<string, string>();
  const reader = createCodexAccountStatusReader({
    now: () => clock.now,
    stamp: async (home) => stamps.get(home) ?? 'auth-1',
    query: async (path, method, params) => { calls.push({ path, method, params }); return answer(method); },
  });
  return { calls, clock, reader, stamps };
}

describe('Codex account status reader', () => {
  it('reads auth without a token, then the plan limits, from the account\'s own control socket', async () => {
    const h = harness((method) => method === 'getAuthStatus' ? auth : limits);
    const status = await h.reader.read('/h/a');
    expect(h.calls).toEqual([
      { path: '/h/a/app-server-control/app-server-control.sock', method: 'getAuthStatus', params: { includeToken: false, refreshToken: false } },
      { path: '/h/a/app-server-control/app-server-control.sock', method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } },
    ]);
    expect(status).toMatchObject({ auth: { state: 'signed-in', method: 'chatgpt' }, fetchedAt: 1_000, cached: false,
      rateLimits: { ordinaryUsageAllowed: true, planType: 'plus' } });
    expect(JSON.stringify(status)).not.toContain('acct-0000');
  });

  it('caches per account for 60 s and shares one upstream read between concurrent callers', async () => {
    const h = harness((method) => method === 'getAuthStatus' ? auth : limits);
    const [a, b] = await Promise.all([h.reader.read('/h/a'), h.reader.read('/h/a')]);
    expect(h.calls).toHaveLength(2);
    // The caller that joined a read already in flight is served from it.
    expect([a.cached, b.cached]).toEqual([false, true]);
    h.clock.now += 59_999;
    expect(await h.reader.read('/h/a')).toMatchObject({ cached: true, fetchedAt: 1_000 });
    expect(h.calls).toHaveLength(2);
    // Another account is its own entry.
    await h.reader.read('/h/b');
    expect(h.calls).toHaveLength(4);
    h.clock.now += 1;
    expect(await h.reader.read('/h/a')).toMatchObject({ cached: false, fetchedAt: 61_000 });
    expect(h.calls).toHaveLength(6);
  });

  it('keeps a failed auth read for 10 s: 100 reads in a row reach the account server once', async () => {
    let authFails = true;
    const h = harness((method) => {
      if (method === 'getAuthStatus') { if (authFails) throw new Error('down'); return auth; }
      return limits;
    });
    for (let i = 0; i < 100; i++) await expect(h.reader.read('/h/a')).rejects.toBeInstanceOf(CodexAccountStatusError);
    expect(h.calls).toHaveLength(1);
    authFails = false;
    h.clock.now += 9_999;
    await expect(h.reader.read('/h/a')).rejects.toBeInstanceOf(CodexAccountStatusError);
    h.clock.now += 1;
    expect(await h.reader.read('/h/a')).toMatchObject({ auth: { state: 'signed-in' }, cached: false });
    expect(h.calls).toHaveLength(3);
  });

  it('a failed limits read is rateLimits null, kept 10 s rather than 60 s', async () => {
    let limitsFail = true;
    const h = harness((method) => {
      if (method === 'getAuthStatus') return auth;
      if (limitsFail) throw new Error('backend unavailable');
      return limits;
    });
    expect(await h.reader.read('/h/a')).toMatchObject({ rateLimits: null, cached: false });
    h.clock.now += 9_999;
    expect(await h.reader.read('/h/a')).toMatchObject({ rateLimits: null, cached: true });
    limitsFail = false;
    h.clock.now += 1;
    expect(await h.reader.read('/h/a')).toMatchObject({ rateLimits: { planType: 'plus' }, cached: false });
  });

  it('keeps 50 accounts read in rotation within their 60 s', async () => {
    const h = harness((method) => method === 'getAuthStatus' ? auth : limits);
    for (let round = 0; round < 2; round++) for (let i = 0; i < 50; i++) await h.reader.read(`/h/${i}`);
    expect(h.calls).toHaveLength(100);
  });

  it('a new sign-in in the same Codex home is read again at once', async () => {
    const h = harness((method) => method === 'getAuthStatus' ? auth : limits);
    await h.reader.read('/h/a');
    expect(await h.reader.read('/h/a')).toMatchObject({ cached: true });
    h.stamps.set('/h/a', 'auth-2');
    expect(await h.reader.read('/h/a')).toMatchObject({ cached: false });
    expect(h.calls).toHaveLength(4);
  });

  it('does not read plan limits for a signed-out or API-key account', async () => {
    for (const authMethod of [null, 'apikey']) {
      const h = harness((method) => method === 'getAuthStatus' ? { authMethod, authToken: null } : limits);
      expect((await h.reader.read('/h/a')).rateLimits).toBeNull();
      expect(h.calls.map((c) => c.method)).toEqual(['getAuthStatus']);
    }
  });
});

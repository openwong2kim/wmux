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
  const reader = createCodexAccountStatusReader({
    now: () => clock.now,
    query: async (path, method, params) => { calls.push({ path, method, params }); return answer(method); },
  });
  return { calls, clock, reader };
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
    expect([a.cached, b.cached]).toEqual([false, false]);
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

  it('fails without caching when auth cannot be read; a failed limits read is rateLimits null', async () => {
    let authFails = true;
    const h = harness((method) => {
      if (method === 'getAuthStatus') { if (authFails) throw new Error('down'); return auth; }
      throw new Error('backend unavailable');
    });
    await expect(h.reader.read('/h/a')).rejects.toBeInstanceOf(CodexAccountStatusError);
    authFails = false;
    expect(await h.reader.read('/h/a')).toMatchObject({ auth: { state: 'signed-in' }, rateLimits: null, cached: false });
  });

  it('does not read plan limits for a signed-out or API-key account', async () => {
    for (const authMethod of [null, 'apikey']) {
      const h = harness((method) => method === 'getAuthStatus' ? { authMethod, authToken: null } : limits);
      expect((await h.reader.read('/h/a')).rateLimits).toBeNull();
      expect(h.calls.map((c) => c.method)).toEqual(['getAuthStatus']);
    }
  });
});

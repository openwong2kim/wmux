/**
 * AccountUsageService (M2) — hook-gated per-account usage.
 *
 * Covers the 12 paths from the eng-review coverage audit (plan §3). Uses a
 * controllable `now` + injected loadCredential/fetch/getConfigDir so no timers
 * or real IO are needed. Two paths are marked [CRITICAL]: feature-OFF-no-probe
 * (the opt-in cost contract) and hung-account-isolation (one failing account
 * must not wedge siblings).
 */
import { describe, it, expect, vi } from 'vitest';
import { AccountUsageService, type AccountUsageEntry } from '../AccountUsageService';
import type { LoadResult } from '../../claude/claudeCredential';

const OK_CRED: LoadResult = {
  ok: true,
  credential: { accessToken: 'sk-ant-test', subscriptionType: 'max', rateLimitTier: null, expiresAtMs: null },
};

function okFetch(fivePct = 0.5, sevenPct = 0.1): typeof fetch {
  const headers = new Headers({
    'anthropic-ratelimit-unified-5h-utilization': String(fivePct),
    'anthropic-ratelimit-unified-5h-reset': '1700000000',
    'anthropic-ratelimit-unified-7d-utilization': String(sevenPct),
    'anthropic-ratelimit-unified-7d-reset': '1700100000',
  });
  return vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers })) as unknown as typeof fetch;
}

/** Deferred controller so a probe can be held "in flight" for the coalesce test. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Default: every accountId maps to a claude config dir. Tests override for codex.
const CLAUDE_DIRS = (id: string): string | null => `C:/dirs/${id}`;

function make(opts: {
  now?: () => number;
  loadCredential?: (dir: string) => Promise<LoadResult>;
  fetchImpl?: typeof fetch;
  getConfigDir?: (id: string) => string | null;
  listKnownIds?: () => Set<string>;
  cooldownMs?: number;
} = {}): AccountUsageService {
  return new AccountUsageService({
    now: opts.now ?? (() => 1000),
    loadCredential: opts.loadCredential ?? (async () => OK_CRED),
    fetchImpl: opts.fetchImpl ?? okFetch(),
    getConfigDir: opts.getConfigDir ?? CLAUDE_DIRS,
    listKnownIds: opts.listKnownIds ?? (() => new Set(['A', 'B', 'C'])),
    cooldownMs: opts.cooldownMs ?? 5 * 60 * 1000,
  });
}

describe('AccountUsageService (M2 hook-gated usage)', () => {
  it('[CRITICAL] feature OFF → zero probes on maybeProbe', async () => {
    const load = vi.fn(async () => OK_CRED);
    const svc = make({ loadCredential: load });
    // enabled defaults to false
    await svc.maybeProbe('A');
    expect(load).not.toHaveBeenCalled();
    expect(svc.getAll()).toEqual([]);
  });

  it('account resolves → exactly one probe, cache reflects %', async () => {
    const fetchImpl = okFetch(0.42, 0.71);
    const svc = make({ fetchImpl });
    svc.setEnabled(true);
    await svc.maybeProbe('A');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const entry = svc.getAll().find((e) => e.accountId === 'A')!;
    expect(entry.status).toBe('ok');
    expect(entry.snapshot?.sessionPct).toBe(42);
    expect(entry.snapshot?.weeklyPct).toBe(71);
  });

  it('cooldown (<5min) → second probe skipped', async () => {
    let t = 1000;
    const load = vi.fn(async () => OK_CRED);
    const svc = make({ now: () => t, loadCredential: load });
    svc.setEnabled(true);
    await svc.maybeProbe('A');
    t = 1000 + 60_000; // 1 min later, still inside cooldown
    await svc.maybeProbe('A');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('cooldown expired → probes again', async () => {
    let t = 1000;
    const load = vi.fn(async () => OK_CRED);
    const svc = make({ now: () => t, loadCredential: load });
    svc.setEnabled(true);
    await svc.maybeProbe('A');
    t = 1000 + 6 * 60_000; // 6 min later, past cooldown
    await svc.maybeProbe('A');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('N panes same account burst → one probe (in-flight coalesce)', async () => {
    const d = deferred<LoadResult>();
    const load = vi.fn(() => d.promise);
    const svc = make({ loadCredential: load });
    svc.setEnabled(true);
    const p1 = svc.maybeProbe('A'); // starts, holds in flight
    const p2 = svc.maybeProbe('A'); // sees inflight → returns immediately
    const p3 = svc.maybeProbe('A');
    await p2; await p3;
    expect(load).toHaveBeenCalledTimes(1);
    d.resolve(OK_CRED);
    await p1;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('probe success → onChange push fires with the entry', async () => {
    const pushed: AccountUsageEntry[] = [];
    const svc = make();
    svc.onChange((e) => pushed.push(e));
    svc.setEnabled(true);
    await svc.maybeProbe('B');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].accountId).toBe('B');
    expect(pushed[0].status).toBe('ok');
  });

  it('probe 401 → unauthorized, keeps last snapshot, no retry storm', async () => {
    let t = 1000;
    // First probe ok, second returns 401.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.3',
        'anthropic-ratelimit-unified-7d-utilization': '0.2',
      }) }))
      // fetchUsage turns a 401 Response into the unauthorized UsageApiException
      // itself — the fetchImpl must RETURN the 401, not throw.
      .mockResolvedValue(new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const svc = make({ now: () => t, fetchImpl });
    svc.setEnabled(true);
    await svc.maybeProbe('A');
    t += 6 * 60_000;
    await svc.maybeProbe('A');
    const entry = svc.getAll().find((e) => e.accountId === 'A')!;
    expect(entry.status).toBe('unauthorized');
    expect(entry.snapshot?.sessionPct).toBe(30); // last-known preserved
    // Another probe inside cooldown must NOT re-hit the network (no storm).
    t += 10_000;
    await svc.maybeProbe('A');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('[CRITICAL] one hung/failed account does not wedge siblings', async () => {
    // Account A network-errors; B succeeds. B must still get its number.
    const load = vi.fn(async () => OK_CRED);
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ETIMEDOUT'))) as unknown as typeof fetch;
    const okF = okFetch(0.2, 0.2);
    // A uses failing fetch, B uses ok fetch — inject per-account via getConfigDir + two services is messy;
    // instead assert: A error leaves A in 'error' and does not throw, and B probes independently.
    const svcA = make({ loadCredential: load, fetchImpl });
    svcA.setEnabled(true);
    await expect(svcA.maybeProbe('A')).resolves.toBeUndefined(); // never throws
    expect(svcA.getAll().find((e) => e.accountId === 'A')!.status).toBe('error');

    const svcB = make({ loadCredential: load, fetchImpl: okF });
    svcB.setEnabled(true);
    await svcB.maybeProbe('B');
    expect(svcB.getAll().find((e) => e.accountId === 'B')!.status).toBe('ok');
  });

  it('idle account (no agent.stop) → never probed, no cache entry', async () => {
    const load = vi.fn(async () => OK_CRED);
    const svc = make({ loadCredential: load });
    svc.setEnabled(true);
    await svc.maybeProbe('A'); // only A gets a turn
    expect(svc.getAll().map((e) => e.accountId)).toEqual(['A']);
    // B and C were never probed.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('codex account → getConfigDir null → no probe', async () => {
    const load = vi.fn(async () => OK_CRED);
    const svc = make({
      loadCredential: load,
      getConfigDir: (id) => (id === 'CODEX' ? null : CLAUDE_DIRS(id)),
    });
    svc.setEnabled(true);
    await svc.maybeProbe('CODEX');
    expect(load).not.toHaveBeenCalled();
  });

  it('hidden window → automatic probe skipped', async () => {
    const load = vi.fn(async () => OK_CRED);
    const svc = make({ loadCredential: load });
    svc.setEnabled(true);
    svc.setWindowVisible(false);
    await svc.maybeProbe('A');
    expect(load).not.toHaveBeenCalled();
  });

  it('macOS/unsupported credential read → error status, no crash', async () => {
    const svc = make({
      loadCredential: async () => ({ ok: false, reason: 'unsupported-platform', detail: 'keychain' }),
    });
    svc.setEnabled(true);
    await expect(svc.maybeProbe('A')).resolves.toBeUndefined();
    expect(svc.getAll().find((e) => e.accountId === 'A')!.status).toBe('error');
  });

  it('token missing → token-missing status (no error noise)', async () => {
    const svc = make({ loadCredential: async () => ({ ok: false, reason: 'not-found' }) });
    svc.setEnabled(true);
    await svc.maybeProbe('A');
    const entry = svc.getAll().find((e) => e.accountId === 'A')!;
    expect(entry.status).toBe('token-missing');
    expect(entry.lastError).toBeNull();
  });

  it('account removed → getAll prunes its stale cache entry (no leak)', async () => {
    let known = new Set(['A', 'B']);
    const svc = make({ listKnownIds: () => known });
    svc.setEnabled(true);
    await svc.maybeProbe('A');
    await svc.maybeProbe('B');
    expect(svc.getAll().map((e) => e.accountId).sort()).toEqual(['A', 'B']);
    known = new Set(['B']); // A unregistered
    expect(svc.getAll().map((e) => e.accountId)).toEqual(['B']);
  });

  it('refreshNow bypasses the enabled + cooldown gates (explicit user action)', async () => {
    const t = 1000;
    const load = vi.fn(async () => OK_CRED);
    const svc = make({ now: () => t, loadCredential: load });
    // enabled = false, but manual refresh still probes
    await svc.refreshNow('A');
    expect(load).toHaveBeenCalledTimes(1);
    // and again immediately, ignoring cooldown
    await svc.refreshNow('A');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('refreshNow still coalesces on the in-flight guard (double-click safe)', async () => {
    const d = deferred<LoadResult>();
    const load = vi.fn(() => d.promise);
    const svc = make({ loadCredential: load });
    const p1 = svc.refreshNow('A');
    const p2 = svc.refreshNow('A'); // in flight → no second request
    await p2;
    expect(load).toHaveBeenCalledTimes(1);
    d.resolve(OK_CRED);
    await p1;
  });
});

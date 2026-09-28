import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RpcRouter } from '../../RpcRouter';
import {
  registerUsageRpc,
  resolveUsageTarget,
  validateRateLimitsParams,
  type UsageRpcDeps,
} from '../usage.rpc';

const RESET = 1_900_000_000;

function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configDir: null,
    ptyId: 'pty-1',
    rateLimits: {
      five_hour: { pct: 12.6, resets_at: RESET },
      seven_day: { pct: 40, resets_at: RESET + 3600 },
    },
    ...overrides,
  };
}

describe('validateRateLimitsParams', () => {
  it('accepts the statusline shape and rounds fractional pct', () => {
    const v = validateRateLimitsParams(sample());
    expect(v?.update.session).toEqual({ pct: 13, resetEpochSec: RESET });
    expect(v?.update.weekly).toEqual({ pct: 40, resetEpochSec: RESET + 3600 });
    expect(v?.configDir).toBeNull();
  });

  it('accepts one window alone', () => {
    const v = validateRateLimitsParams(sample({ rateLimits: { seven_day: { pct: 1, resets_at: RESET } } }));
    expect(v?.update.session).toBeUndefined();
    expect(v?.update.weekly?.pct).toBe(1);
  });

  it.each([
    ['pct above 100', { five_hour: { pct: 101, resets_at: RESET } }],
    ['negative pct', { five_hour: { pct: -1, resets_at: RESET } }],
    ['NaN-ish pct', { five_hour: { pct: 'x', resets_at: RESET } }],
    ['millisecond reset', { five_hour: { pct: 1, resets_at: RESET * 1000 } }],
    ['fractional reset', { five_hour: { pct: 1, resets_at: RESET + 0.5 } }],
    ['ISO reset', { five_hour: { pct: 1, resets_at: '2030-01-01T00:00:00Z' } }],
    ['no windows', {}],
  ])('rejects %s', (_label, rateLimits) => {
    expect(validateRateLimitsParams(sample({ rateLimits }))).toBeNull();
  });

  it('rejects oversized or malformed identity strings', () => {
    expect(validateRateLimitsParams(sample({ configDir: 'x'.repeat(5000) }))).toBeNull();
    expect(validateRateLimitsParams(sample({ configDir: 42 }))).toBeNull();
    expect(validateRateLimitsParams(sample({ ptyId: 'p'.repeat(200) }))).toBeNull();
  });
});

describe('resolveUsageTarget', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function mkdir(): string {
    const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-usage-rpc-')));
    tmpDirs.push(d);
    return d;
  }

  it('unset config dir → default profile', () => {
    const r = resolveUsageTarget(null, { listClaudeAccounts: () => [], defaultConfigDir: () => '/nowhere/.claude' });
    expect(r).toEqual({ isDefault: true, accountIds: [] });
  });

  it('unmatched config dir → nothing', () => {
    const acct = mkdir();
    const r = resolveUsageTarget('/some/other/dir', {
      listClaudeAccounts: () => [{ id: 'A', configDir: acct }],
      defaultConfigDir: () => '/nowhere/.claude',
    });
    expect(r).toEqual({ isDefault: false, accountIds: [] });
  });

  it('a symlinked spelling of a registered dir resolves to that account', () => {
    const root = mkdir();
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link, 'dir');
    const r = resolveUsageTarget(`${link}${path.sep}`, {
      listClaudeAccounts: () => [{ id: 'A', configDir: real }, { id: 'B', configDir: root }],
      defaultConfigDir: () => '/nowhere/.claude',
    });
    expect(r).toEqual({ isDefault: false, accountIds: ['A'] });
  });

  it('an explicit path equal to the default dir → default profile', () => {
    const home = mkdir();
    const r = resolveUsageTarget(home, { listClaudeAccounts: () => [], defaultConfigDir: () => home });
    expect(r.isDefault).toBe(true);
  });
});

describe('usage.rateLimits handler', () => {
  function setup(accounts: Array<{ id: string; configDir: string }> = []) {
    let handler: ((p: Record<string, unknown>) => Promise<unknown>) | null = null;
    const router = { register: (_m: string, h: typeof handler) => { handler = h; } } as unknown as RpcRouter;
    const deps: UsageRpcDeps = {
      listClaudeAccounts: () => accounts,
      defaultConfigDir: () => '/nowhere/.claude',
      ingestDefault: vi.fn(),
      ingestAccount: vi.fn(),
    };
    registerUsageRpc(router, deps);
    return { call: (p: Record<string, unknown>) => (handler ? handler(p) : Promise.reject(new Error("not registered"))), deps };
  }

  it('routes an unset config dir to the default poller', async () => {
    const { call, deps } = setup();
    await expect(call(sample())).resolves.toEqual({ ok: true });
    expect(deps.ingestDefault).toHaveBeenCalledTimes(1);
    expect(deps.ingestAccount).not.toHaveBeenCalled();
  });

  it('drops an unknown config dir and an invalid payload without ingesting', async () => {
    const { call, deps } = setup([{ id: 'A', configDir: '/acct/a' }]);
    await expect(call(sample({ configDir: '/acct/zzz' }))).resolves.toEqual({ ok: false, reason: 'unknown-account' });
    await expect(call(sample({ rateLimits: 'nope' }))).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(deps.ingestDefault).not.toHaveBeenCalled();
    expect(deps.ingestAccount).not.toHaveBeenCalled();
  });

  it('routes a registered config dir to that account', async () => {
    const { call, deps } = setup([{ id: 'A', configDir: '/acct/a' }]);
    await call(sample({ configDir: '/acct/a' }));
    expect(deps.ingestAccount).toHaveBeenCalledWith('A', expect.objectContaining({ session: { pct: 13, resetEpochSec: RESET } }));
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS,
  normalizeFanoutAccountPoolSettings,
  pickPoolAccount,
  poolGroupFor,
  poolIncludesDefaultLogin,
  quotaBand,
  type PoolCandidate,
} from '../fanoutAccountPool';

const usable = (remaining: number | null) => ({ usable: true, remaining, availableAtMs: null });
const c = (id: string, remaining: number | null, open = 0, heldUntilMs: number | null = null): PoolCandidate =>
  ({ id, verdict: usable(remaining), heldUntilMs, open });
const settings = { quotaBandPct: 10, maxWorkersPerAccount: 0 };

describe('pickPoolAccount', () => {
  it('ranks by quota band, then fewest open workers, then id', () => {
    // 0.55 and 0.58 share band 5; 0.71 is band 7.
    expect(pickPoolAccount([c('a', 0.55), c('b', 0.71, 3)], settings)).toEqual({ kind: 'pick', accountId: 'b' });
    expect(pickPoolAccount([c('a', 0.55, 2), c('b', 0.58, 1)], settings)).toEqual({ kind: 'pick', accountId: 'b' });
    expect(pickPoolAccount([c('b', 0.55, 1), c('a', 0.58, 1)], settings)).toEqual({ kind: 'pick', accountId: 'a' });
  });

  it('ranks an unmeasured account below the lowest measured usable band', () => {
    expect(quotaBand(usable(null), 10)).toBe(-1);
    expect(pickPoolAccount([c('unknown', null), c('low', 0.05, 9)], settings)).toEqual({ kind: 'pick', accountId: 'low' });
    // Unknown ones rank on open workers only.
    expect(pickPoolAccount([c('u1', null, 2), c('u2', null, 0)], settings)).toEqual({ kind: 'pick', accountId: 'u2' });
  });

  it('drops unusable, reserve-held and full accounts, and says why none is left', () => {
    const spent: PoolCandidate = { id: 'spent', verdict: { usable: false, remaining: 0, availableAtMs: 5_000 }, heldUntilMs: null, open: 0 };
    expect(pickPoolAccount([spent, c('held', 0.9, 0, 9_000)], settings)).toEqual({ kind: 'none', reason: 'held', availableAtMs: 5_000 });
    expect(pickPoolAccount([spent], settings)).toEqual({ kind: 'none', reason: 'quota', availableAtMs: 5_000 });
    expect(pickPoolAccount([c('a', 0.9, 2)], { quotaBandPct: 10, maxWorkersPerAccount: 2 })).toEqual({ kind: 'none', reason: 'full', availableAtMs: null });
    expect(pickPoolAccount([c('a', 0.9, 2), c('b', 0.2, 1)], { quotaBandPct: 10, maxWorkersPerAccount: 2 })).toEqual({ kind: 'pick', accountId: 'b' });
    expect(pickPoolAccount([], settings)).toEqual({ kind: 'none', reason: 'empty', availableAtMs: null });
    // An account free only once both its window resets and its hold ends.
    const both: PoolCandidate = { id: 'a', verdict: { usable: false, remaining: 0, availableAtMs: 5_000 }, heldUntilMs: 9_000, open: 0 };
    expect(pickPoolAccount([both, c('b', 0.5, 0, 7_000)], settings)).toMatchObject({ kind: 'none', availableAtMs: 7_000 });
  });
});

describe('pool settings and group', () => {
  it('is off by default, and a bad field takes only its own default', () => {
    expect(normalizeFanoutAccountPoolSettings(null)).toEqual(DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS);
    expect(normalizeFanoutAccountPoolSettings({ enabled: true, quotaBandPct: 0, maxWorkersPerAccount: 3, group: ' work ' }))
      .toEqual({ ...DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS, enabled: true, maxWorkersPerAccount: 3, group: 'work' });
    expect(normalizeFanoutAccountPoolSettings({ enabled: 'yes' }).enabled).toBe(false);
  });

  it('stays in the bound account\'s group, and only the ungrouped pool takes the default login', () => {
    expect(poolGroupFor('work', { group: 'personal' })).toBe('work');
    expect(poolGroupFor(null, { group: 'personal' })).toBe('personal');
    expect(poolGroupFor(null, { group: null })).toBe('');
    expect(poolIncludesDefaultLogin('', { includeDefaultLogin: true })).toBe(true);
    expect(poolIncludesDefaultLogin('work', { includeDefaultLogin: true })).toBe(false);
    expect(poolIncludesDefaultLogin('', { includeDefaultLogin: false })).toBe(false);
  });
});

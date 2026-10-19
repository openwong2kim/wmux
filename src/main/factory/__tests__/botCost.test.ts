// A bot's cost estimate survives the usage record's disk round-trip, and its
// quota line comes from the account's held usage reading.
import { describe, expect, it } from 'vitest';
import { DAY_MS, costUsdDay, emptyUsage, pruneUsage, recordCost, sanitizeUsage } from '../budget';
import { BOT_QUOTA_MAX_AGE_MS, botQuotaOf } from '../botQuota';

describe('bot cost estimate', () => {
  it('records, prunes the day but keeps the total, and survives sanitizeUsage', () => {
    const u = emptyUsage();
    recordCost(u, 0.4, 1_000);
    recordCost(u, 0.1, 2_000);
    recordCost(u, Number.NaN, 2_500);
    recordCost(u, -1, 2_600);
    expect(costUsdDay(u, 3_000)).toBeCloseTo(0.5);
    const back = sanitizeUsage(JSON.parse(JSON.stringify(u)));
    expect(back.cost).toEqual({ day: [{ at: 1_000, usd: 0.4 }, { at: 2_000, usd: 0.1 }], total: 0.5 });
    pruneUsage(back, 1_500 + DAY_MS);
    expect(back.cost).toEqual({ day: [{ at: 2_000, usd: 0.1 }], total: 0.5 });
    expect(sanitizeUsage({ turns: [], workers: [], cost: { day: [{ at: 1, usd: 'x' }], total: -2 } }).cost).toBeUndefined();
    expect(sanitizeUsage({ turns: [], workers: [] }).cost).toBeUndefined();
  });
});

describe('botQuotaOf', () => {
  const now = 1_000_000_000;
  const snap = { sessionPct: 42.4, sessionResetEpochSec: now / 1000 + 600, weeklyPct: 100, weeklyResetEpochSec: 0, fetchedAtMs: now - 1 };

  it('shows both windows, rounded and clamped; an unknown reset has no time', () => {
    expect(botQuotaOf('Work', snap, now)).toEqual({
      accountName: 'Work',
      session: { pct: 42, resetsAt: now + 600_000 },
      weekly: { pct: 100 },
    });
  });

  it('drops a window that has reset since the reading, and shows nothing without a reading', () => {
    expect(botQuotaOf(null, { ...snap, sessionResetEpochSec: now / 1000 - 1 }, now)).toEqual({ accountName: null, weekly: { pct: 100 } });
    expect(botQuotaOf(null, null, now)).toBeNull();
    expect(botQuotaOf(null, { ...snap, fetchedAtMs: now - BOT_QUOTA_MAX_AGE_MS - 1 }, now)).toBeNull();
  });
});

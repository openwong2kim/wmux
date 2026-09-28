import { describe, expect, it } from 'vitest';
import { isPermissionReset, orderSchedules, selectScheduleNavSummary } from '../schedules';
import { automation, run } from '../../../components/Schedules/__tests__/fixtures';

describe('selectScheduleNavSummary', () => {
  it('shows the earliest next run across enabled schedules when nothing needs you', () => {
    const summary = selectScheduleNavSummary({
      automations: [
        automation({ id: 'a1', nextRunAt: 5_000 }),
        automation({ id: 'a2', nextRunAt: 3_000 }),
        automation({ id: 'a3', nextRunAt: 1_000, enabled: false }),
      ],
      automationRuns: [run({ automationId: 'a1', state: 'completed' })],
    });
    expect(summary).toEqual({ needs: 0, failed: 0, nextRunAt: 3_000 });
  });

  it('counts awaiting runs as needs, and latest-run failures separately', () => {
    const summary = selectScheduleNavSummary({
      automations: [automation({ id: 'a1' }), automation({ id: 'a2' }), automation({ id: 'a3' })],
      automationRuns: [
        run({ id: 'r1', automationId: 'a1', state: 'awaiting', startedAt: 10 }),
        run({ id: 'r2', automationId: 'a2', state: 'failed', startedAt: 10 }),
        // a3 failed before, then succeeded: the failure no longer counts.
        run({ id: 'r3', automationId: 'a3', state: 'failed', startedAt: 10 }),
        run({ id: 'r4', automationId: 'a3', state: 'completed', startedAt: 20 }),
      ],
    });
    expect(summary.needs).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('ignores runs of schedules that no longer exist', () => {
    const summary = selectScheduleNavSummary({
      automations: [],
      automationRuns: [run({ state: 'awaiting' })],
    });
    expect(summary).toEqual({ needs: 0, failed: 0, nextRunAt: null });
  });
});

describe('isPermissionReset / orderSchedules', () => {
  it('flags a non-approval mode granted at an older revision only', () => {
    expect(isPermissionReset(automation({ permission: { mode: 'bypass', grantedRevision: 3 } }))).toBe(false);
    expect(isPermissionReset(automation({ permission: { mode: 'bypass', grantedRevision: 2 } }))).toBe(true);
    expect(isPermissionReset(automation({ permission: { mode: 'scoped' } }))).toBe(true);
    expect(isPermissionReset(automation({ permission: { mode: 'approval', grantedRevision: 1 } }))).toBe(false);
  });

  it('lists proposed drafts first', () => {
    const ordered = orderSchedules([
      automation({ id: 'b', name: 'B' }),
      automation({ id: 'z', name: 'Z', proposed: true }),
      automation({ id: 'a', name: 'A' }),
    ]);
    expect(ordered.map((a) => a.id)).toEqual(['z', 'a', 'b']);
  });
});

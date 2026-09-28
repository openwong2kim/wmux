// Pin the zone before any Date is built: the DST cases below are specific to it.
process.env.TZ = 'America/New_York';

import { describe, expect, it } from 'vitest';
import type { AutomationScheduleTrigger } from '../automation';
import { nextOccurrenceAfter, occurrencesBetween, planDue } from '../automationSchedule';

const weekdays = (time: string, days = [1, 2, 3, 4, 5], graceMinutes = 180): AutomationScheduleTrigger =>
  ({ kind: 'schedule', weekdays: days, time, graceMinutes });
const at = (y: number, mo: number, d: number, h = 0, m = 0): number => new Date(y, mo, d, h, m).getTime();

describe('automation schedule math', () => {
  it('runs in the pinned zone (sanity: 02:30 on the spring-forward day does not exist)', () => {
    expect(new Date(2026, 2, 8, 2, 30).getHours()).not.toBe(2);
  });

  it('skips the weekend for a weekday schedule', () => {
    // Friday 2026-09-25 09:00 → Monday 2026-09-28 08:30.
    expect(new Date(2026, 8, 25).getDay()).toBe(5);
    expect(nextOccurrenceAfter(weekdays('08:30'), at(2026, 8, 25, 9))).toBe(at(2026, 8, 28, 8, 30));
  });

  it('wraps Saturday to a Sunday-only slot', () => {
    const sundayLate = weekdays('23:59', [0]);
    expect(nextOccurrenceAfter(sundayLate, at(2026, 8, 26, 12))).toBe(at(2026, 8, 27, 23, 59));
  });

  it('DST gap: a nonexistent wall time fires at the first valid instant after it (03:00)', () => {
    const t = nextOccurrenceAfter(weekdays('02:30', [0]), at(2026, 2, 7, 12));
    expect(t).not.toBeNull();
    const d = new Date(t!);
    expect([d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2, 8, 3, 0]);
  });

  it('DST overlap: a repeated wall time fires once, then moves to the next week', () => {
    const trigger = weekdays('01:30', [0]);
    const first = nextOccurrenceAfter(trigger, at(2026, 9, 31, 12))!;
    expect(new Date(first).getHours()).toBe(1);
    // The same wall time really does exist a second time an hour later…
    expect(new Date(first + 3_600_000).getHours()).toBe(1);
    // …but the schedule never offers it.
    const second = nextOccurrenceAfter(trigger, first)!;
    expect(new Date(second).getDate()).toBe(8);
    expect(occurrencesBetween(trigger, first - 1, first + 7_200_000, 10)).toEqual([first]);
  });

  it('fires a missed occurrence inside the grace window', () => {
    const plan = planDue({
      trigger: weekdays('08:30'),
      nextRunAt: at(2026, 8, 28, 8, 30),
      now: at(2026, 8, 28, 9, 0),
      lastScheduledFor: null,
      booting: false,
      limit: 10,
    });
    expect(plan.fire).toBe(at(2026, 8, 28, 8, 30));
    expect(plan.skipped).toEqual([]);
    expect(plan.nextRunAt).toBe(at(2026, 8, 29, 8, 30));
  });

  it('tick gap: fires only the newest in-grace occurrence, records the rest as missed', () => {
    const trigger = weekdays('08:30', [0, 1, 2, 3, 4, 5, 6]);
    const plan = planDue({
      trigger,
      nextRunAt: at(2026, 8, 28, 8, 30),
      now: at(2026, 8, 30, 10, 0),
      lastScheduledFor: null,
      booting: false,
      limit: 10,
    });
    expect(plan.fire).toBe(at(2026, 8, 30, 8, 30));
    expect(plan.skipped).toEqual([
      { at: at(2026, 8, 29, 8, 30), reason: 'missed' },
      { at: at(2026, 8, 28, 8, 30), reason: 'missed' },
    ]);
  });

  it('boot after downtime: beyond-grace occurrences are daemon_down and nothing fires', () => {
    const plan = planDue({
      trigger: weekdays('08:30', [0, 1, 2, 3, 4, 5, 6], 60),
      nextRunAt: at(2026, 8, 28, 8, 30),
      now: at(2026, 8, 29, 15, 0),
      lastScheduledFor: null,
      booting: true,
      limit: 10,
    });
    expect(plan.fire).toBeNull();
    expect(plan.skipped.map((s) => s.reason)).toEqual(['daemon_down', 'daemon_down']);
    expect(plan.nextRunAt).toBe(at(2026, 8, 30, 8, 30));
  });

  it('a clock moved backwards never re-arms an occurrence already recorded', () => {
    const plan = planDue({
      trigger: weekdays('08:30'),
      nextRunAt: at(2026, 8, 28, 8, 30),
      now: at(2026, 8, 28, 8, 0),
      lastScheduledFor: at(2026, 8, 28, 8, 30),
      booting: false,
      limit: 10,
    });
    expect(plan.fire).toBeNull();
    expect(plan.nextRunAt).toBe(at(2026, 8, 29, 8, 30));
  });
});

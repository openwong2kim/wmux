import { describe, expect, it } from 'vitest';
import { clampIdleDays, workspaceSnoozeUntil } from '../workspaceSettle';

// Local-time dates: the presets are defined in the user's time zone.
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min);

describe('workspaceSnoozeUntil', () => {
  // 2026-10-07 is a Wednesday.
  const wed10 = at(2026, 10, 7, 10, 30);

  it('1h is an hour from now', () => {
    expect(workspaceSnoozeUntil('1h', wed10)).toBe(wed10.getTime() + 3_600_000);
  });

  it('tonight is 20:00 today, unavailable from 19:00', () => {
    expect(workspaceSnoozeUntil('tonight', wed10)).toBe(at(2026, 10, 7, 20).getTime());
    expect(workspaceSnoozeUntil('tonight', at(2026, 10, 7, 19))).toBeNull();
    expect(workspaceSnoozeUntil('tonight', at(2026, 10, 7, 23, 50))).toBeNull();
  });

  it('tomorrow is 09:00 the next day, across a month end', () => {
    expect(workspaceSnoozeUntil('tomorrow', wed10)).toBe(at(2026, 10, 8, 9).getTime());
    expect(workspaceSnoozeUntil('tomorrow', at(2026, 10, 31, 22))).toBe(at(2026, 11, 1, 9).getTime());
  });

  it('next week is the next Monday 09:00, a full week out from a Monday', () => {
    expect(workspaceSnoozeUntil('nextWeek', wed10)).toBe(at(2026, 10, 12, 9).getTime());
    expect(workspaceSnoozeUntil('nextWeek', at(2026, 10, 12, 8))).toBe(at(2026, 10, 19, 9).getTime());
    expect(workspaceSnoozeUntil('nextWeek', at(2026, 10, 11, 23))).toBe(at(2026, 10, 12, 9).getTime());
  });
});

describe('clampIdleDays', () => {
  it('rounds and clamps, defaulting junk', () => {
    expect(clampIdleDays(2.6)).toBe(3);
    expect(clampIdleDays(0)).toBe(1);
    expect(clampIdleDays(500)).toBe(90);
    expect(clampIdleDays('7')).toBe(3);
  });
});

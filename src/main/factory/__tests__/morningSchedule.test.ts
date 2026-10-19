// The morning schedule: due once per local day from the configured hour on
// the configured weekdays, remembered across restarts, retried while the HQ
// bot or the fact log is missing, never while the factory is off.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FACTORY_SETTINGS, type FactorySettings } from '../../../shared/factorySettings';
import { MorningSchedule, localDay, morningDecision, morningDue, previousMorningDay } from '../morningSchedule';
import type { MorningFireResult } from '../morningReport';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp3a-morning-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// Monday 2026-10-12, local time.
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 12 + dayOffset, h, m).getTime();
const on: FactorySettings = { ...DEFAULT_FACTORY_SETTINGS, enabled: true };

describe('morningDue', () => {
  it('due from the hour on a listed weekday, once per local day', () => {
    expect(morningDue(on, at(8, 59), null)).toBeNull();
    expect(morningDue(on, at(9), null)).toBe('2026-10-12');
    expect(morningDue(on, at(15), '2026-10-12')).toBeNull();
    expect(morningDue(on, at(9, 0, 1), '2026-10-12')).toBe('2026-10-13');
    // Saturday is not a default weekday; the factory off never fires.
    expect(morningDue(on, at(10, 0, 5), null)).toBeNull();
    expect(morningDue({ ...on, enabled: false }, at(10), null)).toBeNull();
    expect(localDay(at(23, 59))).toBe('2026-10-12');
  });

  it('on the first run or after a gap fires only within the grace window after the hour', () => {
    // First enable at 17:47: no morning report today (the E2E defect).
    expect(morningDue(on, at(17, 47), null)).toBeNull();
    expect(morningDecision(on, at(17, 47), null)).toEqual({ day: '2026-10-12', fire: false });
    expect(morningDue(on, at(10, 59), null)).toBe('2026-10-12');
    expect(morningDue(on, at(11, 0), null)).toBeNull();
    // Monday after Friday's report: a late open still catches up.
    expect(previousMorningDay(on.morning.weekdays, at(15))).toBe('2026-10-09');
    expect(morningDue(on, at(15), '2026-10-09')).toBe('2026-10-12');
    // Last fired the Wednesday before: a gap, so only within the window.
    expect(morningDue(on, at(15), '2026-10-07')).toBeNull();
    expect(morningDue(on, at(9, 30), '2026-10-07')).toBe('2026-10-12');
  });
});

describe('MorningSchedule', () => {
  it('a duplicate answer counts as fired only when the log holds today\'s report', async () => {
    const file = path.join(dir, 'factory', 'morning-schedule.json');
    let reported = false;
    const s = new MorningSchedule({
      file, settings: () => on, now: () => at(10),
      fire: async () => ({ ok: false, code: 'duplicate', message: 'x' }),
      reportedOn: () => reported,
    });
    expect(await s.tick()).toBe('retry');
    expect(fs.existsSync(file)).toBe(false);
    reported = true;
    expect(await s.tick()).toBe('fired');
  });

  it('fires once, remembers the day on disk, and retries a fire that found no HQ bot', async () => {
    let now = at(9, 30);
    const results: MorningFireResult[] = [
      { ok: false, code: 'no_hq_bot', message: 'none' },
      { ok: true, fact: {} as never, hqBotId: 'bot-1' },
    ];
    const fire = vi.fn(async () => results.shift() ?? ({ ok: false, code: 'duplicate', message: 'dup' } as MorningFireResult));
    const file = path.join(dir, 'factory', 'morning-schedule.json');
    const s = new MorningSchedule({ file, settings: () => on, fire, now: () => now });
    expect(await s.tick()).toBe('retry');
    expect(await s.tick()).toBe('fired');
    expect(fire).toHaveBeenCalledWith('morning');
    expect(await s.tick()).toBe('idle');
    // A restart the same day: the file says it already fired.
    const again = new MorningSchedule({ file, settings: () => on, fire, now: () => now });
    expect(await again.tick()).toBe('idle');
    expect(fire).toHaveBeenCalledTimes(2);
    // The next day; a duplicate (today's fact already in the log) counts as fired.
    now = at(9, 1, 1);
    expect(await again.tick()).toBe('fired');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, lastDay: '2026-10-13' });
  });

  it('turned on late in the day: records the day as skipped, fires the next morning', async () => {
    let now = at(17, 47);
    const fire = vi.fn(async (): Promise<MorningFireResult> => ({ ok: true, fact: {} as never, hqBotId: 'bot-1' }));
    const file = path.join(dir, 'factory', 'morning-schedule.json');
    const s = new MorningSchedule({ file, settings: () => on, fire, now: () => now });
    expect(await s.tick()).toBe('idle');
    expect(fire).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, lastDay: '2026-10-12' });
    // The next day, opened after the window: the skipped day counts as handled.
    now = at(13, 0, 1);
    expect(await s.tick()).toBe('fired');
    expect(fire).toHaveBeenCalledTimes(1);
  });
});

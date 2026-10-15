// ─── The morning schedule — the factory's one timer ────────────────────────
//
// Once per local day, on the weekdays and from the hour in the factory
// settings (`morning`), the morning report fires (morningReport.ts
// fireMorningReport): the HQ workspace's `schedule.fired` fact, which wakes
// the coordinator. Checked every minute while the factory is on. The local
// day it last fired is kept in `factory/morning-schedule.json`, so a restart
// later the same day does not fire it again. A day the app was closed through
// the hour fires when the app is next open that day, but only when the
// previous scheduled day was handled too: on the first run (nothing kept) or
// after a gap, it fires only within MORNING_GRACE_MS of the hour, and a later
// check that day records the day as skipped, so turning bots on at 17:47
// posts no "morning" report and the next one comes the next scheduled
// morning. A fire that finds no HQ bot or no fact log is retried on the next
// check.

import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { FactorySettings } from '../../shared/factorySettings';
import type { MorningFireResult } from './morningReport';

export const MORNING_SCHEDULE_ID = 'morning';
export const MORNING_SCHEDULE_FILENAME = 'morning-schedule.json';
const CHECK_MS = 60_000;

/** The local day of `t` as YYYY-MM-DD. */
export function localDay(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** How long after the hour a report fires without a handled previous day. */
export const MORNING_GRACE_MS = 2 * 3_600_000;

/** The scheduled day before `now`'s local day (the newest listed weekday
 *  within the past week), or null when no weekday is listed. Pure. */
export function previousMorningDay(weekdays: readonly number[], now: number): string | null {
  const d = new Date(now);
  for (let back = 1; back <= 7; back++) {
    const prior = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 12);
    if (weekdays.includes(prior.getDay())) return localDay(prior.getTime());
  }
  return null;
}

/** What today's morning check does: fire the report, record the day as
 *  skipped (past the grace window with no handled previous day), or nothing
 *  (null). Pure. */
export function morningDecision(
  settings: Pick<FactorySettings, 'enabled' | 'morning'>,
  now: number,
  lastDay: string | null,
): { day: string; fire: boolean } | null {
  if (!settings.enabled) return null;
  const d = new Date(now);
  const hour = settings.morning.hour;
  if (!settings.morning.weekdays.includes(d.getDay()) || d.getHours() < hour) return null;
  const day = localDay(now);
  if (day === lastDay) return null;
  // The previous scheduled day was handled: a late open today catches up.
  if (lastDay !== null && lastDay === previousMorningDay(settings.morning.weekdays, now)) return { day, fire: true };
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour).getTime();
  return { day, fire: now - start < MORNING_GRACE_MS };
}

/** The local day to fire for now, or null when nothing is due. Pure. */
export function morningDue(settings: Pick<FactorySettings, 'enabled' | 'morning'>, now: number, lastDay: string | null): string | null {
  const decision = morningDecision(settings, now, lastDay);
  return decision?.fire ? decision.day : null;
}

export interface MorningScheduleOptions {
  /** `<wmuxDir>/factory/morning-schedule.json` */
  file: string;
  settings: () => FactorySettings;
  fire: (scheduleId: string) => Promise<MorningFireResult>;
  /** Whether the log holds this local day's report: a `duplicate` answer
   *  counts as fired only when it does (a write that failed reads the same). */
  reportedOn?: (day: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export class MorningSchedule {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly opts: MorningScheduleOptions) {
    this.now = opts.now ?? Date.now;
  }

  private lastDay(): string | null {
    try {
      if (!fs.existsSync(this.opts.file)) return null;
      const raw = atomicReadJSONSync<{ version?: unknown; lastDay?: unknown }>(this.opts.file);
      return raw?.version === 1 && typeof raw.lastDay === 'string' ? raw.lastDay : null;
    } catch {
      return null;
    }
  }

  /** One check; resolves with what happened (tests). */
  async tick(): Promise<'idle' | 'fired' | 'retry'> {
    if (this.busy) return 'idle';
    const decision = morningDecision(this.opts.settings(), this.now(), this.lastDay());
    if (!decision) return 'idle';
    const day = decision.day;
    if (!decision.fire) {
      // Too late for today's report: today counts as handled, so the next
      // scheduled morning fires (and a late open that day still catches up).
      try {
        fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
        atomicWriteJSONSync(this.opts.file, { version: 1, lastDay: day });
      } catch (err) {
        (this.opts.log ?? console.warn)(`[factory] morning schedule could not record a skipped day: ${String(err)}`);
      }
      return 'idle';
    }
    this.busy = true;
    try {
      const r = await this.opts.fire(MORNING_SCHEDULE_ID);
      if (!r.ok && (r.code !== 'duplicate' || this.opts.reportedOn?.(day) === false)) return 'retry';
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
      atomicWriteJSONSync(this.opts.file, { version: 1, lastDay: day });
      return 'fired';
    } catch (err) {
      (this.opts.log ?? console.warn)(`[factory] morning report failed: ${String(err)}`);
      return 'retry';
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHECK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ─── Scheduled runs — wall-clock schedule math ──────────────────────────────
//
// Pure functions over the system time zone (whatever `Date` resolves local
// time with). Occurrences are enumerated by LOCAL CALENDAR DATE, never by
// adding 24h to an instant, which is what makes the two DST edges behave:
//
//   - gap (spring forward, the wall time does not exist that day): the
//     occurrence moves to the first instant whose wall time is at or after the
//     requested one on that date — 02:30 in a 02:00→03:00 gap fires at 03:00.
//   - overlap (fall back, the wall time exists twice): one date yields one
//     instant (the engine's earlier-offset reading), so it fires once.
//
// A missed occurrence fires only while it is within the grace window; of
// several missed ones only the most recent in-grace one fires and every other
// one is reported so the run history can record it as skipped.

import type { AutomationScheduleTrigger } from './automation';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How far back a missed-occurrence scan looks at most. */
const MAX_SCAN_DAYS = 400;

export const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseScheduleTime(time: string): { hour: number; minute: number } | null {
  const m = SCHEDULE_TIME_RE.exec(time);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function sameDate(d: Date, y: number, mo: number, day: number): boolean {
  return d.getFullYear() === y && d.getMonth() === mo && d.getDate() === day;
}

function wallMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * The instant `hour:minute` names on local date y-mo-day, or null when that
 * date has no such wall time at all (a skipped calendar day, or a gap that
 * pushes past midnight).
 */
export function occurrenceOnDate(y: number, mo: number, day: number, hour: number, minute: number): number | null {
  const candidate = new Date(y, mo, day, hour, minute, 0, 0);
  const target = hour * 60 + minute;
  if (sameDate(candidate, y, mo, day) && wallMinutes(candidate) === target) return candidate.getTime();
  if (!sameDate(candidate, y, mo, day)) return null;
  // DST gap. Engines resolve a nonexistent wall time with the pre-transition
  // offset (shifted forward); walk minute by minute to the first instant on
  // this date whose wall time is at or after the requested one.
  let t = candidate.getTime();
  if (wallMinutes(candidate) > target) {
    for (let i = 0; i < 24 * 60; i++) {
      const prev = new Date(t - MINUTE_MS);
      if (!sameDate(prev, y, mo, day) || wallMinutes(prev) < target) break;
      t -= MINUTE_MS;
    }
  } else {
    for (let i = 0; i < 24 * 60; i++) {
      const cur = new Date(t);
      if (!sameDate(cur, y, mo, day)) return null;
      if (wallMinutes(cur) >= target) break;
      t += MINUTE_MS;
    }
  }
  return t;
}

/** Local midday of the date `offsetDays` after the date of `at` (midday dodges DST edges). */
function localDay(at: number, offsetDays: number): Date {
  const base = new Date(at);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, 12, 0, 0, 0);
}

function occurrenceForDay(trigger: AutomationScheduleTrigger, day: Date): number | null {
  if (!trigger.weekdays.includes(day.getDay())) return null;
  const hm = parseScheduleTime(trigger.time);
  if (!hm) return null;
  return occurrenceOnDate(day.getFullYear(), day.getMonth(), day.getDate(), hm.hour, hm.minute);
}

/** First occurrence strictly after `after`, or null when the trigger can never fire. */
export function nextOccurrenceAfter(trigger: AutomationScheduleTrigger, after: number): number | null {
  if (trigger.weekdays.length === 0 || !parseScheduleTime(trigger.time)) return null;
  // Eight days covers a weekly slot even when today's is already past.
  for (let i = 0; i <= 8; i++) {
    const t = occurrenceForDay(trigger, localDay(after, i));
    if (t !== null && t > after) return t;
  }
  return null;
}

/**
 * Occurrences in (fromExclusive, toInclusive], newest first, at most `limit`.
 * Scans backwards from `toInclusive` so a months-long gap costs `limit` hits,
 * not one iteration per missed day.
 */
export function occurrencesBetween(
  trigger: AutomationScheduleTrigger,
  fromExclusive: number,
  toInclusive: number,
  limit: number,
): number[] {
  const out: number[] = [];
  if (toInclusive <= fromExclusive || limit <= 0) return out;
  const spanDays = Math.min(MAX_SCAN_DAYS, Math.ceil((toInclusive - fromExclusive) / DAY_MS) + 1);
  for (let i = 0; i <= spanDays && out.length < limit; i++) {
    const t = occurrenceForDay(trigger, localDay(toInclusive, -i));
    if (t === null || t > toInclusive) continue;
    if (t <= fromExclusive) break;
    out.push(t);
  }
  return out;
}

export interface DuePlanInput {
  trigger: AutomationScheduleTrigger;
  /** Persisted cursor: the next occurrence as last computed. */
  nextRunAt: number | null;
  now: number;
  /** Newest `scheduledFor` already recorded for this automation (never re-fire it). */
  lastScheduledFor: number | null;
  /** First evaluation after daemon start: beyond-grace occurrences were missed because we were down. */
  booting: boolean;
  /** Skipped occurrences reported at most (history is bounded anyway). */
  limit: number;
}

export interface DuePlan {
  /** Occurrence to launch now, if any. */
  fire: number | null;
  /** Occurrences to record as skipped, newest first. */
  skipped: Array<{ at: number; reason: 'missed' | 'daemon_down' }>;
  /** Recomputed cursor. */
  nextRunAt: number | null;
}

/**
 * Decide what a tick does for one enabled automation.
 *
 * The cursor is recomputed on every call from `max(now, lastScheduledFor)`,
 * which is also what absorbs a wall-clock jump: a clock moved backwards cannot
 * re-arm an occurrence already recorded, and a sleep gap simply shows up as
 * several due occurrences at once.
 */
export function planDue(input: DuePlanInput): DuePlan {
  const { trigger, now, lastScheduledFor } = input;
  const graceMs = Math.max(1, trigger.graceMinutes) * MINUTE_MS;
  const floor = lastScheduledFor ?? Number.NEGATIVE_INFINITY;
  const cursorFloor = Math.max(now, lastScheduledFor ?? now);
  const nextRunAt = nextOccurrenceAfter(trigger, cursorFloor);

  if (input.nextRunAt === null || input.nextRunAt > now) {
    return { fire: null, skipped: [], nextRunAt };
  }
  const from = Math.max(input.nextRunAt - 1, floor);
  const due = occurrencesBetween(trigger, from, now, input.limit + 1).filter((t) => t > floor);
  let fire: number | null = null;
  const skipped: DuePlan['skipped'] = [];
  for (const at of due) {
    const inGrace = now - at <= graceMs;
    if (inGrace && fire === null) {
      fire = at;
      continue;
    }
    skipped.push({ at, reason: !inGrace && input.booting ? 'daemon_down' : 'missed' });
  }
  return { fire, skipped: skipped.slice(0, input.limit), nextRunAt };
}

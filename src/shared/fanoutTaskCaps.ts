// ─── Fan-out task caps (Settings → Roles & fan-out) ─────────────────────────
//
// The two app-wide brakes on fan-out (main/worktask/fanoutGuards.ts): how many
// fan-out tasks may be live at once, and how many may start per rolling hour.
// Each is optional: unset (null) means no limit, and that is the default. The
// owner sets them; main stores them in its fan-out policy file
// (main/worktask/fanoutWorkerPolicy.ts), which no pipe RPC writes, so an agent
// cannot set its own brakes. Shared so the Settings field and main clamp to
// the same bounds.

export const MIN_FANOUT_LIVE_TASK_CAP = 1;
export const MAX_FANOUT_LIVE_TASK_CAP = 32;

export const MIN_FANOUT_HOURLY_TASK_CAP = 1;
export const MAX_FANOUT_HOURLY_TASK_CAP = 200;

/**
 * The defaults before the caps became optional. A policy file written before
 * then always held a value, these unless the owner changed them: the one-time
 * migration (fanoutWorkerPolicy.ts) reads exactly these as unset.
 */
export const LEGACY_FANOUT_LIVE_TASK_CAP = 8;
export const LEGACY_FANOUT_HOURLY_TASK_CAP = 24;

function clampCap(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A stored live cap, in bounds; anything but a number is no limit (null). */
export function clampFanoutLiveTaskCap(value: unknown): number | null {
  return clampCap(value, MIN_FANOUT_LIVE_TASK_CAP, MAX_FANOUT_LIVE_TASK_CAP);
}

/** A stored hourly cap, in bounds; anything but a number is no limit (null). */
export function clampFanoutHourlyTaskCap(value: unknown): number | null {
  return clampCap(value, MIN_FANOUT_HOURLY_TASK_CAP, MAX_FANOUT_HOURLY_TASK_CAP);
}

// ─── Fan-out task caps (Settings → Roles & fan-out) ─────────────────────────
//
// The two app-wide brakes on fan-out (main/worktask/fanoutGuards.ts): how many
// fan-out tasks may be live at once, and how many may start per rolling hour.
// The owner sets them; main stores them in its fan-out policy file
// (main/worktask/fanoutWorkerPolicy.ts), which no pipe RPC writes, so an agent
// cannot raise its own brakes. Shared so the Settings field and main clamp to
// the same bounds.

export const DEFAULT_FANOUT_LIVE_TASK_CAP = 8;
export const MIN_FANOUT_LIVE_TASK_CAP = 1;
export const MAX_FANOUT_LIVE_TASK_CAP = 32;

export const DEFAULT_FANOUT_HOURLY_TASK_CAP = 24;
export const MIN_FANOUT_HOURLY_TASK_CAP = 1;
export const MAX_FANOUT_HOURLY_TASK_CAP = 200;

function clampCap(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A stored live cap, in bounds; anything but a number is the default. */
export function clampFanoutLiveTaskCap(value: unknown): number {
  return clampCap(value, DEFAULT_FANOUT_LIVE_TASK_CAP, MIN_FANOUT_LIVE_TASK_CAP, MAX_FANOUT_LIVE_TASK_CAP);
}

/** A stored hourly cap, in bounds; anything but a number is the default. */
export function clampFanoutHourlyTaskCap(value: unknown): number {
  return clampCap(value, DEFAULT_FANOUT_HOURLY_TASK_CAP, MIN_FANOUT_HOURLY_TASK_CAP, MAX_FANOUT_HOURLY_TASK_CAP);
}

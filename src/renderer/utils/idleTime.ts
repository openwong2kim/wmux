/** Idle-duration label: minutes under an hour, then hours, then days. */
export function formatIdle(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Idle badge threshold — under a minute is "just now", not neglect. */
export const IDLE_SHOW_AFTER_MS = 60_000;
/** Re-render cadence for the idle label; minute granularity needs no more. */
export const IDLE_TICK_MS = 30_000;

// Main's mirror of the daemon's pane usage-limit holds (shared/usageLimit).
//
// The daemon owns the state; main keeps a copy for two reasons only: its own
// gated delivery (a2a, channel mentions, turn-end reminders)
// refuses a held pane without a daemon round-trip, and it fills a reset time
// the hook text did not carry from the statusline's live `rate_limits` for the
// same pane.
//
// It also keeps each pane's 5-hour window for the renderer, so a pane close
// to its limit can offer a handoff before work stops. The statusline sends a
// changed sample once per account (its config dir), from whichever pane drew
// it first, so a window is kept per config dir and every pane that ever
// reported from that dir reads it.

import { mergeLiveWindow, type UsageUpdate, type UsageWindow } from '../claude/usageMerge';
import {
  exhaustedWindowResetAt,
  formatResetDuration,
  usageLimitHolds,
  type PaneUsageLimit,
  type PaneUsageWindow,
} from '../../shared/usageLimit';

const limits = new Map<string, PaneUsageLimit>();
/** Last statusline sample per pane, kept small: only panes that report one. */
const samples = new Map<string, UsageUpdate>();
const SAMPLE_CAP = 256;
/** The config dir each pane's statusline reported from ('' = the default profile). */
const paneConfig = new Map<string, string>();
/** The latest 5-hour window per config dir. */
const configWindow = new Map<string, UsageWindow>();

/** Told when a pane's 5-hour window may have changed. */
let onWindows: (() => void) | null = null;

export function setPaneUsageWindowsListener(fn: (() => void) | null): void {
  onWindows = fn;
}

/** Insert as the newest entry, dropping the oldest past the cap. */
function putCapped<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > SAMPLE_CAP) map.delete(map.keys().next().value as string);
}

/** Called with a reset time worth sending to the daemon for a pane. */
let fillReset: ((ptyId: string, resetsAt: number) => void) | null = null;

export function setUsageLimitResetFiller(fn: ((ptyId: string, resetsAt: number) => void) | null): void {
  fillReset = fn;
}

/** The reset of the pane's exhausted window, from its latest statusline sample. */
function sampleResetAt(ptyId: string): number | null {
  const sample = samples.get(ptyId);
  if (!sample) return null;
  return exhaustedWindowResetAt([sample.session, sample.weekly].map((w) =>
    w ? { pct: w.pct, resetsAt: w.resetEpochSec * 1000 } : null));
}

function maybeFill(ptyId: string): void {
  const limit = limits.get(ptyId);
  if (!limit || limit.provider !== 'claude' || limit.resetsAt != null) return;
  const resetsAt = sampleResetAt(ptyId);
  if (resetsAt != null && resetsAt > Date.now()) fillReset?.(ptyId, resetsAt);
}

/** A daemon `usage.limit.changed` (null = cleared). */
export function notePaneUsageLimit(ptyId: string, limit: PaneUsageLimit | null): void {
  if (limit) {
    limits.set(ptyId, limit);
    maybeFill(ptyId);
  } else {
    limits.delete(ptyId);
  }
}

/** Replace the whole mirror (daemon reconnect / renderer boot list). */
export function replacePaneUsageLimits(list: readonly PaneUsageLimit[]): void {
  limits.clear();
  for (const limit of list) limits.set(limit.ptyId, limit);
}

export function getPaneUsageLimit(ptyId: string): PaneUsageLimit | undefined {
  return limits.get(ptyId);
}

/** A live `rate_limits` sample from the pane's statusline, which runs with
 *  the pane's `configDir` (null = the default profile). */
export function notePaneUsageSample(ptyId: string, update: UsageUpdate, configDir: string | null = null, now = Date.now()): void {
  putCapped(samples, ptyId, update);
  maybeFill(ptyId);
  const key = configDir ?? '';
  putCapped(paneConfig, ptyId, key);
  const merged = mergeLiveWindow(configWindow.get(key) ?? null, update.session, Math.floor(now / 1000));
  if (merged) putCapped(configWindow, key, merged);
  onWindows?.();
}

/** Each reporting pane's 5-hour window, while it has not reset, in ptyId order
 *  (so the same windows always serialize the same). */
export function paneUsageWindows(now = Date.now()): Record<string, PaneUsageWindow> {
  const out: Record<string, PaneUsageWindow> = {};
  for (const [ptyId, key] of [...paneConfig].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const w = configWindow.get(key);
    if (w && w.resetEpochSec * 1000 > now) out[ptyId] = { pct: w.pct, resetsAt: w.resetEpochSec * 1000 };
  }
  return out;
}

export function forgetPaneUsage(ptyId: string): void {
  limits.delete(ptyId);
  samples.delete(ptyId);
  if (paneConfig.delete(ptyId)) onWindows?.();
}

/** The refusal detail when automatic input must wait, else null. */
export function usageLimitHoldDetail(ptyId: string, now = Date.now()): string | null {
  const limit = limits.get(ptyId);
  if (!usageLimitHolds(limit, now) || !limit) return null;
  return limit.resetsAt != null
    ? `delivery: the pane hit its ${limit.provider} usage limit; held until it resets at ${new Date(limit.resetsAt).toISOString()} (in ${formatResetDuration(limit.resetsAt - now)})`
    : `delivery: the pane hit its ${limit.provider} usage limit; reset time unknown`;
}

/** Test seam. */
export function resetPaneUsageLimitsForTest(): void {
  limits.clear();
  samples.clear();
  paneConfig.clear();
  configWindow.clear();
  fillReset = null;
  onWindows = null;
}

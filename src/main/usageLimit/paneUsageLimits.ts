// Main's mirror of the daemon's pane usage-limit holds (shared/usageLimit).
//
// The daemon owns the state; main keeps a copy for two reasons only: its own
// gated delivery (a2a, company messages, channel mentions, turn-end reminders)
// refuses a held pane without a daemon round-trip, and it fills a reset time
// the hook text did not carry from the statusline's live `rate_limits` for the
// same pane.

import type { UsageUpdate } from '../claude/usageMerge';
import {
  exhaustedWindowResetAt,
  formatResetDuration,
  usageLimitHolds,
  type PaneUsageLimit,
} from '../../shared/usageLimit';

const limits = new Map<string, PaneUsageLimit>();
/** Last statusline sample per pane, kept small: only panes that report one. */
const samples = new Map<string, UsageUpdate>();
const SAMPLE_CAP = 256;

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

/** A live `rate_limits` sample from the pane's statusline. */
export function notePaneUsageSample(ptyId: string, update: UsageUpdate): void {
  samples.delete(ptyId);
  samples.set(ptyId, update);
  if (samples.size > SAMPLE_CAP) samples.delete(samples.keys().next().value as string);
  maybeFill(ptyId);
}

export function forgetPaneUsage(ptyId: string): void {
  limits.delete(ptyId);
  samples.delete(ptyId);
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
  fillReset = null;
}

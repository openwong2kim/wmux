// Merging a LIVE usage sample into existing usage state.
//
// Two sources feed the usage view: the OAuth usage endpoint (HTTP, polled)
// and Claude Code's statusline `rate_limits` (live, pushed by
// wmux-statusline.mjs through `usage.rateLimits`). HTTP is authoritative: an
// ok HTTP result replaces the whole snapshot (see UsagePoller /
// AccountUsageService), which is what corrects a mid-window adjustment, an
// account switch on the default profile, or a bad live value.
//
// A live sample, by contrast, can come from any pane on the account, and a
// pane that has not rendered since the window rolled over reports the old
// window. Arrival order therefore decides nothing; each window is keyed by
// its reset time:
//   - reset already in the past  → that window is over; drop the sample
//   - existing reset unknown (0) → the sample knows better; replace
//   - same reset (within slack)  → same window; utilization only grows
//                                  inside one window, so keep the max
//   - later reset                → a newer window; replace
//   - earlier reset              → an older window; drop the sample
// A reset of 0 means "unknown" (the HTTP parser's convention), never 1970.

import type { UsageSnapshot } from './UsageApi';

/** One rate-limit window: integer percent 0–100 and its reset (epoch s, 0 = unknown). */
export interface UsageWindow {
  pct: number;
  resetEpochSec: number;
}

/** A live sample. Either window may be absent (the statusline contract allows
 *  each to be missing independently). Live samples never carry scoped
 *  (per-model weekly) limits. */
export interface UsageUpdate {
  session?: UsageWindow;
  weekly?: UsageWindow;
}

/** Two resets this close apart describe the same window. The two sources
 *  report the same instant, but one is parsed from an ISO string and the other
 *  is an integer from Claude Code, so allow a little drift. A NEW window can
 *  only start after the old one reset, so its reset is hours later — far
 *  outside this slack. */
const SAME_WINDOW_SLACK_SEC = 5 * 60;

/** Merge one live window. Returns `prev` itself when the sample changes
 *  nothing, so callers can detect a no-op by reference. */
export function mergeLiveWindow(
  prev: UsageWindow | null,
  next: UsageWindow | undefined,
  nowSec: number,
): UsageWindow | null {
  if (!next) return prev;
  if (next.resetEpochSec <= nowSec) return prev; // already over (or unknown)
  if (!prev || prev.resetEpochSec === 0 || prev.resetEpochSec <= nowSec) return next;
  if (Math.abs(next.resetEpochSec - prev.resetEpochSec) <= SAME_WINDOW_SLACK_SEC) {
    return next.pct > prev.pct ? { pct: next.pct, resetEpochSec: prev.resetEpochSec } : prev;
  }
  return next.resetEpochSec > prev.resetEpochSec ? next : prev;
}

/**
 * Merge a live sample into a snapshot. Returns `prev` (same reference) when
 * nothing observable changed, and null when there is no previous snapshot and
 * the sample does not carry both windows (a snapshot with a made-up 0% would
 * read as real) — the caller reports that as not applied.
 *
 * Scoped limits are per-week: they are kept while the weekly window stays the
 * same and dropped when the sample moves the weekly window on, so an older
 * week's per-model numbers never sit under a newer week.
 */
export function mergeLive(
  prev: UsageSnapshot | null,
  update: UsageUpdate,
  nowMs: number,
): UsageSnapshot | null {
  const nowSec = Math.floor(nowMs / 1000);
  const prevSession = prev ? { pct: prev.sessionPct, resetEpochSec: prev.sessionResetEpochSec } : null;
  const prevWeekly = prev ? { pct: prev.weeklyPct, resetEpochSec: prev.weeklyResetEpochSec } : null;
  const session = mergeLiveWindow(prevSession, update.session, nowSec);
  const weekly = mergeLiveWindow(prevWeekly, update.weekly, nowSec);
  if (!session || !weekly) return prev;
  if (prev && session === prevSession && weekly === prevWeekly) return prev;
  const snapshot: UsageSnapshot = {
    sessionPct: session.pct,
    sessionResetEpochSec: session.resetEpochSec,
    weeklyPct: weekly.pct,
    weeklyResetEpochSec: weekly.resetEpochSec,
    fetchedAtMs: nowMs,
  };
  const sameWeek = prevWeekly !== null && weekly.resetEpochSec === prevWeekly.resetEpochSec;
  if (sameWeek && prev?.scoped && prev.scoped.length > 0) snapshot.scoped = prev.scoped;
  return snapshot;
}

// Merge rule for usage windows arriving from two sources: the OAuth usage
// endpoint (HTTP, polled) and Claude Code's statusline `rate_limits` (live,
// pushed by wmux-statusline.mjs through `usage.rateLimits`).
//
// Either source can be older than what is already on screen — a live sample
// from a pane that has not rendered since the window rolled over, or an HTTP
// response that was in flight while a fresher live sample landed. Arrival
// order therefore decides nothing. Each window is keyed by its reset time:
//   - reset already in the past  → the incoming window is over; drop it
//   - same reset (within slack)  → same window; utilization only grows
//                                  inside one window, so keep the max
//   - later reset                → a newer window; replace
//   - earlier reset              → an older window; drop it
// A reset of 0 means "unknown" (the HTTP parser's convention), never 1970.

import type { UsageSnapshot } from './UsageApi';

/** One rate-limit window: integer percent 0–100 and its reset (epoch s, 0 = unknown). */
export interface UsageWindow {
  pct: number;
  resetEpochSec: number;
}

/** Windows to merge in. Either may be absent (the statusline contract allows
 *  each window to be missing independently). `scoped` is only ever carried by
 *  HTTP; when absent the previous snapshot's scoped limits are kept. */
export interface UsageUpdate {
  session?: UsageWindow;
  weekly?: UsageWindow;
  scoped?: UsageSnapshot['scoped'];
}

/** Two resets this close apart describe the same window. The two sources
 *  report the same instant, but one is parsed from an ISO string and the other
 *  is an integer from Claude Code, so allow a little drift. A NEW window can
 *  only start after the old one reset, so its reset is hours later — far
 *  outside this slack. */
const SAME_WINDOW_SLACK_SEC = 5 * 60;

/** Merge one window. Returns `prev` itself when the incoming one changes
 *  nothing, so callers can detect a no-op by reference. */
export function mergeWindow(
  prev: UsageWindow | null,
  next: UsageWindow | undefined,
  nowSec: number,
): UsageWindow | null {
  if (!next) return prev;
  const nextKnown = next.resetEpochSec > 0;
  const prevLive = prev !== null && (prev.resetEpochSec === 0 || prev.resetEpochSec > nowSec);
  if (nextKnown && next.resetEpochSec <= nowSec) {
    // Already over. It only beats a previous window that is over too, and
    // only when it is the later of the two — never a live one.
    return prev && !prevLive && next.resetEpochSec > prev.resetEpochSec ? next : prev;
  }
  if (!prev || !prevLive) return next;
  if (!nextKnown || prev.resetEpochSec === 0
      || Math.abs(next.resetEpochSec - prev.resetEpochSec) <= SAME_WINDOW_SLACK_SEC) {
    // Same window (or one side cannot tell): utilization only grows. Keep a
    // known reset over an unknown one.
    const pct = Math.max(prev.pct, next.pct);
    const resetEpochSec = prev.resetEpochSec > 0 ? prev.resetEpochSec : next.resetEpochSec;
    if (pct === prev.pct && resetEpochSec === prev.resetEpochSec) return prev;
    return { pct, resetEpochSec };
  }
  return next.resetEpochSec > prev.resetEpochSec ? next : prev;
}

/**
 * Merge an update into a snapshot. Returns `prev` (same reference) when
 * nothing observable changed, and null when there is no previous snapshot and
 * the update does not carry both windows (a snapshot with a made-up 0% would
 * read as real).
 */
export function mergeUsage(
  prev: UsageSnapshot | null,
  update: UsageUpdate,
  nowMs: number,
): UsageSnapshot | null {
  const nowSec = Math.floor(nowMs / 1000);
  const prevSession = prev ? { pct: prev.sessionPct, resetEpochSec: prev.sessionResetEpochSec } : null;
  const prevWeekly = prev ? { pct: prev.weeklyPct, resetEpochSec: prev.weeklyResetEpochSec } : null;
  const session = mergeWindow(prevSession, update.session, nowSec);
  const weekly = mergeWindow(prevWeekly, update.weekly, nowSec);
  if (!session || !weekly) return prev;
  const scoped = update.scoped ?? prev?.scoped;
  if (
    prev
    && session === prevSession
    && weekly === prevWeekly
    && scoped === prev.scoped
  ) {
    return prev;
  }
  const snapshot: UsageSnapshot = {
    sessionPct: session.pct,
    sessionResetEpochSec: session.resetEpochSec,
    weeklyPct: weekly.pct,
    weeklyResetEpochSec: weekly.resetEpochSec,
    fetchedAtMs: nowMs,
  };
  if (scoped && scoped.length > 0) snapshot.scoped = scoped;
  return snapshot;
}

/** The windows of an HTTP snapshot, as an update. */
export function updateFromSnapshot(s: UsageSnapshot): UsageUpdate {
  return {
    session: { pct: s.sessionPct, resetEpochSec: s.sessionResetEpochSec },
    weekly: { pct: s.weeklyPct, resetEpochSec: s.weeklyResetEpochSec },
    scoped: s.scoped ?? [],
  };
}

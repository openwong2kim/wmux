// ─── Command Deck — level-review heartbeat config store ──────────────────────
//
// The WP4 heartbeat periodically re-reads each workspace's CURRENT per-pane
// state (a level snapshot) and wakes the brain through the coalescer's gate
// stack — the missed-judgment safety net for a pane whose edge event was lost.
// This store holds that heartbeat's two knobs: whether it runs at all and how
// often it reviews.
//
// Default is ON at a 3-minute cadence: the review is cheap (it re-runs the same
// budget/rate/mode gates as an edge wake, so it never wakes more than the edge
// path would) and closes the "the edge was dropped, nothing ever surfaced it"
// gap. Same storage shape and never-throw posture as deckAutoWakeStore (atomic
// JSON in the wmux data dir, WMUX_DATA_SUFFIX isolated).

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';

export interface DeckHeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  /** Age (ms) beyond which a PENDING brain-raised decision is treated as STALE:
   *  the next heartbeat wakes the brain with a re-examine turn that bypasses the
   *  pending-decision wake block so a decision can never wedge the wake loop
   *  forever waiting on a human (WP3). Sanitized like intervalMs (corrupt →
   *  default; clamped to a floor). */
  decisionTtlMs: number;
}

/** A floor on the review cadence: a heartbeat firing more often than once a
 *  minute would defeat its own point (it is a safety net, not a poll) and could
 *  churn budget. Anything below is clamped up on read. */
export const MIN_HEARTBEAT_INTERVAL_MS = 60_000;

/** A floor on the decision TTL: re-examining a pending decision more often than
 *  every 5 minutes would nag the brain (and burn a wake) faster than a human
 *  could reasonably answer. Anything below is clamped up on read. */
export const MIN_DECISION_TTL_MS = 5 * 60_000;

/** Default decision TTL: 30 minutes of no human answer before the first
 *  re-examine wake. */
export const DEFAULT_DECISION_TTL_MS = 30 * 60_000;

export const DEFAULT_HEARTBEAT: DeckHeartbeatConfig = {
  enabled: true,
  intervalMs: 180_000,
  decisionTtlMs: DEFAULT_DECISION_TTL_MS,
};

export function getDeckHeartbeatPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-heartbeat.json');
}

/** Read the heartbeat config. Anything uncertain (missing file, torn JSON, wrong
 *  shape, non-finite interval) resolves to the default. intervalMs is clamped to
 *  the sane floor. Never throws. */
export function loadDeckHeartbeat(dir?: string): DeckHeartbeatConfig {
  try {
    const raw = atomicReadJSONSync<unknown>(getDeckHeartbeatPath(dir));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...DEFAULT_HEARTBEAT };
    }
    const o = raw as Record<string, unknown>;
    const enabled = typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_HEARTBEAT.enabled;
    const rawInterval =
      typeof o.intervalMs === 'number' && Number.isFinite(o.intervalMs)
        ? Math.floor(o.intervalMs)
        : DEFAULT_HEARTBEAT.intervalMs;
    const intervalMs = Math.max(MIN_HEARTBEAT_INTERVAL_MS, rawInterval);
    const rawTtl =
      typeof o.decisionTtlMs === 'number' && Number.isFinite(o.decisionTtlMs)
        ? Math.floor(o.decisionTtlMs)
        : DEFAULT_HEARTBEAT.decisionTtlMs;
    const decisionTtlMs = Math.max(MIN_DECISION_TTL_MS, rawTtl);
    return { enabled, intervalMs, decisionTtlMs };
  } catch {
    return { ...DEFAULT_HEARTBEAT };
  }
}

/** Persist the heartbeat config, merging over the current value so a partial
 *  update (just `enabled`, say) keeps the other field. Returns the config now in
 *  force (intervalMs re-clamped). */
export async function saveDeckHeartbeat(
  patch: Partial<DeckHeartbeatConfig>,
  dir?: string,
): Promise<DeckHeartbeatConfig> {
  const current = loadDeckHeartbeat(dir);
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
  const rawInterval =
    typeof patch.intervalMs === 'number' && Number.isFinite(patch.intervalMs)
      ? Math.floor(patch.intervalMs)
      : current.intervalMs;
  const rawTtl =
    typeof patch.decisionTtlMs === 'number' && Number.isFinite(patch.decisionTtlMs)
      ? Math.floor(patch.decisionTtlMs)
      : current.decisionTtlMs;
  const next: DeckHeartbeatConfig = {
    enabled,
    intervalMs: Math.max(MIN_HEARTBEAT_INTERVAL_MS, rawInterval),
    decisionTtlMs: Math.max(MIN_DECISION_TTL_MS, rawTtl),
  };
  await atomicWriteJSON(getDeckHeartbeatPath(dir), next);
  return next;
}

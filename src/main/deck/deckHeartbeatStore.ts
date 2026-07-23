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
}

/** A floor on the review cadence: a heartbeat firing more often than once a
 *  minute would defeat its own point (it is a safety net, not a poll) and could
 *  churn budget. Anything below is clamped up on read. */
export const MIN_HEARTBEAT_INTERVAL_MS = 60_000;

export const DEFAULT_HEARTBEAT: DeckHeartbeatConfig = {
  enabled: true,
  intervalMs: 180_000,
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
    return { enabled, intervalMs };
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
  const next: DeckHeartbeatConfig = {
    enabled,
    intervalMs: Math.max(MIN_HEARTBEAT_INTERVAL_MS, rawInterval),
  };
  await atomicWriteJSON(getDeckHeartbeatPath(dir), next);
  return next;
}

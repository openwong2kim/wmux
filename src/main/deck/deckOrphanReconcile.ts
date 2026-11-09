// ─── Command Deck — Orphan Reconcile (WMX-06) ────────────────────────────────
//
// Reconciles orphan Deck state once at startup (deck.handler.ts arms it) and
// on request (`deck.state.prune`, `wmux deck state --prune`):
//   - Identifies workspaces that no longer exist in wmux (not in liveWorkspaceIds)
//   - Archives active work records to deck-work.archive.json before teardown
//   - Applies parked-work TTL (72 hours) so only expired orphan work is purged;
//     parked work of a live workspace is never touched
//   - Calls teardownWorkspaceDeckState to clean up work, autonomy and
//     decisions for orphan workspaces
//   - Fail-closed: does nothing if liveWorkspaceIds is null or empty
//   - Never throws

import { atomicReadJSONSync } from '../../daemon/util/atomicWrite';
import {
  getDeckWorkPath,
  loadActiveDeckWorks,
  isDeckWorkParked,
  archiveDeckWork,
} from './deckWorkStore';
import { getDeckAutonomyPath } from './deckAutonomyStore';
import { getDeckDecisionPath } from './deckDecisionStore';
import { MOA_MEMORY_DECISION_KEY } from '../../shared/moa';
import { teardownWorkspaceDeckState } from './deckWorkspaceTeardown';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { DEFAULT_MAX_SNAPSHOT_AGE_MS } from './stopGate';

export const PARKED_WORK_TTL_HOURS = 72;

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export interface OrphanReport {
  orphans: string[];
  archived: string[];
  tornDown?: string[];
  skipped?: string;
  skippedIds?: string[];
}

export interface OrphanReconcileOptions {
  dir?: string;
  now?: number;
  log?: (line: string) => void;
  dryRun?: boolean;
  parkedWorkTtlHours?: number;
}

/**
 * Collect every workspace ID matching WORKSPACE_ID_RE present across the
 * Deck store files, along with the list of store file names it appears in:
 *   1. deck-work.json (keys in active)
 *   2. deck-autonomy.json (keys in map)
 *   3. deck-decisions.json (keys in map)
 */
export function collectDeckWorkspaceFiles(dir?: string): Map<string, string[]> {
  const map = new Map<string, Set<string>>();

  const addId = (id: string, file: string) => {
    let set = map.get(id);
    if (!set) {
      set = new Set<string>();
      map.set(id, set);
    }
    set.add(file);
  };

  // 1. deck-work.json
  try {
    const raw = atomicReadJSONSync<unknown>(getDeckWorkPath(dir));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const active = (raw as Record<string, unknown>).active;
      if (active && typeof active === 'object' && !Array.isArray(active)) {
        for (const k of Object.keys(active)) {
          if (WORKSPACE_ID_RE.test(k)) addId(k, 'deck-work.json');
        }
      }
    }
  } catch {
    // Missing or corrupt file is fine
  }

  // 2. deck-autonomy.json
  try {
    const raw = atomicReadJSONSync<unknown>(getDeckAutonomyPath(dir));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const k of Object.keys(raw as Record<string, unknown>)) {
        if (WORKSPACE_ID_RE.test(k)) addId(k, 'deck-autonomy.json');
      }
    }
  } catch {
    // Missing or corrupt file is fine
  }

  // 3. deck-decisions.json
  try {
    const raw = atomicReadJSONSync<unknown>(getDeckDecisionPath(dir));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const k of Object.keys(raw as Record<string, unknown>)) {
        // The retired "Remember this?" card's key is not a workspace.
        if (WORKSPACE_ID_RE.test(k) && k !== MOA_MEMORY_DECISION_KEY) addId(k, 'deck-decisions.json');
      }
    }
  } catch {
    // Missing or corrupt file is fine
  }

  const result = new Map<string, string[]>();
  for (const [id, set] of map.entries()) {
    result.set(id, Array.from(set).sort());
  }
  return result;
}

/**
 * Collect every workspace ID matching WORKSPACE_ID_RE present across the
 * Deck store files.
 */
export function collectDeckWorkspaceIds(dir?: string): Set<string> {
  return new Set(collectDeckWorkspaceFiles(dir).keys());
}

/**
 * Reconcile orphan Deck state at startup:
 *   - Compares existing Deck state against liveWorkspaceIds.
 *   - Fail-closed: null or empty array -> skips with log.
 *   - For each orphan: archives work record, then tears down workspace state.
 *   - Parked work TTL: parked work older than parkedWorkTtlHours is purged;
 *     parked work of a live workspace is never touched.
 *   - dryRun: reports orphans, changes nothing.
 *   - Never throws.
 */
export async function reconcileOrphanDeckState(
  liveWorkspaceIds: readonly string[] | null,
  opts?: OrphanReconcileOptions,
): Promise<OrphanReport> {
  const log = opts?.log ?? ((line: string) => {
    // eslint-disable-next-line no-console
    console.log(`[deck:reconcile] ${line}`);
  });

  const emptyReport: OrphanReport = {
    orphans: [],
    archived: [],
    tornDown: [],
    skippedIds: [],
  };

  try {
    // FAIL CLOSED: when liveWorkspaceIds is null or empty, do nothing
    if (!liveWorkspaceIds || liveWorkspaceIds.length === 0) {
      const skipped = 'skipped: workspace list not loaded';
      log(skipped);
      return { orphans: [], archived: [], tornDown: [], skippedIds: [], skipped };
    }

    const liveSet = new Set<string>();
    for (const id of liveWorkspaceIds) {
      if (typeof id === 'string' && id.trim()) {
        liveSet.add(id.trim());
      }
    }

    if (liveSet.size === 0) {
      const skipped = 'skipped: workspace list not loaded';
      log(skipped);
      return { orphans: [], archived: [], tornDown: [], skippedIds: [], skipped };
    }

    const dir = opts?.dir;
    const now = opts?.now ?? Date.now();
    const ttlHours = opts?.parkedWorkTtlHours ?? PARKED_WORK_TTL_HOURS;
    const ttlMs = ttlHours * 60 * 60 * 1000;

    const allIds = collectDeckWorkspaceIds(dir);
    const orphans = Array.from(allIds)
      .filter((id) => !liveSet.has(id))
      .sort();

    if (opts?.dryRun) {
      return { orphans, archived: [], tornDown: [], skippedIds: [] };
    }

    const archived: string[] = [];
    const tornDown: string[] = [];
    const skippedIds: string[] = [];
    const activeWorks = loadActiveDeckWorks(dir);

    for (const id of orphans) {
      const work = activeWorks[id];

      if (work) {
        // Check parked work TTL: only remove if older than TTL
        if (isDeckWorkParked(work)) {
          const workTs = work.updatedAt || work.startedAt || 0;
          const ageMs = now - workTs;
          if (ageMs < ttlMs) {
            skippedIds.push(id);
            log(
              `skipping orphan ${id}: parked work is ${Math.round(ageMs / 3600000)}h old (< ${ttlHours}h TTL)`,
            );
            continue;
          }
        }

        // Archive before teardown. A record that cannot be archived is not
        // torn down: its workspace keeps all of its Deck state for now.
        try {
          archiveDeckWork(work, dir);
          archived.push(id);
          log(`archived active work ${work.id} for orphan ${id}`);
        } catch (err) {
          skippedIds.push(id);
          log(`skipping orphan ${id}: failed to archive its work: ${String(err)}`);
          continue;
        }
      }

      // Teardown workspace state (log-only, do not raise decisions for non-existent workspace)
      try {
        await teardownWorkspaceDeckState(id, {
          dir,
          archiveActiveWork: false,
          onStrandedWork: () => {
            /* noop: do not raise decisions for workspaces that do not exist */
          },
          log,
        });
        tornDown.push(id);
        log(`torn down orphan workspace ${id}`);
      } catch (err) {
        log(`failed to teardown orphan workspace ${id}: ${String(err)}`);
      }
    }

    return { orphans, archived, tornDown, skippedIds };
  } catch (err) {
    log(`unexpected error during orphan reconcile: ${String(err)}`);
    return emptyReport;
  }
}

let startupDeckReconcileDone = false;

export function isStartupDeckReconcileDone(): boolean {
  return startupDeckReconcileDone;
}

export function __resetStartupDeckReconcileForTest(): void {
  startupDeckReconcileDone = false;
}

/**
 * Attempt startup reconcile if workspace mirror is loaded and fresh.
 * Returns true if reconcile completed or was already completed; false if mirror not ready yet.
 */
export async function tryStartupDeckReconcile(opts?: {
  dir?: string;
  log?: (line: string) => void;
  maxSnapshotAgeMs?: number;
  /** Settle work outside the deck stores whose workspace is gone (the work
   *  links). Runs under the same restored-session rule as the sweep. */
  settleClosedWork?: (liveIds: ReadonlySet<string>) => Promise<unknown>;
}): Promise<boolean> {
  if (startupDeckReconcileDone) return true;
  const mirror = getWorkspaceMirror();
  const entries = mirror.getEntries();
  const peek = mirror.peek();
  const maxAge = opts?.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;

  if (entries && entries.length > 0 && peek && peek.ageMs <= maxAge) {
    startupDeckReconcileDone = true;
    // A failed or empty session load still flips the renderer's pane gate and
    // pushes a mirror holding one freshly generated default workspace. Every
    // real workspace id on disk would then look orphaned and lose its Deck
    // state for good, although the next healthy boot restores those
    // workspaces. Same rule session.json saves follow: nothing destructive
    // unless the saved session actually came back.
    if (!mirror.isSessionRestored()) {
      const line = 'skipped startup reconcile: the renderer did not restore a saved session (load failed, was empty, or the renderer is too old to say)';
      if (opts?.log) opts.log(line);
      else {
        // eslint-disable-next-line no-console
        console.log(`[deck:reconcile] ${line}`);
      }
      return true;
    }
    const liveIds = entries.map((e) => e.id);
    try {
      await reconcileOrphanDeckState(liveIds, opts);
      await opts?.settleClosedWork?.(new Set(liveIds));
      return true;
    } catch (err) {
      opts?.log?.(`startup reconcile error: ${String(err)}`);
      return true;
    }
  }
  return false;
}

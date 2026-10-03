// ─── Command Deck — Workspace Teardown (WMX-05) ─────────────────────────────
//
// Tears down all Deck-owned state when a workspace is removed from wmux:
//   1. Loop cadence schedule (deckScheduleStore)
//   2. Durable loop state (deckLoopStateStore)
//   3. Active work request (deckWorkStore) — archived first (deck-work.archive.json),
//      then cleared and surfaced to onStrandedWork. If the archive write fails
//      the record is KEPT, never deleted unarchived.
//   4. Autonomy settings (deckAutonomyStore) — deletes the workspace entry
//   5. Pending / resolved decisions (deckDecisionStore)
//   6. Commander persisted session keys (commanderSessionStore)
//
// Invariants:
//   - Idempotent: safe to run multiple times, missing records are fine.
//   - Isolated: touches ONLY keys/schedules belonging to the target workspace;
//     any other workspace's entries remain intact.
//   - Fail-closed & resilient: each store operation runs in its own try/catch,
//     logs exactly one line per store, and never throws.
//   - Refuses empty or non-string workspace IDs.
//   - Refuses the designated HQ workspace (deckHqStore.ts): its Deck state
//     outlives a removal of its workspace, which then reads as 'hq-missing'.
//     Refuses every workspace while deck-hq.json is unreadable.

import { atomicReadJSONSync } from '../../daemon/util/atomicWrite';
import {
  type ActiveDeckWork,
  archiveDeckWork,
  clearActiveDeckWork,
  loadActiveDeckWork,
  hasPendingDeckWorkA2aTasks,
  renderStrandedDeckWorkBlock,
} from './deckWorkStore';
import { deleteWorkspaceAutonomy } from './deckAutonomyStore';
import { loadWorkspaceLoopState, clearLoop } from './deckLoopStateStore';
import { mutateDeckSchedules } from './deckScheduleStore';
import {
  loadWorkspaceDecision,
  clearDecision,
  hasPendingDecision,
  raiseDecision,
} from './deckDecisionStore';
import {
  clearCommanderSession,
  getCommanderSessionPath,
} from './commanderSessionStore';
import { getHqWorkspaceId, isHqStoreCorrupt } from './deckHqStore';

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export interface TeardownReport {
  workspaceId: string;
  scheduleDeleted: boolean;
  scheduleIds: string[];
  loopCleared: boolean;
  workCleared: boolean;
  /** The active work record was copied into the archive before it was cleared. */
  workArchived: boolean;
  strandedWork: ActiveDeckWork | null;
  autonomyDeleted: boolean;
  decisionCleared: boolean;
  commanderSessionsCleared: string[];
}

export interface TeardownOptions {
  dir?: string;
  /** Archive the active work record before clearing it (default true). The
   *  startup reconcile archives on its own and passes false. */
  archiveActiveWork?: boolean;
  onStrandedWork?: (work: ActiveDeckWork) => void;
  log?: (line: string) => void;
}

/**
 * Surface a dropped or superseded work record with outstanding A2A tasks
 * as a decision, preserving the decision-gate pattern from deck.handler.ts.
 */
export function surfaceStrandedWork(
  workspaceId: string,
  work: ActiveDeckWork,
  reason: 'superseded' | 'cleared',
  dir?: string,
): void {
  try {
    if (!hasPendingDeckWorkA2aTasks(work)) {
      // eslint-disable-next-line no-console
      console.warn(`[deck] ${reason} work record ${work.id} (no delegated tasks outstanding)`);
      return;
    }
    if (hasPendingDecision(workspaceId, dir)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[deck] ${reason} work record ${work.id} has outstanding A2A tasks; ` +
        'a decision is already pending, not replacing it',
      );
      return;
    }
    const question = reason === 'superseded'
      ? 'A newer request replaced an earlier one that still has delegated tasks running. ' +
        'Cancel those tasks, or adopt them into the new request?'
      : 'Starting a new session dropped a request that still has delegated tasks running. ' +
        'Cancel those tasks, or leave them running?';
    void raiseDecision(workspaceId, {
      question,
      options: reason === 'superseded'
        ? ['Cancel the old tasks', 'Adopt them into the current request']
        : ['Cancel the old tasks', 'Leave them running'],
      context: renderStrandedDeckWorkBlock(work),
    }, dir).catch(() => {
      /* best-effort — log is the fallback record */
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[deck] failed to surface stranded work:', err);
  }
}

/**
 * Tear down all Deck JSON store state for a single workspace.
 * Idempotent, never throws, logs exactly one line per store, and returns
 * a report detailing what was cleaned up.
 */
export async function teardownWorkspaceDeckState(
  workspaceId: string,
  opts?: TeardownOptions,
): Promise<TeardownReport> {
  const emptyReport: TeardownReport = {
    workspaceId: typeof workspaceId === 'string' ? workspaceId : '',
    scheduleDeleted: false,
    scheduleIds: [],
    loopCleared: false,
    workCleared: false,
    workArchived: false,
    strandedWork: null,
    autonomyDeleted: false,
    decisionCleared: false,
    commanderSessionsCleared: [],
  };

  if (typeof workspaceId !== 'string' || !workspaceId.trim() || !WORKSPACE_ID_RE.test(workspaceId.trim())) {
    return emptyReport;
  }

  const id = workspaceId.trim();
  const dir = opts?.dir;
  const log = opts?.log ?? ((line: string) => {
    // eslint-disable-next-line no-console
    console.log(`[deck:teardown] ${line}`);
  });

  if (id === getHqWorkspaceId(dir)) {
    log(`refused teardown of ${id}: it is the HQ workspace`);
    return { ...emptyReport, workspaceId: id };
  }
  // An unreadable deck-hq.json hides which workspace is the HQ: keep the Deck
  // state (harmless, swept later) rather than risk tearing the HQ down.
  if (isHqStoreCorrupt(dir)) {
    log(`refused teardown of ${id}: deck-hq.json is unreadable, so the HQ is unknown`);
    return { ...emptyReport, workspaceId: id };
  }

  const report: TeardownReport = {
    workspaceId: id,
    scheduleDeleted: false,
    scheduleIds: [],
    loopCleared: false,
    workCleared: false,
    workArchived: false,
    strandedWork: null,
    autonomyDeleted: false,
    decisionCleared: false,
    commanderSessionsCleared: [],
  };

  // 1. Schedule Store: remove loop's cadence schedule and any schedules owned by workspace
  try {
    let loopScheduleId: string | undefined;
    try {
      const loop = loadWorkspaceLoopState(id, dir);
      loopScheduleId = loop?.scheduleId;
    } catch {
      // Ignore loop read error; schedule store will still filter by workspaceId
    }

    let toRemove: { id: string }[] = [];
    await mutateDeckSchedules((schedules) => {
      toRemove = schedules.filter(
        (s) => (loopScheduleId && s.id === loopScheduleId) || s.workspaceId === id,
      );
      if (toRemove.length === 0) return null;
      const removeSet = new Set(toRemove.map((s) => s.id));
      return schedules.filter((s) => !removeSet.has(s.id));
    }, dir);
    if (toRemove.length > 0) {
      report.scheduleDeleted = true;
      report.scheduleIds = toRemove.map((s) => s.id);
      log(`[schedule] deleted ${toRemove.length} schedule(s) for ${id}`);
    } else {
      log(`[schedule] no schedule found for ${id}`);
    }
  } catch (err) {
    log(`[schedule] failed to clear schedule for ${id}: ${String(err)}`);
  }

  // 2. Loop State Store: clear loop
  try {
    const loop = loadWorkspaceLoopState(id, dir);
    await clearLoop(id, dir);
    if (loop) {
      report.loopCleared = true;
      log(`[loop] cleared loop state for ${id}`);
    } else {
      log(`[loop] no loop state found for ${id}`);
    }
  } catch (err) {
    log(`[loop] failed to clear loop for ${id}: ${String(err)}`);
  }

  // 3. Work Store: archive, then clear active work and notify stranded work
  try {
    let keepWork = false;
    if (opts?.archiveActiveWork !== false) {
      const current = loadActiveDeckWork(id, dir);
      if (current) {
        try {
          archiveDeckWork(current, dir);
          report.workArchived = true;
        } catch (err) {
          keepWork = true;
          log(`[work] kept active work ${current.id} for ${id}: archiving it failed: ${String(err)}`);
        }
      }
    }
    const stranded = keepWork ? null : clearActiveDeckWork(id, dir);
    if (stranded) {
      report.workCleared = true;
      report.strandedWork = stranded;
      if (opts?.onStrandedWork) {
        try {
          opts.onStrandedWork(stranded);
        } catch (err) {
          // notification callback must not break teardown
        }
      }
      log(`[work] ${report.workArchived ? 'archived and ' : ''}cleared active work ${stranded.id} for ${id}`);
    } else if (!keepWork) {
      log(`[work] no active work found for ${id}`);
    }
  } catch (err) {
    log(`[work] failed to clear active work for ${id}: ${String(err)}`);
  }

  // 4. Autonomy Store: delete workspace autonomy entry
  try {
    const deleted = await deleteWorkspaceAutonomy(id, dir);
    if (deleted) {
      report.autonomyDeleted = true;
      log(`[autonomy] deleted autonomy entry for ${id}`);
    } else {
      log(`[autonomy] no autonomy entry found for ${id}`);
    }
  } catch (err) {
    log(`[autonomy] failed to delete autonomy for ${id}: ${String(err)}`);
  }

  // 5. Decision Store: clear pending / resolved decision
  try {
    const dec = loadWorkspaceDecision(id, dir);
    await clearDecision(id, dir);
    if (dec) {
      report.decisionCleared = true;
      log(`[decision] cleared decision ${dec.id} for ${id}`);
    } else {
      log(`[decision] no decision found for ${id}`);
    }
  } catch (err) {
    log(`[decision] failed to clear decision for ${id}: ${String(err)}`);
  }

  // 6. Commander Session Store: clear all session keys belonging to workspace
  try {
    const clearedKeys: string[] = [];
    try {
      const raw = atomicReadJSONSync<unknown>(getCommanderSessionPath(dir));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const sessions = (raw as Record<string, unknown>).sessions;
        if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
          const matching = Object.keys(sessions as Record<string, unknown>).filter(
            (k) => k === id || k.startsWith(`${id}::`),
          );
          for (const k of matching) {
            await clearCommanderSession(k, dir);
            clearedKeys.push(k);
          }
        }
      }
    } catch {
      // file might be missing or corrupt
    }
    if (clearedKeys.length === 0) {
      await clearCommanderSession(id, dir);
    }
    if (clearedKeys.length > 0) {
      report.commanderSessionsCleared = clearedKeys;
      log(`[commander] cleared ${clearedKeys.length} session key(s) for ${id}`);
    } else {
      log(`[commander] no session found for ${id}`);
    }
  } catch (err) {
    log(`[commander] failed to clear commander session for ${id}: ${String(err)}`);
  }

  return report;
}

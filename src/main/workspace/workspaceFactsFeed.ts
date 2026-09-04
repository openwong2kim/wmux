// ─── Press-scope fact feed (main → daemon) ──────────────────────────────────
//
// `decideApprovalPress` (daemon) refuses an AUTOMATED approval press unless the
// target pane's workspace is a WorkTask TASK workspace whose effective
// `approvalPress` capability is on. Neither fact is visible to the daemon:
//
//   - task membership is the WorkTask projection, mirrored into the task ledger
//     (deck/taskLedgerHost.ts) — main's;
//   - the autonomy capability is deck-autonomy.json — also main's. The stored
//     `approvalPress` is already the EFFECTIVE one (deck.handler's applyTierCaps
//     writes `modeCeiling && loopIsDriving`), which is why this feed publishes
//     the capability and not just the mode: a 'danger' workspace running a
//     `report` loop must not be pressed into.
//
// So main publishes. The direction is the one the codebase already has for
// main-side facts the daemon needs (`daemon.setResumeBinding`, written by main
// from hooks.rpc.ts); the opposite direction does not exist for a reason — the
// daemon has to keep working with the GUI closed, and a fact it had to fetch
// from main would become a hang rather than a refusal.
//
// The table is sent WHOLE on every change, never as a diff: a workspace has to
// be able to leave it (task closed, workspace deleted), and two processes that
// restart independently would otherwise need a resynchronisation protocol for a
// table with one row per workspace.
//
// ORDERING. Publishes are fire-and-forget over a pipe that services requests
// concurrently, so two started close together can land out of order — and the
// loser would restore a CLOSED task's row, which is the row that authorizes a
// press. Every table therefore carries a monotonic `seq` and the daemon drops
// anything not newer. The debouncer below makes that rare rather than merely
// survivable: bursts (a fan-out registering N tasks) collapse into one push.
//
// Publishing is best-effort and idempotent. A failed push leaves the daemon on
// its previous table, which errs toward refusing presses; the next change
// republishes.

import type { TaskLedger } from '../../daemon/ledger/TaskLedger';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { loadDeckAutonomy, DEFAULT_MODE, type WorkspaceAutonomy } from '../deck/deckAutonomyStore';

/** One row of the pushed table — exactly what `decideApprovalPress` consumes. */
export interface WorkspaceFactRow {
  workspaceId: string;
  isTaskWorkspace: boolean;
  autonomyMode: string;
  /** Main's EFFECTIVE approvalPress capability for this workspace. */
  approvalPress: boolean;
}

/** How long a burst of changes is collected before one table is sent. A fan-out
 *  registering N tasks fires N ledger transitions in a few milliseconds; each
 *  one used to mean a full rebuild plus a synchronous JSON read. */
export const WORKSPACE_FACTS_DEBOUNCE_MS = 250;

type AutonomyMap = Record<string, Partial<WorkspaceAutonomy>>;

export interface WorkspaceFactsFeedPorts {
  /** Send the table. Rejections are swallowed by `publish`. */
  push: (rows: WorkspaceFactRow[], seq: number) => Promise<unknown>;
  /** Injected in tests; defaults to the main-hosted ledger. */
  ledger?: () => TaskLedger;
  /** Injected in tests; defaults to the deck-autonomy store. */
  autonomy?: () => AutonomyMap;
}

/**
 * Build the table from main's own stores.
 *
 * A workspace is listed when it is EITHER an open task's workspace or has a
 * stored autonomy entry — the union, because a press needs both facts and a
 * row carrying only one of them still refuses on the other. Only OPEN tasks
 * count as task workspaces: a closed task's workspace is no longer delegated,
 * and an approval pressed into it would be a keystroke into a pane nobody is
 * driving any more.
 */
export function buildWorkspaceFacts(ports: WorkspaceFactsFeedPorts): WorkspaceFactRow[] {
  let taskWorkspaces = new Set<string>();
  try {
    const ledger = (ports.ledger ?? getTaskLedger)();
    taskWorkspaces = new Set(ledger.list({ openOnly: true }).map((e) => e.taskWorkspaceId));
  } catch {
    // An unreadable ledger publishes NO task workspaces rather than a stale
    // set: every press then refuses, which is the safe direction.
    taskWorkspaces = new Set();
  }
  let modes: AutonomyMap = {};
  try {
    modes = (ports.autonomy ?? readAutonomyCached)();
  } catch {
    modes = {};
  }
  const ids = new Set<string>([...taskWorkspaces, ...Object.keys(modes)]);
  const rows: WorkspaceFactRow[] = [];
  for (const workspaceId of ids) {
    if (!workspaceId) continue;
    const entry = modes[workspaceId];
    rows.push({
      workspaceId,
      isTaskWorkspace: taskWorkspaces.has(workspaceId),
      autonomyMode: typeof entry?.mode === 'string' ? entry.mode : DEFAULT_MODE,
      // Absent entry ⇒ false. The product default is press OFF, and a missing
      // row must never read as the dangerous capability being on.
      approvalPress: entry?.approvalPress === true,
    });
  }
  return rows;
}

// ── Autonomy read cache ─────────────────────────────────────────────────────
//
// `loadDeckAutonomy` reads and parses a JSON file synchronously. Rebuilding the
// table on every ledger transition meant one such read per transition on main's
// event loop. The file has exactly one writer — this process — so a cache
// invalidated by that writer's own notification is exact, not eventually
// consistent.

let autonomyCache: AutonomyMap | null = null;

function readAutonomyCached(): AutonomyMap {
  if (!autonomyCache) autonomyCache = loadDeckAutonomy() as AutonomyMap;
  return autonomyCache;
}

/** Drop the cached autonomy map (call from `onAutonomyWritten`). */
export function invalidateAutonomyCache(): void {
  autonomyCache = null;
}

// ── Publishing ──────────────────────────────────────────────────────────────

/**
 * Build and send once, stamping the next sequence number. Never throws — the
 * daemon keeps its previous table.
 *
 * The counter is per PROCESS and starts at 1. A daemon that outlives main
 * clears its table when main's pipe client disconnects, so a fresh main
 * counting from 1 again is never compared against the dead one's high-water
 * mark.
 */
export function createWorkspaceFactsPublisher(ports: WorkspaceFactsFeedPorts): {
  /** Publish now, awaiting the push. Used for the connect-time seed. */
  publishNow: () => Promise<void>;
  /** Coalescing publish: latest wins, at most one in flight. */
  schedule: () => void;
  /** Cancel a pending debounce (shutdown / tests). */
  dispose: () => void;
} {
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // One push at a time. The debounce alone would still let a second push start
  // while the first is on the wire — the out-of-order window all over again.
  // `seq` makes that survivable; not opening it is better.
  let inFlight: Promise<void> | null = null;
  let again = false;

  const send = async (): Promise<void> => {
    seq += 1;
    try {
      await ports.push(buildWorkspaceFacts(ports), seq);
    } catch (err) {
      console.warn(`[approvals] could not publish the workspace fact table: ${String(err)}`);
    }
  };

  const pump = (): Promise<void> => {
    if (inFlight) {
      // Latest wins: one more pass after the current push, whatever the state
      // is by then. Not a queue — N changes during one push are one republish.
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        again = false;
        await send();
      } while (again);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    publishNow: () => pump(),
    schedule: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void pump();
      }, WORKSPACE_FACTS_DEBOUNCE_MS);
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

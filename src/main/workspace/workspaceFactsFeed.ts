// ─── Press-scope fact feed (main → daemon) ──────────────────────────────────
//
// `decideApprovalPress` (daemon) refuses an AUTOMATED approval press unless the
// target pane's workspace is a WorkTask TASK workspace whose deck autonomy is
// on. Neither fact is visible to the daemon:
//
//   - task membership is the WorkTask projection, mirrored into the task ledger
//     (deck/taskLedgerHost.ts) — main's;
//   - the autonomy mode is deck-autonomy.json — also main's.
//
// So main publishes them. The direction is the one the codebase already has for
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
// Publishing is best-effort and idempotent. A failed push leaves the daemon on
// its previous table, which errs toward refusing presses; the next change
// republishes.

import type { TaskLedger } from '../../daemon/ledger/TaskLedger';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { loadDeckAutonomy, DEFAULT_MODE } from '../deck/deckAutonomyStore';

/** One row of the pushed table — exactly what `decideApprovalPress` consumes. */
export interface WorkspaceFactRow {
  workspaceId: string;
  isTaskWorkspace: boolean;
  autonomyMode: string;
}

export interface WorkspaceFactsFeedPorts {
  /** Send the table. Rejections are swallowed by `publish`. */
  push: (rows: WorkspaceFactRow[]) => Promise<unknown>;
  /** Injected in tests; defaults to the main-hosted ledger. */
  ledger?: () => TaskLedger;
  /** Injected in tests; defaults to the deck-autonomy store. */
  autonomy?: () => Record<string, { mode?: string }>;
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
  let modes: Record<string, { mode?: string }> = {};
  try {
    modes = (ports.autonomy ?? loadDeckAutonomy)() as Record<string, { mode?: string }>;
  } catch {
    modes = {};
  }
  const ids = new Set<string>([...taskWorkspaces, ...Object.keys(modes)]);
  const rows: WorkspaceFactRow[] = [];
  for (const workspaceId of ids) {
    if (!workspaceId) continue;
    rows.push({
      workspaceId,
      isTaskWorkspace: taskWorkspaces.has(workspaceId),
      autonomyMode: typeof modes[workspaceId]?.mode === 'string' ? (modes[workspaceId].mode as string) : DEFAULT_MODE,
    });
  }
  return rows;
}

/** Build and send once. Never throws — the daemon keeps its previous table. */
export async function publishWorkspaceFacts(ports: WorkspaceFactsFeedPorts): Promise<void> {
  try {
    await ports.push(buildWorkspaceFacts(ports));
  } catch (err) {
    console.warn(`[approvals] could not publish the workspace fact table: ${String(err)}`);
  }
}

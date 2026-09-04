// ─── Workspace fact table — the daemon's copy of two main-process facts ─────
//
// `decideApprovalPress` refuses an AUTOMATED approve unless the target pane's
// workspace is a WorkTask task workspace whose deck autonomy is on. Neither
// fact exists in the daemon: task membership lives in the WorkTask projection
// and the autonomy mode is a main-process store. So main PUSHES them, over
// `daemon.workspaceFacts.set`, on every change — the same direction and the
// same transport `daemon.setResumeBinding` already uses to hand main-side facts
// down. No new channel, no daemon→main call (the daemon must keep working with
// the GUI closed, and a fact it cannot fetch would just become a hang).
//
// FULL REPLACEMENT, not a patch. A workspace that stops being a task workspace,
// or is deleted, has to be able to LEAVE the table, and a diff protocol between
// two processes that restart independently is a resynchronisation problem this
// does not need: the table is small (one row per workspace) and main can always
// rebuild it from its own stores.
//
// UNPUBLISHED IS NOT EMPTY. Before main's first push the answer is `null` —
// "not established" — which the registry reports as `scope-unavailable`, the
// refusal that says the wiring is missing. An empty published table is a
// different answer: main is connected and says no workspace qualifies, which
// refuses each press as `workspace-unknown`. Collapsing the two would make a
// daemon running without a GUI look like a policy decision.

import type { ApprovalPressFacts } from './approvalKeystrokes';

/** One workspace's row. Deliberately the exact slice `decideApprovalPress`
 *  consumes — anything wider would invite the daemon to reason about main's
 *  state instead of forwarding it. */
export type WorkspaceFacts = Pick<ApprovalPressFacts, 'isTaskWorkspace' | 'autonomyMode'>;

/** Upper bound on a pushed table. Main sends one row per live workspace, so a
 *  number this size can only be reached by a bug or a hostile client; the
 *  excess is dropped rather than retained. */
export const WORKSPACE_FACTS_MAX_ROWS = 2_000;

export class WorkspaceFactStore {
  private facts: Map<string, WorkspaceFacts> | null = null;

  /** Replace the table. Returns how many rows were accepted. */
  replace(rows: readonly { workspaceId: string; isTaskWorkspace: boolean; autonomyMode: string }[]): number {
    const next = new Map<string, WorkspaceFacts>();
    for (const row of rows) {
      if (next.size >= WORKSPACE_FACTS_MAX_ROWS) break;
      if (!row || typeof row.workspaceId !== 'string' || row.workspaceId.length === 0) continue;
      if (typeof row.isTaskWorkspace !== 'boolean' || typeof row.autonomyMode !== 'string') continue;
      next.set(row.workspaceId, { isTaskWorkspace: row.isTaskWorkspace, autonomyMode: row.autonomyMode });
    }
    this.facts = next;
    return next.size;
  }

  /**
   * One workspace's facts, `null` when nothing has been published yet.
   *
   * A workspace ABSENT from a published table answers `{}` rather than `null`:
   * main is talking to us and did not list it, which is evidence that it is not
   * a task workspace — a different refusal from "we were never told anything".
   */
  get(workspaceId: string): WorkspaceFacts | null {
    if (!this.facts) return null;
    return this.facts.get(workspaceId) ?? {};
  }

  /** True once main has pushed at least one table (empty counts). */
  get published(): boolean {
    return this.facts !== null;
  }

  /** Forget everything — main disconnected, so its table is no longer current
   *  and a press must not be authorized by a stale row. */
  clear(): void {
    this.facts = null;
  }
}

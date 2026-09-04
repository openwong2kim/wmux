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
 *  state instead of forwarding it. `approvalPress` is main's EFFECTIVE
 *  capability (mode ceiling already narrowed by a running loop's tier), which
 *  is what authorizes; the mode rides along for the refusal reason. */
export type WorkspaceFacts = Pick<
  ApprovalPressFacts,
  'isTaskWorkspace' | 'autonomyMode' | 'approvalPress'
>;

/** One row as it arrives on the wire. */
export interface WorkspaceFactRowInput {
  workspaceId: string;
  isTaskWorkspace: boolean;
  autonomyMode: string;
  approvalPress: boolean;
}

/** Upper bound on a pushed table. Main sends one row per live workspace, so a
 *  number this size can only be reached by a bug or a hostile client; the
 *  excess is dropped rather than retained. */
export const WORKSPACE_FACTS_MAX_ROWS = 2_000;

/** Rejected because a newer table is already held. Not an error: two pushes
 *  raced and the older one lost, which is exactly what `seq` is for. */
export interface WorkspaceFactsStale {
  ok: false;
  reason: 'stale';
  seq: number;
}

export interface WorkspaceFactsAccepted {
  ok: true;
  accepted: number;
  seq: number;
}

export class WorkspaceFactStore {
  private facts: Map<string, WorkspaceFacts> | null = null;
  /** The `seq` of the table currently held. -1 = nothing published yet. */
  private seq = -1;

  /**
   * Replace the table, unless `seq` is not newer than the one held.
   *
   * ORDERING IS NOT FREE. The pipe carries one request per line and main sends
   * these fire-and-forget, so two publishes started close together can be
   * serviced out of order — and the loser would leave a CLOSED task's workspace
   * still marked `isTaskWorkspace: true`, which is the exact row that
   * authorizes a press. A monotonic counter from the publisher makes the
   * late-arriving older table a no-op rather than a silent regression.
   */
  replace(rows: readonly WorkspaceFactRowInput[], seq: number): WorkspaceFactsAccepted | WorkspaceFactsStale {
    if (!Number.isFinite(seq) || seq <= this.seq) {
      return { ok: false, reason: 'stale', seq: this.seq };
    }
    const next = new Map<string, WorkspaceFacts>();
    for (const row of rows) {
      if (next.size >= WORKSPACE_FACTS_MAX_ROWS) break;
      if (!row || typeof row.workspaceId !== 'string' || row.workspaceId.length === 0) continue;
      if (typeof row.isTaskWorkspace !== 'boolean' || typeof row.autonomyMode !== 'string') continue;
      if (typeof row.approvalPress !== 'boolean') continue;
      next.set(row.workspaceId, {
        isTaskWorkspace: row.isTaskWorkspace,
        autonomyMode: row.autonomyMode,
        approvalPress: row.approvalPress,
      });
    }
    this.facts = next;
    this.seq = seq;
    return { ok: true, accepted: next.size, seq };
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

  /**
   * Forget everything — main disconnected, so its table is no longer current
   * and a press must not be authorized by a stale row.
   *
   * The sequence resets too: the next publisher is a NEW main process counting
   * from its own start, and holding the dead one's high-water mark would make
   * every table it sends look stale.
   */
  clear(): void {
    this.facts = null;
    this.seq = -1;
  }
}

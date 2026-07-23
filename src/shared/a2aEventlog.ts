/**
 * Log payload schema for the A2A task domain (`domain:'a2a'`) (envelope-design section 5 D11).
 *
 * ┌── PROTOCOL file: additive-only contract ──────────────────────────┐
 * │ This payload is persisted in an append-only log. Boot replay       │
 * │ re-parses historical records against this schema, so:              │
 * │   - Do not remove, rename, or change the meaning of fields         │
 * │     (that would break parsing of past records).                    │
 * │   - Add new fields only as optional (`?:`) (absent on old records).│
 * │   - kind values may only be added; never reuse existing values.    │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * envelope.payload is opaque to the domain (eventlog.ts section 1 field table).
 * The log layer does not interpret this type; A2aTaskService interprets it and
 * applies projections.
 */

import type { Task, TaskState, Message, CompletionEvidence } from './types';

/**
 * Discriminated union of A2A log payloads. Because kind is a closed enum,
 * projection can safely ignore unknown kinds (fail-closed). evidence follows
 * the section 6.M completion-evidence schema — the completion-evidence gate
 * (PR-B) is enforced by A2aTaskService.transition; this payload only carries
 * evidence that already passed the gate (the schema is a transport contract,
 * not the validation logic).
 */
export type A2aEventPayload =
  | A2aTaskCreatePayload
  | A2aTaskTransitionPayload
  | A2aTaskCancelPayload
  | A2aExecutorLifecyclePayload;

/** Task creation — carry the complete canonical record to seed the projection. */
export interface A2aTaskCreatePayload {
  kind: 'task.create';
  task: Task;
}

/**
 * State transition (working/completed/failed/input-required). VALID_TRANSITIONS
 * is enforced by A2aTaskService on the daemon side (successful terminal state:
 * 'completed', types.ts:624).
 */
export interface A2aTaskTransitionPayload {
  kind: 'task.transition';
  taskId: string;
  to: TaskState;
  /** ISO 8601 transition time, reflected in projection status.timestamp/updatedAt. */
  timestamp: string;
  /** Human-facing status message, when present; separate from machine evidence (E1). */
  message?: Message;
  /**
   * Section 6.M completion evidence — re-validated via normalizeCompletionEvidenceWire
   * then stored. The completion-evidence gate (PR-B) is enforced by
   * A2aTaskService.transition (completed = structured evidence, failed = reason).
   * verified≥1 is a grade, not a gate (section ② E9), so it is recorded as
   * verifiedItemCount.
   */
  evidence?: CompletionEvidence;
  /** Verified item count for audit/grading (0 = unverified completion). Not a transition gate (section ② E9). */
  verifiedItemCount?: number;
  /**
   * Force-fail audit marker (completion-evidence design section ③ E10). Absent =
   * normal transition. `'workspace_removed'` = force-fail due to receiver workspace
   * teardown (`failTasksForWorkspaceRemoved`) — distinguishes in the log a
   * transition that intentionally bypasses VALID_TRANSITIONS (submitted/
   * input-required→failed is illegal on the graph, but justified when the
   * receiver is gone and no non-terminal state can advance). The normal
   * transition API never sets this value.
   */
  forced?: 'workspace_removed';
}

/** Cancellation (canceled) — either sender or receiver may request it; the service checks authorization. */
export interface A2aTaskCancelPayload {
  kind: 'task.cancel';
  taskId: string;
  timestamp: string;
}

/**
 * Executor lifecycle event — **Q1 schema reservation only** (envelope section 5
 * delta ⑧, section 6.F).
 *
 * The reconciliation protocol for execute's two-process problem (task state =
 * daemon log, ClaudeWorker remains in Main) belongs to section 6.F / Q1-4.
 * Here only the domain slot and fields are reserved — **recording, fencing, and
 * heartbeat are not implemented yet**. When section 6.F lands, heartbeat
 * (periodic, loss-tolerant) is planned as the first consumer of the section 2.7
 * relaxed stream; only low-frequency spawn/exit would follow the commit stream.
 * A2aTaskService does not append this kind, and projection ignores it (reserved slot).
 */
export interface A2aExecutorLifecyclePayload {
  kind: 'executor-lifecycle';
  taskId: string;
  event: 'spawn' | 'heartbeat' | 'exit';
  /** Section 6.F fencing-token reservation — unused in Q1; stale demotion/worker reconciliation is future work. */
  fenceToken?: number;
}

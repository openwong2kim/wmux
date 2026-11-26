// ─── A2A task cleanup (#3068) ────────────────────────────────────────────────
//
// Two ways a workspace clears out its own stale tasks:
//   - a bulk cancel (a2a.task.cancel with `taskIds`, or `state` + `olderThanDays`),
//     run in main one task at a time through the single-task cancel path, so
//     every refusal rule and the log entry as the caller stay as they are;
//   - an optional retention setting: the daemon closes a workspace's own tasks
//     still `submitted` after N days, acting as the workspace that sent them.
// Neither reaches a task the caller's workspace neither sent nor received.

import { TERMINAL_STATES, type TaskState } from './types';

/** Most tasks one bulk call names or changes (the rest are reported as `more`). */
export const A2A_BULK_CANCEL_MAX = 100;
/** Client wait for a bulk call: up to A2A_BULK_CANCEL_MAX cancels, one at a time. */
export const A2A_BULK_CANCEL_CLIENT_TIMEOUT_MS = 120000;

/** States a filter may select: the ones a cancel moves. */
export const A2A_BULK_CANCEL_STATES = ['submitted', 'working', 'input-required'] as const;
export type BulkCancelState = (typeof A2A_BULK_CANCEL_STATES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export type BulkCancelSelection =
  | { kind: 'ids'; taskIds: string[] }
  | { kind: 'filter'; state: BulkCancelState; olderThanMs: number };

export interface BulkCancelRequest {
  selection: BulkCancelSelection;
  dryRun: boolean;
}

/**
 * Read the bulk fields of an a2a.task.cancel call. `null`: not a bulk call (a
 * plain `taskId` cancel, unchanged). Exactly one of `taskId`, `taskIds` or a
 * `state` filter is accepted.
 */
export function parseBulkCancel(params: Record<string, unknown>): BulkCancelRequest | { error: string } | null {
  const hasIds = params.taskIds !== undefined;
  const hasFilter = params.state !== undefined || params.olderThanDays !== undefined;
  const single = typeof params.taskId === 'string' && params.taskId !== '';
  // A dry run of one task goes the bulk way too: the single path has no dry run.
  if (!hasIds && !hasFilter && single && params.dryRun === true) {
    return { selection: { kind: 'ids', taskIds: [(params.taskId as string).trim()] }, dryRun: true };
  }
  if (!hasIds && !hasFilter) return null;
  if ((hasIds && hasFilter) || single) {
    return { error: 'give one of taskId, taskIds, or state with olderThanDays' };
  }
  const dryRun = params.dryRun === true;
  if (hasIds) {
    if (!Array.isArray(params.taskIds)) return { error: 'taskIds must be a list of task ids' };
    const ids = [...new Set(params.taskIds.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))];
    if (ids.length === 0) return { error: 'taskIds is empty' };
    if (ids.length > A2A_BULK_CANCEL_MAX) return { error: `taskIds names ${ids.length} tasks; at most ${A2A_BULK_CANCEL_MAX} per call` };
    return { selection: { kind: 'ids', taskIds: ids }, dryRun };
  }
  const state = params.state;
  if (!(A2A_BULK_CANCEL_STATES as readonly unknown[]).includes(state)) {
    return { error: `state must be one of ${A2A_BULK_CANCEL_STATES.join(', ')}` };
  }
  const days = params.olderThanDays;
  if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
    return { error: 'olderThanDays must be a number of days, 0 or more' };
  }
  return { selection: { kind: 'filter', state: state as BulkCancelState, olderThanMs: days * DAY_MS }, dryRun };
}

/** One task as the daemon's state view lists it. */
export interface CleanupRow {
  id: string;
  state: TaskState;
  /** Last change (ISO-8601); a reopen or a reply moves it. */
  updatedAt: string;
}

export function toCleanupRows(rows: unknown): CleanupRow[] {
  if (!Array.isArray(rows)) return [];
  const out: CleanupRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as { id?: unknown; status?: { state?: unknown }; metadata?: { updatedAt?: unknown } };
    if (typeof rec.id !== 'string') continue;
    const state = rec.status?.state;
    const updatedAt = rec.metadata?.updatedAt;
    out.push({ id: rec.id, state: state as TaskState, updatedAt: typeof updatedAt === 'string' ? updatedAt : '' });
  }
  return out;
}

/** True when the task has not changed for at least `olderThanMs`. */
export function idleFor(updatedAt: string, olderThanMs: number, nowMs: number): boolean {
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) && nowMs - at >= olderThanMs;
}

export interface CleanupPlan {
  /** Ids to cancel, in order (at most A2A_BULK_CANCEL_MAX). */
  targets: string[];
  /** Named ids already ended: left as they are. */
  unchanged: Array<{ taskId: string; state: TaskState }>;
  /** Filter matches past the cap, for a follow-up call. */
  more: number;
}

/**
 * Which tasks a bulk cancel acts on. `rows` is the caller's own view (sent or
 * received by its workspace, held company tasks left out). A named id the view
 * does not hold is still a target: the cancel path answers it with today's
 * refusal, so another workspace's task is refused, never skipped silently.
 */
export function planBulkCancel(selection: BulkCancelSelection, rows: readonly CleanupRow[], nowMs: number): CleanupPlan {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const isEnded = (s: TaskState) => (TERMINAL_STATES as readonly string[]).includes(s);
  if (selection.kind === 'ids') {
    const targets: string[] = [];
    const unchanged: CleanupPlan['unchanged'] = [];
    for (const id of selection.taskIds) {
      const row = byId.get(id);
      if (row && isEnded(row.state)) unchanged.push({ taskId: id, state: row.state });
      else targets.push(id);
    }
    return { targets, unchanged, more: 0 };
  }
  const matched = rows
    .filter((r) => r.state === selection.state && idleFor(r.updatedAt, selection.olderThanMs, nowMs))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return {
    targets: matched.slice(0, A2A_BULK_CANCEL_MAX).map((r) => r.id),
    unchanged: [],
    more: Math.max(0, matched.length - A2A_BULK_CANCEL_MAX),
  };
}

// ── Retention ────────────────────────────────────────────────────────────────

/** In the wmux dir; written by main (Settings), read by the daemon each sweep. */
export const A2A_TASK_RETENTION_FILE = 'a2a-task-retention.json';
export const A2A_TASK_RETENTION_MAX_DAYS = 365;
/** How often the daemon sweeps while retention is on. */
export const A2A_TASK_RETENTION_SWEEP_MS = 60 * 60 * 1000;

/** A whole number of days in 1..365, or null (off). Anything else is off. */
export function clampRetentionDays(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const days = Math.floor(v);
  if (days < 1) return null;
  return Math.min(days, A2A_TASK_RETENTION_MAX_DAYS);
}

/** The retention file's `days`, or null when the file is absent or unusable. */
export function parseRetentionFile(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { days?: unknown } | null;
    return clampRetentionDays(parsed?.days);
  } catch {
    return null;
  }
}

export function retentionMs(days: number): number {
  return days * DAY_MS;
}

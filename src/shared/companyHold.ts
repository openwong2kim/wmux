// Company mode: a task that waits on other tasks (CompanyBriefV1.blockedBy).
//
// A company task whose blockers have not all completed is created but HELD:
// the daemon keeps it in its task record with a marker
// (`Task.metadata.companyHold`) and it is not delivered to its seat. Each
// blocker that completes leaves the marker's `waitingOn`; when the last one
// does, the marker gets `releasedAt` and main delivers the task, at most once
// per attempt:
//
//   1. `A2A_COMPANY_RPC.pending` lists the released tasks owed a delivery.
//   2. A listed task whose marker already says `attempted` was started by an
//      earlier main and never confirmed: mark it `held: 'delivery-unconfirmed'`
//      and never write it again on its own (a person decides). After a daemon
//      restart the daemon does this itself: such a task comes back held as
//      `delivery-unconfirmed` (derived on restore, not written to the log).
//   3. Otherwise mark `attempted: true` BEFORE writing to the pane (do not
//      write unless that mark returned ok), then mark the outcome:
//      `delivered` (with the pty written to), `attempted: false` (the write
//      was refused and nothing was written: it is listed again), or a `held`
//      reason.
//
// While a task waits on a blocker it is not its receiver's yet: a query from
// its receiving side leaves it out, as if it had not been sent, and a state
// move from there is refused (companyHoldWithholds). Its sender and the human
// still see it, and the sender can still cancel it.
//
// `delivered` is final. A `held` task waits for a person; `delivered` is
// still taken on it (the person had it sent), `attempted` is ignored on it.
// A blocker that ends failed or canceled keeps the task held and is noted in
// `blockerEnded`; it is never canceled for it. A blocker reopened and later
// completed releases it as usual.
//
// The marker rides in the task's `task.create` log payload, and each change
// is a `company.mark` payload (shared/a2aEventlog.ts), so it survives app and
// daemon restarts and the eviction of finished tasks.
//
// Pure module: no node:* imports (the renderer imports it).

import { isVerifiedTaskSender } from './a2aReopen';
import { COMPANY_BRIEF_KIND, companyBriefOf, type CompanyBriefV1 } from './company';
import { shortTaskId } from './moaHandoff';
import type { Message, Task, TaskState, TaskStatus } from './types';

/** A task waits on at most this many others. */
export const COMPANY_BLOCKERS_MAX = 8;

/** The `Task.metadata` key the marker is kept under. */
export const COMPANY_HOLD_KEY = 'companyHold';

/** Why a released task is not delivered. Each one waits for a person. */
export type CompanyHoldReason = 'no-agent' | 'pane-missing' | 'delivery-unconfirmed';

export const COMPANY_HOLD_REASONS: readonly CompanyHoldReason[] = ['no-agent', 'pane-missing', 'delivery-unconfirmed'];

export function isCompanyHoldReason(v: unknown): v is CompanyHoldReason {
  return typeof v === 'string' && (COMPANY_HOLD_REASONS as readonly string[]).includes(v);
}

/** A blocker that ended without completing: the task waiting on it stays held. */
export interface CompanyBlockerEnd {
  id: string;
  state: 'failed' | 'canceled';
  /**
   * When it ended (the blocker's status time): a blocker that ends again
   * after a reopen is a new end. Absent on a note written before it was kept.
   */
  at?: string;
}

/** What the daemon keeps under `Task.metadata.companyHold` for a held task. */
export interface CompanyHoldMarker {
  /** The blockers as the brief named them, without repeats. */
  blockedBy: string[];
  /** The blockers that have not completed yet. Empty once released. */
  waitingOn: string[];
  /** When the last blocker completed: from then on the task is owed a delivery. */
  releasedAt?: string;
  /** Main is about to write the task to its pane, or did and has not confirmed it. */
  attempted?: true;
  /** Written to its seat's pane. Final. */
  delivered?: true;
  /** With `delivered`: the pty written to. */
  ptyId?: string;
  /** Released but not delivered, for a reason that waits on a person. */
  held?: CompanyHoldReason;
  /** Blockers still in `waitingOn` that ended failed or canceled (the latest end of each). */
  blockerEnded?: CompanyBlockerEnd[];
}

/**
 * Where a held task stands: `waiting` on a blocker, `owed` a delivery
 * (released; it may carry `attempted`), `delivered`, or `held` for a person.
 * A delivered task is `delivered` whatever its `waitingOn` says: it is its
 * seat's already.
 */
export type CompanyHoldPhase = 'waiting' | 'owed' | 'delivered' | 'held';

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** The task's hold marker, or undefined when it has none (it was never held) or one this version does not know. */
export function companyHoldOf(task: Pick<Task, 'metadata'> | undefined): CompanyHoldMarker | undefined {
  const m = task?.metadata[COMPANY_HOLD_KEY] as CompanyHoldMarker | undefined;
  return m && typeof m === 'object' && isStringList(m.blockedBy) && isStringList(m.waitingOn) ? m : undefined;
}

export function companyHoldPhase(marker: CompanyHoldMarker): CompanyHoldPhase {
  if (marker.delivered) return 'delivered';
  if (marker.waitingOn.length > 0) return 'waiting';
  if (marker.held) return 'held';
  return 'owed';
}

/**
 * True when the task is kept from this caller because it still waits on a
 * blocker: the caller is on its receiving side (its receiver workspace) and
 * is neither its verified sender (in a company workspace that is the sender's
 * own pane) nor the human. A caller whose pane is unknown is kept out.
 */
export function companyHoldWithholds(
  task: Pick<Task, 'metadata'>,
  caller: { workspaceId: string; paneId?: string; trusted?: boolean },
): boolean {
  const hold = companyHoldOf(task);
  if (!hold || companyHoldPhase(hold) !== 'waiting' || caller.trusted === true) return false;
  if (task.metadata.to.workspaceId !== caller.workspaceId) return false;
  return !isVerifiedTaskSender(task.metadata, caller.workspaceId, caller.paneId);
}

/** The complete brief the task's first message carries, or null. */
export function companyBriefOfHistory(history: readonly Message[]): CompanyBriefV1 | null {
  const first = history[0];
  if (!first || !Array.isArray(first.parts)) return null;
  const part = first.parts.find((p) => p.kind === 'data' && !!p.data && typeof p.data === 'object' && p.data.kind === COMPANY_BRIEF_KIND);
  return part?.kind === 'data' ? companyBriefOf(part.data) : null;
}

/** The brief's blockers, without repeats or empty ids, in the order asked. */
export function companyBlockersOf(brief: Pick<CompanyBriefV1, 'blockedBy'> | null | undefined): string[] {
  return [...new Set((brief?.blockedBy ?? []).filter((id) => typeof id === 'string' && id.length > 0))];
}

/**
 * The hold a new company task starts with, from its brief's `blockedBy` and
 * the status of each task known now (`statusOf` answers its status, or just
 * its state, and undefined for one it does not know). Blockers lose repeats
 * and keep the order asked. A completed
 * one is satisfied already; any other (open, ended or unknown) is waited on,
 * and one that ended failed or canceled is noted in `blockerEnded` (with its
 * time when the status gives one). Null when nothing is waited on: the task
 * is not held at all.
 *
 * `releasedAt` (the create time) is for a task its sender already held back
 * for its blockers (`holdForBlockers` on the create): it keeps a marker even
 * when every blocker has completed meanwhile, released at that time, so it is
 * delivered through the pending list like any released task. It still has
 * no marker without blockers.
 */
export function companyHoldAtCreate(
  brief: Pick<CompanyBriefV1, 'blockedBy'> | null | undefined,
  statusOf: (taskId: string) => TaskState | Pick<TaskStatus, 'state' | 'timestamp'> | undefined,
  releasedAt?: string,
): CompanyHoldMarker | null {
  const read = (id: string): { state?: TaskState; timestamp?: string } => {
    const status = statusOf(id);
    return typeof status === 'string' ? { state: status } : (status ?? {});
  };
  const blockedBy = companyBlockersOf(brief);
  const waitingOn = blockedBy.filter((id) => read(id).state !== 'completed');
  if (waitingOn.length === 0) return releasedAt !== undefined && blockedBy.length > 0 ? { blockedBy, waitingOn, releasedAt } : null;
  const blockerEnded: CompanyBlockerEnd[] = [];
  for (const id of waitingOn) {
    const { state, timestamp } = read(id);
    if (state === 'failed' || state === 'canceled') blockerEnded.push({ id, state, ...(timestamp ? { at: timestamp } : {}) });
  }
  return { blockedBy, waitingOn, ...(blockerEnded.length > 0 ? { blockerEnded } : {}) };
}

// ─── Daemon RPCs main calls ──────────────────────────────────────────────────

export const A2A_COMPANY_RPC = Object.freeze({
  /** → `A2aCompanyTasksResult`: released, not delivered, not held, not ended (an `attempted` one included). */
  pending: 'a2a.company.pending',
  /** `A2aCompanyMarkParams` → `A2aCompanyMarkResult`. */
  mark: 'a2a.company.mark',
  /** → `A2aCompanyTasksResult`: not ended, and still waiting on a blocker or held for a person. */
  held: 'a2a.company.held',
} as const);

/** Each listed task carries its marker under `metadata.companyHold`. */
export interface A2aCompanyTasksResult {
  tasks: Task[];
}

/**
 * One change per call. Refused on a task without a marker, an ended task and
 * a task still waiting on a blocker. A mark that changes nothing appends
 * nothing and answers ok.
 */
export type A2aCompanyMarkParams =
  | { taskId: string; attempted: boolean }
  | { taskId: string; delivered: true; ptyId?: string }
  | { taskId: string; held: CompanyHoldReason };

export type A2aCompanyMarkResult = { ok: true; task: Task } | { ok: false; error: string };

// ─── Texts main and the board show ───────────────────────────────────────────

const endedWord = (state: CompanyBlockerEnd['state']): string => (state === 'failed' ? 'failed' : 'was canceled');

/** Why main refuses a task's `blockedBy` before the task is created. */
export const COMPANY_BLOCKED_BY_REFUSAL = Object.freeze({
  tooMany: (count: number): string =>
    `blockedBy names ${count} tasks; a task waits on at most ${COMPANY_BLOCKERS_MAX}`,
  unknown: (id: string): string =>
    `blockedBy names ${id}, which is not an open task or one completed in the last 30 minutes; name tasks of this company that are open or just completed`,
  ended: (id: string, state: CompanyBlockerEnd['state']): string =>
    `blockedBy names ${id}, which ${endedWord(state)} and will never complete; send that work again and wait on the new task, or leave it out`,
  otherCompany: (id: string): string =>
    `blockedBy names ${id}, which is not a task of this company; a task waits only on its own company's tasks`,
  remoteBlocker: (id: string): string =>
    `blockedBy names ${id}, a task sent to another PC; for now a task waits only on tasks on this PC`,
  remoteTask:
    'a task sent to another PC cannot wait on other tasks yet; send it once its blockers are completed',
  self: (id: string): string =>
    `blockedBy names this task itself (${id}); a task cannot wait on itself`,
  gone: (id: string): string =>
    `blockedBy names ${id}, which wmux no longer holds (it ended more than 30 minutes ago); if it completed, send this task again without it, otherwise send that work again and wait on the new task`,
  malformed:
    'blockedBy must be a list of task ids (each a non-empty string), such as ["task-1", "task-2"]; leave it out when the task waits on nothing',
  incompleteBrief: (missing: readonly string[]): string =>
    `blockedBy holds a task only in a complete brief, and this one has no ${missing.join(', ')}; add them, or leave blockedBy out`,
});

/** Why the receiving side may not move a task that still waits on a blocker. */
export function companyWaitingRefusal(waitingOn: readonly string[]): string {
  return `this task waits on ${waitingOn.map(shortTaskId).join(', ')}; it is not yours until ${waitingOn.length === 1 ? 'it completes' : 'they complete'}`;
}

/** Each hold reason in plain words: "<task> is held: <text>". */
export const COMPANY_HOLD_REASON_TEXT: Readonly<Record<CompanyHoldReason, string>> = Object.freeze({
  'no-agent': 'its blockers are done, but its pane has no agent running to take it',
  'pane-missing': 'its blockers are done, but its pane is gone',
  'delivery-unconfirmed': 'its blockers are done and wmux started writing it to its pane, but could not confirm it arrived; check the pane before sending it again',
});

/**
 * Why a message on a task held for a person, with nothing written to its seat
 * (`no-agent`, `pane-missing`), is refused: no delivery is coming for it.
 */
export function companyHeldMessageRefusal(taskId: string, reason: CompanyHoldReason): string {
  return `task ${taskId} is held and was never written to its seat (${COMPANY_HOLD_REASON_TEXT[reason]}); nothing was stored. `
    + 'Cancel it and send the work again to a seat with an agent running';
}

/** The line for a task still waiting: "Waiting on a, b". `label` names a task (default: its id). */
export function companyWaitingLine(waitingOn: readonly string[], label: (id: string) => string = (id) => id): string {
  return `Waiting on ${waitingOn.map(label).join(', ')}`;
}

/** What the CEO is told when a blocker of a held task ends without completing. */
export function companyBlockerEndedLine(
  taskId: string,
  ended: CompanyBlockerEnd,
  label: (id: string) => string = (id) => id,
): string {
  const task = label(taskId);
  const blocker = label(ended.id);
  return `${task} stays on hold: its blocker ${blocker} ${endedWord(ended.state)} and will not complete. `
    + `Write to ${blocker} to reopen it (${task} goes once it completes), or cancel ${task} and send it again without that blocker.`;
}

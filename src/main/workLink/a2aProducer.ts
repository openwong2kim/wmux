// The A2A producer for work links: a new task sent to a workspace becomes a
// link, and the task's later states move it. Called from the a2a.rpc pipe
// handlers after the renderer has delivered, and fire-and-forget: a store
// failure never blocks or fails a delivery.

import { isTaskState, type TaskState } from '../../shared/types';
import { getWorkLinkStore, type WorkLinkStore, type WorkLinkUpsert } from './workLinkStore';
import { workLinkResultFromTask } from '../../shared/workLink';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * The link for a task the renderer just created, from its `a2a.task.send`
 * reply ({ ok, taskId, toWorkspaceId, task }). Read synchronously: the caller
 * strips `task` from the reply right after. Null when the reply is not a new
 * task. A send from a commander brain is a Moa delegation; anything else is
 * manual.
 */
export function workLinkFromSentTask(
  reply: unknown,
  opts: { fromCommander: boolean; workLinkId?: string },
): WorkLinkUpsert | null {
  if (!isRecord(reply) || reply.ok !== true || !isRecord(reply.task)) return null;
  const task = reply.task;
  const meta = isRecord(task.metadata) ? task.metadata : {};
  const to = isRecord(meta.to) ? meta.to : {};
  const from = isRecord(meta.from) ? meta.from : {};
  const taskId = str(reply.taskId) ?? str(task.id);
  // The resolved receiver; the metadata copy is the fallback.
  const ownerWs = str(reply.toWorkspaceId) ?? str(to.workspaceId);
  if (!taskId || !ownerWs) return null;
  const toPane = str(to.paneId);
  const fromWs = str(from.workspaceId);
  const fromPane = str(from.paneId);
  const title = str(meta.title);
  return {
    ...(opts.workLinkId ? { id: opts.workLinkId } : {}),
    origin: opts.fromCommander ? 'moa' : 'manual',
    a2aTaskId: taskId,
    a2aState: stateOfTask(task) ?? 'submitted',
    owner: { workspaceId: ownerWs, ...(toPane ? { paneId: toPane } : {}) },
    ...(fromWs ? { requester: { workspaceId: fromWs, ...(fromPane ? { paneId: fromPane } : {}) } } : {}),
    ...(title ? { title } : {}),
  };
}

/** The state a reopen left the task in: the daemon's snapshot, or `submitted`
 *  for a cache-only reopen (the renderer's reopenTask). Undefined when the
 *  call reopened nothing. */
export function reopenedState(params: Record<string, unknown>): TaskState | undefined {
  if (params.daemonReopenedTask) return stateOfTask(params.daemonReopenedTask);
  return params.localReopen === true ? 'submitted' : undefined;
}

/** The state of an A2A task snapshot, when it carries a valid one. */
export function stateOfTask(task: unknown): TaskState | undefined {
  const state = isRecord(task) && isRecord(task.status) ? task.status.state : undefined;
  return isTaskState(state) ? state : undefined;
}

/**
 * Store the link for a sent task. A named link (`id`) is joined only while it
 * has no other task and the task goes to the workspace it names as owner; it
 * keeps its origin and title. Otherwise the task gets a link of its own.
 * Never rejects.
 */
export function recordSentTask(link: WorkLinkUpsert | null, store?: WorkLinkStore): Promise<void> {
  if (!link) return Promise.resolve();
  try {
    const s = store ?? getWorkLinkStore();
    let input = link;
    if (link.id) {
      const named = s.get(link.id);
      const joinable =
        !!named &&
        (!named.a2aTaskId || named.a2aTaskId === link.a2aTaskId) &&
        named.owner.workspaceId === link.owner?.workspaceId;
      input = { ...link };
      if (joinable) input.title = named?.title ?? link.title;
      else delete input.id;
    }
    return s.upsert(input).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

/**
 * Move an existing link to a task state it reached. A task with no link is
 * left alone (only a send creates one). Never rejects.
 *
 * Every task transition main sees goes through here, so this is also where a
 * finished task's report is kept: on `completed` or `failed`, the result in
 * `task` (the committed task, or `{ status }` built from the update) is
 * copied onto the link. The task record itself is dropped 30 minutes after
 * it ends; the link, and the ticket that reads it, keep the report.
 */
export function recordTaskState(taskId: unknown, state: unknown, store?: WorkLinkStore, task?: unknown): Promise<void> {
  if (typeof taskId !== 'string' || !taskId || !isTaskState(state)) return Promise.resolve();
  try {
    const result = state === 'completed' || state === 'failed' ? workLinkResultFromTask(task, Date.now()) : undefined;
    return (store ?? getWorkLinkStore()).upsert({ a2aTaskId: taskId, a2aState: state, ...(result ? { result } : {}) }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

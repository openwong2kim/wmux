// #1680 — does a pane still have open a2a tasks pinned to it, according to the
// daemon's canonical task store (A2aTaskService)?
//
// Owner decision 2026-10-01: a peer's new task must not clear a pane that is
// still in the middle of another a2a thread. The renderer checks its own task
// list too, but that list is not reloaded when the app starts — a thread begun
// before a restart is missing from it. The daemon's store survives restarts, so
// main asks it before an a2a new-task delivery may clear a pane. When the
// answer cannot be had (no daemon, an error, no pane address), the pane's
// conversation is kept: this check never fails open.

import { TERMINAL_STATES, type TaskState } from '../../../shared/types';
import type { DaemonClient } from '../../DaemonClient';
import type { KeepContextCode } from './freshContext';

/** Where the delivered pane sits, as the renderer resolved it. */
export interface DeliveredPaneAddress {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const MAX_ID_CHARS = 200;
const idOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS ? v : undefined;

/** The task id and pane address of a gated-submit IPC call's options, kept
 *  only when well-formed (the renderer is trusted, the shape is still checked). */
export function gatedSubmitTaskContext(opts: unknown): { taskId?: string; pane?: DeliveredPaneAddress } {
  if (!isRecord(opts)) return {};
  const taskId = idOf(opts.taskId);
  const p = isRecord(opts.pane) ? opts.pane : undefined;
  const workspaceId = idOf(p?.workspaceId);
  const paneId = idOf(p?.paneId);
  const surfaceId = idOf(p?.surfaceId);
  return {
    ...(taskId ? { taskId } : {}),
    ...(workspaceId && paneId && surfaceId ? { pane: { workspaceId, paneId, surfaceId } } : {}),
  };
}

/** Budget for the daemon task read: well inside the delivery's own budget. */
const DAEMON_TASK_QUERY_TIMEOUT_MS = 2_000;

/** The daemon's tasks involving a workspace (either side), or null when they
 *  cannot be read. Asked for in the light `anchors` view (open tasks only, no
 *  history), so a busy workspace cannot outgrow the 1 MiB daemon line; a daemon
 *  that predates the view answers with full tasks, which read the same way. */
export function makeDaemonTaskQuery(
  getDaemonClient: (() => DaemonClient | null) | undefined,
): (workspaceId: string) => Promise<unknown[] | null> {
  return async (workspaceId) => {
    const dc = getDaemonClient?.();
    if (!dc?.isConnected) return null;
    try {
      const res = (await dc.rpc('a2a.task.query', { workspaceId, view: 'anchors' }, { timeoutMs: DAEMON_TASK_QUERY_TIMEOUT_MS })) as
        | { ok?: unknown; tasks?: unknown }
        | null;
      return res && res.ok === true && Array.isArray(res.tasks) ? res.tasks : null;
    } catch {
      return null;
    }
  };
}

/** Is this task side pinned to the delivered pane? */
function sidePinned(side: unknown, pane: DeliveredPaneAddress, ptyId: string): boolean {
  if (!isRecord(side) || side.workspaceId !== pane.workspaceId) return false;
  return (
    (typeof side.paneId === 'string' && side.paneId === pane.paneId) ||
    (typeof side.surfaceId === 'string' && side.surfaceId === pane.surfaceId) ||
    (typeof side.ptyId === 'string' && side.ptyId === ptyId)
  );
}

/**
 * `open_a2a_task` when the daemon holds an open task (not ended, not the task
 * being delivered) whose receiver or sender side is pinned to the pane;
 * `a2a_tasks_unknown` when that cannot be known; undefined when the pane is
 * free.
 */
export async function daemonOpenTaskOnPane(
  query: (workspaceId: string) => Promise<unknown[] | null>,
  ptyId: string,
  pane: DeliveredPaneAddress | undefined,
  exceptTaskId: string | undefined,
): Promise<KeepContextCode | undefined> {
  if (!pane) return 'a2a_tasks_unknown';
  const tasks = await query(pane.workspaceId);
  if (!tasks) return 'a2a_tasks_unknown';
  for (const task of tasks) {
    if (!isRecord(task) || task.id === exceptTaskId) continue;
    const state = isRecord(task.status) ? task.status.state : undefined;
    if (typeof state === 'string' && TERMINAL_STATES.includes(state as TaskState)) continue;
    const metadata = isRecord(task.metadata) ? task.metadata : undefined;
    if (!metadata) continue;
    if (sidePinned(metadata.to, pane, ptyId) || sidePinned(metadata.from, pane, ptyId)) return 'open_a2a_task';
  }
  return undefined;
}

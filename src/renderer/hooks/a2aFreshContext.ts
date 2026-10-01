// #1680 — fresh context for an a2a NEW task: which pane conversations must be
// kept regardless of the role's setting.
//
// Owner decision 2026-10-01: a peer's new task must not clear a pane that is
// still in the middle of another a2a thread. A pane with OTHER open tasks
// pinned to it — as the receiver working one, or as the sender waiting on a
// reply to one — keeps its conversation, and the delivery reports
// `skipped_busy` with reason `open_a2a_task`.

import type { Task, Workspace } from '../../shared/types';
import { TERMINAL_STATES } from '../../shared/types';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { resolvePaneAddress, resolveSenderPaneAddress } from './a2aAddressing';

/** Where a pty sits — workspace, pane and surface — so main can match the
 *  daemon's task anchors against it. Undefined when no workspace holds it. */
export function paneAddressOfPty(
  workspaces: readonly Workspace[],
  ptyId: string,
): { workspaceId: string; paneId: string; surfaceId: string } | undefined {
  for (const ws of workspaces) {
    const addr = resolveSenderPaneAddress(getWorkspaceLeafPanes(ws), ptyId);
    if (addr) return { workspaceId: ws.id, paneId: addr.paneId, surfaceId: addr.surfaceId };
  }
  return undefined;
}

type Side = Task['metadata']['to'];

/** The pty a task side is pinned to, or undefined for a workspace-only side
 *  (or an anchor that no longer resolves). */
function pinnedPty(side: Side | undefined, workspaces: readonly Workspace[]): string | undefined {
  if (!side || (!side.paneId && !side.surfaceId)) return undefined;
  const ws = workspaces.find((w) => w.id === side.workspaceId);
  if (!ws) return undefined;
  const addr = resolvePaneAddress(getWorkspaceLeafPanes(ws), side.paneId ?? '', side.surfaceId ?? '');
  return 'error' in addr ? undefined : addr.ptyId;
}

/**
 * Does `ptyId` have an open a2a task pinned to it, other than `exceptTaskId`
 * (the task being delivered)? Ended tasks (completed / failed / canceled) do
 * not count.
 */
export function paneHasOtherOpenA2aTask(
  tasks: readonly Task[],
  workspaces: readonly Workspace[],
  ptyId: string,
  exceptTaskId: string,
): boolean {
  for (const task of tasks) {
    if (task.id === exceptTaskId) continue;
    if (TERMINAL_STATES.includes(task.status.state)) continue;
    const { to, from } = task.metadata;
    if (to.ptyId === ptyId) return true;
    if (pinnedPty(to, workspaces) === ptyId || pinnedPty(from, workspaces) === ptyId) return true;
  }
  return false;
}

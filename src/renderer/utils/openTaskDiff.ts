import { useStore } from '../stores';
import { findLeafPanes } from '../hooks/a2aAddressing';
import type { WorkTask } from '../../shared/workTask';

/**
 * Does this task still have a worktree whose diff can be reviewed and adopted?
 * Open tasks and detached ones (closed, but the worktree was kept) do. An
 * ordinarily closed task's worktree was removed, and a worktree:false task
 * (output folder) never had one. Mirrors the task diff panel's own rule.
 */
export function hasAdoptableTaskDiff(task: WorkTask | undefined): task is WorkTask {
  if (!task?.worktreePath) return false;
  return task.status === 'open' || task.detachedAt !== undefined;
}

/**
 * F5 — open a task's diff surface in a visible pane of its workspace and
 * switch to that workspace so the diff is on screen. Silently does nothing
 * when the workspace or its leaf is not there yet (a race). F1: the owner
 * workspace id rides on the surface so close / PR / resolveTaskMeta call the
 * owner-scoped RPCs with the right identity.
 */
export function openTaskDiff(taskId: string, workspaceId: string, title: string, ownerWorkspaceId: string): void {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  // Open it where it will be seen: the zoomed pane when one of this
  // workspace's panes is zoomed (the others are hidden), else the workspace's
  // active pane, else its first.
  const leaves = findLeafPanes(ws.rootPane);
  const leaf = leaves.find((l) => l.id === st.zoomedPaneId)
    ?? leaves.find((l) => l.id === ws.activePaneId)
    ?? leaves[0];
  if (!leaf) return;
  st.addDiffSurface(leaf.id, taskId, `diff: ${title}`, workspaceId, ownerWorkspaceId);
  st.setActiveWorkspace(workspaceId);
}

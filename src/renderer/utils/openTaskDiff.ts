import { useStore } from '../stores';
import { findLeafPanes } from '../hooks/a2aAddressing';
import type { Surface } from '../../shared/types';
import type { WorkTask } from '../../shared/workTask';

/**
 * Does this task still have a worktree whose diff can be reviewed and adopted?
 * Open tasks and detached ones (closed, but the worktree was kept) do. An
 * ordinarily closed task's worktree was removed, and a worktree:false task
 * (output folder) never had one. Mirrors the task diff panel's own rule.
 */
export function hasAdoptableTaskDiff(task: WorkTask): boolean {
  if (!task.worktreePath) return false;
  return task.status === 'open' || task.detachedAt !== undefined;
}

/**
 * F5 — open a task's diff surface in a visible pane of its workspace and
 * switch to that workspace so the diff is on screen. Silently does nothing
 * when the workspace or its leaf is not there yet (a race). F1: the owner
 * workspace id rides on the surface so close / PR / resolveTaskMeta call the
 * owner-scoped RPCs with the right identity.
 *
 * One diff surface per task: when a pane of the workspace already holds this
 * task's diff, that tab is brought forward instead of a second one being added
 * to the focused pane. Two mounted panels for one task disagree after a Close:
 * the one that did not close keeps the removed worktree's hunks, with Adopt
 * and Close still up. (Only the layout is searched: a stashed pane's panel is
 * unmounted, and it reloads the task when the pane comes back.)
 */
export function openTaskDiff(taskId: string, workspaceId: string, title: string, ownerWorkspaceId: string): void {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const leaves = findLeafPanes(ws.rootPane);
  const isThisDiff = (s: Surface) => s.surfaceType === 'diff' && s.diffTaskId === taskId;
  const holder = leaves.find((l) => l.surfaces.some(isThisDiff));
  const existing = holder?.surfaces.find(isThisDiff);
  if (holder && existing) {
    // On the pane that holds it, addDiffSurface selects that tab and backfills
    // a missing owner id. Then that pane takes focus, and a zoomed sibling in
    // this workspace, which would hide it, is un-zoomed.
    st.addDiffSurface(holder.id, taskId, `diff: ${title}`, workspaceId, ownerWorkspaceId);
    st.focusPaneSurface(workspaceId, holder.id, existing.id);
    if (st.zoomedPaneId !== null && st.zoomedPaneId !== holder.id && leaves.some((l) => l.id === st.zoomedPaneId)) {
      st.togglePaneZoom(st.zoomedPaneId);
    }
    st.setActiveWorkspace(workspaceId);
    return;
  }
  // Open it where it will be seen: the zoomed pane when one of this
  // workspace's panes is zoomed (the others are hidden), else the workspace's
  // active pane, else its first.
  const leaf = leaves.find((l) => l.id === st.zoomedPaneId)
    ?? leaves.find((l) => l.id === ws.activePaneId)
    ?? leaves[0];
  if (!leaf) return;
  st.addDiffSurface(leaf.id, taskId, `diff: ${title}`, workspaceId, ownerWorkspaceId);
  st.setActiveWorkspace(workspaceId);
}

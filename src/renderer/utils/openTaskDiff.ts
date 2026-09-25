import { useStore } from '../stores';
import { findLeafPanes } from '../hooks/a2aAddressing';

/**
 * F5 — open a task's diff surface on the first leaf pane of its workspace and
 * switch to that workspace so the diff is on screen. Silently does nothing
 * when the workspace or its leaf is not there yet (a race). F1: the owner
 * workspace id rides on the surface so close / PR / resolveTaskMeta call the
 * owner-scoped RPCs with the right identity.
 */
export function openTaskDiff(taskId: string, workspaceId: string, title: string, ownerWorkspaceId: string): void {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const leaf = findLeafPanes(ws.rootPane)[0];
  if (!leaf) return;
  st.addDiffSurface(leaf.id, taskId, `diff: ${title}`, workspaceId, ownerWorkspaceId);
  st.setActiveWorkspace(workspaceId);
}

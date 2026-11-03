// Close and keep folder (#2388): the owner's way out of a task close that
// keeps refusing (its processes could not be verified gone, or its folder
// cannot be removed). The task closes; its folder stays on disk as it is, and
// the toast names where. A close whose repository is gone keeps the folder on
// its own and names it the same way.

import { useStore } from '../../stores';
import { getWorkspacePtyIds } from '../../../shared/paneUtils';
import { selectWorkspaceAgentRoster } from '../../stores/selectors/workspaceAgentRoster';
import { paneRowsFinished } from '../Sidebar/sidebarTree';
import { leaveTaskWorkspaceToCaller } from '../../utils/closedTaskWorkspaces';
import type { useT } from '../../hooks/useT';

type Translate = ReturnType<typeof useT>;

/** The line saying where a closed task's folder was kept, or null when the
 *  close kept none. */
export function keptFolderMessage(res: { keptFolder?: string }, t: Translate): string | null {
  return res.keptFolder ? t('worktask.keepFolder.done', { path: res.keptFolder }) : null;
}

/** Close the task keeping its folder; true when it closed. Toasts the result. */
export async function closeKeepingFolder(taskId: string, verifiedWorkspaceId: string, t: Translate): Promise<boolean> {
  const push = useStore.getState().pushToast;
  const release = leaveTaskWorkspaceToCaller(taskId);
  try {
    const res = await window.electronAPI.workTask.close(taskId, verifiedWorkspaceId, { keepFolder: true });
    if (res.ok) {
      push({ level: 'info', message: keptFolderMessage(res, t) ?? t('worktask.cleanup.closed') });
      void useStore.getState().refreshMissions(verifiedWorkspaceId);
      return true;
    }
    push({ level: 'error', message: t('worktask.cleanup.closeFailed', { error: res.error ?? '' }) });
  } catch (err) {
    push({ level: 'error', message: t('worktask.cleanup.closeFailed', { error: err instanceof Error ? err.message : String(err) }) });
  }
  // Not closed: the task's next close is no longer this caller's.
  release();
  return false;
}

/** Whether `workspaceId` runs work that a close of it would end: an agent
 *  not finished, or a shell running a command (OSC 133) other than the
 *  task's own finished agent. That agent is the command its shell runs
 *  until it exits, and ending it is what the close is for. */
export function workspaceBusy(workspaceId: string): boolean {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return false;
  const rows = selectWorkspaceAgentRoster(st, workspaceId).rows;
  if (!paneRowsFinished(rows)) return true;
  // A pane whose agent is known gone runs something else now.
  const ownAgents = new Set(rows.filter((r) => st.agentAliveByPtyId[r.ptyId] !== false).map((r) => r.ptyId));
  return getWorkspacePtyIds(ws).some((ptyId) => !ownAgents.has(ptyId) && st.commandRunningByPtyId[ptyId] === true);
}

/** The toast action offering Close and keep folder after a refused close;
 *  `onClosed` runs once the task closed. `recheck`: why the task's work may
 *  not be ended now (it started again since the refusal), or null. Asked at
 *  the click (the action then closes nothing) and again once the task closed
 *  (`afterClose`: `onClosed` is then skipped, the workspace stays open). */
export function keepFolderAction(
  taskId: string,
  verifiedWorkspaceId: string,
  t: Translate,
  onClosed?: () => void,
  recheck?: (afterClose: boolean) => string | null,
): { label: string; onClick: () => void } {
  const refused = (afterClose: boolean): boolean => {
    const why = recheck?.(afterClose) ?? null;
    if (why) useStore.getState().pushToast({ level: 'warn', message: why });
    return why !== null;
  };
  return {
    label: t('worktask.keepFolder.action'),
    onClick: () => {
      if (refused(false)) return;
      void closeKeepingFolder(taskId, verifiedWorkspaceId, t).then((closed) => {
        if (closed && !refused(true)) onClosed?.();
      });
    },
  };
}

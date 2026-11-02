// #2934 — a fan-out task closed from anywhere (channel_mission_close, the CLI,
// another agent) used to leave its workspace in the sidebar and the phone task
// list until someone closed it by hand. For a task whose owner workspace is
// still open, the next mission refresh sees the close; this decides which of
// those task workspaces the renderer may close itself. The worktree is never
// touched: removing it stays the caller's call.

import type { AgentStatus, Workspace } from '../../shared/types';
import type { WorkTask } from '../../shared/workTask';
import { getWorkspaceLeafPanes, getWorkspacePtyIds } from '../../shared/paneUtils';
import type { StoreState } from '../stores';
import { selectWorkspaceAgentRoster, type WorkspaceAgentRosterRow } from '../stores/selectors/workspaceAgentRoster';
import { pickStashedRepresentativeSurface } from '../stores/selectors/fleet';
import { isWorkspaceShown } from '../stores/selectors/surfaceShown';
import { workspaceCloseRefusal } from '../components/Moa/moaHqGuard';

/** Tasks whose close a caller handles itself, workspace included (Close and
 *  keep folder decides on its own whether the workspace stays). */
const leftToCaller = new Set<string>();

/** Mark `taskId` as closed by a caller that decides about its workspace
 *  itself: the close this refresh sees then leaves the workspace alone. The
 *  returned release drops the mark when the caller's close failed, so a later
 *  close from anywhere closes the workspace as usual. */
export function leaveTaskWorkspaceToCaller(taskId: string): () => void {
  leftToCaller.add(taskId);
  return () => {
    leftToCaller.delete(taskId);
  };
}

/** An agent not seen to finish: its workspace stays. Finished is a turn that
 *  ended (`complete`) or an agent idle at its prompt (`waiting`; a question
 *  pending on the pane reads `awaiting_input` in the roster). `idle` is not:
 *  without the turn-start hook a working agent reads idle too, the same rule
 *  as paneRowsFinished. */
function agentKeepsWorkspace(status: AgentStatus): boolean {
  return status !== 'complete' && status !== 'waiting';
}

/** A shell running a command (OSC 133) that is not the pane's own live agent,
 *  the same rule as workspaceBusy: ending the agent is what the close is for,
 *  anything else is work of its own. */
function runsOtherCommand(state: StoreState, ws: Workspace, rows: readonly WorkspaceAgentRosterRow[]): boolean {
  const agents = new Set(rows.filter((r) => r.agentName && state.agentAliveByPtyId[r.ptyId] !== false).map((r) => r.ptyId));
  return getWorkspacePtyIds(ws).some((ptyId) => !agents.has(ptyId) && state.commandRunningByPtyId[ptyId] === true);
}

/** The roster shows a stashed pane by one tab (pickStashedRepresentativeSurface):
 *  an agent in another tab of it is not seen to finish, unless known gone. */
function stashedTabHoldsAgent(state: StoreState, ws: Workspace): boolean {
  return (ws.stashedPanes ?? []).some((entry) => {
    const leaf = entry?.pane;
    if (!leaf || leaf.type !== 'leaf') return false;
    const shown = pickStashedRepresentativeSurface(leaf, state.surfaceAgent);
    return leaf.surfaces.some((s) => s.id !== shown?.id && !!s.ptyId
      && !!state.surfaceAgent[s.ptyId]?.name && state.agentAliveByPtyId[s.ptyId] !== false);
  });
}

/** An editor tab (stash included): its edits may be unsaved, and nothing
 *  tracks whether they are. A remote terminal, owned or only viewed: closing
 *  ends that session on the other machine or drops the view of it. Browser,
 *  diff and preview tabs reopen from their URL or the disk. */
function holdsKeptTab(ws: Workspace): boolean {
  return getWorkspaceLeafPanes(ws).some((leaf) => leaf.surfaces.some((s) => s.surfaceType === 'editor' || s.surfaceType === 'remote-terminal'));
}

/**
 * The task workspaces to close after a mission refresh: those whose task went
 * from `open` (in `prev`) to `closed` (in `next`). Edge-triggered only — a task
 * first seen closed (startup) or already closed before is never closed here,
 * so a workspace kept once stays the user's. A workspace is kept when the task
 * was detached or left to its caller, the workspace is gone or shown, an agent
 * in it has not finished or a shell runs a command, it holds an editor or a
 * remote terminal, or closing it would be refused (the last workspace).
 */
export function taskWorkspacesToClose(
  prev: Readonly<Record<string, WorkTask>>,
  next: Readonly<Record<string, WorkTask>>,
  state: StoreState,
): string[] {
  const out: string[] = [];
  // Each close shrinks the list the last-workspace refusal counts.
  let workspaces = state.workspaces;
  for (const [wsId, task] of Object.entries(next)) {
    const before = prev[wsId];
    if (task.status !== 'closed' || before?.status !== 'open') continue;
    // The edge comes once, so the mark is spent here.
    if (leftToCaller.delete(task.id)) continue;
    if (task.detachedAt !== undefined) continue;
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws || isWorkspaceShown(state, wsId)) continue;
    const rows = selectWorkspaceAgentRoster(state, wsId).rows;
    if (rows.some((row) => agentKeepsWorkspace(row.status)) || stashedTabHoldsAgent(state, ws) || runsOtherCommand(state, ws, rows)) continue;
    if (holdsKeptTab(ws)) continue;
    if (workspaceCloseRefusal({ workspaces }, wsId)) continue;
    out.push(wsId);
    workspaces = workspaces.filter((w) => w.id !== wsId);
  }
  return out;
}

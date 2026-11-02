// #2934 — a fan-out task closed from anywhere (channel_mission_close, the CLI,
// another window) used to leave its workspace in the sidebar and the phone task
// list until someone closed it by hand. The mission cache sees the close on its
// next poll; this decides which of those task workspaces the renderer may close
// itself. The worktree is never touched: removing it stays the caller's call.

import type { AgentStatus } from '../../shared/types';
import type { WorkTask } from '../../shared/workTask';
import { getWorkspaceRemoteSessions } from '../../shared/paneUtils';
import type { StoreState } from '../stores';
import { selectWorkspaceAgentRoster } from '../stores/selectors/workspaceAgentRoster';
import { workspaceCloseRefusal } from '../components/Moa/moaHqGuard';

/** An agent still at work or asking something: its workspace stays. `waiting`
 *  without a question is an agent idle at its prompt (the detector's "Ready
 *  for input"), which the roster shows as idle: a finished worker. */
export function agentKeepsWorkspace(row: { status: AgentStatus; pendingQuestion?: string }): boolean {
  if (row.status === 'waiting') return row.pendingQuestion !== undefined;
  return row.status === 'running' || row.status === 'awaiting_input';
}

/**
 * The task workspaces to close after a mission refresh: those whose task went
 * from `open` (in `prev`) to `closed` (in `next`). Edge-triggered only — a task
 * first seen closed (startup) or already closed before is never closed here,
 * so a workspace kept once stays the user's. A workspace is kept when the task
 * was detached, the workspace is gone or active, an agent in it is still
 * working, it holds a remote session (closing would end it on another
 * machine), or closing it would be refused (the last workspace).
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
    if (task.detachedAt !== undefined) continue;
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws || state.activeWorkspaceId === wsId) continue;
    if (selectWorkspaceAgentRoster(state, wsId).rows.some(agentKeepsWorkspace)) continue;
    if (getWorkspaceRemoteSessions(ws).length > 0) continue;
    if (workspaceCloseRefusal({ workspaces }, wsId)) continue;
    out.push(wsId);
    workspaces = workspaces.filter((w) => w.id !== wsId);
  }
  return out;
}

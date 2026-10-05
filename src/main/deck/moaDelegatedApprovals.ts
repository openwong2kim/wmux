// The permission prompts of agents Moa delegated work to, for Moa's "Waiting
// on you". A delegated agent that asks to run a command is waiting on a
// decision only the operator can make, so it belongs beside Moa's own cards;
// before, only the titlebar's count showed it. Read-only: the operator answers
// in the pane (the row jumps there), and Moa never answers it (the approval
// guard refuses a brain's press).
import type { MoaDelegatedApproval } from '../../shared/moa';

/** The fields of a daemon approval record (daemon.approvals.list) read here. */
export interface PendingApprovalLike {
  id?: unknown;
  sessionId?: unknown;
  workspaceId?: unknown;
  agent?: unknown;
  state?: unknown;
  toolName?: unknown;
  toolInputSummary?: unknown;
  summary?: unknown;
  question?: unknown;
  createdAt?: unknown;
}

/** Where Moa's delegated work runs: hand-off panes by pty, fan-out tasks by workspace. */
export interface DelegatedScope {
  /** Open hand-off targets: ptyId → the agent's display name. */
  handoffPtys: ReadonlyMap<string, { workspaceId: string; agentName: string }>;
  /** Workspaces of the HQ's open fan-out tasks. */
  taskWorkspaces: ReadonlySet<string>;
  workspaceName: (workspaceId: string) => string | undefined;
}

/** Most rows shown: the section is a pointer to the panes, not a queue. */
export const DELEGATED_APPROVALS_MAX = 20;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Pending approvals in Moa's delegated scope, oldest first. */
export function selectDelegatedApprovals(pending: readonly PendingApprovalLike[], scope: DelegatedScope): MoaDelegatedApproval[] {
  const out: MoaDelegatedApproval[] = [];
  for (const a of pending) {
    const id = str(a.id);
    const ptyId = str(a.sessionId);
    if (!id || !ptyId || (a.state !== undefined && a.state !== 'pending')) continue;
    const handoff = scope.handoffPtys.get(ptyId);
    const workspaceId = handoff?.workspaceId ?? str(a.workspaceId);
    if (!workspaceId || (!handoff && !scope.taskWorkspaces.has(workspaceId))) continue;
    const what = str(a.summary) ?? str(a.toolInputSummary) ?? str(a.question);
    const toolName = str(a.toolName);
    const workspaceName = scope.workspaceName(workspaceId);
    out.push({
      id,
      ptyId,
      workspaceId,
      ...(workspaceName ? { workspaceName } : {}),
      agentName: handoff?.agentName ?? str(a.agent) ?? 'agent',
      ...(toolName ? { toolName } : {}),
      ...(what ? { what } : {}),
      createdAt: typeof a.createdAt === 'number' ? a.createdAt : 0,
    });
  }
  out.sort((x, y) => x.createdAt - y.createdAt);
  return out.slice(0, DELEGATED_APPROVALS_MAX);
}

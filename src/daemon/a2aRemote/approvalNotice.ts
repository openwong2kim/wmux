// What the receiving PC keeps and shows when another PC's allow or deny was
// typed into one of its panes (remoteApproval.ts `carriedOut`): one line,
// "<PC> allowed|denied <tool> in <pane>", as a desktop notification (main
// raises it from REMOTE_APPROVAL_DONE_EVENT) and as a note on the task
// (`metadata.remote.approvalNotes`). The command is never in either: nothing
// here is given it. <PC> is this PC's own name for that PC (its pairing
// record, as the PC rail shows it), or its short host id; never a name the
// task or a message carries.
//
// The note is not a message: it is never sent to the other PC, never queued
// for the pane, and moves nothing else on the task (its `updatedAt`, a
// refusal still owed a replay, a reopen).

import { REMOTE_APPROVAL_DONE_EVENT, remoteApprovalNoticeText, type A2aRemoteApprovalDecision, type HostId } from '../../shared/a2aRemote';
import { localSideOf, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import type { A2aTaskService } from '../a2a/A2aTaskService';

/** REMOTE_APPROVAL_DONE_EVENT's data: the line to show and the pane to jump to. No command. */
export interface RemoteApprovalDoneEvent {
  taskId: string;
  ptyId?: string;
  decision: A2aRemoteApprovalDecision;
  text: string;
}

export interface ApprovalNoticeDeps {
  tasks: Pick<A2aTaskService, 'getTask' | 'markRemote'>;
  /** This PC's own name for the paired PC (its pairing record); undefined: its short host id is shown. */
  hostName(hostId: HostId): string | undefined;
  /** The pane's name as the app last published it (workspace and pane label); undefined: the workspace name is used. */
  paneLabel?(workspaceId: string, paneId: string): string | undefined;
  broadcast(event: { type: string; sessionId: string; data: RemoteApprovalDoneEvent }): void;
  log(level: 'warn', msg: string): void;
}

/** One carried-out approval: the event for main, then the task's note. */
export async function noteRemoteApproval(
  deps: ApprovalNoticeDeps,
  e: { hostId: HostId; taskId: string; messageId: string; decision: A2aRemoteApprovalDecision; tool: string },
): Promise<void> {
  const task = deps.tasks.getTask(e.taskId);
  const marker = task?.metadata.remote as A2aRemoteTaskState | undefined;
  if (!task || !marker) return;
  const local = task.metadata[localSideOf(task)];
  const pane = (local.paneId ? deps.paneLabel?.(local.workspaceId, local.paneId) : undefined) ?? local.displayName ?? local.name;
  const text = remoteApprovalNoticeText({ pc: deps.hostName(e.hostId) || e.hostId.slice(0, 8), decision: e.decision, tool: e.tool, pane });
  deps.broadcast({
    type: REMOTE_APPROVAL_DONE_EVENT,
    sessionId: local.ptyId ?? '',
    data: { taskId: task.id, ...(local.ptyId ? { ptyId: local.ptyId } : {}), decision: e.decision, text },
  });
  const res = await deps.tasks.markRemote({ taskId: task.id, approvalNote: { messageId: e.messageId, decision: e.decision, tool: e.tool, text } });
  if (!res.ok) deps.log('warn', `[a2a-remote] approval task=${task.id} message=${e.messageId}: its note was not kept: ${res.error}`);
}

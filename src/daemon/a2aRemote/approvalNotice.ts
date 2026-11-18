// What the receiving PC keeps and shows when another PC's allow or deny was
// typed into one of its panes (remoteApproval.ts `carriedOut`): one line,
// "<PC> allowed|denied <tool> in <pane>", as a desktop notification (main
// raises it from REMOTE_APPROVAL_DONE_EVENT) and as an entry in the task's
// history. The command is never in either: nothing here is given it.
//
// The history entry is this PC's own record. It is written by the task's
// local side with the sender's role, so the outbound sync never sends it to
// the other PC as a reply (it sends only this side's own role), and it is not
// a message from the other PC, so it is never queued for the pane.

import crypto from 'node:crypto';
import { remoteApprovalNoticeText, type A2aRemoteApprovalDecision, type HostId } from '../../shared/a2aRemote';
import { localSideOf, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import type { A2aTaskService } from '../a2a/A2aTaskService';

/** The daemon event main turns into a notification. */
export const REMOTE_APPROVAL_DONE_EVENT = 'a2a.remote.approval.done';

/** REMOTE_APPROVAL_DONE_EVENT's data: the line to show and the pane to jump to. No command. */
export interface RemoteApprovalDoneEvent {
  taskId: string;
  ptyId?: string;
  decision: A2aRemoteApprovalDecision;
  text: string;
}

/** The history entry's message id: derived from the approval's, so a second call for it adds nothing. */
export function approvalNoticeMessageId(approvalMessageId: string): string {
  return `apn-${crypto.createHash('sha256').update(approvalMessageId).digest('hex').slice(0, 32)}`;
}

export interface ApprovalNoticeDeps {
  tasks: Pick<A2aTaskService, 'getTask' | 'appendRemoteMessage'>;
  /** The paired PC's name here. */
  hostName(hostId: HostId): string | undefined;
  /** The pane's name as the app last published it (workspace and pane label); undefined: the workspace name is used. */
  paneLabel?(workspaceId: string, paneId: string): string | undefined;
  broadcast(event: { type: string; sessionId: string; data: RemoteApprovalDoneEvent }): void;
  log(level: 'warn', msg: string): void;
}

/** One carried-out approval: the event for main, then the task's history entry. */
export async function noteRemoteApproval(
  deps: ApprovalNoticeDeps,
  e: { hostId: HostId; taskId: string; messageId: string; decision: A2aRemoteApprovalDecision; tool: string },
): Promise<void> {
  const task = deps.tasks.getTask(e.taskId);
  const marker = task?.metadata.remote as A2aRemoteTaskState | undefined;
  if (!task || !marker) return;
  const local = task.metadata[localSideOf(task)];
  const pane = (local.paneId ? deps.paneLabel?.(local.workspaceId, local.paneId) : undefined) ?? local.displayName ?? local.name;
  const text = remoteApprovalNoticeText({ pc: deps.hostName(e.hostId), decision: e.decision, tool: e.tool, pane });
  deps.broadcast({
    type: REMOTE_APPROVAL_DONE_EVENT,
    sessionId: local.ptyId ?? '',
    data: { taskId: task.id, ...(local.ptyId ? { ptyId: local.ptyId } : {}), decision: e.decision, text },
  });
  const res = await deps.tasks.appendRemoteMessage({
    taskId: task.id,
    linkId: marker.linkId,
    actorWorkspaceId: local.workspaceId,
    message: {
      kind: 'message',
      messageId: approvalNoticeMessageId(e.messageId),
      // The other side's role: the sync sends only this side's own messages.
      role: localSideOf(task) === 'to' ? 'user' : 'agent',
      parts: [{ kind: 'text', text }],
      metadata: { wmuxRemoteApproval: { messageId: e.messageId, decision: e.decision, tool: e.tool } },
    },
  });
  if (!res.ok) deps.log('warn', `[a2a-remote] approval task=${task.id} message=${e.messageId}: its history entry was not kept: ${res.error}`);
}

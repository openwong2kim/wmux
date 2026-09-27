// Who may reopen an ended A2A task: its sender, and only a provable one.
//
// Shared by the daemon (the durable gate) and the renderer (which decides
// whether to ask for a reopen), so the two can never disagree about it.
import type { Task, WmuxTaskMetadata } from './types';
import { TERMINAL_STATES } from './types';

/**
 * True when the caller is verifiably the task's sender. Cross-workspace, the
 * sender side is the whole `from` workspace. Same-workspace, both sides share
 * a workspace, so only the `from` pane itself counts; a caller without a
 * resolved pane (headless worker, missing or unverified senderPtyId) or any
 * other pane is not the sender.
 */
export function isVerifiedTaskSender(
  meta: Pick<WmuxTaskMetadata, 'from' | 'to'>,
  callerWorkspaceId: string,
  callerPaneId: string | undefined,
): boolean {
  if (meta.from.workspaceId !== callerWorkspaceId) return false;
  if (meta.from.workspaceId !== meta.to.workspaceId) return true;
  return !!meta.from.paneId && callerPaneId === meta.from.paneId;
}

/** The task has ended (completed, failed or canceled). */
export function isTaskEnded(task: Pick<Task, 'status'>): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(task.status.state);
}

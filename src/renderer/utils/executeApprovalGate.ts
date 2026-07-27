/**
 * Renderer-side gate for A2A `execute:true` requests.
 *
 * Spawning a background Claude in `--permission-mode bypassPermissions` is the
 * highest-risk A2A action, so every NEW execute request is parked here until
 * the user approves — unless the global YOLO auto-approve is on, or the 30s
 * timer auto-denies. Extracted from useRpcBridge so it can be unit-tested
 * without importing the full RPC bridge (and its xterm/canvas dependencies).
 */
import { useStore } from '../stores';
import { generateId } from '../../shared/types';
import { resolveExecuteApproval, setExecuteApprovalResolver } from './executeApproval';

const EXECUTE_APPROVAL_TIMEOUT_MS = 30_000;

export function requestExecuteApproval(input: {
  taskId: string;
  senderWorkspaceId: string;
  receiverWorkspaceId: string;
  messagePreview: string;
  cwd: string | null;
  /** Set by the fan-out RPC path so the dialog describes what actually
   *  happens (N new worktree workspaces, not one spawn in this workspace). */
  fanout?: { taskCount: number; repoPath: string };
}): Promise<boolean> {
  if (useStore.getState().a2aAutoApproveExecute) return Promise.resolve(true);

  const approvalId = generateId('approval');
  const expiresAt = Date.now() + EXECUTE_APPROVAL_TIMEOUT_MS;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      useStore.getState().removeExecuteApproval(approvalId);
      resolve(approved);
    };
    const timer = setTimeout(() => resolveExecuteApproval(approvalId, false), EXECUTE_APPROVAL_TIMEOUT_MS);
    setExecuteApprovalResolver(approvalId, settle);
    useStore.getState().enqueueExecuteApproval({
      approvalId,
      taskId: input.taskId,
      senderWorkspaceId: input.senderWorkspaceId,
      receiverWorkspaceId: input.receiverWorkspaceId,
      messagePreview: input.messagePreview,
      cwd: input.cwd,
      expiresAt,
      ...(input.fanout ? { fanout: input.fanout } : {}),
    });
  });
}

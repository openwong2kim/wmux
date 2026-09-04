/**
 * Renderer-side gate for A2A `execute:true` requests and for pipe/MCP fan-out.
 *
 * Spawning a background Claude in `--permission-mode bypassPermissions` is the
 * highest-risk A2A action, so every NEW execute request is parked here until
 * the user approves — unless the global YOLO auto-approve is on, or the 30s
 * timer auto-denies. Extracted from useRpcBridge so it can be unit-tested
 * without importing the full RPC bridge (and its xterm/canvas dependencies).
 *
 * Fan-out shares the queue, the dialog and the timer but NOT the auto-approve
 * toggle — see requestFanOutApproval.
 */
import { useStore } from '../stores';
import { generateId } from '../../shared/types';
import { resolveExecuteApproval, setExecuteApprovalResolver } from './executeApproval';

const EXECUTE_APPROVAL_TIMEOUT_MS = 30_000;

/** How an approval prompt ended. `timeout` is the unattended case, and callers
 *  that report back over the wire need to tell it apart from a real denial. */
export type ApprovalOutcome = 'approved' | 'declined' | 'timeout';

interface ApprovalInput {
  taskId: string;
  senderWorkspaceId: string;
  receiverWorkspaceId: string;
  messagePreview: string;
  cwd: string | null;
  /** Set by the fan-out path so the dialog describes what actually happens
   *  (N new worktree workspaces, not one spawn in this workspace). */
  fanout?: { taskCount: number; repoPath: string };
  /** Set by the task-lifecycle path (task.close / task.pr), for the same
   *  reason `fanout` exists: neither spawns anything, so the execute copy
   *  would describe an action the user is not being asked about. */
  task?: {
    taskId: string;
    title: string;
    branch: string;
    worktreePath: string;
    action: string;
    effect: string;
    branchTip?: string;
  };
}

/**
 * Park one prompt on the shared queue and resolve when it settles.
 *
 * `autoApprovable` is what separates the two callers: the A2A execute path
 * honours the user's global auto-approve toggle, the fan-out path does not.
 */
function enqueueApproval(
  input: ApprovalInput,
  autoApprovable: boolean,
): Promise<{ approved: boolean; outcome: ApprovalOutcome }> {
  if (autoApprovable && useStore.getState().a2aAutoApproveExecute) {
    return Promise.resolve({ approved: true, outcome: 'approved' });
  }

  const approvalId = generateId('approval');

  return new Promise<{ approved: boolean; outcome: ApprovalOutcome }>((resolve) => {
    let settled = false;
    // The auto-deny timer resolves through the same path a Deny click does, so
    // record which one fired before the verdict collapses to a boolean.
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      countdownStarters.delete(approvalId);
      useStore.getState().removeExecuteApproval(approvalId);
      resolve({ approved, outcome: approved ? 'approved' : timedOut ? 'timeout' : 'declined' });
    };
    // The timer starts when the dialog SHOWS this prompt, not now. Only one
    // prompt is on screen at a time, so a second one used to burn its whole
    // 30 s behind the first and auto-deny having never been visible — a denial
    // nobody made, reported to the caller as a timeout.
    countdownStarters.set(approvalId, () => {
      if (settled || timer) return;
      timer = setTimeout(() => {
        timedOut = true;
        resolveExecuteApproval(approvalId, false);
      }, EXECUTE_APPROVAL_TIMEOUT_MS);
      useStore.getState().setExecuteApprovalExpiry(approvalId, Date.now() + EXECUTE_APPROVAL_TIMEOUT_MS);
    });
    setExecuteApprovalResolver(approvalId, settle);
    useStore.getState().enqueueExecuteApproval({
      approvalId,
      taskId: input.taskId,
      senderWorkspaceId: input.senderWorkspaceId,
      receiverWorkspaceId: input.receiverWorkspaceId,
      messagePreview: input.messagePreview,
      cwd: input.cwd,
      // 0 = queued, countdown not started. See beginApprovalCountdown.
      expiresAt: 0,
      ...(input.fanout ? { fanout: input.fanout } : {}),
      ...(input.task ? { task: input.task } : {}),
    });
  });
}

/** Prompts whose countdown has not started yet, keyed by approval id. */
const countdownStarters = new Map<string, () => void>();

/**
 * Start one prompt's auto-deny countdown. Called by the dialog when it renders
 * that prompt, so the 30 s a caller is told about is 30 s a person could have
 * used. Idempotent, and a no-op for a prompt that already settled.
 */
export function beginApprovalCountdown(approvalId: string): void {
  countdownStarters.get(approvalId)?.();
}

export function requestExecuteApproval(input: {
  taskId: string;
  senderWorkspaceId: string;
  receiverWorkspaceId: string;
  messagePreview: string;
  cwd: string | null;
}): Promise<boolean> {
  return enqueueApproval(input, true).then((v) => v.approved);
}

/**
 * Gate for a fan-out started over the pipe/MCP surface.
 *
 * Same queue, same dialog, same 30s timer as the execute gate — but deliberately
 * NOT the same consent. `a2aAutoApproveExecute` is the user agreeing that an
 * agent may spawn a background agent; it is not the user agreeing that an agent
 * may create N git worktrees and branches in their repository. So fan-out is
 * never auto-approved, and it reports the outcome instead of a bare boolean:
 * the wire caller has already been told "accepted", so a silent auto-deny would
 * leave an unattended fleet waiting on a fan-out that will never happen.
 */
export function requestFanOutApproval(input: {
  workspaceId: string;
  repoPath: string;
  taskCount: number;
  messagePreview: string;
}): Promise<{ approved: boolean; outcome: ApprovalOutcome }> {
  return enqueueApproval(
    {
      taskId: 'fan-out',
      senderWorkspaceId: input.workspaceId,
      receiverWorkspaceId: input.workspaceId,
      messagePreview: input.messagePreview,
      cwd: input.repoPath || null,
      fanout: { taskCount: input.taskCount, repoPath: input.repoPath },
    },
    false,
  );
}

/**
 * Gate for the two destructive task-lifecycle methods (task.close, task.pr).
 *
 * Never auto-approved, for the same reason fan-out is not: `a2aAutoApproveExecute`
 * is consent to background execution, and neither removing a worktree nor
 * pushing a branch to a remote is that. The outcome (not a bare boolean) goes
 * back over the wire so an unattended orchestrator learns it was refused, and
 * whether by a person or by the timer.
 */
export function requestTaskApproval(input: {
  workspaceId: string;
  taskId: string;
  title: string;
  branch: string;
  worktreePath: string;
  action: string;
  effect: string;
  branchTip?: string;
}): Promise<{ approved: boolean; outcome: ApprovalOutcome }> {
  return enqueueApproval(
    {
      taskId: input.taskId,
      senderWorkspaceId: input.workspaceId,
      receiverWorkspaceId: input.workspaceId,
      messagePreview: input.title,
      cwd: input.worktreePath || null,
      task: {
        taskId: input.taskId,
        title: input.title,
        branch: input.branch,
        worktreePath: input.worktreePath,
        action: input.action,
        effect: input.effect,
        ...(input.branchTip !== undefined ? { branchTip: input.branchTip } : {}),
      },
    },
    false,
  );
}

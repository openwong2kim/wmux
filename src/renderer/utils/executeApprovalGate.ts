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
 * toggle, and by default it is not prompted at all — see requestFanOutApproval.
 */
import { useStore } from '../stores';
import { generateId } from '../../shared/types';
import { resolveExecuteApproval, setExecuteApprovalResolver } from './executeApproval';
import {
  EXECUTE_APPROVAL_HARD_CAP_MS,
  EXECUTE_APPROVAL_WINDOW_MS,
} from '../../shared/executeApprovalBounds';

/** How an approval prompt ended. `timeout` is the unattended case, and callers
 *  that report back over the wire need to tell it apart from a real denial.
 *  `auto` means no prompt was shown because the operator turned it off (the
 *  fan-out default) — the audit log records it as approved by nobody. */
export type ApprovalOutcome = 'approved' | 'declined' | 'timeout' | 'auto';

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
 *
 * `hardCapMs` bounds the prompt's whole life from the moment it is queued,
 * shown or not. The execute path needs it because main stops waiting for the
 * verdict at a fixed point; see EXECUTE_APPROVAL_HARD_CAP_MS.
 */
function enqueueApproval(
  input: ApprovalInput,
  autoApprovable: boolean,
  hardCapMs?: number,
): Promise<{ approved: boolean; outcome: ApprovalOutcome }> {
  if (autoApprovable && useStore.getState().a2aAutoApproveExecute) {
    return Promise.resolve({ approved: true, outcome: 'approved' });
  }

  const approvalId = generateId('approval');
  const capAt = hardCapMs === undefined ? Infinity : Date.now() + hardCapMs;

  return new Promise<{ approved: boolean; outcome: ApprovalOutcome }>((resolve) => {
    let settled = false;
    // The auto-deny timer resolves through the same path a Deny click does, so
    // record which one fired before the verdict collapses to a boolean.
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (capTimer) clearTimeout(capTimer);
      countdowns.delete(approvalId);
      useStore.getState().removeExecuteApproval(approvalId);
      resolve({ approved, outcome: approved ? 'approved' : timedOut ? 'timeout' : 'declined' });
    };
    const expire = () => {
      timedOut = true;
      // Stamp the deadline as "now" first: a prompt the cap ends while it is
      // still queued has expiresAt 0, and the auto-rejected log keys off it.
      useStore.getState().setExecuteApprovalExpiry(approvalId, Date.now());
      resolveExecuteApproval(approvalId, false);
    };
    if (hardCapMs !== undefined) capTimer = setTimeout(expire, hardCapMs);
    // The timer starts when a surface SHOWS this prompt, not now. Only one
    // prompt is on screen at a time in the dialog, so a second one used to
    // burn its whole 30 s behind the first and auto-deny having never been
    // visible — a denial nobody made, reported to the caller as a timeout.
    countdowns.set(approvalId, {
      start: () => {
        if (settled || timer) return;
        timer = setTimeout(expire, EXECUTE_APPROVAL_WINDOW_MS);
        // The countdown shown is whichever ends first: the window, or the cap.
        const expiresAt = Math.min(Date.now() + EXECUTE_APPROVAL_WINDOW_MS, capAt);
        useStore.getState().setExecuteApprovalExpiry(approvalId, expiresAt);
      },
      pause: () => {
        if (settled || !timer) return;
        clearTimeout(timer);
        timer = null;
        useStore.getState().setExecuteApprovalExpiry(approvalId, 0);
      },
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

/** Countdown controls for every unsettled prompt, keyed by approval id. */
const countdowns = new Map<string, { start: () => void; pause: () => void }>();

/**
 * Start one prompt's auto-deny countdown. Called by the surface that renders
 * that prompt (the dialog, or the Fleet inbox), so the 30 s a caller is told
 * about is 30 s a person could have used. Idempotent, and a no-op for a prompt
 * that already settled.
 */
export function beginApprovalCountdown(approvalId: string): void {
  countdowns.get(approvalId)?.start();
}

/**
 * Stop a prompt's countdown because the surface showing it went away; the next
 * surface that shows it starts a fresh one. Without this, closing the Fleet
 * inbox left every row it had shown counting down behind the dialog, which
 * shows one at a time — and those rows auto-denied unseen. An execute prompt
 * still ends at its hard cap. No-op when the countdown is not running.
 */
export function pauseApprovalCountdown(approvalId: string): void {
  countdowns.get(approvalId)?.pause();
}

/** What makes two execute requests "the same request". The task id is minted
 *  per call, so a caller's retry never shares it — the content has to. */
interface ExecuteRequestIdentity {
  senderWorkspaceId: string;
  /** The sending pane's pty, or '' when it could not be verified. */
  senderPtyId: string;
  receiverWorkspaceId: string;
  /** The pane the task is pinned to, or '' when none was resolved. */
  targetPtyId: string;
  cwd: string | null;
  /** The full message, not the 500-char preview the dialog shows. */
  message: string;
}

/** An execute request still waiting on the user. */
export interface PendingExecuteRequest {
  /** The task the first request creates if it is approved. */
  taskId: string;
  /** Resolves with the first request's verdict. */
  verdict: Promise<boolean>;
}

/** Execute requests waiting on a verdict, by request identity. */
const pendingExecuteRequests = new Map<string, PendingExecuteRequest>();

function executeRequestKey(r: ExecuteRequestIdentity): string {
  return JSON.stringify([
    r.senderWorkspaceId, r.senderPtyId, r.receiverWorkspaceId, r.targetPtyId, r.cwd, r.message,
  ]);
}

/**
 * An identical execute request that is still waiting on the user, or
 * undefined. A retry joins it rather than raising a second prompt for the same
 * work (#1462) — approving both would run it twice. The entry lives exactly as
 * long as the prompt, which the hard cap ends before main stops waiting, so a
 * retry can never be pinned to a request nobody will answer.
 */
export function findPendingExecuteRequest(request: ExecuteRequestIdentity): PendingExecuteRequest | undefined {
  return pendingExecuteRequests.get(executeRequestKey(request));
}

export function requestExecuteApproval(input: {
  taskId: string;
  senderWorkspaceId: string;
  receiverWorkspaceId: string;
  messagePreview: string;
  cwd: string | null;
  /** When given, the request is findable by findPendingExecuteRequest until
   *  it settles. */
  identity?: ExecuteRequestIdentity;
}): Promise<boolean> {
  const { identity, ...approvalInput } = input;
  const verdict = enqueueApproval(approvalInput, true, EXECUTE_APPROVAL_HARD_CAP_MS).then((v) => v.approved);
  if (!identity) return verdict;
  const key = executeRequestKey(identity);
  const entry: PendingExecuteRequest = { taskId: input.taskId, verdict };
  pendingExecuteRequests.set(key, entry);
  return verdict.finally(() => {
    if (pendingExecuteRequests.get(key) === entry) pendingExecuteRequests.delete(key);
  });
}

/**
 * Gate for a fan-out started over the pipe/MCP surface.
 *
 * Whether anyone is asked is MAIN's decision (worktask/fanoutWorkerPolicy.ts),
 * passed in as `requireApproval`: by default there is no prompt (owner decision
 * 2026-09-24) and the brakes are main-side — depth-1, the global caps and the
 * audit log (worktask/fanoutGuards.ts). Deciding it here, from a store that is
 * only complete once the session has loaded, would let an early request be
 * waved through by a not-yet-restored default.
 *
 * When it is on: same queue, same dialog, same 30s timer as the execute gate —
 * but deliberately NOT the same consent. `a2aAutoApproveExecute` is the user
 * agreeing that an agent may spawn a background agent; it is not the user
 * agreeing that an agent may create N git worktrees and branches in their
 * repository, so it never answers this prompt. The outcome goes back instead
 * of a bare boolean: the wire caller has already been told "accepted", so a
 * silent auto-deny would leave an unattended fleet waiting on a fan-out that
 * will never happen.
 */
export function requestFanOutApproval(input: {
  workspaceId: string;
  repoPath: string;
  taskCount: number;
  messagePreview: string;
  requireApproval: boolean;
}): Promise<{ approved: boolean; outcome: ApprovalOutcome }> {
  if (!input.requireApproval) {
    return Promise.resolve({ approved: true, outcome: 'auto' });
  }
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
 * Never auto-approved: `a2aAutoApproveExecute`
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

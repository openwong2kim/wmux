import type { ApprovalQueue } from '../mcp/ApprovalQueue';
import {
  BORROW_APPROVAL_DEADLINE_MS,
  type BorrowApprovalOutcome,
  type BorrowApprovalRequest,
  type BorrowApprovalRequester,
} from '../../shared/liveWriteScope';

// ---------------------------------------------------------------------------
// Asking the human to lend an agent one live Chrome tab.
//
// This is the ONLY new consent question the agent-window policy introduces, and
// it deliberately introduces no new UI to ask it with: it rides the existing MCP
// permission-prompt pipeline (ApprovalQueue → the modal dialog and the Fleet
// approvals inbox, which are the same queue's two renditions). What is new is
// only the wording and the deadline.
// ---------------------------------------------------------------------------

// The deadline itself lives in shared/liveWriteScope: the MCP client has to give
// its RPC a longer one, so the two cannot be allowed to drift apart. Long enough
// to notice and read a prompt, short enough that an agent blocked on it is not
// blocked for the session — and a timeout is a DENY, because an unanswered
// question about handing over a logged-in tab must never resolve as yes.

/** The sentence the human reads. Names the workspace, the tab and its origin —
 *  a title alone is not enough to tell two logged-in tabs apart. */
export function borrowPromptTitle(
  workspaceName: string,
  request: Pick<BorrowApprovalRequest, 'title' | 'origin'>,
): string {
  const tab = request.title.trim().length > 0 ? request.title.trim() : 'untitled';
  const where = request.origin.length > 0 ? ` (${request.origin})` : '';
  return `Agent in workspace ${workspaceName} wants to control tab "${tab}"${where}`;
}

/**
 * Build the requester main hands to the browser RPC layer.
 *
 * Fail-closed in every direction: a queue that throws, a prompt nobody answers,
 * a cancelled prompt (renderer torn down) all come back as a refusal, never as a
 * grant. Only an explicit approve returns 'approved'.
 */
export function createBorrowApprovalRequester(deps: {
  queue: Pick<ApprovalQueue, 'requestConsent' | 'cancelPrompt'>;
  /** Display name for a workspace id; falls back to the id itself. */
  workspaceName: (workspaceId: string) => string;
  deadlineMs?: number;
}): BorrowApprovalRequester {
  const deadlineMs = deps.deadlineMs ?? BORROW_APPROVAL_DEADLINE_MS;
  return async (request): Promise<BorrowApprovalOutcome> => {
    const name = deps.workspaceName(request.workspaceId) || request.workspaceId;
    const deadlineAt = Date.now() + deadlineMs;
    let handle;
    try {
      handle = deps.queue.requestConsent({
        kind: 'browser-borrow',
        // One prompt per (workspace, tab). Two workspaces asking for the same
        // tab are two questions, because the answer differs.
        dedupeKey: `${request.workspaceId}::${request.surfaceId}`,
        clientName: name,
        title: borrowPromptTitle(name, request),
        deadlineAt,
      });
    } catch {
      // The queue could not even open the prompt, so nobody was asked.
      return 'denied';
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deadlineMs);
      // A pending question must not be the reason the process stays alive.
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        handle.resolution.then((r) => (r.approved ? 'approved' : 'denied') as BorrowApprovalOutcome),
        expiry,
      ]);
      if (outcome === 'timeout') {
        // Take the row off screen as well as refusing: a prompt whose answer
        // can no longer be used must not sit in the inbox inviting a click.
        deps.queue.cancelPrompt(handle.promptId, 'borrow request expired');
      }
      return outcome;
    } catch {
      // cancelPrompt rejects the waiters — a prompt that was withdrawn was not
      // approved.
      return 'denied';
    } finally {
      if (timer) clearTimeout(timer);
      // The race leaves the loser unhandled; a rejection there would be
      // reported against a call that already answered.
      handle.resolution.catch(() => {
        /* already answered above */
      });
    }
  };
}

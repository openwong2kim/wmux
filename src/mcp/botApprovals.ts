// approval_request / approval_list — a bot asks the owner for an
// irreversible or public act and reads its own requests
// (shared/botApproval.ts), registered with registerToolModule
// (src/mcp/toolModules.ts). Every call carries the bot's token; main takes
// the bot, its repository, the PR head, the gh login and the thread from its
// own state, so no tool sends them, and no tool decides a request.

import { z } from 'zod';
import { BOT_APPROVAL_RPC, BOT_REQUESTABLE_ACTIONS, type ApprovalAction, type ApprovalState } from '../shared/botApproval';
import { registerToolModule } from './toolModules';

/** A merge request reads the PR and the gh login from GitHub first. */
const REQUEST_TIMEOUT_MS = 30_000;

const NUMBER = z.number().int().positive();
const STATES = ['pending', 'approved', 'denied', 'undone', 'executed', 'refused', 'expired'] as const satisfies readonly ApprovalState[];

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

registerToolModule({
  name: 'bot-approvals',
  tools: ['approval_request', 'approval_list'],
  register(host, deps) {
    // A fresh object literal: the SDK's result type has an index signature.
    const call = async (method: Parameters<typeof deps.callRpc>[0], params: Record<string, unknown>, timeoutMs?: number) => ({
      ...(await deps.callRpc(method, compact(params), timeoutMs)),
    });

    host.tool(
      'approval_request',
      'Ask the owner to approve an irreversible or public act: merge a PR of your repository, push to its default branch, open or close an issue, '
        + 'comment under the owner\'s name, or publish a release. Your workers cannot do these themselves. A card with Approve / Deny / Always allow '
        + 'appears in your thread; list the requests to the owner there. wmux merges an approved PR itself (after a 10 s Undo window, re-checking '
        + 'the head and CI); a new head needs a new request. Other acts are recorded only for now. Returns the request (requestId, state); '
        + 'to the owner it is the approval card for that PR, never its requestId.',
      {
        action: z.enum(BOT_REQUESTABLE_ACTIONS as unknown as [ApprovalAction, ...ApprovalAction[]]),
        pr_number: NUMBER.optional().describe('merge, or a comment on a PR.'),
        issue_number: NUMBER.optional().describe('issue_close, or a comment on an issue.'),
        reason: z.string().min(1).max(300).describe('One line for the owner, in your own words and in the owner\'s language (the wake block says which): what this act does and what you checked. The owner reads it on the approval card. Never quote the owner\'s messages.'),
      },
      async ({ action, pr_number, issue_number, reason }) =>
        call(BOT_APPROVAL_RPC.request, { action, prNumber: pr_number, issueNumber: issue_number, reason }, REQUEST_TIMEOUT_MS),
    );

    host.tool(
      'approval_list',
      'Your approval requests, newest first: requestId, act, PR or issue, head, state (pending, approved, denied, executed, refused with a reason, expired).',
      {
        state: z.array(z.enum(STATES)).min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      async ({ state, limit }) => call(BOT_APPROVAL_RPC.list, { state, limit }),
    );
  },
});

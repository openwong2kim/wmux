// A bot's approval request, as a push to the phone, and the retraction once it
// is no longer waiting. Main pushes the table of waiting requests
// (shared/botApprovalPush.ts); BotApprovalPushRouter (a PushTableRouter) turns
// each change of that table into sends, parks and retractions.
//
// The payload names the request by `botApprovalId`, NEVER `approvalId`: every
// shipped extension attaches the pane-approval category and deep link to an
// `approvalId`, and the app would answer it on `/api/approvals`, where no such
// record exists. A bot approval is answered in the app's Bots conversation
// (`workspaceId` + `threadId`) through `/api/bot-approvals/:id`.
//
// The body carries no bot-written text. Like the phone's REST view of the
// request, it is built from the request's structured fields (the act, the
// repository, the PR or issue number) and the bot's display name, so a bot
// cannot put words of its own on the owner's lock screen.

import { PUSH_RISK_CRITICAL, PUSH_RISK_NORMAL, type PushPayload } from '../../shared/push/pushEnvelope';
import { APPROVAL_NEVER_BY_RULE } from '../../shared/botApproval';
import { BOT_APPROVAL_PUSH_CAPABILITY, type BotApprovalPushRow } from '../../shared/botApprovalPush';
import type { PhoneBotApproval } from '../../shared/phoneBotApprovals';
import { APPROVAL_RETRACTION_KIND } from './approvalPushPayload';
import { PushTableRouter, type PushTableRouterDeps } from './pushTableRouter';

/** The bot has no name the daemon was told. */
const BOT_NAME_FALLBACK = 'A bot';

function summary(r: PhoneBotApproval): string {
  const repo = r.repoKey;
  switch (r.action) {
    case 'merge':
      return r.prNumber !== undefined ? `Merge PR #${r.prNumber} in ${repo}` : `Merge a PR in ${repo}`;
    case 'push_default':
      return `Push to the default branch of ${repo}`;
    case 'issue_create':
      return `Open an issue in ${repo}`;
    case 'issue_close':
      return r.issueNumber !== undefined ? `Close issue #${r.issueNumber} in ${repo}` : `Close an issue in ${repo}`;
    case 'comment':
      if (r.prNumber !== undefined) return `Comment on PR #${r.prNumber} in ${repo}`;
      if (r.issueNumber !== undefined) return `Comment on issue #${r.issueNumber} in ${repo}`;
      return `Comment in ${repo}`;
    case 'release':
      return `Publish a release of ${repo}`;
    default:
      return `Approve an action in ${repo}`;
  }
}

export function buildBotApprovalPushPayload(row: BotApprovalPushRow): PushPayload {
  const r = row.request;
  return {
    title: 'Approval needed',
    body: `${row.botName ?? BOT_NAME_FALLBACK}: ${summary(r)}`,
    approvalKind: 'bot',
    botApprovalId: r.requestId,
    workspaceId: r.workspaceId,
    threadId: r.threadId,
    action: r.action,
    botId: r.botId,
    // No lock-screen affirmative: the choice is made on the card in the app.
    requiresInAppChoice: true,
    // An act no rule may ever approve (a release, a push to the default
    // branch) is `critical`, which also rings through desktop presence.
    risk: APPROVAL_NEVER_BY_RULE.has(r.action) ? PUSH_RISK_CRITICAL : PUSH_RISK_NORMAL,
  };
}

/** One banner per request. `apr-` ids are at most 36 characters. */
export function botApprovalPushCollapseId(requestId: string): string {
  return `bot-${requestId}`.slice(0, 64);
}

/** Replaces the request's banner once it is no longer waiting. No
 *  `approvalId` and no `botApprovalId`, for the reason the pane retraction
 *  gives: an extension that saw one would put the card's actions back. */
export function buildBotApprovalRetractionPayload(requestId: string): PushPayload {
  return {
    title: 'Approval resolved',
    body: 'No longer waiting — nothing to do.',
    kind: APPROVAL_RETRACTION_KIND,
    retractsBotApprovalId: requestId,
  };
}

/** Park-queue keys, kept apart from pane approval ids. */
export const BOT_APPROVAL_PARK_PREFIX = 'bot:';

/** Main's table of waiting bot approvals, as pushes and retractions. */
export class BotApprovalPushRouter extends PushTableRouter<BotApprovalPushRow> {
  constructor(deps: PushTableRouterDeps) {
    super({
      parkPrefix: BOT_APPROVAL_PARK_PREFIX,
      requires: BOT_APPROVAL_PUSH_CAPABILITY,
      noun: 'bot approval',
      idOf: (row) => row.request.requestId,
      build: buildBotApprovalPushPayload,
      collapseId: botApprovalPushCollapseId,
      retraction: buildBotApprovalRetractionPayload,
    }, deps);
  }
}

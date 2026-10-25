// Main's half of pushing a bot's approval requests to the phone: the table of
// phone-visible requests still waiting on the owner, sent to the daemon over
// `daemon.botApprovals.set` whenever it can have changed and on every daemon
// connect. The daemon pushes what appeared and retracts what left
// (shared/botApprovalPush.ts, daemon/push/botApprovalPush.ts).
//
// A pending request expires lazily (ApprovalService.expire runs on a read),
// so the feed also republishes when the oldest one reaches its TTL: the read
// that builds the table expires it, and the daemon retracts its banner.
//
// Unknown is not empty (pushTableFeed.ts): before the approval store starts
// and while it stops on quit the table is null and nothing is sent; only a
// store that failed to start sends an empty table, since nothing can be
// answered then.

import { APPROVAL_LIMITS, type ApprovalView } from '../factory/approvals';
import { phoneBotApproval } from '../../shared/phoneBotApprovals';
import { BOT_APPROVAL_PUSH_MAX_ROWS, type BotApprovalPushRow } from '../../shared/botApprovalPush';
import { createPushTableFeed, type PushTableFeed, type PushTableFeedDeps } from './pushTableFeed';

/** The waiting, phone-visible requests among `requests`, with their bot's
 *  name: the oldest BOT_APPROVAL_PUSH_MAX_ROWS, the ones the daemon keeps. */
export function botApprovalPushRows(
  requests: readonly ApprovalView[],
  botName: (botId: string) => string | undefined,
): BotApprovalPushRow[] {
  const rows: BotApprovalPushRow[] = [];
  for (const r of requests) {
    if (r.state !== 'pending') continue;
    // Null for a card-only act (a skill, a profile change, a native tool):
    // those are decided on the desktop card and never reach the phone.
    const request = phoneBotApproval(r);
    if (!request) continue;
    const name = botName(r.botId);
    rows.push({ request, ...(name ? { botName: name } : {}) });
  }
  return rows.sort((a, b) => a.request.createdAt - b.request.createdAt).slice(0, BOT_APPROVAL_PUSH_MAX_ROWS);
}

/** `rows` reads the store, which expires requests past their TTL. */
export type BotApprovalPushFeedDeps = Omit<PushTableFeedDeps<BotApprovalPushRow>, 'refreshAt'>;

export type BotApprovalPushFeed = PushTableFeed;

export function createBotApprovalPushFeed(deps: BotApprovalPushFeedDeps): BotApprovalPushFeed {
  return createPushTableFeed({
    ...deps,
    // The oldest request reaches its TTL with nothing reported.
    refreshAt: (rows) => rows.length > 0
      ? Math.min(...rows.map((row) => row.request.createdAt)) + APPROVAL_LIMITS.PENDING_TTL_MS + 1_000
      : undefined,
  });
}

let feed: BotApprovalPushFeed | null = null;

/** Wired once by index.ts; null in tests and before it runs. */
export function setBotApprovalPushFeed(next: BotApprovalPushFeed | null): void {
  feed = next;
}

/** ApprovalService said its requests changed. */
export function noteBotApprovalsChanged(): void {
  feed?.schedule();
}

let storeUnavailable = false;

/** The approval store did not start: nothing can be answered, so the empty
 *  table is the answer. */
export function noteBotApprovalStoreUnavailable(): void {
  storeUnavailable = true;
  feed?.schedule();
}

/** The table to send for `requests` (the running store's list, or null when
 *  there is none), or null while it is not known. */
export function botApprovalPushTable(
  requests: readonly ApprovalView[] | null,
  botName: (botId: string) => string | undefined,
): BotApprovalPushRow[] | null {
  if (requests) return botApprovalPushRows(requests, botName);
  return storeUnavailable ? [] : null;
}

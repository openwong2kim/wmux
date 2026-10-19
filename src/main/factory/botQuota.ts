// ─── A bot's account usage limits (main) ────────────────────────────────────
//
// A bot's brain runs on the owner's Claude subscription: the account its
// conversation started on, or the workspace's binding for a bot with none
// (backgroundLaunchAccount.ts resolveConversationAccount). Its Today block
// shows that account's 5-hour and weekly usage from the readings wmux already
// holds: AccountUsageService for a registered account, the usage meter's
// poller for the default login. Nothing here reads a credential or sends a
// request; with no reading held the bot shows no quota, as before.

import type { UsageSnapshot } from '../claude/UsageApi';
import type { BotQuota, BotQuotaWindow } from '../../shared/bot';
import { resolveConversationAccount } from '../account/backgroundLaunchAccount';
import { getAccountStore } from '../account/accountStore';

/** The usage readings wmux holds, by account (null: the default login). */
export interface ClaudeUsageCache {
  read(accountId: string | null): UsageSnapshot | null;
  /** A reading changed. Returns an unsubscribe. */
  onChange(cb: () => void): () => void;
}

/** A reading older than this is not shown: the line carries no age, and a
 *  meter that stopped refreshing would leave yesterday's numbers on it. */
export const BOT_QUOTA_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function quotaWindow(pct: number, resetEpochSec: number, now: number): BotQuotaWindow | undefined {
  if (!Number.isFinite(pct)) return undefined;
  const resetsAt = resetEpochSec > 0 ? resetEpochSec * 1000 : undefined;
  // A window that has reset since the reading says nothing about now.
  if (resetsAt !== undefined && resetsAt <= now) return undefined;
  return { pct: Math.max(0, Math.min(100, Math.round(pct))), ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/** The quota line of an account's reading; null when it has no window to show. */
export function botQuotaOf(accountName: string | null, snapshot: UsageSnapshot | null, now: number): BotQuota | null {
  if (!snapshot || now - snapshot.fetchedAtMs > BOT_QUOTA_MAX_AGE_MS) return null;
  const session = quotaWindow(snapshot.sessionPct, snapshot.sessionResetEpochSec, now);
  const weekly = quotaWindow(snapshot.weeklyPct, snapshot.weeklyResetEpochSec, now);
  if (!session && !weekly) return null;
  return { accountName, ...(session ? { session } : {}), ...(weekly ? { weekly } : {}) };
}

/** The quota of the account a bot's brain runs on. Never throws. */
export function botAccountQuota(
  cache: ClaudeUsageCache,
  workspaceId: string,
  conversationAccountId: string | null | undefined,
  now: number = Date.now(),
): BotQuota | null {
  try {
    const { run } = resolveConversationAccount(workspaceId, 'claude', conversationAccountId);
    const name = run.accountId ? getAccountStore().getAccount(run.accountId)?.name ?? null : null;
    // A registered account that is gone has no reading to show.
    if (run.accountId && name === null) return null;
    return botQuotaOf(name, cache.read(run.accountId), now);
  } catch {
    return null;
  }
}

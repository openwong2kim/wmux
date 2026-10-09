/**
 * PC rail: when a list answer may change the attention ledger.
 *
 * A list (`/api/workspaces` or `/api/approvals`) is a snapshot taken when its
 * request started. An entry raised by an SSE frame after that moment is newer
 * than the snapshot, so the snapshot cannot speak for it:
 *
 *   approvals list   replaces `approval:` entries raised before the request;
 *                    later ones stay until the next list. Never touches
 *                    `critical:` entries.
 *   workspace list   drops a `critical:` entry whose pane it no longer lists,
 *                    only when the entry was raised before the list request.
 *
 * Every entry older than PC_RAIL_PENDING_TTL_MS is purged on each tick,
 * whether or not the host answered.
 */
import {
  PC_RAIL_APPROVAL_LIMITS,
  PC_RAIL_PENDING_TTL_MS,
  reconcilePcRailApprovals,
  type PcRailPendingEntry,
  type PcRailPendingLedger,
  type RemoteApprovalSummary,
} from '../../../shared/pcRail';

/** The same ledger when nothing expired, so an idle tick costs no copy. */
export function purgeExpiredPcRailEntries(ledger: PcRailPendingLedger, now: number): PcRailPendingLedger {
  let next: Record<string, PcRailPendingEntry> | null = null;
  for (const [key, entry] of Object.entries(ledger)) {
    if (now - entry.at < PC_RAIL_PENDING_TTL_MS) continue;
    next ??= { ...ledger };
    delete next[key];
  }
  return next ?? ledger;
}

/** An approvals snapshot requested at `requestedAt`, applied at `now`. */
export function applyPcRailApprovalsSnapshot(
  ledger: PcRailPendingLedger,
  approvals: readonly RemoteApprovalSummary[],
  requestedAt: number,
  now: number,
): PcRailPendingLedger {
  // No live set: an approvals list never decides that a critical pane is gone.
  const next: Record<string, PcRailPendingEntry> = { ...reconcilePcRailApprovals(ledger, approvals, now) };
  for (const [key, entry] of Object.entries(ledger)) {
    if (Object.keys(next).length >= PC_RAIL_APPROVAL_LIMITS.approvals) break;
    if (!key.startsWith('approval:') || key in next) continue;
    if (entry.at > requestedAt && now - entry.at < PC_RAIL_PENDING_TTL_MS) next[key] = entry;
  }
  return next;
}

/** Drop critical entries whose pane a list requested after them no longer carries. */
export function dropGonePcRailCritical(
  ledger: PcRailPendingLedger,
  liveSessionIds: ReadonlySet<string>,
  listRequestedAt: number,
): PcRailPendingLedger {
  let next: Record<string, PcRailPendingEntry> | null = null;
  for (const [key, entry] of Object.entries(ledger)) {
    if (!key.startsWith('critical:') || entry.at > listRequestedAt || liveSessionIds.has(entry.sessionId)) continue;
    next ??= { ...ledger };
    delete next[key];
  }
  return next ?? ledger;
}

// ─── C-3: approval auto-reject countdown + the record of what expired ────
//
// An approval that nobody answers is auto-rejected. Until now the Fleet inbox
// showed that deadline for A2A rows only, and when a row expired it simply
// vanished — indistinguishable from someone approving it. These pure helpers
// give the list both halves: the remaining seconds while the row is alive, and
// a short log of the rows that died of the deadline.
//
// The deadline itself is data, not a guess: A2A rows carry `expiresAt`, and an
// MCP prompt carries `deadlineAt` once the daemon stamps it (Lane A). Without a
// deadline no badge is rendered — a countdown wmux cannot back with a real
// auto-reject would be a lie about what happens when you walk away.

import type { InboxItem } from '../../stores/selectors/approvalInbox';

/** How many expired rows the list remembers. Enough to explain "what happened
 *  while I was away" without turning the inbox into a history view. */
export const AUTO_REJECT_LOG_CAP = 5;

/** A row that expired without an answer. */
export interface AutoRejectedEntry {
  /** The inbox key of the row that expired (`a2a:…` / `mcp:…`). */
  key: string;
  /** What it was, for the log line. */
  label: string;
  /** When it expired (epoch ms). */
  at: number;
}

/** The deadline the list is tracking for one row. */
export interface TrackedDeadline {
  key: string;
  label: string;
  deadlineAt: number;
}

/**
 * The auto-reject deadline for an inbox row, or `undefined` when it has none.
 * A2A execute approvals expire on their own clock; an MCP prompt only has one
 * once the approval record carries `deadlineAt` (read structurally so this lane
 * does not depend on the field having landed).
 */
export function deadlineForItem(
  item: InboxItem,
  mcpDeadlineAt?: (promptId: string) => number | undefined,
): number | undefined {
  if (item.source === 'a2a') return item.expiresAt;
  const at = mcpDeadlineAt?.(item.promptId);
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}

/** Whole seconds left before auto-reject, never negative. */
export function remainingSeconds(deadlineAt: number, now: number): number {
  return Math.ceil(Math.max(0, deadlineAt - now) / 1000);
}

/**
 * Fold the rows that have LEFT the inbox into the auto-rejected log.
 *
 * A row counts as auto-rejected when it is gone and its deadline had already
 * passed; a row that left before its deadline was answered by a human and is
 * not logged. Newest first, capped, and idempotent on key — re-running with the
 * same inputs cannot double-log an entry.
 */
export function reduceAutoRejected(args: {
  previous: readonly AutoRejectedEntry[];
  /** Deadlines observed on the previous render. */
  tracked: readonly TrackedDeadline[];
  /** Keys still present in the inbox. */
  presentKeys: ReadonlySet<string>;
  now: number;
}): AutoRejectedEntry[] {
  const { previous, tracked, presentKeys, now } = args;
  const already = new Set(previous.map((e) => e.key));
  const expired: AutoRejectedEntry[] = [];
  for (const row of tracked) {
    if (presentKeys.has(row.key) || already.has(row.key)) continue;
    if (row.deadlineAt > now) continue; // answered before the deadline
    expired.push({ key: row.key, label: row.label, at: row.deadlineAt });
  }
  if (expired.length === 0) return previous as AutoRejectedEntry[];
  return [...expired.reverse(), ...previous].slice(0, AUTO_REJECT_LOG_CAP);
}

/** A short, source-appropriate label for the log line. */
export function inboxItemLabel(item: InboxItem): string {
  return item.source === 'a2a' ? item.taskId : item.clientName;
}

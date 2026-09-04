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
 * How far past its deadline a row may leave the inbox and still count as an
 * auto-rejection.
 *
 * "Gone and past its deadline" alone is not proof: a background tab's timers
 * are throttled and a suspended machine wakes with a clock minutes ahead, so a
 * row a HUMAN answered late would be logged as expired. An auto-reject removes
 * the row at its deadline, so a removal that lands well after it is somebody
 * else's doing.
 */
export const AUTO_REJECT_GRACE_MS = 5_000;

/**
 * Did this row leave the inbox because its deadline fired?
 *
 * `removedAt` is the instant the row actually left the store, not a render
 * tick — the classification is made at the removal point (the slice), so a
 * deadline that fires while the Fleet tab is closed is still recorded.
 */
export function isAutoRejection(args: {
  deadlineAt?: number;
  removedAt: number;
}): boolean {
  const { deadlineAt, removedAt } = args;
  if (typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt)) return false;
  const late = removedAt - deadlineAt;
  return late >= 0 && late <= AUTO_REJECT_GRACE_MS;
}

/**
 * Prepend one expired row to the log: newest first, capped, and idempotent on
 * key so a repeated removal cannot double-log.
 */
export function appendAutoRejected(
  previous: readonly AutoRejectedEntry[],
  entry: AutoRejectedEntry,
): AutoRejectedEntry[] {
  if (previous.some((e) => e.key === entry.key)) return previous as AutoRejectedEntry[];
  return [entry, ...previous].slice(0, AUTO_REJECT_LOG_CAP);
}

/** A short, source-appropriate label for the log line. */
export function inboxItemLabel(item: InboxItem): string {
  return item.source === 'a2a' ? item.taskId : item.clientName;
}

import type { AgentStatus } from '../../../shared/types';

// Display-only reordering for the sidebar workspace list and the mini rail.
// It never touches the canonical `workspaces` array: Ctrl+N labels and drag
// reorder stay defined on the unfiltered positions, so a pinned row still
// carries its real index. And it is opt-in because rows that jump while the
// user is scanning destroy positional memory — the list you learned is gone.

/** Statuses that mean the agent has stopped and is waiting on the human. */
export function needsAttention(status: AgentStatus): boolean {
  return status === 'waiting' || status === 'awaiting_input';
}

/**
 * Stable partition: needs-attention items first, everything else after, with
 * the original relative order preserved inside both halves. Returns the input
 * untouched when `enabled` is false.
 */
export function orderByAttention<T extends { id: string }>(
  items: readonly T[],
  statusOf: (id: string) => AgentStatus,
  enabled: boolean,
): T[] {
  if (!enabled) return items as T[];
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    (needsAttention(statusOf(item.id)) ? pinned : rest).push(item);
  }
  return pinned.concat(rest);
}

/**
 * #1481 — "Recent activity": the workspace with the newest sign of life first.
 * Stable, so ties (and workspaces with no activity this session, which sort
 * last) keep their manual order.
 */
export function orderByRecentActivity<T extends { id: string }>(
  items: readonly T[],
  lastActivityOf: (id: string) => number,
): T[] {
  return items
    .map((item, index) => ({ item, index, at: lastActivityOf(item.id) || 0 }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ item }) => item);
}

/** One entry point for every sort mode the sidebar offers. */
export function orderWorkspaces<T extends { id: string }>(
  items: readonly T[],
  mode: 'manual' | 'attention' | 'recent',
  statusOf: (id: string) => AgentStatus,
  lastActivityOf: (id: string) => number,
): T[] {
  if (mode === 'attention') return orderByAttention(items, statusOf, true);
  if (mode === 'recent') return orderByRecentActivity(items, lastActivityOf);
  return items as T[];
}

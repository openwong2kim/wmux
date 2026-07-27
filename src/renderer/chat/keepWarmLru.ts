// Chat View keep-warm LRU (plan PR-9, §6 memory policy).
//
// A surface in chat mode keeps its xterm MOUNTED at visible={false} so a
// toggle-back is instant. That is free for one pane and expensive for thirty:
// every mounted xterm holds its own canvas/DOM renderer plus scrollback. The
// policy: keep the N most recently used chat panes warm and unmount the rest.
//
// Unmounting is safe for the PTY — Terminal.tsx only disposes a pty it created
// itself and then had cancelled; an externally supplied `ptyId` is untouched,
// and a remount re-attaches through the session pipe (PTY_RECONNECT /
// PTY_RESYNC). The cost of eviction is therefore a ring-buffer replay on
// toggle-back, not a lost session.
//
// Everything here is pure so the eviction order is testable without a store.

/** Panes kept mounted-but-hidden while in chat mode. */
export const KEEP_WARM_DEFAULT_N = 4;

/**
 * Upper bound on the tracked toggle order. Entries are normally removed when a
 * pane leaves chat mode or its surface is cleared, so this only guards against
 * a pane that disappears without either (a crashed renderer path).
 */
export const TOGGLE_ORDER_MAX = 32;

/**
 * Pure. Returns the ptyIds whose xterm should stay MOUNTED-but-hidden.
 * N=4 → instant toggle-back for the working set; the rest unmount.
 *
 * @param toggleOrder chat-mode toggle recency, MOST recently used FIRST.
 * @param n how many to keep warm; `0` (or negative) keeps none.
 */
export function keepWarmSet(
  toggleOrder: readonly string[],
  n: number = KEEP_WARM_DEFAULT_N,
): ReadonlySet<string> {
  if (n <= 0) return new Set<string>();
  const warm = new Set<string>();
  for (const ptyId of toggleOrder) {
    if (!ptyId || warm.has(ptyId)) continue;
    warm.add(ptyId);
    if (warm.size >= n) break;
  }
  return warm;
}

/**
 * Pure. Moves `ptyId` to the MRU head, de-duplicating and capping the list.
 * Re-toggling a pane that is already warm must not evict a different pane, so
 * the promotion is a move, never an insert.
 */
export function promoteToggle(order: readonly string[], ptyId: string): string[] {
  if (!ptyId) return [...order];
  const next = [ptyId, ...order.filter((id) => id !== ptyId)];
  return next.length > TOGGLE_ORDER_MAX ? next.slice(0, TOGGLE_ORDER_MAX) : next;
}

/** Pure. Drops `ptyId` from the toggle order (chat mode off, surface closed). */
export function dropToggle(order: readonly string[], ptyId: string): string[] {
  return order.filter((id) => id !== ptyId);
}

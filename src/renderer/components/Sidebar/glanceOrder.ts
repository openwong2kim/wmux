// ─── Sidebar glance-board order (owner decision 2026-09-25) ──────────────────
//
// The Attention order: pinned workspaces keep their manual position; the rest
// fill the remaining slots most-urgent first (see selectWorkspaceAttentionScores:
// needs you → finished → running → unconfirmed → idle, newest first within a
// class). A workspace created in the last few minutes stays on top so the row
// you just made does not jump away from you.
//
// And rows must not move under the pointer. `reconcileAppliedOrder` keeps the
// order the user is looking at and only reports that a re-sort is pending; the
// sidebar applies it after a short settle or when the pointer leaves.

/** A just-created workspace holds the top slot this long. */
export const NEW_WORKSPACE_HOLD_MS = 3 * 60_000;
/** A pending re-sort applies after the list has been quiet this long. */
export const GLANCE_SETTLE_MS = 3_000;
/** Under changes that never stop, a pending re-sort applies this long after
 *  the first one (still never while the pointer or focus is in the list). */
export const GLANCE_MAX_WAIT_MS = 10_000;

export function glanceOrder<T extends { id: string }>(
  manual: readonly T[],
  scoreOf: (id: string) => number,
  pinned: ReadonlySet<string>,
  newAt: Readonly<Record<string, number>>,
  now: number,
  holdMs = NEW_WORKSPACE_HOLD_MS,
): T[] {
  const slots: (T | undefined)[] = new Array(manual.length);
  const rest: { item: T; index: number }[] = [];
  manual.forEach((item, index) => {
    if (pinned.has(item.id)) slots[index] = item;
    else rest.push({ item, index });
  });
  const held = (id: string) => {
    const at = newAt[id];
    return at !== undefined && now - at < holdMs ? at : undefined;
  };
  rest.sort((a, b) => {
    const ha = held(a.item.id);
    const hb = held(b.item.id);
    if (ha !== undefined || hb !== undefined) {
      if (ha === undefined) return 1;
      if (hb === undefined) return -1;
      if (ha !== hb) return hb - ha;
    }
    return scoreOf(a.item.id) - scoreOf(b.item.id) || a.index - b.index;
  });
  let next = 0;
  for (let i = 0; i < slots.length; i += 1) {
    if (!slots[i]) slots[i] = rest[next++]?.item;
  }
  return slots.filter((x): x is T => x !== undefined);
}

/**
 * Keep the order on screen (`applied`) while absorbing membership changes at
 * once: removed ids drop out, new ids take their place in `desired` (so a new
 * workspace appears where the board puts it — on top while held). Returns the
 * order to show now and whether it still differs from `desired`, i.e. whether
 * a re-sort is pending.
 */
export function reconcileAppliedOrder(
  applied: readonly string[],
  desired: readonly string[],
): { order: string[]; pending: boolean } {
  const want = new Set(desired);
  const kept = applied.filter((id) => want.has(id));
  const have = new Set(kept);
  const order = [...kept];
  desired.forEach((id, i) => {
    if (have.has(id)) return;
    // Insert before the first kept id that follows it in `desired`.
    const after = desired.slice(i + 1).find((d) => have.has(d));
    const at = after === undefined ? order.length : order.indexOf(after);
    order.splice(at, 0, id);
    have.add(id);
  });
  const pending = order.length !== desired.length || order.some((id, i) => id !== desired[i]);
  return { order, pending };
}

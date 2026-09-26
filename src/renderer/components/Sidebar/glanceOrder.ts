// ─── Sidebar glance-board order (owner decision 2026-09-25) ──────────────────
//
// The Attention order: most-urgent first (see selectWorkspaceAttentionScores:
// needs you → finished → running → unconfirmed → idle, newest first within a
// class). A workspace created in the last few minutes stays on top so the row
// you just made does not jump away from you. It orders only the rows below the
// pinned group (2026-09-26): pinned rows stay first, in the user's order, and
// never re-sort — see splitPinnedGroup.
//
// And rows must not move under the pointer. `reconcileAppliedOrder` keeps the
// order the user is looking at and only reports that a re-sort is pending; the
// sidebar applies it after a short settle or when the pointer leaves.

import type { SidebarSortMode } from '../../utils/sidebarLayout';
import { orderByRecentActivity } from './attentionOrder';

/** A just-created workspace holds the top slot this long. */
export const NEW_WORKSPACE_HOLD_MS = 3 * 60_000;
/** A pending re-sort applies after the list has been quiet this long. */
export const GLANCE_SETTLE_MS = 3_000;
/** Under changes that never stop, a pending re-sort applies this long after
 *  the first one (still never while the pointer or focus is in the list). */
export const GLANCE_MAX_WAIT_MS = 10_000;

/**
 * The pinned group and the rest, both in stored order. The group is the
 * top-level pinned rows (a nested fan-out task renders under its owner, so it
 * never joins the group); everything else is `rest`, which the sort mode
 * orders. The sidebar shows `[...pinned, ...ordered rest]` in every mode.
 */
export function splitPinnedGroup<T extends { id: string }>(
  manual: readonly T[],
  pinned: ReadonlySet<string>,
  nestedOwnerOf?: (id: string) => string | undefined,
): { pinned: T[]; rest: T[] } {
  const group: T[] = [];
  const rest: T[] = [];
  for (const item of manual) {
    if (pinned.has(item.id) && !nestedOwnerOf?.(item.id)) group.push(item);
    else rest.push(item);
  }
  return { pinned: group, rest };
}

export function glanceOrder<T extends { id: string }>(
  manual: readonly T[],
  scoreOf: (id: string) => number,
  newAt: Readonly<Record<string, number>>,
  now: number,
  holdMs = NEW_WORKSPACE_HOLD_MS,
): T[] {
  const rest = manual.map((item, index) => ({ item, index }));
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
  return rest.map((r) => r.item);
}

/**
 * The sidebar's order for a sort mode, as the pinned group (never re-sorted)
 * and the rest in the mode's order. Only `rest` goes through the settle rule,
 * so pinning, unpinning and reordering inside the group land at once.
 *
 * In Attention, nested fan-out tasks take no top-level slot (they render under
 * their owner) and go last; an owner scores as its most urgent task, so a task
 * that needs you lifts its whole group.
 */
export function boardOrder<T extends { id: string }>(opts: {
  manual: readonly T[];
  mode: SidebarSortMode;
  pinned: ReadonlySet<string>;
  scoreOf: (id: string) => number | undefined;
  activityOf: (id: string) => number | undefined;
  newAt: Readonly<Record<string, number>>;
  now: number;
  nestedOwnerOf?: (id: string) => string | undefined;
}): { pinned: T[]; rest: T[] } {
  const { manual, mode, scoreOf, activityOf, newAt, now, nestedOwnerOf } = opts;
  const split = splitPinnedGroup(manual, opts.pinned, nestedOwnerOf);
  if (mode === 'recent') return { pinned: split.pinned, rest: orderByRecentActivity(split.rest, (id) => activityOf(id) ?? 0) };
  if (mode !== 'attention') return split;
  const top: T[] = [];
  const nested: T[] = [];
  const effective: Record<string, number> = {};
  for (const item of split.rest) {
    if (nestedOwnerOf?.(item.id)) nested.push(item);
    else top.push(item);
  }
  for (const item of top) effective[item.id] = scoreOf(item.id) ?? Number.MAX_SAFE_INTEGER;
  for (const item of nested) {
    const owner = nestedOwnerOf?.(item.id) as string;
    if (effective[owner] === undefined) continue;
    effective[owner] = Math.min(effective[owner], scoreOf(item.id) ?? Number.MAX_SAFE_INTEGER);
  }
  const ordered = glanceOrder(top, (id) => effective[id] ?? Number.MAX_SAFE_INTEGER, newAt, now);
  return { pinned: split.pinned, rest: [...ordered, ...nested] };
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

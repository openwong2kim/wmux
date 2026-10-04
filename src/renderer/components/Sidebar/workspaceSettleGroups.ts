// ─── Sidebar Snoozed / Settled groups ────────────────────────────────────────
//
// Pure: splits the sidebar's rows into the main list and the two groups at
// its foot. Main decides who is settled or snoozed (shared/workspaceSettle);
// this only places rows. Not to be confused with `useSettledOrder`, where
// "settled" means the list order stopped moving.
//
//   - Only TOP-LEVEL rows are placed by their own state.
//   - A fan-out task nested under its owner goes wherever its owner goes, so
//     a settled owner takes its task group along and a task never leaves it.
//   - A pinned row is never grouped: pinned wins.
//   - A snooze whose end has passed counts as not snoozed (main expires it
//     within a minute; the row must not wait for that).

import type { WorkspaceSettleState } from '../../../shared/workspaceSettle';
import type { WorkspaceSettleGroupKind } from '../../stores/slices/workspaceSettleSlice';

export function workspaceSettleGroupOf(state: WorkspaceSettleState | undefined, now: number): WorkspaceSettleGroupKind | null {
  if (!state) return null;
  if (state.settled) return 'settled';
  if (state.snoozedUntil !== undefined && state.snoozedUntil > now) return 'snoozed';
  return null;
}

export function partitionWorkspaceSettle<T extends { id: string }>(
  rows: readonly T[],
  opts: {
    groupOf: (id: string) => WorkspaceSettleGroupKind | null;
    pinned: ReadonlySet<string>;
    /** The owner a nested fan-out task renders under, else undefined (see Sidebar). */
    nestedOwnerOf?: (id: string) => string | undefined;
  },
): { main: T[]; snoozed: T[]; settled: T[] } {
  const out = { main: [] as T[], snoozed: [] as T[], settled: [] as T[] };
  const placeOf = (id: string) => (opts.pinned.has(id) ? null : opts.groupOf(id));
  for (const row of rows) {
    const owner = opts.nestedOwnerOf?.(row.id);
    const group = owner !== undefined ? placeOf(owner) : placeOf(row.id);
    out[group ?? 'main'].push(row);
  }
  return out;
}

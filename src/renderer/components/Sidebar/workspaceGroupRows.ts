// ─── Sidebar workspace groups (#3069) ────────────────────────────────────────
//
// Pure: splits the main list's rows (already ordered, settled / snoozed rows
// already taken out) into the user's groups and the rows outside any group.
// Only places rows; the order inside each part is the input order, so the
// list's sort applies inside a group too.
//
//   - A row goes under the group its workspace names, if that group exists.
//   - A fan-out task nested under its owner goes wherever its owner goes, so
//     a task never leaves its owner's task group.
//   - A pinned row is never grouped: pinned wins (it leads the list), the same
//     rule as the Snoozed / Settled groups.
//   - Every group is returned, in the groups' order, empty ones included; the
//     caller decides whether an empty group is drawn.

import type { WorkspaceGroup } from '../../../shared/workspaceGroups';

export interface WorkspaceGroupRows<T> {
  /** Pinned rows outside any group: they lead the list, above the groups. */
  pinned: T[];
  /** The groups, in their own order, each with its rows. */
  groups: { group: WorkspaceGroup; rows: T[] }[];
  /** The remaining rows outside any group, below the groups. */
  rest: T[];
}

export function partitionWorkspaceGroups<T extends { id: string }>(
  rows: readonly T[],
  opts: {
    groups: readonly WorkspaceGroup[];
    /** The group id a workspace names, else undefined. */
    groupOf: (id: string) => string | undefined;
    pinned: ReadonlySet<string>;
    /** The owner a nested fan-out task renders under, else undefined (see Sidebar). */
    nestedOwnerOf?: (id: string) => string | undefined;
  },
): WorkspaceGroupRows<T> {
  const byGroup = new Map<string, T[]>(opts.groups.map((g) => [g.id, []]));
  const out: WorkspaceGroupRows<T> = { pinned: [], groups: [], rest: [] };
  for (const row of rows) {
    const owner = opts.nestedOwnerOf?.(row.id) ?? row.id;
    const isPinned = opts.pinned.has(owner);
    const groupId = isPinned ? undefined : opts.groupOf(owner);
    const bucket = groupId !== undefined ? byGroup.get(groupId) : undefined;
    if (bucket) bucket.push(row);
    else if (isPinned) out.pinned.push(row);
    else out.rest.push(row);
  }
  out.groups = opts.groups.map((group) => ({ group, rows: byGroup.get(group.id) ?? [] }));
  return out;
}

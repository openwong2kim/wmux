/**
 * Multiview groups: several saved grids, one on screen at a time.
 *
 * The grid on screen stays `multiviewIds` — every reader of the grid (the
 * viewport gate, cold-park, focus, the seen selectors) keeps reading that one
 * list. The other groups wait in `multiviewSavedGroups`. Activating a member
 * of a saved group swaps it in (promoteMultiviewGroup, run by
 * activateLocalWorkspace, the one place activeWorkspaceId is assigned), and
 * the group that was showing is saved in its place.
 *
 * A workspace belongs to at most one group, and every group has at least two
 * members: a one-member group would draw a one-tile grid.
 */

export interface MultiviewGroupState {
  multiviewIds?: string[];
  multiviewSavedGroups?: string[][];
  parkedWorkspaceIds?: Record<string, true>;
  lastVisibleAt?: Record<string, number>;
}

/** Save the group on screen (when it is one) and clear the grid. */
export function saveCurrentMultiviewGroup(state: MultiviewGroupState): void {
  if (!state.multiviewIds || !state.multiviewSavedGroups) return;
  if (state.multiviewIds.length >= 2) state.multiviewSavedGroups.push([...state.multiviewIds]);
  state.multiviewIds = [];
}

/**
 * Put the saved group holding `id` on screen, saving the one that was there.
 * No-op when `id` is in no saved group (the grid on screen, or no grid). Its
 * members become visible together, so they are un-parked in the same
 * mutation, as a Ctrl+click join does.
 */
export function promoteMultiviewGroup(state: MultiviewGroupState, id: string): void {
  const saved = state.multiviewSavedGroups;
  if (!saved || !state.multiviewIds) return;
  const idx = saved.findIndex((group) => group.includes(id));
  if (idx < 0) return;
  const [group] = saved.splice(idx, 1);
  saveCurrentMultiviewGroup(state);
  state.multiviewIds = group;
  if (state.parkedWorkspaceIds && state.lastVisibleAt) {
    for (const member of group) {
      if (state.parkedWorkspaceIds[member]) delete state.parkedWorkspaceIds[member];
      if (state.lastVisibleAt[member] !== undefined) delete state.lastVisibleAt[member];
    }
  }
}

/** Take `id` out of every saved group (it is joining another), dropping groups left with one member. */
export function leaveSavedMultiviewGroups(state: MultiviewGroupState, id: string): void {
  if (!state.multiviewSavedGroups) return;
  state.multiviewSavedGroups = state.multiviewSavedGroups
    .map((group) => group.filter((member) => member !== id))
    .filter((group) => group.length >= 2);
}

/** Drop members whose workspace is gone from the saved groups, and groups left with one member. */
export function pruneSavedMultiviewGroups(state: MultiviewGroupState, liveIds: ReadonlySet<string>): void {
  if (!state.multiviewSavedGroups || state.multiviewSavedGroups.length === 0) return;
  state.multiviewSavedGroups = state.multiviewSavedGroups
    .map((group) => group.filter((member) => liveIds.has(member)))
    .filter((group) => group.length >= 2);
}

/** Every group, the one on screen first, for session.json. */
export function multiviewGroupsForSave(state: { multiviewIds: string[]; multiviewSavedGroups: string[][] }): string[][] {
  return [state.multiviewIds, ...state.multiviewSavedGroups].filter((group) => group.length >= 2).map((group) => [...group]);
}

/**
 * Saved groups from session.json, shape-checked: the file is user-editable and
 * may come from another build. Unknown or closed workspaces are dropped, a
 * workspace named twice keeps its first group, and groups left with fewer than
 * two members are dropped.
 */
export function parseMultiviewGroups(raw: unknown, liveIds: ReadonlySet<string>): string[][] {
  if (!Array.isArray(raw)) return [];
  const taken = new Set<string>();
  const groups: string[][] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue;
    const group: string[] = [];
    for (const id of entry) {
      if (typeof id !== 'string' || !liveIds.has(id) || taken.has(id)) continue;
      group.push(id);
      taken.add(id);
    }
    if (group.length >= 2) groups.push(group);
    else for (const id of group) taken.delete(id);
  }
  return groups;
}

/**
 * The sidebar's group number for each grouped workspace, 1-based. Groups are
 * numbered by where their first member sits in the sidebar, so a number does
 * not move when another group is put on screen.
 */
export function multiviewGroupNumbers(
  workspaceOrder: readonly string[],
  multiviewIds: readonly string[],
  savedGroups: readonly (readonly string[])[],
): Map<string, number> {
  const position = new Map(workspaceOrder.map((id, i) => [id, i]));
  const first = (group: readonly string[]): number =>
    Math.min(...group.map((id) => position.get(id) ?? Number.MAX_SAFE_INTEGER));
  const groups = [multiviewIds, ...savedGroups].filter((group) => group.length >= 2);
  groups.sort((a, b) => first(a) - first(b));
  const numbers = new Map<string, number>();
  groups.forEach((group, i) => {
    for (const id of group) numbers.set(id, i + 1);
  });
  return numbers;
}

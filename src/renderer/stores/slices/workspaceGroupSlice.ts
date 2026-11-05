// Workspace groups slice (#3069) — the user's named sidebar groups and the
// verbs that file workspaces under them. Display-only: nothing here touches
// sessions, agents, settle / snooze or the stored workspace order.
//
// PERSISTED: `workspaceGroups` is saved with the session (AppLayout
// buildSessionData) and normalized on load (workspaceSlice loadSession); a
// workspace's membership is its own `groupId`, saved with the workspace.

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { generateId, type Workspace } from '../../../shared/types';
import { isShadowWorkspaceId } from '../../../shared/pcRail';
import { normalizeWorkspaceGroupName, WORKSPACE_GROUPS_MAX, type WorkspaceGroup } from '../../../shared/workspaceGroups';

export interface WorkspaceGroupSlice {
  /** The user's groups, in the order the sidebar shows them. */
  workspaceGroups: WorkspaceGroup[];
  /** TRANSIENT: the group whose header shows its name field (set right after
   *  "New group…" so the user can name it in place). */
  workspaceGroupRenamingId: string | null;
  /**
   * Make a group and, when `workspaceId` is given, file that workspace under
   * it. Returns the new id, or null when the name is empty or the cap is hit.
   */
  createWorkspaceGroup: (name: string, workspaceId?: string) => string | null;
  /** An empty name is refused (the old name stays). */
  renameWorkspaceGroup: (groupId: string, name: string) => void;
  /** The group goes; its workspaces return to the top level, still open. */
  deleteWorkspaceGroup: (groupId: string) => void;
  setWorkspaceGroupCollapsed: (groupId: string, collapsed: boolean) => void;
  /** File the workspace under `groupId`, or (undefined) back at the top level. */
  moveWorkspaceToGroup: (workspaceId: string, groupId: string | undefined) => void;
  setWorkspaceGroupRenaming: (groupId: string | null) => void;
}

/** A row that can be filed: a local workspace (a shadow is another computer's). */
function fileable(state: StoreState, workspaceId: string): Workspace | undefined {
  if (isShadowWorkspaceId(workspaceId)) return undefined;
  return state.workspaces.find((w: Workspace) => w.id === workspaceId);
}

export const createWorkspaceGroupSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  WorkspaceGroupSlice
> = (set, get) => ({
  workspaceGroups: [],
  workspaceGroupRenamingId: null,

  createWorkspaceGroup: (name, workspaceId) => {
    const label = normalizeWorkspaceGroupName(name);
    if (!label || get().workspaceGroups.length >= WORKSPACE_GROUPS_MAX) return null;
    const id = generateId('grp');
    set((state: StoreState) => {
      state.workspaceGroups.push({ id, name: label });
      if (workspaceId) {
        const ws = fileable(state, workspaceId);
        if (ws) ws.groupId = id;
      }
    });
    return id;
  },

  renameWorkspaceGroup: (groupId, name) => set((state: StoreState) => {
    const label = normalizeWorkspaceGroupName(name);
    const group = state.workspaceGroups.find((g) => g.id === groupId);
    if (group && label) group.name = label;
  }),

  deleteWorkspaceGroup: (groupId) => set((state: StoreState) => {
    if (!state.workspaceGroups.some((g) => g.id === groupId)) return;
    state.workspaceGroups = state.workspaceGroups.filter((g) => g.id !== groupId);
    for (const ws of state.workspaces) {
      if (ws.groupId === groupId) delete ws.groupId;
    }
    if (state.workspaceGroupRenamingId === groupId) state.workspaceGroupRenamingId = null;
  }),

  setWorkspaceGroupCollapsed: (groupId, collapsed) => set((state: StoreState) => {
    const group = state.workspaceGroups.find((g) => g.id === groupId);
    if (!group) return;
    if (collapsed) group.collapsed = true;
    else delete group.collapsed;
  }),

  moveWorkspaceToGroup: (workspaceId, groupId) => set((state: StoreState) => {
    const ws = fileable(state, workspaceId);
    if (!ws) return;
    if (groupId === undefined) {
      delete ws.groupId;
      return;
    }
    const group = state.workspaceGroups.find((g) => g.id === groupId);
    if (!group) return;
    ws.groupId = groupId;
    // The row must not vanish into a folded header: show where it went.
    delete group.collapsed;
  }),

  setWorkspaceGroupRenaming: (groupId) => set((state: StoreState) => {
    state.workspaceGroupRenamingId = groupId;
  }),
});

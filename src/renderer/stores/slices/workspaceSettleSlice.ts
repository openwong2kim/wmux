// Workspace settle / snooze slice — renderer mirror of main's settle state
// (shared/workspaceSettle). Drives the sidebar's Snoozed / Settled groups, the
// Fleet "Settled" chip and the context-menu verbs.
//
// TRANSIENT: never enters buildSessionData. Main owns and persists the state;
// this slice is hydrated from `workspaceSettle.get()` on mount and kept live by
// `workspaceSettle.onChanged` (useWorkspaceSettleBridge).

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { DEFAULT_WORKSPACE_IDLE_DAYS, type WorkspaceSettleSnapshot } from '../../../shared/workspaceSettle';

export type WorkspaceSettleGroupKind = 'snoozed' | 'settled';

export interface WorkspaceSettleSlice {
  workspaceSettle: WorkspaceSettleSnapshot;
  setWorkspaceSettleSnapshot: (snapshot: WorkspaceSettleSnapshot) => void;
  /** Optimistic idle-days value while the settings field waits for main's reply. */
  setWorkspaceSettleIdleDays: (days: number) => void;
  /** The sidebar groups' open state for this session. Absent = the default. */
  workspaceSettleGroupsOpen: Partial<Record<WorkspaceSettleGroupKind, boolean>>;
  setWorkspaceSettleGroupOpen: (group: WorkspaceSettleGroupKind, open: boolean) => void;
}

export const createWorkspaceSettleSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  WorkspaceSettleSlice
> = (set) => ({
  workspaceSettle: { states: {}, idleDays: DEFAULT_WORKSPACE_IDLE_DAYS },
  workspaceSettleGroupsOpen: {},

  setWorkspaceSettleSnapshot: (snapshot) => set((draft: StoreState) => {
    draft.workspaceSettle = {
      states: snapshot && typeof snapshot.states === 'object' && snapshot.states ? snapshot.states : {},
      idleDays: typeof snapshot?.idleDays === 'number' ? snapshot.idleDays : draft.workspaceSettle.idleDays,
    };
  }),

  setWorkspaceSettleIdleDays: (days) => set((draft: StoreState) => {
    draft.workspaceSettle.idleDays = days;
  }),

  setWorkspaceSettleGroupOpen: (group, open) => set((draft: StoreState) => {
    draft.workspaceSettleGroupsOpen[group] = open;
  }),
});

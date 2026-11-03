// Agent marker slice — each pane's computer-use marker colour, keyed by ptyId
// (shared/computer/agentMarker.ts). Main gives a pane's agent its colour the
// first time it sends computer-use input and keeps it until wmux quits; the
// sidebar row and the pane's tab draw a dot in that colour, so a marker on
// screen can be tied to its pane (DESIGN.md › Agent identity colours).
//
// TRANSIENT: never enters buildSessionData. Main owns the list; this slice is
// read once, then replaced by every push (useAgentMarkersBridge).

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { AgentMarkerEntry } from '../../../shared/computer/agentMarker';

export interface AgentMarkerSlice {
  /** ptyId → marker colour. Absent key = the pane has not used computer use. */
  agentMarkers: Record<string, string>;
  /** Replace the map with main's whole list. */
  setAgentMarkers: (entries: readonly AgentMarkerEntry[]) => void;
}

export const createAgentMarkerSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  AgentMarkerSlice
> = (set) => ({
  agentMarkers: {},

  setAgentMarkers: (entries) => set((draft: StoreState) => {
    const next: Record<string, string> = {};
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry && typeof entry.ptyId === 'string' && entry.ptyId && typeof entry.color === 'string') {
        next[entry.ptyId] = entry.color;
      }
    }
    // An unchanged list keeps the map, so no row or tab re-renders.
    const prev = draft.agentMarkers;
    const keys = Object.keys(next);
    if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) return;
    draft.agentMarkers = next;
  }),
});

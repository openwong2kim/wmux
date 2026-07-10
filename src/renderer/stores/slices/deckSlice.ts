// ─── Command Deck renderer state (Command Deck Phase 1) ──────────────────────
//
// The right-side dock is being re-framed from a pure "channel viewer" into a
// Command Deck: a tabbed surface whose DEFAULT tab (`commander`) is an
// LLM-less command composer — @-mention several agent panes at once and watch
// their replies land in one thread — and whose second tab (`channels`) holds
// the existing channel list + conversation exactly as before.
//
// This slice owns ONLY the deck's chrome state (which tab is active). The
// Commander thread itself is NOT new state: it is the `#commander` channel's
// message list, read straight from `channelsSlice.channelMessages`. Phase 2
// (the orchestrator chat) reuses this same tab + composer skeleton, so keeping
// the tab state here (and the thread data in the channels slice) means the
// chat UI has zero throwaway state.
//
// Pattern mirrors the other thin UI slices (uiSlice's dock/panel toggles):
// a single enum field + its setter, no async, no bridge.

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';

/** Which dock tab is showing. `commander` is the default (the LLM-less
 *  command composer); `channels` is the classic channel list + conversation. */
export type DeckTab = 'commander' | 'channels';

export interface DeckSlice {
  /** Active dock tab. Defaults to `commander` — the deck opens on the command
   *  composer, and the channel list is one tab over. Transient UI state (not
   *  persisted): the deck always opens on Commander on a fresh load. */
  activeDeckTab: DeckTab;
  setActiveDeckTab: (tab: DeckTab) => void;
}

export const createDeckSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  DeckSlice
> = (set) => ({
  activeDeckTab: 'commander',

  setActiveDeckTab: (tab) =>
    set((state: StoreState) => {
      state.activeDeckTab = tab;
    }),
});

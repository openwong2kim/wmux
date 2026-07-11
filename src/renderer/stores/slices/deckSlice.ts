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
import type { BrainEvent } from '../../../main/deck/BrainAdapter';
import {
  applyBrainEvent,
  type DeckBrainMessage,
} from '../../components/Deck/deckBrain';
import { generateId } from '../../../shared/types';

/** Which dock tab is showing. `commander` is the default (the LLM-less
 *  command composer); `channels` is the classic channel list + conversation. */
export type DeckTab = 'commander' | 'channels';

/** The Commander BRAIN turn state (Phase 2). Distinct from the Phase 1 fan-out
 *  threads (which live in the `#commander` channel): the brain stream is an
 *  orchestrator turn, not channel semantics, so it is deck-owned state. */
export type DeckBrainStatus = 'idle' | 'busy';

export interface DeckSlice {
  /** Active dock tab. Defaults to `commander` — the deck opens on the command
   *  composer, and the channel list is one tab over. Transient UI state (not
   *  persisted): the deck always opens on Commander on a fresh load. */
  activeDeckTab: DeckTab;
  setActiveDeckTab: (tab: DeckTab) => void;

  /** The Commander brain conversation (this-session only — resume is P3). */
  brainMessages: DeckBrainMessage[];
  /** `busy` while a brain turn streams; the composer disables to enforce the
   *  one-turn-at-a-time contract the session manager also guards. */
  brainStatus: DeckBrainStatus;

  /** Open a new brain turn: push the human message + a streaming assistant
   *  placeholder, and mark the deck busy. */
  startDeckBrainTurn: (text: string) => void;
  /** Apply one normalized brain stream event to the open turn. `turn-end` /
   *  `error` flip the deck back to idle. */
  applyDeckBrainEvent: (event: BrainEvent) => void;
  /** Mark the open turn failed (used when deck.send is REJECTED before any
   *  stream event — e.g. a busy race). */
  failDeckBrainTurn: (message: string) => void;

  /** P3b: the reboot-recovery greeting card was dismissed (or its recovery was
   *  launched) this session. Transient — a fresh launch re-evaluates from the
   *  resume hints, which self-clear as agents come back. */
  recoveryCardDismissed: boolean;
  dismissRecoveryCard: () => void;
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

  brainMessages: [],
  brainStatus: 'idle',

  startDeckBrainTurn: (text) =>
    set((state: StoreState) => {
      state.brainMessages.push({ id: generateId('dbu'), role: 'user', text, ts: Date.now() });
      state.brainMessages.push({
        id: generateId('dba'),
        role: 'assistant',
        text: '',
        ts: Date.now(),
        tools: [],
        status: 'streaming',
      });
      state.brainStatus = 'busy';
    }),

  applyDeckBrainEvent: (event) =>
    set((state: StoreState) => {
      // A main-originated turn (P3d scheduled run) announces itself with
      // `turn-start` — open the turn exactly like startDeckBrainTurn so the
      // scheduled run renders as visibly as a typed one.
      if (event.type === 'turn-start') {
        state.brainMessages.push({ id: generateId('dbu'), role: 'user', text: event.prompt, ts: Date.now() });
        state.brainMessages.push({
          id: generateId('dba'),
          role: 'assistant',
          text: '',
          ts: Date.now(),
          tools: [],
          status: 'streaming',
        });
        state.brainStatus = 'busy';
        return;
      }
      state.brainMessages = applyBrainEvent(state.brainMessages, event);
      if (event.type === 'turn-end' || event.type === 'error') {
        state.brainStatus = 'idle';
      }
    }),

  failDeckBrainTurn: (message) =>
    set((state: StoreState) => {
      state.brainMessages = applyBrainEvent(state.brainMessages, { type: 'error', message });
      state.brainStatus = 'idle';
    }),

  recoveryCardDismissed: false,
  dismissRecoveryCard: () =>
    set((state: StoreState) => {
      state.recoveryCardDismissed = true;
    }),
});

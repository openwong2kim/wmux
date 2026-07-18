// ─── Command Deck renderer state (Command Deck Phase 1, per-ws M1.5) ─────────
//
// The right-side dock is being re-framed from a pure "channel viewer" into a
// Command Deck: a tabbed surface whose DEFAULT tab (`commander`) is an
// LLM-less command composer — @-mention several agent panes at once and watch
// their replies land in one thread — and whose second tab (`channels`) holds
// the existing channel list + conversation exactly as before.
//
// This slice owns the deck's chrome state (which tab is active) and the
// Commander BRAIN threads. M1.5: one orchestrator per workspace → the brain
// conversation is a wsId-keyed map of independent threads, each with its own
// busy state. The deck shows the ACTIVE workspace's thread; a turn streaming
// in a background workspace keeps landing in ITS thread (events arrive
// enveloped with their workspaceId), so switching back shows the complete
// transcript — and the active workspace's composer is never blocked by
// another workspace's turn (the parallelism that motivated M1.5).
//
// Pattern mirrors the other thin UI slices (uiSlice's dock/panel toggles):
// enum fields + setters, no async, no bridge.

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { BrainEvent } from '../../../main/deck/BrainAdapter';
import {
  applyBrainEvent,
  type DeckBrainMessage,
} from '../../components/Deck/deckBrain';
import { generateId } from '../../../shared/types';

/** Which dock tab is showing. `commander` is the default (the LLM-less
 *  command composer); `channels` is the classic channel list + conversation;
 *  `git` is the workspace's git surface (worktrees + PRs); `review` is the
 *  diff-first review roster across ALL workspaces (P1, 2026-07-18). */
export type DeckTab = 'commander' | 'channels' | 'git' | 'review';

/** One workspace orchestrator's turn state. Distinct from the Phase 1 fan-out
 *  threads (which live in the `#commander` channel): the brain stream is an
 *  orchestrator turn, not channel semantics, so it is deck-owned state. */
export type DeckBrainStatus = 'idle' | 'busy';

export interface DeckBrainThread {
  messages: DeckBrainMessage[];
  /** `busy` while a brain turn streams in THIS workspace; the composer
   *  disables to enforce the per-workspace one-turn-at-a-time contract the
   *  session manager also guards. */
  status: DeckBrainStatus;
}

export const EMPTY_DECK_BRAIN_THREAD: DeckBrainThread = { messages: [], status: 'idle' };

export interface DeckSlice {
  /** Active dock tab. Defaults to `commander` — the deck opens on the command
   *  composer, and the channel list is one tab over. Transient UI state (not
   *  persisted): the deck always opens on Commander on a fresh load. */
  activeDeckTab: DeckTab;
  setActiveDeckTab: (tab: DeckTab) => void;

  /** Per-workspace orchestrator conversations (this-session only — the
   *  transcript itself resumes SDK-side via the persisted session id). */
  brainThreads: Record<string, DeckBrainThread>;

  /** Open a new brain turn on one workspace's thread: push the human message
   *  + a streaming assistant placeholder, and mark that workspace busy. */
  startDeckBrainTurn: (workspaceId: string, text: string) => void;
  /** Apply one normalized brain stream event to the given workspace's open
   *  turn. `turn-end` / `error` flip that workspace back to idle. */
  applyDeckBrainEvent: (workspaceId: string, event: BrainEvent) => void;
  /** Mark the given workspace's open turn failed (used when deck.send is
   *  REJECTED before any stream event — e.g. a busy race). */
  failDeckBrainTurn: (workspaceId: string, message: string) => void;

  /** P3b: the reboot-recovery greeting card was dismissed (or its recovery was
   *  launched) this session. Transient — a fresh launch re-evaluates from the
   *  resume hints, which self-clear as agents come back. */
  recoveryCardDismissed: boolean;
  dismissRecoveryCard: () => void;

  /** diff→오케스트레이터 질문 릴레이. DiffPanel(다른 표면)이 질문을 실어 두고
   *  Orchestrator 탭으로 전환하면, CommanderView가 마운트/변경 시 집어
   *  handleBrainSend로 발사한다 — fleet context·optimistic 버블·모델 오버라이드
   *  조립을 한 곳(CommanderView)에 유지하기 위한 우회로. transient(비영속). */
  pendingBrainPrompt: string | null;
  setPendingBrainPrompt: (prompt: string | null) => void;
}

function threadOf(state: StoreState, workspaceId: string): DeckBrainThread {
  const existing = state.brainThreads[workspaceId];
  if (existing) return existing;
  const fresh: DeckBrainThread = { messages: [], status: 'idle' };
  state.brainThreads[workspaceId] = fresh;
  return fresh;
}

function openTurn(thread: DeckBrainThread, text: string): void {
  thread.messages.push({ id: generateId('dbu'), role: 'user', text, ts: Date.now() });
  thread.messages.push({
    id: generateId('dba'),
    role: 'assistant',
    text: '',
    ts: Date.now(),
    tools: [],
    status: 'streaming',
  });
  thread.status = 'busy';
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

  brainThreads: {},

  pendingBrainPrompt: null,

  setPendingBrainPrompt: (prompt) =>
    set((state: StoreState) => {
      state.pendingBrainPrompt = prompt;
    }),

  startDeckBrainTurn: (workspaceId, text) =>
    set((state: StoreState) => {
      openTurn(threadOf(state, workspaceId), text);
    }),

  applyDeckBrainEvent: (workspaceId, event) =>
    set((state: StoreState) => {
      const thread = threadOf(state, workspaceId);
      // A main-originated turn (P3d scheduled run) announces itself with
      // `turn-start` — open the turn exactly like startDeckBrainTurn so the
      // scheduled run renders as visibly as a typed one (in ITS workspace's
      // thread, which may be a background one).
      if (event.type === 'turn-start') {
        openTurn(thread, event.prompt);
        return;
      }
      thread.messages = applyBrainEvent(thread.messages, event);
      if (event.type === 'turn-end' || event.type === 'error') {
        thread.status = 'idle';
      }
    }),

  failDeckBrainTurn: (workspaceId, message) =>
    set((state: StoreState) => {
      const thread = threadOf(state, workspaceId);
      thread.messages = applyBrainEvent(thread.messages, { type: 'error', message });
      thread.status = 'idle';
    }),

  recoveryCardDismissed: false,
  dismissRecoveryCard: () =>
    set((state: StoreState) => {
      state.recoveryCardDismissed = true;
    }),
});
